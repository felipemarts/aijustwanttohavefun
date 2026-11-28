/**
 * `RemoteCore`: the desktop core is the Go program, which serves this interface on 127.0.0.1 and implements the
 * routes listed at the top of `core-api.ts`. Same origin, JSON over HTTP, events over Server-Sent Events.
 *
 * Session: the program opens the page at `/#token=<launch token>`. The token is exchanged once, with
 * `POST /core/session {token}`, for an HttpOnly, SameSite=Strict cookie set by the program, and then dropped from
 * memory. Every later call relies on that cookie (`credentials: 'same-origin'`, no Authorization header), so a reload
 * keeps working. The token is never written to storage, never logged and never put back in a URL.
 * State-changing requests always carry `Content-Type: application/json` (the program checks it, and the Origin).
 */
import { SseParser } from './sse';
import {
  CODES,
  CoreFailure,
  type AppearanceOptions,
  type CharacterDetail,
  type CharacterId,
  type CharacterSummary,
  type ChatMessage,
  type ConnectionAware,
  type ConnectionStatus,
  type Core,
  type CoreEvent,
  type CoreState,
  type Directives,
  type EngineChoice,
  type EngineState,
  type EngineTest,
  type LogEntry,
  type NewCharacter,
  type ProviderInfo,
  type Settings,
} from './types';

type FetchFn = typeof fetch;

export type RemoteCoreOptions = {
  /** Origin of the Go program, for example `http://127.0.0.1:43117`. Requests go to `<base>/core/...`. */
  base: string;
  /** The one-time token from the URL fragment, or null to rely on a cookie from an earlier exchange. */
  token: string | null;
  fetch?: FetchFn;
  /** Reconnect delays for the event stream, in ms. */
  backoff?: number[];
  /** Silence after which the event stream is treated as dead and reopened (default 45 s, three missed keepalives). */
  silenceMs?: number;
};

const EVENT_TYPES = new Set<CoreEvent['type']>(['character', 'removed', 'log', 'engine', 'chat', 'server']);
const SLOW_MS = 180_000; // a model turn on a slow machine
/** The program sends `: keepalive` every 15 s; three missed beats mean the stream is dead even if TCP says otherwise. */
const STREAM_SILENCE_MS = 45_000;
const NORMAL_MS = 20_000;

export class RemoteCore implements Core, ConnectionAware {
  readonly #base: string;
  #token: string | null;
  #exchange: Promise<void> | null = null;
  readonly #fetch: FetchFn;
  readonly #backoff: number[];
  readonly #silenceMs: number;
  #status: ConnectionStatus = 'connecting';
  readonly #statusListeners = new Set<(s: ConnectionStatus) => void>();

  constructor(opts: RemoteCoreOptions) {
    this.#base = opts.base.replace(/\/+$/, '');
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? ((...args) => fetch(...args));
    this.#backoff = opts.backoff ?? [1000, 2000, 5000, 10_000, 15_000];
    this.#silenceMs = opts.silenceMs ?? STREAM_SILENCE_MS;
  }

