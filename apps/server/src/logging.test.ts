import { describe, expect, it } from 'vitest';
import { scrubUrl } from './logger';
import type { FetchLike } from './owner/oauth';
import { ADMIN, makeServer, ORIGIN } from './test-helpers';

const ACCESS_TOKEN = 'gho_LOGGEDACCESSTOKEN0123456789';
const CODE = 'OAUTHCODE0123456789abcdef';

const provider: FetchLike = async (url) =>
  url.includes('access_token') ? Response.json({ access_token: ACCESS_TOKEN }) : Response.json({ id: 7, login: 'octo', name: 'Octo' });

describe('logs', () => {
  it('never contain API keys, claim tokens, the admin token, session cookies or OAuth secrets', async () => {
    const lines: string[] = [];
    const s = await makeServer({
      logStream: { write: (line: string) => void lines.push(line) },
      // Every request is logged at debug: the scrubbing must hold for all of them.
      logLevel: 'debug',
      config: { oauth: { github: { id: 'gh', secret: 'GH-CLIENT-SECRET-123' } } },
      fetch: provider,
    });

    const reg = await s.app.inject({ method: 'POST', url: '/api/v1/agents/register', remoteAddress: '198.51.100.40', payload: { name: 'Pip', class: 'mage' } });
    const { api_key: key, claim_url: claimUrl } = reg.json();
    const token = claimUrl.split('/').pop();
    await s.register('Brasa');
    await s.act(key, 'move', { dir: 'north' });
    await s.get(key, '/api/v1/me');
    await s.app.inject({ method: 'GET', url: '/api/v1/look', headers: { authorization: `Bearer ${key}x` } });

    // OAuth: the login start, then the callback with code and state in the query string.
    const start = await s.app.inject({ method: 'GET', url: `/api/owner/login/github?next=/claim/${token}` });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const oauthCookie = String(start.headers['set-cookie']).split(';')[0]!;
    const cb = await s.app.inject({ method: 'GET', url: `/api/owner/oauth/github/callback?code=${CODE}&state=${state}`, headers: { cookie: oauthCookie } });
    const session = String(cb.headers['set-cookie']).match(/ajwf_session=([A-Za-z0-9_-]{43})/)![1]!;
    // The claim page, the public claim preview and the claim itself carry the token in the path.
    await s.app.inject({ method: 'GET', url: `/claim/${token}` });
    await s.app.inject({ method: 'GET', url: `/api/owner/claim/${token}` });
    await s.app.inject({ method: 'POST', url: `/api/owner/claim/${token}`, headers: { cookie: `ajwf_session=${session}`, origin: ORIGIN }, payload: {} });
    const regen = await s.owner(`ajwf_session=${session}`, 'POST', `/api/owner/agents/${s.game.agentByName('Pip')!.id}/regenerate-key`);
    const newKey = regen.json().api_key as string;
    await s.app.inject({ method: 'GET', url: '/api/admin/reports', headers: { 'x-admin-token': ADMIN } });

    expect(lines.length).toBeGreaterThan(10);
    const all = lines.join('\n');
    expect(all).toContain('/api/v1/agents/register');
    expect(all).toContain('/api/owner/oauth/github/callback?[redacted]');
    expect(all).toContain('/claim/[redacted]');
    for (const secret of [key, newKey, token, ADMIN, session, CODE, state, ACCESS_TOKEN, 'GH-CLIENT-SECRET-123', oauthCookie.split('=')[1]!.slice(0, 30)]) {
      expect(all).not.toContain(secret);
    }
    expect(all).not.toContain('ajwf_sk_');
  });

  it('writes one line per request at debug, and only failures and slow requests at info', async () => {
    const lines: string[] = [];
    const s = await makeServer({ logStream: { write: (line: string) => void lines.push(line) } });
    const { key } = await s.register('Pip');
    await s.act(key, 'move', { dir: 'north' });
    await s.get(key, '/api/v1/me');
    expect(lines.filter((l) => l.includes('request'))).toEqual([]);

    const debug: string[] = [];
    const d = await makeServer({ logStream: { write: (line: string) => void debug.push(line) }, logLevel: 'debug' });
    await d.register('Pip');
    const done = debug.map((l) => JSON.parse(l) as { msg: string; req?: { url: string }; res?: { statusCode: number } }).filter((l) => l.msg === 'request completed');
    expect(done).toHaveLength(1);
    expect(done[0]!.req!.url).toBe('/api/v1/agents/register');
    expect(done[0]!.res!.statusCode).toBe(200);
  });

  it('scrubs claim tokens and query strings from logged URLs', () => {
    expect(scrubUrl('/claim/abc?x=1')).toBe('/claim/[redacted]?[redacted]');
    expect(scrubUrl('/api/owner/claim/abc')).toBe('/api/owner/claim/[redacted]');
    expect(scrubUrl('/api/owner/oauth/google/callback?code=x&state=y')).toBe('/api/owner/oauth/google/callback?[redacted]');
    expect(scrubUrl('/api/v1/look')).toBe('/api/v1/look');
  });
});
