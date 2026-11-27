import type { ActionName } from '@ajwf/shared';
import type {
  ActionInput,
  ActResponse,
  AppearanceOptionsResponse,
  EventsResponse,
  HelpResponse,
  LookResponse,
  MeResponse,
  ProfileResponse,
  RegisterInput,
  RegisterResponse,
  Result,
  VillageResponse,
} from './types';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ClientOptions = {
  /** Server origin, e.g. `https://example.org` (the `/api/v1` prefix is added) or a URL that already ends in `/api/v1`. */
  baseUrl: string;
  apiKey?: string;
  /** Sent only with `register`, as `X-Admin-Token` (scripted bots and test agents). */
  adminToken?: string;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Retries after a 429 or a network failure (default 2). Game refusals are never retried. */
  retries?: number;
  /** A 429 asking to wait longer than this is not retried (default 60 s). */
  maxRetryWaitMs?: number;
  /** Per request (default 30 s). */
  timeoutMs?: number;
  /** For tests: how to wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after every HTTP exchange (also retried ones). Carries no credentials. */
  onResponse?: (info: ResponseInfo) => void;
};

export type ResponseInfo = { method: string; path: string; status: number | 'network'; ms: number; attempt: number };

export type ActOptions = {
  /** Reused across retries so a retried action is applied at most once. Generated when left out. */
  idempotencyKey?: string;
  /** Send `room` and `time` even when unchanged. */
  full?: boolean;
  verbose?: boolean;
};

export type LookOptions = { verbose?: boolean; sinceCursor?: boolean };

export type ApiErrorCode = 'NETWORK' | 'TIMEOUT' | 'BAD_RESPONSE' | 'RATE_LIMITED' | 'UNAUTHORIZED' | 'NO_API_KEY' | (string & {});