  // ── Connection status (not in the contract; see types.ts) ──────────────────────────────────────────────────
  onConnection(listener: (s: ConnectionStatus) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  #setStatus(s: ConnectionStatus): void {
    if (this.#status === 'unauthorized' || this.#status === s) return;
    this.#status = s;
    for (const l of this.#statusListeners) l(s);
  }

  // ── Session ────────────────────────────────────────────────────────────────────────────────────────────────
  /** Trades the one-time token for the session cookie, once; later calls wait for it. */
  #session(): Promise<void> {
    if (!this.#token) return Promise.resolve();
    this.#exchange ??= this.#send<unknown>('POST', '/session', { token: this.#token }, NORMAL_MS).then(
      () => {
        this.#token = null; // the cookie carries the session from now on
        this.#exchange = null;
      },
      (e: unknown) => {
        this.#exchange = null;
        if (e instanceof CoreFailure && e.status === 401) this.#token = null; // a used or wrong token: never retry it
        throw e;
      },
    );
    return this.#exchange;
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────────────────────────────────────
  async #req<T>(method: string, path: string, body?: unknown, timeoutMs = NORMAL_MS): Promise<T> {
    await this.#session();
    return this.#send<T>(method, path, body, timeoutMs);
  }

  async #send<T>(method: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const changes = method !== 'GET';
    if (changes) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/core${path}`, {
        method,
        headers,
        body: changes ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch (e) {
      throw new CoreFailure(CODES.coreUnreachable, e instanceof Error ? e.message : String(e));
    }
    const text = await res.text().catch(() => '');
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      if (res.status === 401) this.#setStatus('unauthorized');
      const err = (json as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      const code = typeof err?.code === 'string' ? err.code : res.status === 401 ? CODES.unauthorized : `http_${res.status}`;
      const message = typeof err?.message === 'string' ? err.message : res.statusText;
      throw new CoreFailure(code, message, res.status);
    }
    if (json === undefined && text) throw new CoreFailure(CODES.badResponse, 'Response is not JSON', res.status);
    return json as T;
  }

  // ── Events ─────────────────────────────────────────────────────────────────────────────────────────────────
  subscribe(listener: (ev: CoreEvent) => void): () => void {
    const ctl = new AbortController();
    void this.#streamLoop(listener, ctl.signal);
    return () => ctl.abort();
  }

  async #streamLoop(listener: (ev: CoreEvent) => void, signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted && this.#status !== 'unauthorized') {
      let gotThrough = false;
      // One controller per connection: aborted by the caller's signal, or by the watchdog when the stream goes silent.
      const conn = new AbortController();
      const onAbort = () => conn.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const feed = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => conn.abort(), this.#silenceMs);
      };
      try {
        await this.#session();
        feed();
        const res = await this.#fetch(`${this.#base}/core/events`, {
          headers: { Accept: 'text/event-stream' },
          signal: conn.signal,
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (res.status === 401) {
          this.#setStatus('unauthorized');
          return;
        }
        if (res.ok && res.body) {
          gotThrough = true;
          attempt = 0;
          this.#setStatus('live');
          const parser = new SseParser((data) => {
            const ev = parseEvent(data);
            if (ev) listener(ev);
          });
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            feed(); // any bytes, keepalive comments included
            parser.push(decoder.decode(value, { stream: true }));
          }
        }
      } catch {
        // network error, abort, silence, or a failed session exchange (a 401 there already set 'unauthorized')
      } finally {
        if (watchdog) clearTimeout(watchdog);
        signal.removeEventListener('abort', onAbort);
      }
      if (signal.aborted) return;
      this.#setStatus('reconnecting');
      const delay = this.#backoff[Math.min(attempt, this.#backoff.length - 1)] ?? 5000;
      if (!gotThrough) attempt++;
      await sleep(delay, signal);
    }
  }

  // ── The contract ───────────────────────────────────────────────────────────────────────────────────────────
  state(): Promise<CoreState> {
    return this.#req('GET', '/state');
  }
  appearanceOptions(): Promise<AppearanceOptions> {
    return this.#req('GET', '/appearance/options');
  }
  createCharacter(input: NewCharacter): Promise<CharacterSummary> {
    return this.#req('POST', '/characters', input, SLOW_MS);
  }
  character(id: CharacterId): Promise<CharacterDetail> {
    return this.#req('GET', `/characters/${enc(id)}`);
  }
  seen(id: CharacterId): Promise<CharacterSummary> {
    return this.#req('POST', `/characters/${enc(id)}/seen`);
  }
  async claimLink(id: CharacterId): Promise<string | null> {
    const r = await this.#req<{ url?: unknown }>('GET', `/characters/${enc(id)}/claim`);
    return typeof r?.url === 'string' ? r.url : null;
  }
  log(id: CharacterId, opts?: { before?: string; limit?: number }): Promise<LogEntry[]> {
    const q = new URLSearchParams();
    if (opts?.before) q.set('before', opts.before);
    if (opts?.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return this.#req('GET', `/characters/${enc(id)}/log${qs ? `?${qs}` : ''}`);
  }
  control(id: CharacterId, run: boolean): Promise<CharacterSummary> {
    return this.#req('POST', `/characters/${enc(id)}/control`, { run });
  }
  setDirectives(id: CharacterId, d: Directives): Promise<Directives> {
    return this.#req('PUT', `/characters/${enc(id)}/directives`, d);
  }
  async command(id: CharacterId, text: string): Promise<void> {
    await this.#req('POST', `/characters/${enc(id)}/command`, { text });
  }
  chat(id: CharacterId, text: string): Promise<ChatMessage> {
    return this.#req('POST', `/characters/${enc(id)}/chat`, { text }, SLOW_MS);
  }
  chatHistory(id: CharacterId, limit?: number): Promise<ChatMessage[]> {
    return this.#req('GET', `/characters/${enc(id)}/chat${limit ? `?limit=${limit}` : ''}`);
  }
  async forget(id: CharacterId): Promise<void> {
    await this.#req('DELETE', `/characters/${enc(id)}`);
  }
  settings(): Promise<Settings> {
    return this.#req('GET', '/settings');
  }
  setSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.#req('PUT', '/settings', patch);
  }
  engine(): Promise<EngineState> {
    return this.#req('GET', '/engine');
  }
  providers(): Promise<ProviderInfo[]> {
    return this.#req('GET', '/engine/providers', undefined, 30_000);
  }
  probeProvider(url: string): Promise<ProviderInfo> {
    return this.#req('GET', `/engine/providers?${new URLSearchParams({ url }).toString()}`, undefined, 30_000);
  }
  setEngine(choice: EngineChoice): Promise<EngineState> {
    return this.#req('PUT', '/engine', choice, 30_000);
  }
  startDownload(): Promise<EngineState> {
    return this.#req('POST', '/engine/download');
  }
  pauseDownload(): Promise<EngineState> {
    return this.#req('POST', '/engine/download/pause');
  }
  cancelDownload(): Promise<EngineState> {
    return this.#req('DELETE', '/engine/download');
  }
  testEngine(): Promise<EngineTest> {
    return this.#req('POST', '/engine/test', undefined, SLOW_MS);
  }
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

/** Parses one SSE `data:` payload into a CoreEvent, or null when it is not one the interface knows. */
export function parseEvent(data: string): CoreEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const type = (v as { type?: unknown }).type;
  if (typeof type !== 'string' || !EVENT_TYPES.has(type as CoreEvent['type'])) return null;
  return v as CoreEvent;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
