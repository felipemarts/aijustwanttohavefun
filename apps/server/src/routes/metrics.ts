import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app';
import { isAdminToken } from '../auth';
import { errorBody } from '../http-errors';

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

/**
 * `GET /metrics` (Prometheus text format). With `ADMIN_TOKEN` set, the token is required (`Authorization: Bearer`
 * or `X-Admin-Token`); without one it is open only outside production, and absent in production.
 */
export function metricsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, render } = ctx;
  app.get('/metrics', async (req, reply) => {
    if (config.adminToken) {
      const bearer = BEARER_RE.exec(req.headers.authorization ?? '')?.[1];
      if (!isAdminToken(bearer ?? req.headers['x-admin-token'], config.adminToken)) {
        if (!ctx.limitAnonymous(req, reply)) return reply;
        return reply.code(401).send(errorBody(render.apiError('en', 'UNAUTHORIZED', 'forbidden')));
      }
    } else if (config.production) {
      return reply.code(404).send(errorBody(render.apiError('en', 'NOT_FOUND', 'not_found')));
    }
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(ctx.metrics.render());
  });
}
