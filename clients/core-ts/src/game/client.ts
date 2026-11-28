import type { Clock, Fetch, KeyVault } from '../ports.ts';
import { deadline, sleep } from '../util/async.ts';
import { isAbort } from '../util/errors.ts';
import type { Redactor } from '../util/redact.ts';
import { RedirectRefused, safeFetch } from '../util/safe-fetch.ts';
import { fromPlain, isObj, parse as parseOrdered, toPlain, write, type JV } from '../playkit/jv.ts';
import { parseSchemaDoc, type SchemaDoc } from '../playkit/schema.ts';
import type {
  ActResult,
  ActionSpec,
  AppearanceOptionsView,
  EventsPage,
  GameSchema,
  MeView,
  Observation,
  Profile,
  RegisterBody,
  RegisterResult,
} from './types.ts';

/** Transport-level failures. Game refusals (HTTP 200, `ok: false`) are results, not errors. */
export type GameErrorCode = 'NETWORK' | 'TIMEOUT' | 'RATE_LIMITED' | 'UNAUTHORIZED' | 'SERVER_ERROR' | 'BAD_RESPONSE' | 'REDIRECT' | 'NO_KEY' | 'ABORTED' | string;

export class GameError extends Error {
  readonly code: GameErrorCode;
  readonly status: number;
  /** For RATE_LIMITED: how long the server asked to wait. */
  readonly retryAfterMs?: number;
  constructor(code: GameErrorCode, message: string, status = 0, retryAfterMs?: number) {
    super(message);
    this.name = 'GameError';
    this.code = code;
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export type GameClientOptions = {
  fetch: Fetch;
  clock: Clock;
  vault: KeyVault;
  redactor: Redactor;
  /** Per request. */
  timeoutMs?: number;
  /** Extra attempts after a network error, a timeout, a 5xx or a 429 (only for requests safe to repeat). */
  retries?: number;
  /** Requests per minute per key the client allows itself (the server allows 60). */
  perMinute?: number;
  /** Longest `Retry-After` the client waits for itself; longer ones are returned to the caller. */
  maxRetryWaitMs?: number;
  /** Told after every request whether the server answered. */
  onReachable?: (reachable: boolean) => void;
};

type Bucket = { tokens: number; at: number; blockedUntil: number };

/** Every parsed answer carries its member-ordered JSON value under this key (not enumerable, never serialized). */
export const ORDERED: unique symbol = Symbol('ordered');
const ETAG: unique symbol = Symbol('etag');
const NOT_MODIFIED: unique symbol = Symbol('not-modified');

/** The answer as the playkit reads it: member order as received. */
export function ordered(x: unknown): JV {
  const v = x && typeof x === 'object' ? (x as { [ORDERED]?: JV })[ORDERED] : undefined;
  return v === undefined ? fromPlain(x) : v;
}

type Req = {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** A 304 answer is a result (schema revalidation). */
  allow304?: boolean;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Vault name of the agent key; omitted for public routes. */
  keyName?: string;
  idempotencyKey?: string;
  /** Safe to send again after a timeout or a 5xx. */
  repeatable: boolean;
  signal?: AbortSignal;
};

/**
 * The REST calls a player makes, for one game server. The agent key is read from the vault at call time, sent only
 * to this server's origin, and never appears in an error, a log or a return value.
 */
export class GameClient {
  readonly baseUrl: string;
  private readonly o: Required<Omit<GameClientOptions, 'onReachable'>> & Pick<GameClientOptions, 'onReachable'>;
  private buckets = new Map<string, Bucket>();

  constructor(baseUrl: string, opts: GameClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    // 50 a minute, under the server's 60 (playkit `requests.perMinute`), leaves room for the owner's own calls.
    this.o = { timeoutMs: 15_000, retries: 2, perMinute: 50, maxRetryWaitMs: 65_000, ...opts };
  }

  // ── Routes ──────────────────────────────────────────────────────────────────────────────────────────────────

  appearanceOptions(lang?: string, signal?: AbortSignal): Promise<AppearanceOptionsView> {
    return this.call<AppearanceOptionsView>({ method: 'GET', path: '/appearance/options', query: lang ? { lang } : undefined, repeatable: true, signal }, true);
  }

  /** Not repeated after a timeout: a second attempt could register twice (the first would then be lost). */
  register(body: RegisterBody, signal?: AbortSignal): Promise<RegisterResult> {
    return this.call<RegisterResult>({ method: 'POST', path: '/agents/register', body, repeatable: false, signal }, false);
  }

  me(keyName: string, signal?: AbortSignal): Promise<MeView> {
    return this.call<MeView>({ method: 'GET', path: '/me', keyName, repeatable: true, signal }, true);
  }

  look(keyName: string, signal?: AbortSignal): Promise<Observation> {
    return this.call<Observation>({ method: 'GET', path: '/look', keyName, repeatable: true, signal }, true);
  }

  /** With an `Idempotency-Key`, so a retry after a timeout returns the stored answer instead of acting twice. */
  act(keyName: string, action: string, params: JV, idempotencyKey: string, signal?: AbortSignal): Promise<ActResult> {
    const body = new Map<string, JV>([
      ['action', action],
      ['params', isObj(params) ? params : new Map()],
    ]);
    return this.call<ActResult>({ method: 'POST', path: '/act', body, keyName, idempotencyKey, repeatable: true, signal }, false);
  }

  /**
   * `GET /schema` as the playkit reads it (member order kept), revalidated with `If-None-Match` (README 3.1):
   * `null` when the copy behind `etag` is still current. Falls back to `/help` on a server without `/schema`.
   */
  async schemaDoc(etag?: string, signal?: AbortSignal): Promise<{ doc: SchemaDoc; etag?: string } | null> {
    let raw: unknown;
    try {
      raw = await this.call<unknown>({ method: 'GET', path: '/schema', repeatable: true, signal, allow304: true, ...(etag ? { headers: { 'if-none-match': etag } } : {}) }, true);
    } catch (e) {
      if (!(e instanceof GameError) || (e.status !== 404 && e.code !== 'NOT_FOUND')) throw e;
      raw = await this.call<unknown>({ method: 'GET', path: '/help', repeatable: true, signal }, true);
    }
    if (raw && typeof raw === 'object' && (raw as { [NOT_MODIFIED]?: boolean })[NOT_MODIFIED]) return null;
    try {
      const tag = (raw as { [ETAG]?: string })[ETAG];
      return { doc: parseSchemaDoc(ordered(raw)), ...(tag ? { etag: tag } : {}) };
    } catch {
      throw new GameError('BAD_RESPONSE', 'The game server sent an unreadable action schema.');
    }
  }

  events(keyName: string, since: string, signal?: AbortSignal): Promise<EventsPage> {
    return this.call<EventsPage>({ method: 'GET', path: '/events', query: { since }, keyName, repeatable: true, signal }, true);
  }

  profile(name: string, signal?: AbortSignal): Promise<Profile> {
    return this.call<Profile>({ method: 'GET', path: `/agents/${encodeURIComponent(name)}`, repeatable: true, signal }, true);
  }

  /** Every action's params as JSON Schema: `GET /schema`, or `GET /help` on a server without it. */
  async schema(signal?: AbortSignal): Promise<GameSchema> {
    let raw: Record<string, unknown>;
    try {
      raw = await this.call<Record<string, unknown>>({ method: 'GET', path: '/schema', repeatable: true, signal }, true);
    } catch (e) {
      if (!(e instanceof GameError) || (e.status !== 404 && e.code !== 'NOT_FOUND')) throw e;
      raw = await this.call<Record<string, unknown>>({ method: 'GET', path: '/help', repeatable: true, signal }, true);
    }
    return parseSchema(raw);
  }

  /** Whether the server answers at all (any HTTP answer counts). */
  async ping(signal?: AbortSignal): Promise<{ reachable: boolean; skillVersion?: string }> {
    try {
      const s = await this.schema(signal);
      return { reachable: true, ...(s.skillVersion ? { skillVersion: s.skillVersion } : {}) };
    } catch (e) {
      if (e instanceof GameError && (e.code === 'NETWORK' || e.code === 'TIMEOUT' || e.code === 'REDIRECT')) return { reachable: false };
      return { reachable: true };
    }
  }

  // ── Transport ───────────────────────────────────────────────────────────────────────────────────────────────

  /** Waits for a token of this key's bucket (the server allows `perMinute` per key; staying under it avoids 429s). */
  private async throttle(bucketKey: string, signal?: AbortSignal): Promise<void> {
    const rate = this.o.perMinute / 60_000;
    for (;;) {
      const now = this.o.clock.now();
      const b = this.buckets.get(bucketKey) ?? { tokens: this.o.perMinute, at: now, blockedUntil: 0 };
      b.tokens = Math.min(this.o.perMinute, b.tokens + Math.max(0, now - b.at) * rate);
      b.at = now;
      this.buckets.set(bucketKey, b);
      if (now >= b.blockedUntil && b.tokens >= 1) {
        b.tokens -= 1;
        return;
      }
      const wait = Math.max(b.blockedUntil - now, Math.ceil((1 - b.tokens) / rate));
      await sleep(this.o.clock, wait, signal);
    }
  }

  private block(bucketKey: string, ms: number): void {
    const now = this.o.clock.now();
    const b = this.buckets.get(bucketKey) ?? { tokens: 0, at: now, blockedUntil: 0 };
    b.blockedUntil = Math.max(b.blockedUntil, now + ms);
    b.tokens = 0;
    this.buckets.set(bucketKey, b);
  }

  private reachable(v: boolean): void {
    this.o.onReachable?.(v);
  }

  private async call<T>(req: Req, failOnRefusal: boolean): Promise<T> {
    const bucketKey = req.keyName ?? '(anonymous)';
    let attempt = 0;
    for (;;) {
      if (req.signal?.aborted) throw new GameError('ABORTED', 'The request was cancelled.');
      await this.throttle(bucketKey, req.signal).catch((e: unknown) => {
        if (isAbort(e)) throw new GameError('ABORTED', 'The request was cancelled.');
        throw e;
      });
      let res: Response;
      const d = deadline(this.o.clock, this.o.timeoutMs, req.signal);
      try {
        res = await safeFetch(this.o.fetch, this.url(req), await this.init(req, d.signal));
      } catch (e) {
        d.done();
        if (e instanceof GameError) throw e;
        if (req.signal?.aborted) throw new GameError('ABORTED', 'The request was cancelled.');
        const timedOut = d.timedOut();
        if (e instanceof RedirectRefused) {
          this.reachable(false);
          throw new GameError('REDIRECT', 'The game server redirected to another address; nothing was sent there.');
        }
        this.reachable(false);
        if (req.repeatable && attempt < this.o.retries) {
          await this.backoff(attempt++, req.signal);
          continue;
        }
        throw timedOut ? new GameError('TIMEOUT', 'The game server did not answer in time.') : new GameError('NETWORK', 'The game server cannot be reached.');
      }
      let text: string;
      try {
        text = await res.text();
      } catch {
        d.done();
        this.reachable(false);
        if (req.repeatable && attempt < this.o.retries) {
          await this.backoff(attempt++, req.signal);
          continue;
        }
        throw new GameError(d.timedOut() ? 'TIMEOUT' : 'NETWORK', 'The game server stopped answering mid-way.');
      }
      d.done();
      this.reachable(true);
      if (res.status === 304 && req.allow304) return { [NOT_MODIFIED]: true } as T;

      if (res.status === 429) {
        const waitMs = retryAfterMs(res.headers.get('retry-after'), this.o.clock.now());
        this.block(bucketKey, waitMs);
        if (attempt < this.o.retries && waitMs <= this.o.maxRetryWaitMs) {
          attempt++;
          continue; // throttle() waits out the block
        }
        throw new GameError('RATE_LIMITED', `The game server asks to wait ${Math.ceil(waitMs / 1000)} s.`, 429, waitMs);
      }
      if (res.status >= 500) {
        if (req.repeatable && attempt < this.o.retries) {
          await this.backoff(attempt++, req.signal);
          continue;
        }
        throw new GameError('SERVER_ERROR', `The game server failed (HTTP ${res.status}).`, res.status);
      }
      if (res.status === 401) throw new GameError('UNAUTHORIZED', 'The game server refused this character\'s key.', 401);
      let body: unknown;
      let value: JV;
      try {
        // Strict and order-preserving (the playkit renders game objects in the order received); duplicate keys refused.
        value = parseOrdered(text);
        body = toPlain(value);
      } catch {
        throw new GameError('BAD_RESPONSE', `The game server sent something that is not JSON (HTTP ${res.status}).`, res.status);
      }
      if (body && typeof body === 'object') {
        Object.defineProperty(body, ORDERED, { value, enumerable: false });
        const tag = res.headers.get('etag');
        if (tag) Object.defineProperty(body, ETAG, { value: tag, enumerable: false });
      }
      if (!body || typeof body !== 'object') throw new GameError('BAD_RESPONSE', 'The game server sent an unexpected answer.', res.status);
      const ok = (body as { ok?: unknown }).ok;
      if (res.status >= 400 || (ok === false && failOnRefusal)) {
        const err = (body as { error?: { code?: unknown; message?: unknown } }).error;
        const code = typeof err?.code === 'string' ? err.code : `HTTP_${res.status}`;
        const msg = typeof err?.message === 'string' ? err.message : `The game server answered HTTP ${res.status}.`;
        throw new GameError(code, this.o.redactor.scrub(msg), res.status);
      }
      if (ok !== true && ok !== false) throw new GameError('BAD_RESPONSE', 'The game server sent an unexpected answer.', res.status);
      return body as T;
    }
  }

  private url(req: Req): string {
    const q = req.query ? `?${new URLSearchParams(req.query).toString()}` : '';
    return `${this.baseUrl}/api/v1${req.path}${q}`;
  }

  private async init(req: Req, signal: AbortSignal): Promise<RequestInit> {
    const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;
    if (req.keyName) {
      const key = await this.o.vault.get(req.keyName);
      if (!key) throw new GameError('NO_KEY', 'This character has no key stored on this device.');
      this.o.redactor.add(key);
      headers.authorization = `Bearer ${key}`;
    }
    const body = req.body === undefined ? undefined : write(req.body instanceof Map ? (req.body as JV) : fromPlain(req.body));
    return { method: req.method, headers, body, signal };
  }

  private async backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    try {
      await sleep(this.o.clock, Math.min(8_000, 1_000 * 2 ** attempt), signal);
    } catch {
      throw new GameError('ABORTED', 'The request was cancelled.');
    }
  }
}

/** `Retry-After` in seconds or as an HTTP date; one second when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number): number {
  if (!header) return 1_000;
  const s = Number(header);
  if (Number.isFinite(s) && s >= 0) return Math.max(1_000, Math.round(s * 1000));
  const t = Date.parse(header);
  return Number.isFinite(t) ? Math.max(1_000, t - now) : 1_000;
}

export function parseSchema(raw: Record<string, unknown>): GameSchema {
  const list = raw.actions;
  const actions: ActionSpec[] = [];
  const add = (name: unknown, spec: unknown) => {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/.test(name)) return;
    const s = (spec && typeof spec === 'object' ? spec : {}) as { params?: unknown; ap?: unknown };
    const params = s.params && typeof s.params === 'object' ? (s.params as Record<string, unknown>) : { type: 'object', properties: {} };
    actions.push({ name, ...(typeof s.ap === 'number' ? { ap: s.ap } : {}), params });
  };
  if (Array.isArray(list)) for (const a of list) add((a as { name?: unknown })?.name, a);
  else if (list && typeof list === 'object') for (const [name, spec] of Object.entries(list)) add(name, spec);
  if (!actions.length) throw new GameError('BAD_RESPONSE', 'The game server sent no action list.');
  return {
    actions: actions.sort((a, b) => a.name.localeCompare(b.name)),
    ...(typeof raw.api_version === 'string' ? { apiVersion: raw.api_version } : {}),
    ...(typeof raw.skill_version === 'string' ? { skillVersion: raw.skill_version } : {}),
  };
}
