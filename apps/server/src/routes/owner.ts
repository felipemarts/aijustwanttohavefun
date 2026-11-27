import { randomBytes } from 'node:crypto';
import type { AgentState } from '@ajwf/engine';
import { languageTagSchema, MAX_AGENTS_PER_OWNER, MAX_OWNER_NOTE_LEN, maskBlockedWords, ownerNoteSchema, sanitizeAgentText, type MsgParams } from '@ajwf/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { newApiKey, sha256 } from '../auth';
import { errorBody, invalidParams, sendRateLimited } from '../http-errors';
import { authorizeUrl, decodeAttempt, encodeAttempt, enabledProviders, fetchIdentity, isProvider, newAttempt, OAUTH_TTL_MS, sameSecret, UsedStates } from '../owner/oauth';
import { validSubscription } from '../owner/push';
import { cookieOptions } from '../owner/session';
import { buildSummary, SUMMARY_EVENT_TYPES, SUMMARY_MAX_EVENTS } from '../owner/summary';
import type { OwnerRow } from '../store/types';

const CLAIM_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Browser subscriptions kept per owner. */
export const MAX_PUSH_SUBSCRIPTIONS = 10;

const idParams = z.object({ id: z.string().regex(/^a[0-9a-z]{1,12}$/) });
const sinceQuery = z.object({ since: z.coerce.number().int().min(0).max(1e15).optional() });
const languageBody = z.object({ language: languageTagSchema });
const devLoginBody = z.object({ name: z.string().min(1).max(40).optional() });
const subscribeBody = z.object({ endpoint: z.string().max(1024), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });
const unsubscribeBody = z.object({ endpoint: z.string().max(1024) });

/**
 * The same-origin check of every state-changing owner route: `Origin` must be PUBLIC_URL's origin (or the dev
 * web server's, outside production); without `Origin`, `Sec-Fetch-Site` must say same-origin. No header: refused.
 */
export function sameOrigin(req: FastifyRequest, allowed: readonly string[]): boolean {
  const origin = req.headers.origin;
  if (typeof origin === 'string') return allowed.includes(origin);
  return req.headers['sec-fetch-site'] === 'same-origin';
}

/** Reads (GET) refuse requests a browser marks as coming from another site. */
function crossSiteRead(req: FastifyRequest): boolean {
  const site = req.headers['sec-fetch-site'];
  return site === 'cross-site' || site === 'same-site';
}

function isJson(req: FastifyRequest): boolean {
  const type = req.headers['content-type'];
  return typeof type === 'string' && /^application\/json\s*(;|$)/i.test(type);
}

/**
 * `/api/owner`: login (OAuth with PKCE, or the dev login), the claim flow and the owner dashboard (§14.2, §15.1).
 * No CORS: only the game's own pages can call these routes with the session cookie.
 */
