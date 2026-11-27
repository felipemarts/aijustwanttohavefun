import fastifyCookie from '@fastify/cookie';
import { OptionsTokenStore } from '@ajwf/appearance';
import type { AgentState } from '@ajwf/engine';
import type { I18n } from '@ajwf/i18n';
import Fastify, {
  LogController,
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
import { CardService } from './og/service';
import type { FetchLike } from './owner/oauth';
import { Sessions } from './owner/session';
import type { Persistence } from './persistence';
import { createLimiters, type Limiters } from './rate-limit';
import type { Renderer } from './render';
import { adminRoutes, reportRoute } from './routes/admin';
import { agentRoutes } from './routes/agent';
import { chronicleRoutes } from './routes/chronicle';
import { fileRoutes } from './routes/files';
import { mcpRoutes } from './routes/mcp';
import { metricsRoutes } from './routes/metrics';
import { ownerRoutes } from './routes/owner';
import { publicRoutes } from './routes/public';
import { registerRoutes } from './routes/register';
import { spectatorRoutes } from './routes/spectator';
import { isApiPath, webRoutes } from './routes/web';
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
  persistence: Persistence;
  /** Shared renderer (the push notifier uses the same one). */
  render: Renderer;
  /** Share card cache directory. */
  cardsDir: string;
  /** For the OAuth provider calls; tests pass a fake provider. */
  fetch?: FetchLike;
};

const ACT_ROUTE = '/api/v1/act';
const REGISTER_ROUTE = '/api/v1/agents/register';
/** Requests slower than this are logged at warn (the `/act` target is 30 ms at p99). */
const SLOW_REQUEST_MS = 1000;

/**
 * Fastify writes two lines per request ("incoming request", "request completed") at info: about 1,000 lines per
 * second at the §3.4 load. Here a request is one line, at debug unless it failed (error) or was slow (warn).
 */
class RequestLogs extends LogController {
  override incomingRequest(): void {}

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    const ms = reply.elapsedTime;
    const level = error || reply.statusCode >= 500 ? 'error' : ms >= SLOW_REQUEST_MS ? 'warn' : 'debug';
    // Skip building the line when the level is off (the logger is pino's, which knows `isLevelEnabled`).
    if (!(request.log as FastifyBaseLogger & { isLevelEnabled(l: string): boolean }).isLevelEnabled(level)) return;
    request.log[level]({ req: request, res: { statusCode: reply.statusCode }, responseTime: Math.round(ms * 10) / 10, ...(error ? { err: error } : {}) }, 'request completed');
  }

  override routeNotFound(request: FastifyRequest): void {
    request.log.debug({ req: request }, 'route not found');
  }
}
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
  sessions: Sessions;
  cards: CardService;
  fetch: FetchLike;
  /** Writes buffered events to the store (the owner summary reads them from there). */
  flushEvents(): Promise<void>;
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
    logController: new RequestLogs(),
  });

  const render = deps.render;
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
    sessions: new Sessions(game.store, game.now, config.production),
    cards: new CardService(game, render, deps.chronicle, config.publicUrl, deps.cardsDir, deps.logger),
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    flushEvents: () => deps.persistence.flushEvents(),
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

  const security = securityHeaders(config);
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    for (const [k, v] of security) if (!reply.hasHeader(k)) reply.header(k, v);
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

  // Unknown GETs from a browser are pages of the web app (client-side routes): they get the app shell.
  let pageFallback: ((req: FastifyRequest, reply: FastifyReply) => FastifyReply) | null = null;
  app.setNotFoundHandler((req, reply) => {
    const html = (req.method === 'GET' || req.method === 'HEAD') && /text\/html/.test(String(req.headers.accept ?? ''));
    if (html && pageFallback && !isApiPath(req.url)) return pageFallback(req, reply);
    return reply.code(404).send(errorBody(render.apiError('en', 'NOT_FOUND', 'not_found')));
  });

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
  app.register(
    async (owner) => {
      // Cookies only here: the signed one is the OAuth attempt; the session cookie is an opaque random token.
      await owner.register(fastifyCookie, { secret: config.sessionSecret, hook: 'onRequest' });
      ownerRoutes(owner, ctx);
    },
    { prefix: '/api/owner' },
  );
  app.register(async (admin) => adminRoutes(admin, ctx), { prefix: '/api/admin' });
  app.register(
    async (pub) => {
      spectatorRoutes(pub, ctx);
      chronicleRoutes(pub, ctx);
      reportRoute(pub, ctx);
    },
    { prefix: '/api/public' },
  );
  app.register(async (ops) => metricsRoutes(ops, ctx));
  // MCP over Streamable HTTP: tool calls run through the API above in-process (`app.inject`).
  app.register(async (mcp) => mcpRoutes(mcp, ctx, app));
  attachSpectatorSocket(app.server, { broadcaster: deps.spectators, config, metrics: deps.metrics, log: deps.logger });
  app.register(async (files) => {
    files.addHook('onRequest', async (req, reply) => {
      const t = limiters.files.take(req.ip, game.now());
      if (!t.ok) return sendRateLimited(reply, render, 'en', t.retryAfterSec);
    });
    fileRoutes(files, ctx);
  });
  app.register(async (web) => {
    pageFallback = (await webRoutes(web, ctx)).fallback;
  });
  return app;
}

/**
 * Headers for everything the server answers, pages above all (§15.2): a strict Content-Security-Policy (scripts
 * only from the site itself, no inline scripts; images from the site and data URLs; connections to the site and
 * its WebSocket), no framing, a conservative referrer policy and no powerful browser features. HSTS in production.
 */
export function securityHeaders(config: Config): [string, string][] {
  const host = new URL(config.publicUrl).host;
  const ws = config.production ? `wss://${host}` : `ws://${host} wss://${host}`;
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // React and PixiJS set styles through the DOM; inline style attributes are allowed, inline scripts never.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${ws}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  const out: [string, string][] = [
    ['content-security-policy', csp],
    ['referrer-policy', 'strict-origin-when-cross-origin'],
    ['x-frame-options', 'DENY'],
    ['permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'],
    ['cross-origin-opener-policy', 'same-origin'],
  ];
  if (config.production) out.push(['strict-transport-security', 'max-age=31536000; includeSubDomains']);
  return out;
}
