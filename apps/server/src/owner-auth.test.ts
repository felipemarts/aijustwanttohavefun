import fastifyCookie from '@fastify/cookie';
import { describe, expect, it } from 'vitest';
import { sha256 } from './auth';
import type { Config } from './config';
import { challenge, encodeAttempt, type FetchLike } from './owner/oauth';
import { SESSION_MAX_AGE_MS, SESSION_TTL_MS } from './owner/session';
import { makeServer, ORIGIN, type TestServer } from './test-helpers';

const OAUTH: Config['oauth'] = { github: { id: 'gh-client', secret: 'gh-secret' }, google: { id: 'g-client', secret: 'g-secret' } };
const ACCESS_TOKEN = 'gho_FAKEACCESSTOKEN0123456789abcdef';

type Call = { url: string; body: string; headers: Record<string, string> };

/** A fake GitHub and Google: token endpoints and identity endpoints. */
function fakeProvider(mode: 'ok' | 'token_500' | 'token_error' | 'user_500' = 'ok') {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: String(init?.body ?? ''), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    if (url === 'https://github.com/login/oauth/access_token' || url === 'https://oauth2.googleapis.com/token') {
      if (mode === 'token_500') return new Response('down', { status: 500 });
      if (mode === 'token_error') return Response.json({ error: 'bad_verification_code' });
      return Response.json({ access_token: ACCESS_TOKEN, token_type: 'bearer' });
    }
    if (mode === 'user_500') return new Response('down', { status: 500 });
    if (url === 'https://api.github.com/user') return Response.json({ id: 4242, login: 'octo', name: 'Octo Cat', email: 'octo@example.com' });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: 'g-123', name: 'Gina', email: 'gina@example.com' });
    return new Response('?', { status: 404 });
  };
  return { fetch, calls, tokenCalls: () => calls.filter((c) => c.url.includes('token')).length };
}

const firstCookie = (setCookie: string | string[] | undefined, name: string) =>
  ([] as string[]).concat(setCookie ?? []).find((c) => c.startsWith(`${name}=`));

async function start(s: TestServer, provider: string, next?: string) {
  const res = await s.app.inject({ method: 'GET', url: `/api/owner/login/${provider}${next !== undefined ? `?next=${encodeURIComponent(next)}` : ''}` });
  expect(res.statusCode).toBe(302);
  const url = new URL(res.headers.location as string);
  const raw = firstCookie(res.headers['set-cookie'], s.config.production ? '__Host-ajwf_oauth' : 'ajwf_oauth')!;
  return { url, state: url.searchParams.get('state')!, cookie: raw.split(';')[0]!, raw };
}

function callback(s: TestServer, provider: string, o: { cookie?: string; state: string; code?: string }) {
  return s.app.inject({
    method: 'GET',
    url: `/api/owner/oauth/${provider}/callback?code=${o.code ?? 'CODE-1234'}&state=${encodeURIComponent(o.state)}`,
    headers: o.cookie ? { cookie: o.cookie } : {},
  });
}

const sessionOf = (res: { headers: Record<string, unknown> }, name = 'ajwf_session') => firstCookie(res.headers['set-cookie'] as string[] | string | undefined, name)?.split(';')[0];

