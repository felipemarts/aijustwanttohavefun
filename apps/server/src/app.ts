import { OptionsTokenStore } from '@ajwf/appearance';
import type { AgentState } from '@ajwf/engine';
import type { I18n } from '@ajwf/i18n';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import type { Logger } from 'pino';
import { bearerKeyHash, isAdminToken } from './auth';
import type { Census } from './census';
import type { Chronicle } from './civic/chronicle';
import { Leaderboards } from './civic/leaderboard';
import type { Config } from './config';
import type { Game } from './game';
import { buildHelp } from './help';
import { classifyHttpError, errorBody, sendRateLimited } from './http-errors';
import { IdempotencyCache } from './idempotency';
import type { Metrics } from './metrics';
import { createLimiters, type Limiters } from './rate-limit';
import { Renderer } from './render';
import { agentRoutes } from './routes/agent';
import { chronicleRoutes } from './routes/chronicle';
import { devRoutes } from './routes/dev';
import { fileRoutes } from './routes/files';
import { metricsRoutes } from './routes/metrics';
import { publicRoutes } from './routes/public';
import { registerRoutes } from './routes/register';
import { spectatorRoutes } from './routes/spectator';
import type { Broadcaster } from './spectate/broadcaster';
import { attachSpectatorSocket } from './spectate/socket';
import { SpriteService } from './sprites';
import { AgentViews } from './views';

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated agent, on routes that require an API key. */
    agent: AgentState | null;
  }
  interface FastifyContextConfig {
    /** Public read-only GET route: any origin may read it, without credentials. */
    cors?: boolean;
  }
}

export const BODY_LIMIT = 16 * 1024;

export type AppDeps = {
  game: Game;
  config: Config;
  i18n: I18n;
  logger: Logger;
  spritesDir: string;
  docsDir: string;
  spectators: Broadcaster;
  metrics: Metrics;
  census: Census;
  chronicle: Chronicle;
};

const ACT_ROUTE = '/api/v1/act';
const REGISTER_ROUTE = '/api/v1/agents/register';
/** Every API error body starts like this, so error codes can be counted without parsing the JSON. */
const ERROR_PREFIX = '{"ok":false,"error":{"code":"';

/** Shared services handed to every route module. */
export type AppContext = {
  game: Game;
  config: Config;
  render: Renderer;
  limiters: Limiters;
  idem: IdempotencyCache;
  views: AgentViews;
  sprites: SpriteService;
  options: OptionsTokenStore;
  /** Population, presence and online counts. */
  census: Census;
  spectators: Broadcaster;
  metrics: Metrics;
  /** Highlights, gazette, secrets, timeline, board and journal reads. */
  chronicle: Chronicle;
  leaderboards: Leaderboards;
  help: Record<string, unknown>;
  docsDir: string;
  /** Language of the error texts for this request: the agent's when known, English otherwise. */
  lang(req: FastifyRequest): string;
  /** Per-IP limit for everything not authenticated by a valid key. Returns false after answering 429. */
  limitAnonymous(req: FastifyRequest, reply: FastifyReply): boolean;
};

