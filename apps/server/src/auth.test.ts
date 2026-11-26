import { randomBytes } from 'node:crypto';
import { API_KEY_PREFIX } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { bearerKeyHash, isAdminToken, sha256 } from './auth';
import { makeServer } from './test-helpers';

describe('authentication', () => {
  it('answers 401 UNAUTHORIZED to missing, malformed and wrong keys', async () => {
    const s = await makeServer();
    await s.register('Pip');
    const wrongKey = API_KEY_PREFIX + randomBytes(32).toString('base64url');
    const headers: (Record<string, string> | undefined)[] = [
      undefined,
      { authorization: 'Bearer' },
      { authorization: 'Bearer not-a-key' },
      { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` },
      { authorization: `Bearer ${API_KEY_PREFIX}short` },
      { authorization: `Bearer ${wrongKey}` },
    ];
    for (const h of headers) {
      const res = await s.app.inject({ method: 'GET', url: '/api/v1/look', headers: h });
      expect(res.statusCode, JSON.stringify(h)).toBe(401);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
      expect(res.json().error.hint).toMatch(/Bearer/);
    }
    for (const url of ['/api/v1/me', '/api/v1/events']) expect((await s.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'POST', url: '/api/v1/act', payload: { action: 'flee' } })).statusCode).toBe(401);
  });

  it('accepts the key it issued, and stores only its SHA-256 hash', async () => {
    const s = await makeServer();
    const res = await s.app.inject({ method: 'POST', url: '/api/v1/agents/register', remoteAddress: '198.51.100.9', payload: { name: 'Pip', class: 'rogue' } });
    const { api_key: key, claim_url: claimUrl } = res.json();
    expect((await s.get(key, '/api/v1/look')).statusCode).toBe(200);
    expect((await s.app.inject({ method: 'GET', url: '/api/v1/look', headers: { authorization: `bearer   ${key}` } })).statusCode).toBe(200);

    const rec = [...s.store.agents.values()][0]!;
    expect(rec.keyHash).toBe(sha256(key));
    const claimToken = claimUrl.split('/').pop();
    expect(rec.claimTokenHash).toBe(sha256(claimToken));
    await s.persistence.snapshot();
    const everything = JSON.stringify([[...s.store.agents.values()], [...s.store.agentSnapshots.values()], [...s.store.worldSnapshots.values()]]);
    expect(everything).not.toContain(key);
    expect(everything).not.toContain(claimToken);
  });

  it('parses only well-formed bearer keys', () => {
    const key = API_KEY_PREFIX + 'A'.repeat(43);
    expect(bearerKeyHash(`Bearer ${key}`)).toBe(sha256(key));
    expect(bearerKeyHash(`Bearer ${key}x`)).toBeNull();
    expect(bearerKeyHash(`Token ${key}`)).toBeNull();
    expect(bearerKeyHash(undefined)).toBeNull();
  });

  it('compares the admin token in constant time and only when one is configured', () => {
    expect(isAdminToken('secret-token', 'secret-token')).toBe(true);
    expect(isAdminToken('secret-tokeN', 'secret-token')).toBe(false);
    expect(isAdminToken('short', 'secret-token')).toBe(false);
    expect(isAdminToken(['secret-token'], 'secret-token')).toBe(false);
    expect(isAdminToken('', undefined)).toBe(false);
    expect(isAdminToken('anything', undefined)).toBe(false);
  });
});

describe('HTTP hygiene', () => {
  it('sets nosniff everywhere, no-store on authenticated answers and CORS only on public GET routes', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    const look = await s.get(key, '/api/v1/look');
    expect(look.headers['x-content-type-options']).toBe('nosniff');
    expect(look.headers['cache-control']).toBe('no-store');
    expect(look.headers['access-control-allow-origin']).toBeUndefined();
    const help = await s.app.inject({ method: 'GET', url: '/api/v1/help', headers: { origin: 'https://example.org' } });
    expect(help.headers['access-control-allow-origin']).toBe('*');
    expect(help.headers['access-control-allow-credentials']).toBeUndefined();
    const reg = await s.app.inject({ method: 'POST', url: '/api/v1/agents/register', headers: { origin: 'https://example.org' }, payload: {} });
    expect(reg.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('uses real statuses only for transport problems, all with the same error shape', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    const post = (payload: string, type: string) =>
      s.app.inject({ method: 'POST', url: '/api/v1/act', headers: { ...s.auth(key), 'content-type': type }, payload });
    const cases: [Promise<{ statusCode: number; json: () => { ok: boolean; error: { code: string; message: string } } }>, number, string][] = [
      [post('{"action": ', 'application/json'), 400, 'BAD_REQUEST'],
      [post('action=flee', 'application/x-www-form-urlencoded'), 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [post('flee', 'text/plain'), 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [post(JSON.stringify({ action: 'say', params: { text: 'x'.repeat(17 * 1024) } }), 'application/json'), 413, 'PAYLOAD_TOO_LARGE'],
      [s.app.inject({ method: 'GET', url: '/api/v1/nowhere' }), 404, 'NOT_FOUND'],
    ];
    for (const [pending, status, code] of cases) {
      const res = await pending;
      expect(res.statusCode, code).toBe(status);
      expect(res.json()).toMatchObject({ ok: false, error: { code } });
      expect(res.json().error.message).toMatch(/\w/);
    }
  });

  it('ignores unknown fields in bodies', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/v1/act',
      headers: s.auth(key),
      payload: { action: 'move', params: { dir: 'north', teleport: 'village.vault' }, agentId: 'a2' },
    });
    expect(res.json().ok).toBe(true);
    expect(s.game.agentByName('Pip')!.room).toBe('village.tavern');
  });
});
