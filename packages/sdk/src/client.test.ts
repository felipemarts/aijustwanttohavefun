import { describe, expect, it } from 'vitest';
import { ApiError, createClient, isRefusal, type FetchLike } from './index';

const KEY = 'ajwf_sk_' + 'A'.repeat(43);
const ADMIN = 'admin-secret-token';

type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A fake `fetch` that records requests and answers from a script (a Response, or an Error to throw). */
function fakeFetch(script: (req: Seen, n: number) => Response | Error) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    seen.push(req);
    const out = script(req, seen.length);
    if (out instanceof Error) throw out;
    return out;
  };
  return { fetch, seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const okAct = { ok: true, narration: 'You move north.', you: { lvl: 1, hp: [10, 10], mp: [5, 5], ap: [239, 240], gold: 25, xp: [0, 100], bag: [2, 30] }, actions: ['move'], cursor: '3' };

function client(fetch: FetchLike, extra: Partial<Parameters<typeof createClient>[0]> = {}) {
  const waits: number[] = [];
  const c = createClient({ baseUrl: 'http://game.test/', apiKey: KEY, fetch, sleep: async (ms) => void waits.push(ms), ...extra });
  return { c, waits };
}

describe('createClient', () => {
  it('sends the key as a bearer token to /api/v1 and returns the parsed body', async () => {
    const f = fakeFetch(() => json({ ok: true, cursor: '0', you: okAct.you }));
    const { c } = client(f.fetch);
    const r = await c.look({ verbose: true, sinceCursor: true });
    expect(r.ok).toBe(true);
    expect(f.seen[0]!.url).toBe('http://game.test/api/v1/look?verbose=1&since_cursor=1');
    expect(f.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('accepts a base URL that already ends in /api/v1', () => {
    expect(createClient({ baseUrl: 'http://game.test/api/v1/' }).baseUrl).toBe('http://game.test/api/v1');
  });

  it('returns game refusals instead of throwing, and does not retry them', async () => {
    const f = fakeFetch(() => json({ ok: false, error: { code: 'NOT_ENOUGH_AP', message: 'Too tired.' } }));
    const { c } = client(f.fetch);
    const r = await c.act('flee');
    expect(isRefusal(r)).toBe(true);
    if (!r.ok) expect(r.error.code).toBe('NOT_ENOUGH_AP');
    expect(f.seen).toHaveLength(1);
  });

  it('types action params from the shared schemas', async () => {
    const f = fakeFetch(() => json(okAct));
    const { c } = client(f.fetch);
    await c.act('move', { dir: 'north' });
    await c.act('shop_buy', { npc: 'olga', item: 'minor_potion' }); // qty has a server default
    await c.act('rest');
    // @ts-expect-error move needs a direction
    await c.act('move');
    // @ts-expect-error unknown param type
    await c.act('move', { dir: 3 });
    // @ts-expect-error unknown action
    await c.act('fly', {});
    expect(f.seen[1]!.body).toEqual({ action: 'shop_buy', params: { npc: 'olga', item: 'minor_potion' } });
  });

  it('gives every act an idempotency key and reuses it after a network failure, so the action applies once', async () => {
    const applied = new Map<string, unknown>();
    let calls = 0;
    const f = fakeFetch((req) => {
      calls++;
      const key = req.headers['idempotency-key']!;
      // The server applies the first attempt, but the answer is lost on the way back.
      if (!applied.has(key)) applied.set(key, okAct);
      return calls === 1 ? new TypeError('fetch failed: socket hang up') : json(applied.get(key));
    });
    const { c, waits } = client(f.fetch);
    const r = await c.act('move', { dir: 'north' });
    expect(r.ok).toBe(true);
    expect(f.seen).toHaveLength(2);
    expect(f.seen[0]!.headers['idempotency-key']).toMatch(/\S{16,}/);
    expect(f.seen[1]!.headers['idempotency-key']).toBe(f.seen[0]!.headers['idempotency-key']);
    expect(applied.size).toBe(1);
    expect(waits).toHaveLength(1);
    // Separate calls get separate keys; an explicit key is used as given.
    await c.act('rest');
    await c.act('rest', {}, { idempotencyKey: 'mine-1' });
    expect(f.seen[2]!.headers['idempotency-key']).not.toBe(f.seen[0]!.headers['idempotency-key']);
    expect(f.seen[3]!.headers['idempotency-key']).toBe('mine-1');
  });

  it('waits for Retry-After on 429 and retries, a bounded number of times', async () => {
    const f = fakeFetch((_req, n) => (n <= 2 ? json({ ok: false, error: { code: 'RATE_LIMITED', message: 'slow down' } }, 429, { 'retry-after': '2' }) : json(okAct)));
    const { c, waits } = client(f.fetch);
    expect((await c.act('rest')).ok).toBe(true);
    expect(waits).toEqual([2000, 2000]);
    expect(new Set(f.seen.map((s) => s.headers['idempotency-key'])).size).toBe(1);

    const always = fakeFetch(() => json({ ok: false, error: { code: 'RATE_LIMITED', message: 'slow down' } }, 429, { 'retry-after': '1' }));
    const one = client(always.fetch, { retries: 1 });
    const err = await one.c.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterSec: 1 });
    expect(always.seen).toHaveLength(2);
  });

  it('does not sit out a long Retry-After', async () => {
    const f = fakeFetch(() => json({ ok: false, error: { code: 'RATE_LIMITED', message: 'later' } }, 429, { 'retry-after': '3600' }));
    const { c, waits } = client(f.fetch);
    await expect(c.register({ name: 'Pip', class: 'mage' })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSec: 3600 });
    expect(waits).toEqual([]);
  });

  it('throws ApiError on transport problems, never with the key in it', async () => {
    const unauthorized = fakeFetch(() => json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid API key.' } }, 401));
    const e1 = await client(unauthorized.fetch).c.me().catch((e: unknown) => e);
    expect(e1).toMatchObject({ name: 'ApiError', code: 'UNAUTHORIZED', status: 401 });

    // A network layer that echoes the request (headers included) into its error message.
    const leaky = fakeFetch((req) => new Error(`connect failed for ${JSON.stringify(req.headers)} ${KEY}`));
    const e2 = await client(leaky.fetch, { retries: 0 }).c.look().catch((e: unknown) => e);
    expect(e2).toMatchObject({ code: 'NETWORK' });
    for (const e of [e1, e2]) {
      const text = `${String(e)} ${(e as Error).stack} ${JSON.stringify(e)}`;
      expect(text).not.toContain(KEY);
    }

    const broken = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(client(broken.fetch).c.village()).rejects.toMatchObject({ code: 'BAD_RESPONSE', status: 502 });
    const crashed = fakeFetch(() => json({ ok: false, error: { code: 'INTERNAL', message: 'oops' } }, 500));
    await expect(client(crashed.fetch).c.act('rest')).rejects.toMatchObject({ code: 'INTERNAL', status: 500 });
    expect(crashed.seen).toHaveLength(1);
  });

  it('never exposes the key on the client object', () => {
    const { c } = client(fakeFetch(() => json({ ok: true })).fetch);
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(Object.values(c).some((v) => v === KEY)).toBe(false);
    expect(c.hasApiKey).toBe(true);
  });

  it('refuses authenticated calls without a key, before any request', async () => {
    const f = fakeFetch(() => json({ ok: true }));
    const c = createClient({ baseUrl: 'http://game.test', fetch: f.fetch });
    await expect(c.me()).rejects.toMatchObject({ code: 'NO_API_KEY' });
    expect(f.seen).toHaveLength(0);
  });

  it('registers with the admin token and does not retry registration after a network failure', async () => {
    const f = fakeFetch(() => new TypeError('fetch failed'));
    const { c } = client(f.fetch, { adminToken: ADMIN });
    const err = await c.register({ name: 'Pip', class: 'mage', bot: true, claimed: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'NETWORK' });
    expect(String(err)).not.toContain(ADMIN);
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]!.headers['x-admin-token']).toBe(ADMIN);
    expect(f.seen[0]!.headers.authorization).toBeUndefined();
  });

  it('retries reads after a timeout', async () => {
    let n = 0;
    const fetch: FetchLike = (_url, init) => {
      n++;
      if (n === 1) {
        return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return Promise.resolve(json({ ok: true, time: 'day', population: 1, online: 1 }));
    };
    const c = createClient({ baseUrl: 'http://game.test', fetch, timeoutMs: 20, sleep: async () => {} });
    expect(await c.village()).toEqual({ ok: true, time: 'day', population: 1, online: 1 });
    expect(n).toBe(2);
  });

  it('village sends the key when the client has one (headline in the agent language) and works without one', async () => {
    const f = fakeFetch(() => json({ ok: true, time: 'day', population: 1, online: 1 }));
    await client(f.fetch).c.village();
    expect(f.seen[0]!.url).toBe('http://game.test/api/v1/village');
    expect(f.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    await client(f.fetch, { apiKey: undefined }).c.village();
    expect(f.seen[1]!.headers.authorization).toBeUndefined();
    // The other public routes never send it.
    await client(f.fetch).c.help();
    expect(f.seen[2]!.headers.authorization).toBeUndefined();
  });

  it('builds the events, profile and appearance URLs', async () => {
    const f = fakeFetch(() => json({ ok: true }));
    const { c } = client(f.fetch);
    await c.events(42);
    await c.events();
    await c.profile('Zé Ninguém');
    await c.appearanceOptions('pt-BR');
    await c.help();
    expect(f.seen.map((s) => s.url.replace('http://game.test/api/v1', ''))).toEqual([
      '/events?since=42',
      '/events',
      '/agents/Z%C3%A9%20Ningu%C3%A9m',
      '/appearance/options?lang=pt-BR',
      '/help',
    ]);
    expect(f.seen[4]!.headers.authorization).toBeUndefined();
  });
});
