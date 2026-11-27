import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sanitizeAgentText } from '@ajwf/shared';
import type { Config } from '../config';

export const PROVIDERS = ['github', 'google'] as const;
export type Provider = (typeof PROVIDERS)[number];
/** `fetch`, injectable so tests can play the provider. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The login attempt lives 10 minutes in a signed, httpOnly cookie. */
export const OAUTH_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_OWNER_NAME = 64;

type Spec = {
  authorize: string;
  token: string;
  user: string;
  scope: string;
  /** Extra headers of the identity request. */
  userHeaders: Record<string, string>;
  /** Stable id and display name from the identity response, or null when it is not usable. */
  identity(json: Record<string, unknown>): { externalId: string; name: string } | null;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');

const SPECS: Record<Provider, Spec> = {
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    user: 'https://api.github.com/user',
    // No scope: only the public profile (id, login, name), never the email.
    scope: '',
    userHeaders: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    identity: (j) => {
      const id = typeof j.id === 'number' || typeof j.id === 'string' ? String(j.id) : '';
      return id ? { externalId: id, name: str(j.name) || str(j.login) } : null;
    },
  },
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    user: 'https://openidconnect.googleapis.com/v1/userinfo',
    // `profile` without `email`: the stable subject id and the display name.
    scope: 'openid profile',
    userHeaders: {},
    identity: (j) => (str(j.sub) ? { externalId: str(j.sub), name: str(j.name) || str(j.given_name) } : null),
  },
};

/** Providers with both a client id and a secret configured; the others are not offered. */
export function enabledProviders(config: Config): Provider[] {
  return PROVIDERS.filter((p) => config.oauth[p]);
}

export function isProvider(p: string): p is Provider {
  return (PROVIDERS as readonly string[]).includes(p);
}

export function redirectUri(config: Config, provider: Provider): string {
  return `${config.publicUrl}/api/owner/oauth/${provider}/callback`;
}

/** Where the owner may land after login: a fixed set of relative paths, never a URL from the request as is. */
const NEXT_EXACT = new Set(['/', '/owner']);
const NEXT_CLAIM = /^\/claim\/[A-Za-z0-9_-]{43}$/;
export const DEFAULT_NEXT = '/owner';

export function safeNext(next: unknown): string {
  if (typeof next !== 'string') return DEFAULT_NEXT;
  return NEXT_EXACT.has(next) || NEXT_CLAIM.test(next) ? next : DEFAULT_NEXT;
}

/** What the signed cookie carries for one login attempt. */
export type Attempt = { p: Provider; s: string; v: string; n: string; e: number };

export function newAttempt(provider: Provider, next: string, now: number): Attempt {
  return { p: provider, s: randomBytes(32).toString('base64url'), v: randomBytes(32).toString('base64url'), n: safeNext(next), e: now + OAUTH_TTL_MS };
}

export function encodeAttempt(a: Attempt): string {
  return Buffer.from(JSON.stringify(a)).toString('base64url');
}

export function decodeAttempt(raw: string): Attempt | null {
  try {
    const j = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Attempt>;
    if (typeof j.p !== 'string' || !isProvider(j.p) || typeof j.s !== 'string' || typeof j.n !== 'string' || typeof j.e !== 'number') return null;
    return { p: j.p, s: j.s, v: typeof j.v === 'string' ? j.v : '', n: safeNext(j.n), e: j.e };
  } catch {
    return null;
  }
}

/** PKCE S256 challenge of a verifier. */
export function challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Constant-time string comparison (hashed first, so lengths do not leak and buffers have equal size). */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function authorizeUrl(config: Config, a: Attempt): string {
  const spec = SPECS[a.p];
  const client = config.oauth[a.p]!;
  const q = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri(config, a.p),
    response_type: 'code',
    state: a.s,
    code_challenge: challenge(a.v),
    code_challenge_method: 'S256',
  });
  if (spec.scope) q.set('scope', spec.scope);
  if (a.p === 'google') q.set('prompt', 'select_account');
  return `${spec.authorize}?${q}`;
}

/**
 * Single-use guard for `state` values: a state is accepted once, then remembered until its attempt expires, so a
 * replayed callback (same cookie, same state) is refused.
 */
export class UsedStates {
  private used = new Map<string, number>();

  /** True the first time a state is seen. */
  take(state: string, expiresAt: number, now: number): boolean {
    for (const [s, e] of this.used) if (e <= now) this.used.delete(s);
    if (this.used.has(state)) return false;
    this.used.set(state, expiresAt);
    return true;
  }
}

export type IdentityResult = { ok: true; externalId: string; name: string } | { ok: false; error: 'provider' };

/**
 * Exchanges the code (with the PKCE verifier) for an access token, reads the identity, and discards the token: it
 * is never stored or logged. Only the provider's stable user id and display name come back.
 */
export async function fetchIdentity(fetchFn: FetchLike, config: Config, provider: Provider, code: string, verifier: string): Promise<IdentityResult> {
  const spec = SPECS[provider];
  const client = config.oauth[provider];
  if (!client) return { ok: false, error: 'provider' };
  try {
    const body = new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      code,
      redirect_uri: redirectUri(config, provider),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    const tokenRes = await fetchFn(spec.token, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!tokenRes.ok) return { ok: false, error: 'provider' };
    // GitHub answers errors with HTTP 200 and an `error` field.
    const tokenJson = (await tokenRes.json()) as Record<string, unknown>;
    const accessToken = str(tokenJson.access_token);
    if (!accessToken || tokenJson.error) return { ok: false, error: 'provider' };
    const userRes = await fetchFn(spec.user, {
      headers: { authorization: `Bearer ${accessToken}`, 'user-agent': 'ajwf-server', ...spec.userHeaders },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!userRes.ok) return { ok: false, error: 'provider' };
    const who = spec.identity((await userRes.json()) as Record<string, unknown>);
    if (!who) return { ok: false, error: 'provider' };
    // Display names come from outside: same cleaning as agent text, short.
    const name = sanitizeAgentText(who.name, MAX_OWNER_NAME).text || `${provider} user`;
    return { ok: true, externalId: who.externalId.slice(0, 200), name };
  } catch {
    return { ok: false, error: 'provider' };
  }
}