export function ownerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { game, render, config, sessions } = ctx;
  const store = game.store;
  const origins = [new URL(config.publicUrl).origin, ...config.extraOrigins];
  const usedStates = new UsedStates();
  const providers = enabledProviders(config);

  const fail = (reply: FastifyReply, status: number, code: string, slug: string, lang = 'en', params?: MsgParams) =>
    reply.code(status).send(errorBody(render.apiError(lang, code, slug, params)));

  /**
   * The owner behind this request, after the CSRF checks on state-changing methods. Answers the error itself and
   * returns null when the request may not go on.
   */
  async function owner(req: FastifyRequest, reply: FastifyReply): Promise<OwnerRow | null> {
    const refused = csrf(req, reply);
    if (refused) return null;
    const s = await sessions.read(req, reply);
    const o = s ? await store.getOwner(s.ownerId) : null;
    if (!o) {
      if (s) sessions.clear(reply);
      fail(reply, 401, 'UNAUTHORIZED', 'owner_unauthorized');
      return null;
    }
    return o;
  }

  /** Answers 403 or 415 and returns true when the request fails the cross-site checks. */
  function csrf(req: FastifyRequest, reply: FastifyReply): boolean {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!crossSiteRead(req)) return false;
      fail(reply, 403, 'FORBIDDEN', 'cross_origin');
      return true;
    }
    if (!sameOrigin(req, origins)) {
      fail(reply, 403, 'FORBIDDEN', 'cross_origin');
      return true;
    }
    if (!isJson(req)) {
      fail(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'unsupported_media_type');
      return true;
    }
    return false;
  }

  /** The owner's agent with this id, or a 404 identical to the one for an agent that does not exist. */
  function mine(o: OwnerRow, req: FastifyRequest, reply: FastifyReply): AgentState | null {
    const p = idParams.safeParse(req.params);
    const a = p.success ? game.ownedAgent(o.id, p.data.id) : undefined;
    if (a) return a;
    fail(reply, 404, 'NOT_FOUND', 'owner_agent_not_found', render.lang(o.language));
    return null;
  }

  const lang = (o: OwnerRow) => render.lang(o.language);
  const profileUrl = (a: AgentState) => `${config.publicUrl}/a/${encodeURIComponent(a.name)}`;
  const languageOf = (req: FastifyRequest) => render.lang(String(req.headers['accept-language'] ?? '').split(',')[0]?.split(';')[0]?.trim());

  function agentView(a: AgentState, l: string) {
    return {
      id: a.id,
      name: a.name,
      class: a.cls,
      level: a.level,
      status: a.status,
      ...(a.title ? { title: a.title, title_text: render.name(l, 'title', a.title) } : {}),
      look: render.look(a.appearance, a.lookHash, l),
      sprite_hash: a.lookHash,
      sprite: `/sprites/${a.lookHash}.png`,
      note: a.ownerNote,
      achievements: Object.keys(a.achievements).length,
      friends: a.friends.length,
      last_active_at: a.lastActiveAt,
      ...(game.ownerSeenAt(a.id) !== undefined ? { seen_at: game.ownerSeenAt(a.id) } : {}),
      profile_url: profileUrl(a),
      card_url: `${config.publicUrl}/og/agent/${encodeURIComponent(a.name)}.png?lang=${encodeURIComponent(l)}`,
    };
  }

  // Per-IP limits: everything here, logins, and the claim token routes (strict: tokens are not guessable anyway).
  app.addHook('onRequest', async (req, reply) => {
    const t = ctx.limiters.owner.take(req.ip, game.now());
    if (!t.ok) return sendRateLimited(reply, render, 'en', t.retryAfterSec);
  });
  const limitWith = (limiter: { take(k: string, now: number): { ok: true } | { ok: false; retryAfterSec: number } }) => async (req: FastifyRequest, reply: FastifyReply) => {
    const t = limiter.take(req.ip, game.now());
    if (!t.ok) return sendRateLimited(reply, render, 'en', t.retryAfterSec);
  };
  const claimLimit = { onRequest: limitWith(ctx.limiters.claim) };
  const loginLimit = { onRequest: limitWith(ctx.limiters.login) };

  // ── login ───────────────────────────────────────────────────────────────────────────────────────────────

  app.get('/providers', async () => ({ ok: true, providers, dev_login: config.devLogin }));

  app.get('/login/:provider', loginLimit, async (req, reply) => {
    const { provider } = req.params as { provider: string };
    if (!isProvider(provider) || !providers.includes(provider)) return fail(reply, 404, 'NOT_FOUND', 'login_unavailable');
    const attempt = newAttempt(provider, (req.query as { next?: unknown }).next as string, game.now());
    reply.setCookie(sessions.names.oauth, encodeAttempt(attempt), { ...cookieOptions(config.production, OAUTH_TTL_MS), signed: true });
    return reply.code(302).header('location', authorizeUrl(config, attempt)).send();
  });

  app.get('/oauth/:provider/callback', loginLimit, async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const q = req.query as Record<string, unknown>;
    const raw = req.cookies[sessions.names.oauth];
    reply.clearCookie(sessions.names.oauth, cookieOptions(config.production, 0));
    const back = (error: string) => reply.code(302).header('location', `${config.publicUrl}/owner?login_error=${error}`).send();
    if (q.error !== undefined) return back('denied');
    const unsigned = raw ? req.unsignCookie(raw) : null;
    const attempt = unsigned?.valid ? decodeAttempt(unsigned.value) : null;
    const now = game.now();
    if (!attempt || attempt.p !== provider || typeof q.state !== 'string' || !sameSecret(q.state, attempt.s)) return back('state');
    if (attempt.e <= now) return back('expired');
    // A cookie without the PKCE verifier cannot finish the exchange.
    if (!/^[A-Za-z0-9_-]{43}$/.test(attempt.v)) return back('state');
    if (!usedStates.take(attempt.s, attempt.e, now)) return back('state');
    if (typeof q.code !== 'string' || !q.code || q.code.length > 1024) return back('state');
    const who = await fetchIdentity(ctx.fetch, config, attempt.p, q.code, attempt.v);
    if (!who.ok) return back('provider');
    const o = await store.upsertOwner({ provider: attempt.p, externalId: who.externalId, name: who.name, language: languageOf(req) }, now);
    await sessions.create(req, reply, o.id);
    req.log.info({ owner: o.id, provider: attempt.p }, 'owner logged in');
    return reply.code(302).header('location', `${config.publicUrl}${attempt.n}`).send();
  });

  if (config.devLogin) {
    /** Development and tests only (DEV_LOGIN=1, never in production): a fake owner, no OAuth app needed. */
    app.post('/dev-login', loginLimit, async (req, reply) => {
      if (csrf(req, reply)) return reply;
      const body = devLoginBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send(invalidParams(render, 'en', body.error.issues));
      const name = sanitizeAgentText(body.data.name ?? 'Dev Owner', 40).text || 'Dev Owner';
      const o = await store.upsertOwner({ provider: 'dev', externalId: name.toLowerCase(), name, language: languageOf(req) }, game.now());
      await sessions.create(req, reply, o.id);
      return { ok: true, owner: { id: o.id, name: o.name, language: o.language } };
    });
  }

  app.post('/logout', async (req, reply) => {
    if (csrf(req, reply)) return reply;
    await sessions.destroy(req, reply);
    return { ok: true };
  });

  // ── the claim link ──────────────────────────────────────────────────────────────────────────────────────

  /** Public preview for the claim page. Unknown and already used tokens get the very same 404. */
  app.get('/claim/:token', claimLimit, async (req, reply) => {
    const { token } = req.params as { token: string };
    const a = CLAIM_TOKEN_RE.test(token) ? game.claimable(sha256(token)) : undefined;
    if (!a) return fail(reply, 404, 'NOT_FOUND', 'claim_invalid');
    const l = render.lang(String((req.query as { lang?: unknown }).lang ?? a.lang));
    return { ok: true, agent: { name: a.name, class: a.cls, level: a.level, look: render.look(a.appearance, a.lookHash, l), sprite_hash: a.lookHash, sprite: `/sprites/${a.lookHash}.png` } };
  });

  app.post('/claim/:token', claimLimit, async (req, reply) => {
    const o = await owner(req, reply);
    if (!o) return reply;
    const { token } = req.params as { token: string };
    if (!CLAIM_TOKEN_RE.test(token)) return fail(reply, 404, 'NOT_FOUND', 'claim_invalid', lang(o));
    const res = await game.claim(sha256(token), o.id);
    if (!res.ok) {
      if (res.reason === 'limit') return fail(reply, 409, 'AGENT_LIMIT', 'owner_agent_limit', lang(o), { max: MAX_AGENTS_PER_OWNER });
      if (res.reason === 'store') return fail(reply, 500, 'INTERNAL', 'internal', lang(o));
      return fail(reply, 404, 'NOT_FOUND', 'claim_invalid', lang(o));
    }
    req.log.info({ owner: o.id, agent: res.agent.id }, 'agent claimed');
    return { ok: true, agent: agentView(res.agent, lang(o)) };
  });

  // ── the dashboard ───────────────────────────────────────────────────────────────────────────────────────

  app.get('/me', async (req, reply) => {
    const o = await owner(req, reply);
    if (!o) return reply;
    const l = lang(o);
    const subs = config.vapid ? (await store.listPushSubscriptions(o.id)).length : 0;
    return {
      ok: true,
      owner: { id: o.id, name: o.name, provider: o.provider, language: l },
      limits: { max_agents: MAX_AGENTS_PER_OWNER, note_max: MAX_OWNER_NOTE_LEN },
      agents: game.ownedBy(o.id).map((a) => agentView(a, l)),
      push: { enabled: config.vapid !== null, subscriptions: subs },
    };
  });

  app.put('/language', async (req, reply) => {
    const o = await owner(req, reply);
    if (!o) return reply;
    const body = languageBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(invalidParams(render, lang(o), body.error.issues));
    const l = render.lang(body.data.language);
    await store.setOwnerLanguage(o.id, l);
    return { ok: true, language: l };
  });

  app.delete('/me', async (req, reply) => {
    const o = await owner(req, reply);
    if (!o) return reply;
    await game.deleteOwner(o.id);
    sessions.clear(reply);
    req.log.info({ owner: o.id }, 'owner account deleted');
    return { ok: true };
  });

  app.get('/agents/:id/summary', async (req, reply) => {
    const o = await owner(req, reply);
    if (!o) return reply;
    const a = mine(o, req, reply);
    if (!a) return reply;
    const q = sinceQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send(invalidParams(render, lang(o), q.error.issues));
    const until = game.now();
    const since = q.data.since ?? game.ownerSeenAt(a.id) ?? a.createdAt;
    // Events reach the store in one-second batches: write what is buffered so the summary is complete.
    await ctx.flushEvents();
    const events = await store.agentEvents(a.id, since, SUMMARY_EVENT_TYPES, SUMMARY_MAX_EVENTS);
    const highlights = await ctx.chronicle.highlights(null, 200, (h) => h.ts > since && h.agents.includes(a.name));
    const summary = buildSummary({ s: game.state, render, lang: lang(o), agent: a, events, highlights, since, until });
    await game.markOwnerSeen(a.id, until);
    return { ok: true, agent: { id: a.id, name: a.name }, ...summary, seen_at: until };
  });

  app.put('/agents/:id/note', async (req, reply) => {
    const o = await owner(req, reply);
    if (!o) return reply;
    const a = mine(o, req, reply);
    if (!a) return reply;
    const body = ownerNoteSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(invalidParams(render, lang(o), body.error.issues));
    // Delivered to the agent as is: cleaned exactly like agent-written text (no links, keys or invisible characters).
    const note = maskBlockedWords(sanitizeAgentText(body.data.note, MAX_OWNER_NOTE_LEN).text);
    await game.setOwnerNote(a.id, note);
    return { ok: true, note };
  });

  app.post('/agents/:id/regenerate-key', async (req, reply) => {
    const o = await owner(req, reply);
    if (!o) return reply;
    const a = mine(o, req, reply);
    if (!a) return reply;
    if (a.status !== 'active') return fail(reply, 409, 'CONFLICT', 'owner_agent_inactive', lang(o));
    const key = newApiKey();
    const done = await game.regenerateKey(a.id, key.hash);
    if (done === 'busy') return fail(reply, 409, 'CONFLICT', 'key_busy', lang(o));
    if (done === 'failed') return fail(reply, 500, 'INTERNAL', 'internal', lang(o));
    req.log.info({ owner: o.id, agent: a.id }, 'api key regenerated');
    return { ok: true, api_key: key.value, note: render.t(lang(o), 'owner.key.shown_once') };
  });

  app.post('/agents/:id/retire', async (req, reply) => {
    const o = await owner(req, reply);
    if (!o) return reply;
    const a = mine(o, req, reply);
    if (!a) return reply;
    if (a.status === 'active') await game.deactivate(a.id, 'retired');
    req.log.info({ owner: o.id, agent: a.id }, 'agent retired');
    return { ok: true, agent: { id: a.id, name: a.name, status: a.status } };
  });

  /** "Announce my agent": a prefilled post in the owner's language, its link, and the X intent URL. */
  app.get('/agents/:id/share', async (req, reply) => {
    const o = await owner(req, reply);
    if (!o) return reply;
    const a = mine(o, req, reply);
    if (!a) return reply;
    const text = render.t(lang(o), 'owner.share.announce', { name: a.name, level: a.level, class: `@class:${a.cls}` });
    const url = profileUrl(a);
    return { ok: true, text, url, intent_url: `https://x.com/intent/post?${new URLSearchParams({ text, url })}` };
  });

  // ── Web Push ────────────────────────────────────────────────────────────────────────────────────────────

  const pushOff = (reply: FastifyReply, o: OwnerRow) => fail(reply, 503, 'PUSH_DISABLED', 'push_disabled', lang(o));

  app.get('/push/key', async (req, reply) => {
    const o = await owner(req, reply);
    if (!o) return reply;
    if (!config.vapid) return pushOff(reply, o);
    return { ok: true, public_key: config.vapid.publicKey };
  });

  app.post('/push/subscribe', async (req, reply) => {
    const o = await owner(req, reply);
    if (!o) return reply;
    if (!config.vapid) return pushOff(reply, o);
    const body = subscribeBody.safeParse(req.body ?? {});
    const sub = body.success ? validSubscription(body.data.endpoint, body.data.keys) : null;
    if (!sub) return fail(reply, 400, 'INVALID_PARAMS', 'push_endpoint', lang(o));
    const existing = await store.listPushSubscriptions(o.id);
    if (!existing.some((s) => s.endpoint === sub.endpoint) && existing.length >= MAX_PUSH_SUBSCRIPTIONS) return fail(reply, 409, 'CONFLICT', 'push_limit', lang(o), { max: MAX_PUSH_SUBSCRIPTIONS });
    await store.savePushSubscription({ id: `p${randomBytes(12).toString('base64url')}`, ownerId: o.id, ...sub });
    return { ok: true };
  });

  app.delete('/push/subscribe', async (req, reply) => {
    const o = await owner(req, reply);
    if (!o) return reply;
    if (!config.vapid) return pushOff(reply, o);
    const body = unsubscribeBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(invalidParams(render, lang(o), body.error.issues));
    let endpoint = body.data.endpoint;
    try {
      endpoint = new URL(endpoint).toString();
    } catch {
      // Not a URL: nothing stored can match it.
    }
    await store.deletePushSubscription(endpoint, o.id);
    return { ok: true };
  });
}
