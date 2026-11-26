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
import { bearerKeyHash } from './auth';
import type { Config } from './config';
import type { Game } from './game';
import { buildHelp } from './help';
import { classifyHttpError, errorBody, sendRateLimited } from './http-errors';
import { IdempotencyCache } from './idempotency';
import { createLimiters, type Limiters } from './rate-limit';
import { Renderer } from './render';
import { agentRoutes } from './routes/agent';
import { devRoutes } from './routes/dev';
import { fileRoutes } from './routes/files';
import { publicRoutes } from './routes/public';
import { registerRoutes } from './routes/register';
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

export type AppDeps = { game: Game; config: Config; i18n: I18n; logger: Logger; spritesDir: string; docsDir: string };

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
  /** agent id -> last authenticated request, for the online count. */
  presence: Map<string, number>;
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
    presence: new Map(),
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

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    if (req.routeOptions.config.cors && req.method === 'GET') reply.header('access-control-allow-origin', '*');
  });

  app.setErrorHandler((err: { statusCode?: number }, req, reply) => {
    const c = classifyHttpError(err.statusCode);
    if (c.status >= 500) req.log.error({ err }, 'request failed');
    return reply.code(c.status).send(errorBody(render.apiError(ctx.lang(req), c.code, c.slug)));
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send(errorBody(render.apiError('en', 'NOT_FOUND', 'not_found'))));

  const anonymous = async (req: FastifyRequest, reply: FastifyReply) => {
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
          ctx.presence.set(a.id, now);
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
  app.register(async (files) => {
    files.addHook('onRequest', async (req, reply) => {
      const t = limiters.files.take(req.ip, game.now());
      if (!t.ok) return sendRateLimited(reply, render, 'en', t.retryAfterSec);
    });
    fileRoutes(files, ctx);
  });
  return app;
}
