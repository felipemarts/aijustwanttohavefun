import { describe, expect, it } from 'vitest';
import { IdempotencyCache } from './idempotency';
import { RateLimiter } from './rate-limit';
import { makeServer } from './test-helpers';

describe('rate limits', () => {
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
