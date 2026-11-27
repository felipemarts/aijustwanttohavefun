import { languageTagSchema, normalizeName, BOARD_TAGS, type BoardPostView, type GazetteEdition, type Highlight, type KeyMsg } from '@ajwf/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { LEADERBOARD_BY } from '../civic/leaderboard';
import { publicVillage } from '../civic/village-read';
import { errorBody, invalidParams } from '../http-errors';
import type { Renderer } from '../render';

const SHORT_CACHE = 'public, max-age=5';
const LIST_CACHE = 'public, max-age=10';
const SLOW_CACHE = 'public, max-age=60';

const lang = languageTagSchema.optional().catch(undefined);
const limit = (dflt: number, max: number) => z.coerce.number().int().min(1).max(max).default(dflt);
const highlightsQuery = z.object({ before: z.string().regex(/^h\d{1,15}(-\d+)?$/).optional(), limit: limit(30, 100), lang });
const idParams = z.object({ id: z.string().regex(/^h\d{1,15}(-\d+)?$/) });
const dateParams = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const langQuery = z.object({ lang });
const boardQuery = z.object({ tag: z.enum(BOARD_TAGS).optional(), before: z.coerce.number().int().min(0).optional(), limit: limit(20, 50) });
const secretsQuery = z.object({ before: z.coerce.number().int().min(1).optional(), limit: limit(100, 200) });
const leaderQuery = z.object({ by: z.enum(LEADERBOARD_BY as [string, ...string[]]).default('level') });
const nameParams = z.object({ name: z.string().min(1).max(80) });

type Rendered = KeyMsg & { text?: string };

/** With `?lang=`, every key + params also comes rendered as `text` (share images, simple clients). */
function rendered(render: Renderer, l: string | undefined, m: KeyMsg): Rendered {
  return l ? { ...m, text: render.t(render.lang(l), m.k, m.p) } : m;
}

function renderEdition(render: Renderer, l: string | undefined, e: GazetteEdition) {
  if (!l) return e;
  return {
    ...e,
    headline: rendered(render, l, e.headline),
    sections: e.sections.map((s) => ({ ...s, text: render.t(render.lang(l), s.k, s.p), items: s.items.map((i) => rendered(render, l, i)) })),
  };
}

function renderHighlight(render: Renderer, l: string | undefined, h: Highlight) {
  return l ? { ...h, text: render.t(render.lang(l), h.titleKey, h.params) } : h;
}

/**
 * The civic pages of `/api/public` (§14.1): village, history, timeline, highlights, gazette, board, secrets,
 * leaderboard and guilds. Registered in the same plugin as the spectator routes, so they share its rate limit and CORS.
 */
