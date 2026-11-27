import { randomBytes } from 'node:crypto';
import { LAYERS, OPTIONS_TTL_MS } from '@ajwf/appearance';
import type { AgentState } from '@ajwf/engine';
import { languageTagSchema } from '@ajwf/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { bearerKeyHash } from '../auth';
import { reputationOf } from '../civic/profile';
import { compactVillage } from '../civic/village-read';
import { errorBody, invalidParams, sendRateLimited } from '../http-errors';
import type { Renderer } from '../render';

const langQuery = z.object({ lang: languageTagSchema.optional().catch(undefined) });
const nameParams = z.object({ name: z.string().min(1).max(80) });

/** What anyone may know about an agent, rendered in `lang`. Nothing private (gold, inventory, owner note). */
export function publicProfile(render: Renderer, a: AgentState, lang: string) {
  return {
    name: a.name,
    class: a.cls,
    lvl: a.level,
    ...(a.title ? { title: render.name(lang, 'title', a.title) } : {}),
    look: render.look(a.appearance, a.lookHash, lang),
    sprite: `/sprites/${a.lookHash}.png`,
    ...(a.bio ? { bio: { untrusted_text: a.bio } } : {}),
    claimed: a.claimed,
    bot: a.bot,
    achievements: Object.keys(a.achievements),
  };
}

/** Unauthenticated read-only routes (CORS open, no credentials). */
export function publicRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { game, render } = ctx;
  const cors = { config: { cors: true } };

  app.get('/help', cors, async () => ctx.help);

  app.get('/appearance/options', cors, async (req, reply) => {
    const now = game.now();
    const limit = ctx.limiters.options.take(req.ip, now);
    if (!limit.ok) return sendRateLimited(reply, render, 'en', limit.retryAfterSec);
    const lang = render.lang(langQuery.parse(req.query ?? {}).lang);
    const issued = ctx.options.issue(now, randomBytes(18).toString('base64url'));
    const options: Record<string, Record<string, string>> = {};
    const fields: Record<string, string> = {};
    for (const layer of LAYERS) {
      options[layer] = Object.fromEntries(issued.options[layer].map((id) => [id, render.i18n.maybe(lang, `appearance.${layer}.${id}`) ?? id]));
      fields[layer] = render.t(lang, `api.appearance.fields.${layer}`);
    }
    return { ok: true, options_token: issued.token, expires_in: Math.round(OPTIONS_TTL_MS / 1000), options, fields, how: render.t(lang, 'api.appearance.instructions') };
  });

  app.get('/village', cors, async (req) => {
    const now = game.now();
    // Public, but a valid key (optional) picks the agent's language for the gazette headline; `?lang=` otherwise.
    const a = req.headers.authorization ? game.agentByKeyHash(bearerKeyHash(req.headers.authorization) ?? '') : undefined;
    const lang = render.lang(a?.lang ?? langQuery.parse(req.query ?? {}).lang);
    const h = ctx.chronicle.todayEdition(now).headline;
    return compactVillage(game.state, now, { population: ctx.census.counts(now).population, online: ctx.census.online(now), headline: render.t(lang, h.k, h.p) });
  });

  app.get('/agents/:name', cors, async (req) => {
    const lang = render.lang(langQuery.parse(req.query ?? {}).lang);
    const params = nameParams.safeParse(req.params);
    if (!params.success) return invalidParams(render, lang, params.error.issues);
    const { name } = params.data;
    const a = game.agentByName(name);
    if (!a) return errorBody(render.apiError(lang, 'NOT_FOUND', 'agent_not_found', { name }));
    const rep = reputationOf(game.state, a, game.now());
    return { ok: true, agent: { ...publicProfile(render, a, lang), ...(rep ? { reputation: rep } : {}) } };
  });
}