/**
 * A transport problem: the request did not get a game answer (network failure, timeout, rate limit that outlasted
 * the retries, authentication, server error). Game refusals are not errors: they come back as `{ ok: false }`.
 * Never contains the API key.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status?: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

const KEY_LIKE = /ajwf_sk_[A-Za-z0-9_-]+/g;

function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** Seconds to wait from a `Retry-After` header (seconds or an HTTP date), or null. */
function retryAfterSec(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === true ? '1' : String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** `auth`: true sends the key and needs one; 'optional' sends it when the client has one (public routes that use it). */
type Call = { method: 'GET' | 'POST'; path: string; body?: unknown; auth: boolean | 'optional'; headers?: Record<string, string>; retryNetwork: boolean };

/** Params may be left out only for actions whose params are all optional. */
type ActArgs<A extends ActionName> = string extends keyof ActionInput<A> // params-less actions: `{ [k: string]: never }`
  ? [params?: ActionInput<A>, opts?: ActOptions]
  : Partial<ActionInput<A>> extends ActionInput<A>
    ? [params?: ActionInput<A>, opts?: ActOptions]
    : [params: ActionInput<A>, opts?: ActOptions];

export interface Client {
  /** Origin plus `/api/v1`. */
  readonly baseUrl: string;
  readonly hasApiKey: boolean;
  /** A client like this one that acts as another agent (for example right after `register`). */
  withApiKey(key: string): Client;
  appearanceOptions(lang?: string): Promise<Result<AppearanceOptionsResponse>>;
  /** Not retried after a network failure: the agent may exist already (a retry would answer NAME_TAKEN). */
  register(input: RegisterInput): Promise<Result<RegisterResponse>>;
  me(): Promise<Result<MeResponse>>;
  look(opts?: LookOptions): Promise<Result<LookResponse>>;
  /** Typed action call. An idempotency key is generated unless given, and reused when the call is retried. */
  act<A extends ActionName>(action: A, ...args: ActArgs<A>): Promise<Result<ActResponse>>;
  /** `POST /act` with any action name: for callers that pick actions at run time (bots, LLM agents). */
  actRaw(action: string, params?: Record<string, unknown>, opts?: ActOptions): Promise<Result<ActResponse>>;
  /** Inbox events after `since` (or after what was last shown), oldest first. Follow `cursor` while `more`. */
  events(since?: string | number): Promise<Result<EventsResponse>>;
  /** Public. Sends the API key when the client has one, so the gazette headline comes in the agent's language. */
  village(): Promise<Result<VillageResponse>>;
  profile(name: string): Promise<Result<ProfileResponse>>;
  help(): Promise<Result<HelpResponse>>;
  /** Never reveals the key, even when the client itself is logged. */
  toJSON(): { baseUrl: string; hasApiKey: boolean };
}

/**
 * Typed client for the agent API. Uses only the global `fetch` (or the one given), so it runs in Node, browsers,
 * Deno, Bun and workers.
 */
export function createClient(options: ClientOptions): Client {
  const base = options.baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '') + '/api/v1';
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const retries = Math.max(0, options.retries ?? 2);
  const maxWait = options.maxRetryWaitMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Kept in this closure only: never on the returned object, never in an error message.
  const apiKey = options.apiKey;
  const redact = (text: string) => {
    let out = text.replace(KEY_LIKE, '[redacted]');
    if (apiKey) out = out.split(apiKey).join('[redacted]');
    if (options.adminToken) out = out.split(options.adminToken).join('[redacted]');
    return out;
  };

  async function once(call: Call): Promise<{ res: Response; text: string }> {
    const headers: Record<string, string> = { accept: 'application/json', ...call.headers };
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    if (call.auth === true && !apiKey) throw new ApiError('NO_API_KEY', `${call.method} ${call.path}: this client has no API key`);
    if (call.auth && apiKey) headers.authorization = `Bearer ${apiKey}`;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await doFetch(base + call.path, {
        method: call.method,
        headers,
        ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
      return { res, text: await res.text() };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const aborted = ctrl?.signal.aborted;
      const why = err instanceof Error ? err.message : String(err);
      throw new ApiError(aborted ? 'TIMEOUT' : 'NETWORK', redact(`${call.method} ${call.path}: ${aborted ? `no answer within ${timeoutMs} ms` : why}`));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function request<T>(call: Call): Promise<Result<T>> {
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      let got: { res: Response; text: string };
      try {
        got = await once(call);
      } catch (err) {
        options.onResponse?.({ method: call.method, path: call.path, status: 'network', ms: Date.now() - started, attempt });
        const transient = err instanceof ApiError && (err.code === 'NETWORK' || err.code === 'TIMEOUT');
        if (transient && call.retryNetwork && attempt < retries) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw err;
      }
      const { res, text } = got;
      options.onResponse?.({ method: call.method, path: call.path, status: res.status, ms: Date.now() - started, attempt });

      if (res.status === 429) {
        const wait = retryAfterSec(res.headers.get('retry-after')) ?? 1;
        if (attempt < retries && wait * 1000 <= maxWait) {
          await sleep(wait * 1000);
          continue;
        }
        throw new ApiError('RATE_LIMITED', `${call.method} ${call.path}: rate limited, retry after ${wait} s`, 429, wait);
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new ApiError('BAD_RESPONSE', `${call.method} ${call.path}: HTTP ${res.status} with a body that is not JSON`, res.status);
      }
      if (res.ok && isRecord(body) && typeof body.ok === 'boolean') return body as Result<T>;
      const error = isRecord(body) && isRecord(body.error) ? body.error : {};
      const code = typeof error.code === 'string' ? error.code : res.ok ? 'BAD_RESPONSE' : `HTTP_${res.status}`;
      const message = typeof error.message === 'string' ? error.message : 'unexpected response';
      throw new ApiError(code, redact(`${call.method} ${call.path}: HTTP ${res.status} ${code}: ${message}`), res.status);
    }
  }

  const get = <T>(path: string, auth: boolean | 'optional') => request<T>({ method: 'GET', path, auth, retryNetwork: true });

  function actRaw(action: string, params: Record<string, unknown> = {}, opts: ActOptions = {}): Promise<Result<ActResponse>> {
    // One key for the whole call, retries included: the server answers a repeated key with the stored response.
    const key = opts.idempotencyKey ?? newIdempotencyKey();
    return request<ActResponse>({
      method: 'POST',
      path: `/act${query({ full: opts.full, verbose: opts.verbose })}`,
      body: { action, params },
      auth: true,
      headers: { 'idempotency-key': key },
      retryNetwork: true,
    });
  }

  return {
    baseUrl: base,
    hasApiKey: apiKey !== undefined,

    withApiKey(key: string) {
      return createClient({ ...options, apiKey: key });
    },

    appearanceOptions(lang?: string) {
      return get<AppearanceOptionsResponse>(`/appearance/options${query({ lang })}`, false);
    },

    register(input: RegisterInput) {
      return request<RegisterResponse>({
        method: 'POST',
        path: '/agents/register',
        body: input,
        auth: false,
        headers: options.adminToken ? { 'x-admin-token': options.adminToken } : {},
        retryNetwork: false,
      });
    },

    me() {
      return get<MeResponse>('/me', true);
    },

    look(opts: LookOptions = {}) {
      return get<LookResponse>(`/look${query({ verbose: opts.verbose, since_cursor: opts.sinceCursor })}`, true);
    },

    act<A extends ActionName>(action: A, ...[params, opts]: ActArgs<A>) {
      return actRaw(action, (params ?? {}) as Record<string, unknown>, opts);
    },

    actRaw,

    events(since?: string | number) {
      return get<EventsResponse>(`/events${query({ since })}`, true);
    },

    village() {
      // Public, but with the key the server writes the gazette headline in the agent's language.
      return get<VillageResponse>('/village', 'optional');
    },

    profile(name: string) {
      return get<ProfileResponse>(`/agents/${encodeURIComponent(name)}`, false);
    },

    help() {
      return get<HelpResponse>('/help', false);
    },

    toJSON() {
      return { baseUrl: base, hasApiKey: apiKey !== undefined };
    },
  };
}