describe('OAuth login (authorization code + PKCE + state)', () => {
  it('GitHub: PKCE S256, state, redirect URI from PUBLIC_URL; keeps only id and name; discards the token', async () => {
    const p = fakeProvider();
    const s = await makeServer({ config: { oauth: OAUTH }, fetch: p.fetch });
    const { url, state, cookie, raw } = await start(s, 'github', '/owner');
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('gh-client');
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/owner/oauth/github/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).toMatch(/Max-Age=600/);

    const res = await callback(s, 'github', { cookie, state });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${ORIGIN}/owner`);
    const session = sessionOf(res)!;
    expect(session).toMatch(/^ajwf_session=[A-Za-z0-9_-]{43}$/);
    // The token request carried the verifier behind the challenge, the client secret and the same redirect URI.
    const tokenCall = p.calls.find((c) => c.url.includes('access_token'))!;
    const form = new URLSearchParams(tokenCall.body);
    expect(challenge(form.get('code_verifier')!)).toBe(url.searchParams.get('code_challenge'));
    expect(form.get('client_secret')).toBe('gh-secret');
    expect(form.get('redirect_uri')).toBe(`${ORIGIN}/api/owner/oauth/github/callback`);
    expect(p.calls.find((c) => c.url === 'https://api.github.com/user')!.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

    const me = await s.owner(session, 'GET', '/api/owner/me');
    expect(me.json()).toMatchObject({ ok: true, owner: { name: 'Octo Cat', provider: 'github' }, agents: [] });
    const [owner] = [...s.store.owners.values()];
    expect(owner).toMatchObject({ provider: 'github', externalId: '4242', name: 'Octo Cat' });
    const stored = JSON.stringify({ owners: [...s.store.owners.values()], sessions: [...s.store.sessions.entries()] });
    expect(stored).not.toContain('octo@example.com');
    expect(stored).not.toContain(ACCESS_TOKEN);
    const value = session.split('=')[1]!;
    expect(stored).not.toContain(value);
    expect(s.store.sessions.has(sha256(value))).toBe(true);
  });

  it('Google: openid profile scope (no email), identity from the subject id', async () => {
    const p = fakeProvider();
    const s = await makeServer({ config: { oauth: OAUTH }, fetch: p.fetch });
    const { url, state, cookie } = await start(s, 'google');
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(url.searchParams.get('response_type')).toBe('code');
    const res = await callback(s, 'google', { cookie, state });
    expect(res.headers.location).toBe(`${ORIGIN}/owner`);
    expect(new URLSearchParams(p.calls[0]!.body).get('grant_type')).toBe('authorization_code');
    expect([...s.store.owners.values()][0]).toMatchObject({ provider: 'google', externalId: 'g-123', name: 'Gina' });
    expect(JSON.stringify([...s.store.owners.values()])).not.toContain('gina@');
  });

  it('refuses a state that does not match the cookie, and a callback without the cookie', async () => {
    const p = fakeProvider();
    const s = await makeServer({ config: { oauth: OAUTH }, fetch: p.fetch });
    const { state, cookie } = await start(s, 'github');
    for (const res of [await callback(s, 'github', { cookie, state: `${state.slice(0, -1)}x` }), await callback(s, 'github', { state }), await callback(s, 'google', { cookie, state })]) {
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${ORIGIN}/owner?login_error=state`);
      expect(sessionOf(res)).toBeUndefined();
    }
    expect(p.tokenCalls()).toBe(0);
    expect(s.store.sessions.size).toBe(0);
  });

  it('refuses a replayed state (same cookie and state twice)', async () => {
    const p = fakeProvider();
    const s = await makeServer({ config: { oauth: OAUTH }, fetch: p.fetch });
    const { state, cookie } = await start(s, 'github');
    expect(sessionOf(await callback(s, 'github', { cookie, state }))).toBeDefined();
    const replay = await callback(s, 'github', { cookie, state });
    expect(replay.headers.location).toBe(`${ORIGIN}/owner?login_error=state`);
    expect(sessionOf(replay)).toBeUndefined();
    expect(p.tokenCalls()).toBe(1);
  });

  it('refuses a signed attempt without a PKCE verifier, a tampered cookie, and an expired attempt', async () => {
    const p = fakeProvider();
    const s = await makeServer({ config: { oauth: OAUTH }, fetch: p.fetch });
    const state = 'S'.repeat(43);
    const signed = (v: string) => `ajwf_oauth=${fastifyCookie.sign(encodeAttempt({ p: 'github', s: state, v, n: '/owner', e: s.clock.now() + 60_000 }), s.config.sessionSecret)}`;
    expect((await callback(s, 'github', { cookie: signed(''), state })).headers.location).toBe(`${ORIGIN}/owner?login_error=state`);
    // Signed with another secret.
    const forged = `ajwf_oauth=${fastifyCookie.sign(encodeAttempt({ p: 'github', s: state, v: 'V'.repeat(43), n: '/owner', e: s.clock.now() + 60_000 }), 'x'.repeat(32))}`;
    expect((await callback(s, 'github', { cookie: forged, state })).headers.location).toBe(`${ORIGIN}/owner?login_error=state`);
    const { state: st, cookie } = await start(s, 'github');
    s.clock.advance(11 * 60_000);
    expect((await callback(s, 'github', { cookie, state: st })).headers.location).toBe(`${ORIGIN}/owner?login_error=expired`);
    expect(p.tokenCalls()).toBe(0);
  });

  it('reports provider errors: denied consent, failing token endpoint, token error body, failing identity', async () => {
    for (const mode of ['token_500', 'token_error', 'user_500'] as const) {
      const p = fakeProvider(mode);
      const s = await makeServer({ config: { oauth: OAUTH }, fetch: p.fetch });
      const { state, cookie } = await start(s, 'github');
      const res = await callback(s, 'github', { cookie, state });
      expect(res.headers.location, mode).toBe(`${ORIGIN}/owner?login_error=provider`);
      expect(s.store.owners.size).toBe(0);
    }
    const s = await makeServer({ config: { oauth: OAUTH }, fetch: fakeProvider().fetch });
    const { state, cookie } = await start(s, 'github');
    const denied = await s.app.inject({ method: 'GET', url: `/api/owner/oauth/github/callback?error=access_denied&state=${state}`, headers: { cookie } });
    expect(denied.headers.location).toBe(`${ORIGIN}/owner?login_error=denied`);
  });

  it('lands only on allowlisted relative paths (no open redirect)', async () => {
    const s = await makeServer({ config: { oauth: OAUTH }, fetch: fakeProvider().fetch });
    const token = 'A'.repeat(43);
    const cases: [string, string][] = [
      ['https://evil.example/steal', '/owner'],
      ['//evil.example', '/owner'],
      ['/\\evil.example', '/owner'],
      ['/owner/../../evil', '/owner'],
      ['javascript:alert(1)', '/owner'],
      ['/', '/'],
      [`/claim/${token}`, `/claim/${token}`],
    ];
    for (const [next, landing] of cases) {
      const { state, cookie } = await start(s, 'github', next);
      const res = await callback(s, 'github', { cookie, state });
      expect(res.headers.location, next).toBe(`${ORIGIN}${landing}`);
    }
  });

  it('offers only configured providers', async () => {
    const s = await makeServer({ config: { oauth: { github: OAUTH.github! } }, devLogin: false });
    expect((await s.app.inject({ method: 'GET', url: '/api/owner/providers' })).json()).toEqual({ ok: true, providers: ['github'], dev_login: false });
    expect((await s.app.inject({ method: 'GET', url: '/api/owner/login/google' })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: '/api/owner/login/myspace' })).statusCode).toBe(404);
    // Without DEV_LOGIN there is no dev login at all.
    expect((await s.app.inject({ method: 'POST', url: '/api/owner/dev-login', headers: { origin: ORIGIN }, payload: {} })).statusCode).toBe(404);
  });
});