export function buildApp(deps: AppDeps): FastifyInstance {
  const { game, config } = deps;
  // The default logger type keeps route modules independent of pino's generic parameters.
  const app: FastifyInstance = Fastify<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, FastifyBaseLogger>({
    loggerInstance: deps.logger,
    bodyLimit: BODY_LIMIT,
    trustProxy: config.trustProxy,
  });

  const render = new Renderer(deps.i18n, game.state);
  const limiters = createLimiters();
  const sprites = new SpriteService(game.state, deps.spritesDir, deps.logger);
  game.subscribe(sprites);

  const ctx: AppContext = {
    game,
    config,
    render,
    limiters,
    idem: new IdempotencyCache(),
    views: new AgentViews(game.state),
    sprites,
    options: new OptionsTokenStore(config.worldSeed ^ 0x5eed),
    census: deps.census,
    spectators: deps.spectators,
    metrics: deps.metrics,
    chronicle: deps.chronicle,
    leaderboards: new Leaderboards(game.state, game.now),
    help: buildHelp(),
    docsDir: deps.docsDir,
    lang: (req) => render.lang(req.agent?.lang),
    limitAnonymous(req, reply) {
      const t = limiters.anonymous.take(req.ip, game.now());
      if (t.ok) return true;
      sendRateLimited(reply, render, 'en', t.retryAfterSec);
      return false;
    },
  };

  app.decorateRequest('agent', null);
  // Only JSON bodies are accepted; any other content type is answered with 415.
  app.removeContentTypeParser('text/plain');

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    if (req.routeOptions.config.cors && req.method === 'GET') reply.header('access-control-allow-origin', '*');
    if (typeof payload === 'string' && payload.startsWith(ERROR_PREFIX)) {
      const end = payload.indexOf('"', ERROR_PREFIX.length);
      if (end > 0 && end - ERROR_PREFIX.length <= 40) deps.metrics.error(payload.slice(ERROR_PREFIX.length, end));
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.routeOptions.url !== ACT_ROUTE || req.method !== 'POST') return;
    deps.metrics.actions.add(game.now());
    deps.metrics.actLatency.observe(reply.elapsedTime / 1000);
  });

  app.setErrorHandler((err: { statusCode?: number }, req, reply) => {
    const c = classifyHttpError(err.statusCode);
    if (c.status >= 500) req.log.error({ err }, 'request failed');
    return reply.code(c.status).send(errorBody(render.apiError(ctx.lang(req), c.code, c.slug)));
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send(errorBody(render.apiError('en', 'NOT_FOUND', 'not_found'))));

  const anonymous = async (req: FastifyRequest, reply: FastifyReply) => {
    // Bulk registration of test bots: a valid admin token (constant-time check) skips the per-IP limit on this one
    // route. A wrong or missing token gets no exemption.
    const adminRegister = req.method === 'POST' && req.routeOptions.url === REGISTER_ROUTE && isAdminToken(req.headers['x-admin-token'], config.adminToken);
    if (adminRegister) return;
    if (!ctx.limitAnonymous(req, reply)) return reply;
  };

  app.register(
    async (api) => {
      api.register(async (pub) => {
        pub.addHook('onRequest', anonymous);
        publicRoutes(pub, ctx);
        registerRoutes(pub, ctx);
      });
      api.register(async (authed) => {
        authed.addHook('onRequest', async (req, reply) => {
          const a = game.agentByKeyHash(bearerKeyHash(req.headers.authorization) ?? '');
          if (!a) {
            if (!ctx.limitAnonymous(req, reply)) return reply;
            return reply.code(401).send(errorBody(render.apiError('en', 'UNAUTHORIZED', 'unauthorized')));
          }
          req.agent = a;
          const now = game.now();
          ctx.census.seen(a.id, now);
          ctx.spectators.markActive(a.id, now);
          const t = limiters.agent.take(a.id, now);
          if (!t.ok) return sendRateLimited(reply, render, ctx.lang(req), t.retryAfterSec);
        });
        agentRoutes(authed, ctx);
      });
    },
    { prefix: '/api/v1' },
  );
  if (config.devLogin) {
    app.register(
      async (dev) => {
        dev.addHook('onRequest', anonymous);
        devRoutes(dev, ctx);
      },
      { prefix: '/api/dev' },
    );
  }
  app.register(
    async (pub) => {
      spectatorRoutes(pub, ctx);
      chronicleRoutes(pub, ctx);
    },
    { prefix: '/api/public' },
  );
  app.register(async (ops) => metricsRoutes(ops, ctx));
  attachSpectatorSocket(app.server, { broadcaster: deps.spectators, config, metrics: deps.metrics, log: deps.logger });
  app.register(async (files) => {
    files.addHook('onRequest', async (req, reply) => {
      const t = limiters.files.take(req.ip, game.now());
      if (!t.ok) return sendRateLimited(reply, render, 'en', t.retryAfterSec);
    });
    fileRoutes(files, ctx);
  });
  return app;
}
