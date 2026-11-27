import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { normalizeName } from '@ajwf/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../app';
import { dayKey } from '../chronicle/stats';
import { errorBody, sendRateLimited } from '../http-errors';
import type { Card } from '../og/service';
import { Shell, type PageMeta } from '../web/shell';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const HIGHLIGHT_RE = /^(h\d{1,15}(?:-\d+)?)\.png$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.png$/;
const PNG_NAME_RE = /^(.{1,80})\.png$/su;
/** A path that may be a claim link, in any spelling a router could accept. */
const CLAIM_PATH_RE = /^\/+claim(?:[/?#;]|$)/i;

/** Paths that are never pages of the web app. */
export function isApiPath(url: string): boolean {
  return /^\/(api|og|sprites|ws|healthz|metrics)(\/|$|\?)/.test(url) || /^\/(skill[^/]*\.md|heartbeat\.md)/.test(url);
}

/**
 * Page routes for crawlers and the built web app (§14.2): every shareable page answers HTML with its title,
 * description and Open Graph / Twitter tags, and `/og/*` composes the share cards they point to. In production the
 * built app (`apps/web/dist`) is served too: hashed assets cached forever, `index.html` never.
 */
export async function webRoutes(app: FastifyInstance, ctx: AppContext): Promise<{ fallback: (req: FastifyRequest, reply: FastifyReply) => FastifyReply }> {
  const { game, render, config, chronicle, cards } = ctx;
  const shell = new Shell(config.webDist ? readFileSync(join(config.webDist, 'index.html'), 'utf8') : null);
  const site = render.t('en', 'owner.card.game_name');

  if (config.webDist) {
    const assets = join(config.webDist, 'assets');
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      // One route per built file (no catch-all), so page routes and the API keep their own handlers.
      wildcard: false,
      index: false,
      globIgnore: ['index.html'],
      cacheControl: false,
      setHeaders: (reply, path) => {
        // Vite names assets by content hash: they never change. The service worker is checked on every visit, so a
        // fixed one reaches browsers at once.
        reply.header('cache-control', path.startsWith(assets) ? IMMUTABLE : /[\\/]sw\.js$/.test(path) ? 'no-cache' : 'public, max-age=3600');
      },
    });
  }

  /** `?lang=`, else the first Accept-Language tag, resolved to a launch language. */
  const langOf = (req: FastifyRequest) => {
    const q = (req.query as { lang?: unknown }).lang;
    if (typeof q === 'string' && q.length <= 35) return render.lang(q);
    return render.lang(String(req.headers['accept-language'] ?? '').split(',')[0]?.split(';')[0]?.trim());
  };
  const abs = (path: string) => `${config.publicUrl}${path}`;
  const enc = encodeURIComponent;
  const defaultImage = (lang: string) => abs(`/og/gazette/${dayKey(game.now())}.png?lang=${enc(lang)}`);

  function page(reply: FastifyReply, status: number, m: Omit<PageMeta, 'siteName'>) {
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('vary', 'accept-language')
      .send(shell.render({ ...m, siteName: site }));
  }

  function home(req: FastifyRequest, reply: FastifyReply, status = 200) {
    const lang = langOf(req);
    const path = req.url.split('?')[0] ?? '/';
    return page(reply, status, { lang, title: render.t(lang, 'owner.page.home_title'), description: render.t(lang, 'owner.page.home_description'), image: defaultImage(lang), url: abs(path) });
  }

  app.get('/', async (req, reply) => home(req, reply));

  app.get('/a/:name', async (req, reply) => {
    const lang = langOf(req);
    const { name } = req.params as { name: string };
    const a = name.length <= 80 ? game.agentByName(name) : undefined;
    if (!a) return home(req, reply, 404);
    const spec = cards.agentSpec(a, lang);
    const p = { name: a.name, level: a.level, class: `@class:${a.cls}` };
    const base = render.t(lang, 'owner.page.agent_description', { ...p, achievements: Object.keys(a.achievements).length, friends: a.friends.length });
    return page(reply, 200, {
      lang,
      title: render.t(lang, 'owner.page.agent_title', p),
      // The bio is agent-written: it is escaped like everything else by the shell.
      description: a.bio ? `${base} “${a.bio}”` : base,
      image: abs(`/og/agent/${enc(a.name)}.png?lang=${enc(lang)}&v=${cards.version(spec)}`),
      url: abs(`/a/${enc(a.name)}`),
    });
  });

  app.get('/h/:id', async (req, reply) => {
    const lang = langOf(req);
    const { id } = req.params as { id: string };
    const h = /^h\d{1,15}(-\d+)?$/.test(id) ? await chronicle.highlight(id) : null;
    if (!h) return home(req, reply, 404);
    const spec = cards.highlightSpec(h, lang);
    return page(reply, 200, {
      lang,
      title: render.t(lang, h.titleKey, h.params),
      description: render.t(lang, 'owner.page.highlight_description'),
      image: abs(`/og/highlight/${h.id}.png?lang=${enc(lang)}&v=${cards.version(spec)}`),
      url: abs(`/h/${h.id}`),
    });
  });

  app.get('/gazette/:date', async (req, reply) => {
    const lang = langOf(req);
    const { date } = req.params as { date: string };
    const g = /^\d{4}-\d{2}-\d{2}$/.test(date) ? await cards.gazetteSpec(date, lang) : null;
    if (!g || g.spec.data.kind !== 'gazette') return home(req, reply, 404);
    return page(reply, 200, {
      lang,
      title: render.t(lang, 'owner.page.gazette_title', { date: g.spec.data.date }),
      description: g.spec.data.headline,
      image: abs(`/og/gazette/${date}.png?lang=${enc(lang)}&v=${cards.version(g.spec)}`),
      url: abs(`/gazette/${date}`),
    });
  });

  app.get('/g/:name', async (req, reply) => {
    const lang = langOf(req);
    const { name } = req.params as { name: string };
    const s = game.state;
    const id = name.length <= 80 ? (s.guildNames.get(normalizeName(name)) ?? [...s.guilds.values()].find((g) => g.name.toLowerCase() === name.toLowerCase())?.id) : undefined;
    const g = id ? s.guilds.get(id) : undefined;
    if (!g) return home(req, reply, 404);
    const base = render.t(lang, 'owner.page.guild_description', { guild: g.name, n: g.members.length });
    return page(reply, 200, {
      lang,
      title: render.t(lang, 'owner.page.guild_title', { guild: g.name }),
      // The motto is agent-written: escaped by the shell.
      description: g.motto ? `${base} “${g.motto}”` : base,
      image: defaultImage(lang),
      url: abs(`/g/${enc(g.name)}`),
    });
  });

  /** The claim page: never indexed, never sends its URL (which holds the token) as a referrer. */
  function claimPage(req: FastifyRequest, reply: FastifyReply) {
    const lang = langOf(req);
    reply.header('referrer-policy', 'no-referrer');
    return page(reply, 200, {
      lang,
      title: render.t(lang, 'owner.page.claim_title'),
      description: render.t(lang, 'owner.page.claim_description'),
      image: defaultImage(lang),
      url: abs('/'),
      noindex: true,
    });
  }
  app.get('/claim/:token', async (req, reply) => claimPage(req, reply));

  // ── share cards ─────────────────────────────────────────────────────────────────────────────────────────

  const ogLimit = {
    onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
      const t = ctx.limiters.og.take(req.ip, game.now());
      if (!t.ok) return sendRateLimited(reply, render, 'en', t.retryAfterSec);
    },
  };
  const notFound = (reply: FastifyReply) => reply.code(404).send(errorBody(render.apiError('en', 'NOT_FOUND', 'not_found')));

  function sendCard(req: FastifyRequest, reply: FastifyReply, card: Card, cache: string) {
    const etag = `"${card.hash}"`;
    const v = (req.query as { v?: unknown }).v;
    reply.type('image/png').header('etag', etag).header('cache-control', v === card.hash ? IMMUTABLE : cache).header('vary', 'accept-language');
    const match = req.headers['if-none-match'];
    if (typeof match === 'string' && match.split(',').some((t) => t.trim() === etag)) return reply.code(304).send();
    return reply.send(card.png);
  }

  app.get('/og/agent/:file', { ...ogLimit, config: { cors: true } }, async (req, reply) => {
    const m = PNG_NAME_RE.exec((req.params as { file: string }).file);
    const a = m ? game.agentByName(m[1]!) : undefined;
    if (!a) return notFound(reply);
    return sendCard(req, reply, await cards.png(cards.agentSpec(a, langOf(req))), 'public, max-age=3600');
  });

  app.get('/og/highlight/:file', { ...ogLimit, config: { cors: true } }, async (req, reply) => {
    const m = HIGHLIGHT_RE.exec((req.params as { file: string }).file);
    const h = m ? await chronicle.highlight(m[1]!) : null;
    if (!h) return notFound(reply);
    return sendCard(req, reply, await cards.png(cards.highlightSpec(h, langOf(req))), 'public, max-age=86400');
  });

  app.get('/og/gazette/:file', { ...ogLimit, config: { cors: true } }, async (req, reply) => {
    const m = DATE_RE.exec((req.params as { file: string }).file);
    const g = m ? await cards.gazetteSpec(m[1]!, langOf(req)) : null;
    if (!g) return notFound(reply);
    return sendCard(req, reply, await cards.png(g.spec), g.final ? 'public, max-age=86400' : 'public, max-age=600');
  });

  /**
   * Any other page of the web app (`/village`, `/owner`...): the app shell with the site's default tags. Claim links
   * the route above misses (`/claim/<token>/`, `/Claim/<token>`: the client router still opens them as the claim
   * page) get the claim page's protections, so their token never lands in `og:url` or the canonical link.
   */
  return { fallback: (req, reply) => (CLAIM_PATH_RE.test(req.url) ? claimPage(req, reply) : home(req, reply)) };
}
