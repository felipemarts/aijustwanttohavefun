import { describe, expect, it } from 'vitest';
import { IdempotencyCache } from './idempotency';
import { ipKey, RateLimiter } from './rate-limit';
import { ADMIN, makeServer } from './test-helpers';

describe('rate limits', () => {
  it('counts IPv6 clients by /64, so rotating addresses inside one allocation does not reset the limits', async () => {
    expect(ipKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
    const s = await makeServer();
    const reg = (ip: string, name: string) =>
      s.app.inject({ method: 'POST', url: '/api/v1/agents/register', remoteAddress: ip, payload: { name, class: 'warrior' } });
    for (let i = 0; i < 5; i++) expect((await reg(`2001:db8:1:2::${i + 1}`, `Six${'abcde'[i]}`)).json().ok).toBe(true);
    // A sixth address in the same /64 is the same client; another /64 is not.
    expect((await reg('2001:db8:1:2:dead:beef:0:1', 'Sixf')).statusCode).toBe(429);
    expect((await reg('2001:db8:1:3::1', 'Sixg')).json().ok).toBe(true);
  });

  it('gives every request a time limit, so slow clients cannot hold connections forever', async () => {
    const s = await makeServer();
    expect(s.app.server.requestTimeout).toBe(30_000);
    expect(s.app.server.headersTimeout).toBeLessThanOrEqual(60_000);
  });

  it('allows 60 requests per minute per API key; the 61st gets 429 with Retry-After', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    for (let i = 0; i < 60; i++) expect((await s.get(key, '/api/v1/look')).statusCode).toBe(200);
    const res = await s.act(key, 'move', { dir: 'north' });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    // Refused requests do not act.
    expect(s.game.agentByName('Pip')!.room).toBe('village.square');
    // Another key has its own budget.
    const other = await s.register('Brasa');
    expect((await s.get(other.key, '/api/v1/look')).statusCode).toBe(200);
    s.clock.advance(1000);
    expect((await s.get(key, '/api/v1/look')).statusCode).toBe(200);
  });

  it('a valid admin token skips the per-IP limits on registration only; a wrong token does not', async () => {
    const s = await makeServer();
    const reg = (ip: string, name: string, token?: string) =>
      s.app.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        remoteAddress: ip,
        headers: token ? { 'x-admin-token': token } : {},
        payload: { name, class: 'warrior', appearance: 'surprise_me' },
      });
    // 300 bot registrations from one address in the same minute.
    for (let i = 0; i < 300; i++) {
      const res = await reg('203.0.113.50', `Bot${i}q`, ADMIN);
      expect(res.statusCode, `registration ${i}`).toBe(200);
      expect(res.json().ok).toBe(true);
    }
    // They did not spend that address's anonymous budget, which still applies to everything else.
    const help = () => s.app.inject({ method: 'GET', url: '/api/v1/help', remoteAddress: '203.0.113.50' });
    for (let i = 0; i < 120; i++) expect((await help()).statusCode).toBe(200);
    expect((await help()).statusCode).toBe(429);
    // Once the address is limited: no token or a wrong token stays limited, the valid token still registers.
    expect((await reg('203.0.113.50', 'Nobody1q')).statusCode).toBe(429);
    expect((await reg('203.0.113.50', 'Nobody2q', 'wrong-token')).statusCode).toBe(429);
    expect((await reg('203.0.113.50', 'Nobody3q', `${ADMIN}x`)).statusCode).toBe(429);
    expect((await reg('203.0.113.50', 'Tokened1q', ADMIN)).json().ok).toBe(true);
    // Without the token the anonymous limit applies to registration too (120 per minute per address).
    let last = 200;
    let n = 0;
    while (last !== 429 && n < 200) {
      last = (await reg('203.0.113.51', `Plain${n++}q`, 'wrong-token')).statusCode;
    }
    expect(last).toBe(429);
    expect(n).toBeLessThanOrEqual(121);
  });

  it('allows 5 registrations per hour per IP, and X-Forwarded-For cannot dodge it by default', async () => {
    const s = await makeServer();
    const reg = (i: number, headers: Record<string, string> = {}) =>
      s.app.inject({ method: 'POST', url: '/api/v1/agents/register', remoteAddress: '203.0.113.7', headers, payload: { name: `Newbie${i}x`, class: 'cleric' } });
    for (let i = 0; i < 5; i++) expect((await reg(i)).json().ok).toBe(true);
    const sixth = await reg(5);
    expect(sixth.statusCode).toBe(429);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(60);
    expect((await reg(6, { 'x-forwarded-for': '192.0.2.99' })).statusCode).toBe(429);
    // Admin token holders (test bots) are not limited.
    expect((await reg(7, { 'x-admin-token': s.config.adminToken! })).json().ok).toBe(true);
    // A different address is.
    const elsewhere = await s.app.inject({ method: 'POST', url: '/api/v1/agents/register', remoteAddress: '203.0.113.8', payload: { name: 'Elsewhere', class: 'cleric' } });
    expect(elsewhere.json().ok).toBe(true);
  });

  it('limits failed authentication per IP, so keys cannot be guessed at full speed', async () => {
    const s = await makeServer();
    const bad = () => s.app.inject({ method: 'GET', url: '/api/v1/look', remoteAddress: '203.0.113.50', headers: { authorization: 'Bearer nope' } });
    for (let i = 0; i < 120; i++) expect((await bad()).statusCode).toBe(401);
    expect((await bad()).statusCode).toBe(429);
  });

  it('limits GET /appearance/options to 30 per minute per IP', async () => {
    const s = await makeServer();
    const get = () => s.app.inject({ method: 'GET', url: '/api/v1/appearance/options', remoteAddress: '203.0.113.60' });
    for (let i = 0; i < 30; i++) expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(429);
  });

  it('keeps the bucket map bounded', () => {
    const rl = new RateLimiter(2, 1000, 10);
    for (let i = 0; i < 100; i++) rl.take(`ip${i}`, 0);
    expect(rl.size).toBeLessThanOrEqual(10);
    rl.sweep(10_000);
    expect(rl.size).toBe(0);
  });
});

describe('idempotency cache', () => {
  it('remembers 32 keys per agent for 10 minutes', () => {
    const c = new IdempotencyCache();
    for (let i = 0; i < 40; i++) c.set('a1', `k${i}`, `body${i}`, 0);
    expect(c.get('a1', 'k0', 0)).toBeUndefined();
    expect(c.get('a1', 'k8', 0)).toBe('body8');
    expect(c.get('a1', 'k39', 0)).toBe('body39');
    expect(c.get('a2', 'k39', 0)).toBeUndefined();
    expect(c.get('a1', 'k39', 10 * 60_000)).toBeUndefined();
  });
});