describe('owner sessions', () => {
  it('development cookie: HttpOnly, SameSite=Lax, Path=/, 30 days, not Secure, plain name', async () => {
    const s = await makeServer();
    const res = await s.app.inject({ method: 'POST', url: '/api/owner/dev-login', headers: { origin: ORIGIN }, payload: { name: 'Ada' } });
    const raw = firstCookie(res.headers['set-cookie'], 'ajwf_session')!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(raw).toMatch(/Path=\//);
    expect(raw).toMatch(new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
    expect(raw).not.toMatch(/Secure/);
  });

  it('production cookies: __Host- prefix, Secure, HttpOnly, SameSite=Lax, Path=/', async () => {
    const pub = 'https://game.example';
    const s = await makeServer({ devLogin: false, config: { production: true, publicUrl: pub, oauth: OAUTH }, fetch: fakeProvider().fetch });
    const { state, cookie, raw } = await start(s, 'github');
    expect(cookie.startsWith('__Host-ajwf_oauth=')).toBe(true);
    expect(raw).toMatch(/Secure/);
    const res = await callback(s, 'github', { cookie, state });
    expect(res.headers.location).toBe(`${pub}/owner`);
    const session = firstCookie(res.headers['set-cookie'], '__Host-ajwf_session')!;
    for (const flag of [/Secure/, /HttpOnly/, /SameSite=Lax/, /Path=\//]) expect(session).toMatch(flag);
    expect(session).not.toMatch(/Domain=/);
    expect(res.headers['strict-transport-security']).toMatch(/max-age=/);
  });

  it('expires after 30 days, slides at most once a day, and logout deletes the row', async () => {
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    const id = sha256(cookie.split('=')[1]!);
    const created = s.store.sessions.get(id)!.expiresAt;
    s.clock.advance(3_600_000);
    const same = await s.owner(cookie, 'GET', '/api/owner/me');
    expect(same.statusCode).toBe(200);
    expect(same.headers['set-cookie']).toBeUndefined();
    expect(s.store.sessions.get(id)!.expiresAt).toBe(created);
    s.clock.advance(25 * 3_600_000);
    const slid = await s.owner(cookie, 'GET', '/api/owner/me');
    expect(sessionOf(slid)).toBe(cookie);
    expect(s.store.sessions.get(id)!.expiresAt).toBe(s.clock.now() + SESSION_TTL_MS);

    s.clock.advance(SESSION_TTL_MS + 1);
    expect((await s.owner(cookie, 'GET', '/api/owner/me')).statusCode).toBe(401);
    expect(s.store.sessions.has(id)).toBe(false);

    const again = await s.ownerLogin();
    const logout = await s.owner(again, 'POST', '/api/owner/logout');
    expect(logout.json()).toEqual({ ok: true });
    expect(String(logout.headers['set-cookie'])).toMatch(/ajwf_session=;.*Max-Age=0/);
    expect(s.store.sessions.size).toBe(0);
    expect((await s.owner(again, 'GET', '/api/owner/me')).statusCode).toBe(401);
  });

  it('ends 90 days after login however often it is refreshed; the cookie Max-Age follows the time left', async () => {
    const DAY = 24 * 3_600_000;
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    const id = sha256(cookie.split('=')[1]!);
    const login = s.clock.now();
    expect(s.store.sessions.get(id)!.createdAt).toBe(login);
    for (let day = 1; day < 90; day++) {
      s.clock.advance(DAY);
      const res = await s.owner(cookie, 'GET', '/api/owner/me');
      expect(res.statusCode, `day ${day}`).toBe(200);
      const row = s.store.sessions.get(id)!;
      expect(row.expiresAt, `day ${day}`).toBe(Math.min(s.clock.now() + SESSION_TTL_MS, login + SESSION_MAX_AGE_MS));
      expect(row.createdAt).toBe(login);
      const set = firstCookie(res.headers['set-cookie'], 'ajwf_session');
      // Once the expiry reaches the cap there is nothing left to extend: no write, no new cookie.
      if (day <= 60) expect(set, `day ${day}`).toMatch(new RegExp(`Max-Age=${Math.floor((row.expiresAt - s.clock.now()) / 1000)}(;|$)`));
      else expect(set, `day ${day}`).toBeUndefined();
    }
    s.clock.advance(DAY);
    expect(s.clock.now()).toBe(login + SESSION_MAX_AGE_MS);
    expect((await s.owner(cookie, 'GET', '/api/owner/me')).statusCode).toBe(401);
    expect(s.store.sessions.has(id)).toBe(false);
  });

  it('the cap also ends an older row whose stored expiry is later', async () => {
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    const id = sha256(cookie.split('=')[1]!);
    const row = s.store.sessions.get(id)!;
    row.createdAt = s.clock.now() - SESSION_MAX_AGE_MS;
    row.expiresAt = s.clock.now() + SESSION_TTL_MS;
    expect((await s.owner(cookie, 'GET', '/api/owner/me')).statusCode).toBe(401);
    expect(s.store.sessions.has(id)).toBe(false);
  });

  it('rotates the session at login: the browser\'s previous session is deleted', async () => {
    const s = await makeServer();
    const first = await s.ownerLogin('Ada');
    const res = await s.app.inject({ method: 'POST', url: '/api/owner/dev-login', headers: { origin: ORIGIN, cookie: first }, payload: { name: 'Ada' } });
    const second = sessionOf(res)!;
    expect(second).not.toBe(first);
    expect(s.store.sessions.size).toBe(1);
    expect((await s.owner(first, 'GET', '/api/owner/me')).statusCode).toBe(401);
    expect((await s.owner(second, 'GET', '/api/owner/me')).statusCode).toBe(200);
  });

  it('GET /session tells the navigation who is logged in, without a 401 for anonymous visitors', async () => {
    const s = await makeServer();
    const anon = await s.app.inject({ method: 'GET', url: '/api/owner/session' });
    expect(anon.statusCode).toBe(200);
    expect(anon.json()).toEqual({ ok: true, owner: null });
    const cookie = await s.ownerLogin('Ada');
    expect((await s.owner(cookie, 'GET', '/api/owner/session')).json()).toEqual({ ok: true, owner: { name: 'Ada', language: 'en' } });
    expect((await s.owner(cookie, 'GET', '/api/owner/session', undefined, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
  });

  it('ignores malformed and unknown session cookies', async () => {
    const s = await makeServer();
    for (const cookie of ['ajwf_session=short', `ajwf_session=${'A'.repeat(43)}`, 'other=1']) {
      expect((await s.owner(cookie, 'GET', '/api/owner/me')).json().error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('CSRF on owner routes', () => {
  it('needs the session, the same Origin (or Sec-Fetch-Site: same-origin) and a JSON body on every write', async () => {
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    const { token } = await s.registerUnclaimed('Pip');
    await s.owner(cookie, 'POST', `/api/owner/claim/${token}`);
    const id = s.game.agentByName('Pip')!.id;
    const url = `/api/owner/agents/${id}/note`;
    const put = (headers: Record<string, string>, payload: string) => s.app.inject({ method: 'PUT', url, headers: { cookie, ...headers }, payload });
    const json = { 'content-type': 'application/json' };
    const body = JSON.stringify({ note: 'be kind' });

    expect((await put({ ...json }, body)).statusCode).toBe(403);
    expect((await put({ ...json, origin: 'https://evil.example' }, body)).statusCode).toBe(403);
    expect((await put({ ...json, origin: 'null' }, body)).statusCode).toBe(403);
    expect((await put({ ...json, 'sec-fetch-site': 'cross-site' }, body)).statusCode).toBe(403);
    expect((await put({ origin: ORIGIN, 'content-type': 'text/plain' }, body)).statusCode).toBe(415);
    expect((await put({ origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, 'note=x')).statusCode).toBe(415);
    expect((await s.app.inject({ method: 'POST', url: `/api/owner/agents/${id}/retire`, headers: { cookie, origin: ORIGIN } })).statusCode).toBe(415);
    expect((await s.app.inject({ method: 'PUT', url, headers: { ...json, origin: ORIGIN }, payload: body })).statusCode).toBe(401);
    expect(s.game.agentByName('Pip')!.ownerNote).toBe('');
    expect(s.game.agentByName('Pip')!.status).toBe('active');

    expect((await put({ ...json, origin: ORIGIN }, body)).json()).toEqual({ ok: true, note: 'be kind' });
    expect((await put({ ...json, 'sec-fetch-site': 'same-origin' }, JSON.stringify({ note: 'again' }))).json().ok).toBe(true);
  });

  it('refuses cross-site reads and never answers with CORS headers', async () => {
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    const cross = await s.owner(cookie, 'GET', '/api/owner/me', undefined, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(cross.statusCode).toBe(403);
    const ok = await s.owner(cookie, 'GET', '/api/owner/me', undefined, { 'sec-fetch-site': 'same-origin' });
    expect(ok.statusCode).toBe(200);
    for (const res of [cross, ok, await s.app.inject({ method: 'OPTIONS', url: '/api/owner/me', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } })]) {
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  it('accepts the dev web origin only when configured', async () => {
    const s = await makeServer({ config: { extraOrigins: ['http://localhost:5710'] } });
    const res = await s.app.inject({ method: 'POST', url: '/api/owner/dev-login', headers: { origin: 'http://localhost:5710' }, payload: {} });
    expect(res.statusCode).toBe(200);
    const plain = await makeServer();
    expect((await plain.app.inject({ method: 'POST', url: '/api/owner/dev-login', headers: { origin: 'http://localhost:5710' }, payload: {} })).statusCode).toBe(403);
  });
});
