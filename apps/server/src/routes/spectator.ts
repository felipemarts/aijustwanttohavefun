import { createHash } from 'node:crypto';
import { languageTagSchema, type I18nBundle, type PublicStats } from '@ajwf/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { errorBody, sendRateLimited } from '../http-errors';
import { agentXp, dayInfo } from '../spectate/views';
import { profileExtras } from '../civic/profile';
import { publicProfile } from './public';

const LIVE_CACHE = 'public, max-age=2';
const PROFILE_CACHE = 'public, max-age=10';
const STATS_CACHE = 'public, max-age=10';
const I18N_CACHE = 'public, max-age=300';

/** Catalog keys the spectator client renders: interface, event lines, directions, appearance, content names. */
const I18N_PREFIXES = ['ui.', 'ev.', 'dir.', 'appearance.', 'gazette.', 'highlight.'];

/**
 * True for the content keys spectators need: every `.name`, room descriptions, and the emote lines that emote
 * events use as their key (`content.emote.<id>.solo|at`).
 */
function spectatorContentKey(key: string): boolean {
  if (!key.startsWith('content.')) return false;
  if (key.endsWith('.name')) return true;
  if (key.startsWith('content.room.') && key.endsWith('.desc')) return true;
  return key.startsWith('content.emote.');
}

const langParams = z.object({ lang: languageTagSchema });
const roomParams = z.object({ id: z.string().min(1).max(80) });
const nameParams = z.object({ name: z.string().min(1).max(80) });
const langQuery = z.object({ lang: languageTagSchema.optional().catch(undefined) });

/**
 * `/api/public`: read-only state for spectators (§14.1), the same shapes the WebSocket sends. No authentication,
 * any origin may read, per-IP rate limit; nothing private is reachable from here.
 */
export function spectatorRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { game, render, spectators, census } = ctx;
  const cors = { config: { cors: true } };
  const notFound = (reply: FastifyReply, slug: string, params?: Record<string, string>) =>
    reply.code(404).send(errorBody(render.apiError('en', 'NOT_FOUND', slug, params)));

  app.addHook('onRequest', async (req, reply) => {
    const t = ctx.limiters.publicRead.take(req.clientIp, game.now());
    if (!t.ok) return sendRateLimited(reply, render, 'en', t.retryAfterSec);
  });

  app.get('/world', cors, async (_req, reply) => reply.header('cache-control', LIVE_CACHE).send(spectators.worldFull()));

  app.get('/rooms/:id', cors, async (req, reply) => {
    const p = roomParams.safeParse(req.params);
    const room = p.success ? spectators.roomFull(p.data.id) : null;
    if (!room) return notFound(reply, 'room_not_found', { room: p.success ? p.data.id : '?' });
    return reply.header('cache-control', LIVE_CACHE).send(room);
  });

  app.get('/agents/:name', cors, async (req, reply) => {
    const lang = render.lang(langQuery.parse(req.query ?? {}).lang);
    const p = nameParams.safeParse(req.params);
    const a = p.success ? game.agentByName(p.data.name) : undefined;
    if (!a) return notFound(reply, 'agent_not_found', { name: p.success ? p.data.name : '?' });
    const profile = publicProfile(render, a, lang);
    const extras = await profileExtras(game.state, ctx.chronicle, a, game.now());
    // `title` is the id here, as everywhere in /api/public (AgentCard); `title_text` is its name in `lang`.
    // `xp` is [into this level, needed for the next]; `bio_lang` is the language the bio was written in.
    const agent = {
      ...profile,
      title: a.title,
      ...(profile.title ? { title_text: profile.title } : {}),
      profession: a.profession,
      xp: agentXp(a),
      ...(profile.bio ? { bio_lang: a.lang } : {}),
      room: a.room,
      sprite_hash: a.lookHash,
      ...extras,
    };
    return reply.header('cache-control', PROFILE_CACHE).send({ ok: true, agent });
  });

  app.get('/stats', cors, async (_req, reply) => {
    const now = game.now();
    const counts = census.counts(now);
    const stats: PublicStats = { now, population: counts.population, online: census.online(now), byClass: counts.byClass, day: dayInfo(now), spectators: spectators.connections };
    return reply.header('cache-control', STATS_CACHE).send(stats);
  });

  /** Built once per language: the catalogs only change with a deploy. */
  const bundles = new Map<string, { json: string; etag: string }>();
  app.get('/i18n/:lang', cors, async (req, reply) => {
    const p = langParams.safeParse(req.params);
    const lang = render.lang(p.success ? p.data.lang : undefined);
    let b = bundles.get(lang);
    if (!b) {
      const messages: Record<string, string> = {};
      for (const [k, v] of Object.entries(render.i18n.mergedCatalog(lang))) {
        if (I18N_PREFIXES.some((x) => k.startsWith(x)) || spectatorContentKey(k)) messages[k] = v;
      }
      const body: I18nBundle = { lang, messages };
      const json = JSON.stringify(body);
      b = { json, etag: `"${createHash('sha256').update(json).digest('base64url').slice(0, 27)}"` };
      bundles.set(lang, b);
    }
    reply.header('cache-control', I18N_CACHE).header('etag', b.etag).header('vary', 'accept-encoding');
    const match = req.headers['if-none-match'];
    if (typeof match === 'string' && match.split(',').some((t) => t.trim() === b.etag)) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(b.json);
  });
}
