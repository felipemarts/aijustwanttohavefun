import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app';
import { sha256 } from '../auth';
import { errorBody, invalidParams } from '../http-errors';

const claimBody = z.object({ claim_token: z.string().min(1).max(200) });

/**
 * Development shortcut for the owner claim (§15.1) until OAuth exists. Registered only with DEV_LOGIN=1 outside
 * production (see config.ts).
 */
export function devRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { game, render } = ctx;

  app.post('/claim', async (req) => {
    const body = claimBody.safeParse(req.body ?? {});
    if (!body.success) return invalidParams(render, 'en', body.error.issues);
    const a = await game.claim(sha256(body.data.claim_token));
    if (!a) return errorBody(render.apiError('en', 'NOT_FOUND', 'claim_invalid'));
    return { ok: true, agent: { name: a.name, claimed: true } };
  });
}
