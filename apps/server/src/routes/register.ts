import { ensureUnique, randomAppearance, validateChoice, type Appearance } from '@ajwf/appearance';
import { nameAvailable } from '@ajwf/engine';
import { registerSchema, type RegisterRequest } from '@ajwf/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { isAdminToken, newApiKey, newClaimToken } from '../auth';
import { errorBody, invalidParams, sendRateLimited, type ErrorBody } from '../http-errors';
import type { Renderer } from '../render';

/** Fields only an admin token holder may set (scripted bots, test agents). Ignored for everyone else. */
const adminFields = z.object({ bot: z.boolean().optional(), claimed: z.boolean().optional() });

type Choice = { ok: true; appearance: Appearance } | { ok: false; body: ErrorBody };

/** `surprise_me` draws from the token's options when one is given; an explicit choice must come from its token's draw. */
function chooseAppearance(ctx: AppContext, render: Renderer, lang: string, body: RegisterRequest): Choice {
  const now = ctx.game.now();
  const draw = body.options_token ? ctx.options.get(body.options_token, now) : null;
  if (body.appearance === 'surprise_me') return { ok: true, appearance: randomAppearance(ctx.game.rng, draw ?? undefined) };
  if (!body.options_token) return { ok: false, body: errorBody(render.apiError(lang, 'INVALID_PARAMS', 'options_required')) };
  if (!draw) return { ok: false, body: errorBody(render.apiError(lang, 'OPTIONS_EXPIRED', 'options_expired')) };
  const valid = validateChoice(body.appearance, draw);
  if (!valid.ok) return { ok: false, body: errorBody(render.apiError(lang, 'INVALID_PARAMS', 'appearance_choice', { layer: valid.layer, value: valid.value })) };
  return { ok: true, appearance: body.appearance };
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { game, render, config } = ctx;

  app.post('/agents/register', async (req, reply) => {
    const admin = isAdminToken(req.headers['x-admin-token'], config.adminToken);
    if (!admin) {
      const limit = ctx.limiters.register.take(req.ip, game.now());
      if (!limit.ok) return sendRateLimited(reply, render, 'en', limit.retryAfterSec);
    }
    const parsed = registerSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalidParams(render, 'en', parsed.error.issues);
    const body = parsed.data;
    const lang = render.lang(body.language);

    const name = nameAvailable(game.state, body.name);
    if (!name.ok) {
      const key = name.code === 'NAME_TAKEN' ? 'err.name_taken' : `err.name_${name.reason}`;
      return errorBody(render.error(lang, { code: name.code, msg: { k: key, p: { name: body.name } }, hint: { k: 'hint.name' } }));
    }
    const choice = chooseAppearance(ctx, render, lang, body);
    if (!choice.ok) return choice.body;
    // From here to game.register nothing awaits, so no other registration can take this look or name meanwhile.
    const unique = ensureUnique(choice.appearance, (h) => game.state.lookHashes.has(h), game.rng);
    const extra = admin ? adminFields.catch({}).parse(req.body) : {};
    const apiKey = newApiKey();
    const claim = newClaimToken();
    const res = await game.register(
      { name: body.name, cls: body.class, lang: body.language, bio: body.bio, appearance: unique.appearance, bot: extra.bot, claimed: extra.claimed },
      { keyHash: apiKey.hash, claimHash: claim.hash },
    );
    if (!res.ok) return reply.code(res.error.code === 'INTERNAL' ? 500 : 200).send(errorBody(render.error(lang, res.error)));
    const a = res.agent;
    return {
      ok: true,
      agent: {
        name: a.name,
        class: a.cls,
        level: a.level,
        language: lang,
        appearance: a.appearance,
        appearance_text: render.look(a.appearance, a.lookHash, lang),
      },
      ...(unique.changed.length ? { appearance_changed: unique.changed } : {}),
      api_key: apiKey.value,
      claim_url: `${config.publicUrl}/claim/${claim.value}`,
      next_steps: render.t(lang, 'api.register.next_steps'),
    };
  });
}
