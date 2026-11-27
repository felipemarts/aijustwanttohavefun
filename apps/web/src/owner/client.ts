/**
 * The one way the web app talks to `/api/owner`. Every request carries the session cookie of this origin only
 * (`credentials: 'same-origin'`); every write sends `Content-Type: application/json` and a JSON body, which is what
 * the server's CSRF check requires. Answers become typed results: `{ ok: true, data }`, or `{ ok: false, error }`
 * with the server's `{code, message, hint}`. Nothing is retried: a write that failed on the way may still have
 * happened (a regenerated key, a retirement), so only the person decides to try again.
 */

export type OwnerErrorCode =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'AGENT_LIMIT'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'PUSH_DISABLED'
  | 'INVALID_PARAMS'
  | 'FORBIDDEN'
  | 'INTERNAL'
  /** No answer at all (offline, DNS, CORS, aborted). */
  | 'NETWORK'
  /** An answer that is not the API's JSON (a proxy error page, a truncated body). */
  | 'BAD_RESPONSE'
  | (string & {});

export type OwnerError = {
  code: OwnerErrorCode;
  /** The server's text, in the owner's language; empty for NETWORK and BAD_RESPONSE. */
  message: string;
  hint: string | null;
  status: number;
  /** Seconds, from `Retry-After` on 429. */
  retryAfter: number | null;
};

export type Result<T> = { ok: true; data: T } | { ok: false; error: OwnerError };

/** `fetch`, injectable: tests pass a recorder, mock mode an in-memory owner API. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const BASE = '/api/owner';

function fail(code: OwnerErrorCode, status: number, message = '', hint: string | null = null, retryAfter: number | null = null): { ok: false; error: OwnerError } {
  return { ok: false, error: { code, message, hint, status, retryAfter } };
}

function retryAfterOf(res: Response): number | null {
  const v = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** Path segments are encoded; ids and tokens are also checked by the callers' shapes before they get here. */
const seg = (s: string) => encodeURIComponent(s);

export class OwnerClient {
  constructor(private readonly fetchFn: FetchFn) {}

  /** One request, never repeated. GETs send no body; writes always send JSON (an empty object at least). */
  async request(method: Method, path: string, body?: unknown): Promise<Result<Record<string, unknown>>> {
    const write = method !== 'GET';
    const init: RequestInit = {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      // The claim page's URL holds the token: the referrer is the bare origin, never the path. Not `no-referrer`:
      // with it, browsers send `Origin: null` on same-origin writes and the server's CSRF check refuses them.
      referrerPolicy: 'strict-origin',
      headers: write ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json' },
      ...(write ? { body: JSON.stringify(body ?? {}) } : {}),
    };
    let res: Response;
    try {
      res = await this.fetchFn(`${BASE}${path}`, init);
    } catch {
      return fail('NETWORK', 0);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return fail(res.status === 429 ? 'RATE_LIMITED' : 'BAD_RESPONSE', res.status, '', null, retryAfterOf(res));
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return fail('BAD_RESPONSE', res.status);
    const o = json as Record<string, unknown>;
    if (o.ok === true && res.ok) return { ok: true, data: o };
    const e = o.error && typeof o.error === 'object' ? (o.error as Record<string, unknown>) : {};
    const code = typeof e.code === 'string' && /^[A-Z_]{2,40}$/.test(e.code) ? e.code : res.status === 429 ? 'RATE_LIMITED' : 'BAD_RESPONSE';
    return fail(
      code,
      res.status,
      typeof e.message === 'string' ? e.message.slice(0, 500) : '',
      typeof e.hint === 'string' ? e.hint.slice(0, 500) : null,
      retryAfterOf(res),
    );
  }

  // ── login ─────────────────────────────────────────────────────────────────────────────────────────────────

  providers() {
    return this.request('GET', '/providers');
  }

  session() {
    return this.request('GET', '/session');
  }

  devLogin(name?: string) {
    return this.request('POST', '/dev-login', name ? { name } : {});
  }

  logout() {
    return this.request('POST', '/logout');
  }

  /**
   * Where a login button points: a full navigation (the server answers with the provider's redirect). `next` is a
   * relative path the server checks against its own allowlist.
   */
  static loginUrl(provider: string, next: string): string {
    return `${BASE}/login/${seg(provider)}?${new URLSearchParams({ next })}`;
  }

  // ── claim ─────────────────────────────────────────────────────────────────────────────────────────────────

  claimPreview(token: string, lang: string) {
    return this.request('GET', `/claim/${seg(token)}?${new URLSearchParams({ lang })}`);
  }

  claim(token: string) {
    return this.request('POST', `/claim/${seg(token)}`);
  }

  // ── dashboard ─────────────────────────────────────────────────────────────────────────────────────────────

  me() {
    return this.request('GET', '/me');
  }

  setLanguage(language: string) {
    return this.request('PUT', '/language', { language });
  }

  deleteAccount() {
    return this.request('DELETE', '/me');
  }

  summary(agentId: string, since?: number) {
    return this.request('GET', `/agents/${seg(agentId)}/summary${since !== undefined ? `?since=${Math.max(0, Math.floor(since))}` : ''}`);
  }

  markSeen(agentId: string, until: number) {
    return this.request('POST', `/agents/${seg(agentId)}/seen`, { until: Math.max(0, Math.floor(until)) });
  }

  setNote(agentId: string, note: string) {
    return this.request('PUT', `/agents/${seg(agentId)}/note`, { note });
  }

  regenerateKey(agentId: string) {
    return this.request('POST', `/agents/${seg(agentId)}/regenerate-key`);
  }

  retire(agentId: string) {
    return this.request('POST', `/agents/${seg(agentId)}/retire`);
  }

  share(agentId: string) {
    return this.request('GET', `/agents/${seg(agentId)}/share`);
  }

  // ── Web Push ──────────────────────────────────────────────────────────────────────────────────────────────

  pushKey() {
    return this.request('GET', '/push/key');
  }

  pushSubscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    return this.request('POST', '/push/subscribe', sub);
  }

  pushUnsubscribe(endpoint: string) {
    return this.request('DELETE', '/push/subscribe', { endpoint });
  }
}