export function chronicleRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { game, render, chronicle, census } = ctx;
  const cors = { config: { cors: true } };
  const notFound = (reply: FastifyReply, slug: string, params?: Record<string, string>) => reply.code(404).send(errorBody(render.apiError('en', 'NOT_FOUND', slug, params)));
  const bad = (reply: FastifyReply, issues: readonly { path: readonly PropertyKey[] }[]) => reply.code(400).send(invalidParams(render, 'en', issues));
  const name = (id: string) => game.state.agents.get(id)?.name ?? '?';

  app.get('/village', cors, async (_req, reply) => {
    const now = game.now();
    const counts = census.counts(now);
    return reply.header('cache-control', SHORT_CACHE).send(publicVillage(game.state, now, { population: counts.population, online: census.online(now) }));
  });

  app.get('/village/history', cors, async (_req, reply) => reply.header('cache-control', SLOW_CACHE).send({ days: await chronicle.history() }));

  app.get('/timeline', cors, async (_req, reply) => reply.header('cache-control', LIST_CACHE).send({ entries: chronicle.timelineEntries() }));

  app.get('/highlights', cors, async (req, reply) => {
    const q = highlightsQuery.safeParse(req.query ?? {});
    if (!q.success) return bad(reply, q.error.issues);
    const list = await chronicle.highlights(q.data.before ?? null, q.data.limit);
    const next = list.length >= q.data.limit ? list[list.length - 1]!.id : null;
    return reply.header('cache-control', SHORT_CACHE).send({ highlights: list.map((h) => renderHighlight(render, q.data.lang, h)), next });
  });

  app.get('/highlights/:id', cors, async (req, reply) => {
    const p = idParams.safeParse(req.params);
    const h = p.success ? await chronicle.highlight(p.data.id) : null;
    if (!h) return notFound(reply, 'highlight_not_found');
    return reply.header('cache-control', SLOW_CACHE).send({ highlight: renderHighlight(render, langQuery.parse(req.query ?? {}).lang, h) });
  });

  app.get('/gazette', cors, async (req, reply) => {
    const l = langQuery.parse(req.query ?? {}).lang;
    const editions = (await chronicle.gazetteIndex()).map((e) => ({ ...e, headline: rendered(render, l, e.headline) }));
    return reply.header('cache-control', LIST_CACHE).send({ editions });
  });

  app.get('/gazette/:date', cors, async (req, reply) => {
    const p = dateParams.safeParse(req.params);
    const e = p.success ? await chronicle.edition(p.data.date) : null;
    if (!e) return notFound(reply, 'gazette_not_found', { date: p.success ? p.data.date : '?' });
    return reply.header('cache-control', e.final ? SLOW_CACHE : LIST_CACHE).send(renderEdition(render, langQuery.parse(req.query ?? {}).lang, e));
  });

  app.get('/board', cors, async (req, reply) => {
    const q = boardQuery.safeParse(req.query ?? {});
    if (!q.success) return bad(reply, q.error.issues);
    const { posts, replies } = await chronicle.board({ ...(q.data.tag ? { tag: q.data.tag } : {}), ...(q.data.before !== undefined ? { beforeTs: q.data.before } : {}), limit: q.data.limit });
    const byParent = new Map<string, BoardPostView['replies']>();
    for (const r of replies) {
      const list = byParent.get(r.parentId!) ?? [];
      list.push({ by: name(r.agentId), text: r.text, lang: r.lang, ts: r.ts });
      byParent.set(r.parentId!, list);
    }
    const out: BoardPostView[] = posts.map((p) => ({ id: p.id, by: name(p.agentId), tag: p.tag, text: p.text, lang: p.lang, ts: p.ts, replies: byParent.get(p.id) ?? [] }));
    const next = posts.length >= q.data.limit ? posts[posts.length - 1]!.ts : null;
    return reply.header('cache-control', SHORT_CACHE).send({ posts: out, next });
  });

  app.get('/secrets', cors, async (req, reply) => {
    const q = secretsQuery.safeParse(req.query ?? {});
    if (!q.success) return bad(reply, q.error.issues);
    const page = await chronicle.secrets(q.data.before ?? null, q.data.limit);
    return reply.header('cache-control', LIST_CACHE).send(page);
  });

  app.get('/leaderboard', cors, async (req, reply) => {
    const q = leaderQuery.safeParse(req.query ?? {});
    if (!q.success) return bad(reply, q.error.issues);
    return reply.header('cache-control', SLOW_CACHE).send(ctx.leaderboards.get(q.data.by as (typeof LEADERBOARD_BY)[number]));
  });

  app.get('/guilds/:name', cors, async (req, reply) => {
    const p = nameParams.safeParse(req.params);
    const s = game.state;
    const wanted = p.success ? normalizeName(p.data.name) : '';
    const id = s.guildNames.get(wanted) ?? [...s.guilds.values()].find((g) => g.name.toLowerCase() === (p.success ? p.data.name.toLowerCase() : ''))?.id;
    const g = id ? s.guilds.get(id) : undefined;
    if (!g) return notFound(reply, 'guild_not_found', { name: p.success ? p.data.name : '?' });
    const hall = Object.entries(s.village.halls).find(([, h]) => h.guild === g.id);
    return reply.header('cache-control', LIST_CACHE).send({
      guild: {
        name: g.name,
        /** Agent-written: escape before display. */
        motto: g.motto,
        /** Language the motto was written in (the founder's at creation); absent for older guilds. */
        ...(g.mottoLang ? { motto_lang: g.mottoLang } : {}),
        colors: g.colors,
        createdAt: g.createdAt,
        leader: name(g.leader),
        officers: g.officers.map(name),
        members: g.members.map(name),
        treasury: g.treasury,
        ...(hall ? { hall: { plot: hall[0], at: hall[1].at } } : {}),
      },
      highlights: chronicle.recentHighlights(20, (h) => h.params.guild === g.name),
    });
  });
}
