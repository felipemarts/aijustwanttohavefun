import { createVillageServer, handleStatelessPost, type FetchLike } from '@ajwf/mcp';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../app';
import { bearerKeyHash } from '../auth';

/** Same as the REST API's body limit: tool arguments are small (the longest, a journal entry, is 1,000 characters). */
export const MCP_BODY_LIMIT = 16 * 1024;
const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;
/** Request headers the MCP transport reads. Nothing else (no Authorization, no cookies) reaches it. */
const TRANSPORT_HEADERS = ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'] as const;
const API_PREFIX = '/api/v1/';

/** A JSON-RPC error without an id, as the Streamable HTTP transport answers transport-level failures. */
function rpcError(reply: FastifyReply, status: number, code: number, message: string): FastifyReply {
  return reply.code(status).type('application/json; charset=utf-8').send({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * The agent API as a `fetch` that never leaves the process: each call is a Fastify `inject` into `/api/v1`, from
 * the MCP caller's address, so authentication, rate limits, idempotency and rendering are exactly those of REST.
 * Only the headers the SDK client sets are sent (no forwarded-for, no admin token).
 */
export function inProcessFetch(app: FastifyInstance, ip: string): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    if (!url.pathname.startsWith(API_PREFIX)) throw new Error('in-process fetch is limited to the agent API');
    const res = await app.inject({
      method: init.method === 'POST' ? 'POST' : 'GET',
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers)),
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
      remoteAddress: ip,
    });
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) headers.append(k, String(one));
    }
    return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers });
  };
}

/**
 * Browsers always send `Origin` on cross-origin requests and on POSTs; MCP clients (not browsers) send none. A
 * request with an `Origin` other than the game's own, or one a browser marks as cross-site, is refused (MCP
 * Streamable HTTP: "If the Origin header is present and invalid, servers MUST respond with HTTP 403 Forbidden"),
 * so a web page cannot drive a visitor's MCP session. No CORS headers are ever sent here, so preflights fail too.
 */
export function mcpOriginAllowed(req: FastifyRequest, allowed: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined) return typeof origin === 'string' && allowed.has(origin);
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

/**
 * `/mcp`: the agent API as MCP tools over Streamable HTTP, stateless (PLANEJAMENTO §11.7). The API key comes from
 * the MCP request's `Authorization: Bearer` header and is handed to the in-process API client only.
 */
export function mcpRoutes(app: FastifyInstance, ctx: AppContext, root: FastifyInstance): void {
  const { game, config, limiters } = ctx;
  const publicUrl = new URL(config.publicUrl).origin;
  const origins = new Set([publicUrl, ...config.extraOrigins]);

  // Framework errors (body too large, not JSON, malformed JSON) as JSON-RPC errors.
  app.setErrorHandler((err: { statusCode?: number }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status === 413) return rpcError(reply, 413, -32600, `Request body larger than ${MCP_BODY_LIMIT} bytes`);
    if (status === 415) return rpcError(reply, 415, -32600, 'Unsupported Media Type: Content-Type must be application/json');
    if (status >= 400 && status < 500) return rpcError(reply, 400, -32700, 'Parse error: Invalid JSON');
    req.log.error({ err }, 'mcp request failed');
    return rpcError(reply, 500, -32603, 'Internal error');
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!mcpOriginAllowed(req, origins)) return rpcError(reply, 403, -32000, 'Forbidden: Origin not allowed');
  });

  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) => {
    // Stateless: no standalone SSE stream to open (GET) and no session to end (DELETE).
    reply.header('allow', 'POST');
    return rpcError(reply, 405, -32000, 'Method not allowed: this server is stateless and only accepts POST');
  };
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  app.post('/mcp', { bodyLimit: MCP_BODY_LIMIT }, async (req, reply) => {
    const body = req.body;
    if (Array.isArray(body)) return rpcError(reply, 400, -32600, 'Invalid Request: batches are not supported');
    const header = req.headers.authorization;
    const key = header ? (BEARER_RE.exec(header)?.[1] ?? header) : undefined;
    // A tool call with a valid key is limited per key by the API it calls (60 per minute, shared with REST). Every
    // other message (initialize, tools/list, ping, calls without a valid key) counts against a per-IP budget.
    const isCall = typeof body === 'object' && body !== null && (body as { method?: unknown }).method === 'tools/call';
    const keyed = key !== undefined && !!game.agentByKeyHash(bearerKeyHash(header) ?? '');
    if (!(isCall && keyed)) {
      const t = limiters.mcp.take(req.ip, game.now());
      if (!t.ok) {
        reply.header('retry-after', String(t.retryAfterSec));
        return rpcError(reply, 429, -32000, `Rate limited: retry after ${t.retryAfterSec} s`);
      }
    }

    const headers = new Headers();
    for (const name of TRANSPORT_HEADERS) {
      const v = req.headers[name];
      if (typeof v === 'string') headers.set(name, v);
    }
    const request = new Request(`${publicUrl}/mcp`, { method: 'POST', headers });
    const build = () =>
      createVillageServer({
        // No retries: a 429 goes back to the model as a tool error with the wait, instead of holding the request.
        api: { baseUrl: 'http://in-process', apiKey: key, fetch: inProcessFetch(root, req.ip), retries: 0 },
        publicUrl,
        mode: 'http',
      });
    const res = await handleStatelessPost(build, request, body);
    reply.code(res.status);
    res.headers.forEach((value, name) => {
      if (name !== 'content-length') reply.header(name, value);
    });
    const text = await res.text();
    return text ? reply.send(text) : reply.send();
  });
}
