import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * Structured logs without secrets (PLANEJAMENTO §15.3). Request and response bodies are never logged, so API keys
 * can only leak through headers and URLs: headers are censored here, and request URLs go through `scrubUrl`.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-admin-token"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers["x-admin-token"]',
  'headers.cookie',
  'headers["set-cookie"]',
  // OAuth material, should any of it ever reach a log call.
  'access_token',
  '*.access_token',
  'id_token',
  '*.id_token',
  'refresh_token',
  '*.refresh_token',
  'client_secret',
  '*.client_secret',
  'code_verifier',
  '*.code_verifier',
];

/** Claim tokens travel in the path of claim pages and routes; codes, states and next-links in query strings. */
const CLAIM_PATH = /(\/claim\/)[^/?#]+/g;

/** A request URL safe to log: claim tokens masked and the query string dropped (OAuth `code` and `state` live there). */
export function scrubUrl(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  const path = (q >= 0 ? url.slice(0, q) : url).replace(CLAIM_PATH, '$1[redacted]');
  return q >= 0 ? `${path}?[redacted]` : path;
}

type ReqLike = { method?: string; url?: string; ip?: string; clientIp?: string; socket?: { remotePort?: number } };

const MAX_ERR_TEXT = 2000;
/** Drizzle puts every bound value of a failed query in the message ("Failed query: ...\nparams: ..."). */
const QUERY_PARAMS = /\nparams: [\s\S]*?(?=\n {4}at |\ncaused by: |$)/;

/**
 * Errors without the values of failed queries: a failed snapshot or event write would otherwise log whole world
 * snapshots, unrevealed whispers, push subscription secrets and hashes (megabytes per retry while the database is
 * down). The SQL text, the driver's code and the stack stay.
 */
export function errSerializer(e: unknown): unknown {
  if (!(e instanceof Error)) return e;
  const out = pino.stdSerializers.err(e) as unknown as Record<string, unknown>;
  for (const k of ['params', 'parameters', 'values']) delete out[k];
  for (const k of ['message', 'stack', 'detail']) {
    const v = out[k];
    if (typeof v === 'string') out[k] = v.replace(QUERY_PARAMS, '\nparams: [redacted]').slice(0, MAX_ERR_TEXT);
  }
  // What the database said (pg's DatabaseError: message, code, detail), serialized the same way.
  if (e.cause instanceof Error) out.cause = errSerializer(e.cause);
  return out;
}

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      // Replaces Fastify's request serializer (which logs the raw URL).
      serializers: {
        req: (req: ReqLike) => ({ method: req.method, url: scrubUrl(req.url), remoteAddress: req.clientIp ?? req.ip, remotePort: req.socket?.remotePort }),
        err: errSerializer,
      },
    },
    destination,
  );
}
