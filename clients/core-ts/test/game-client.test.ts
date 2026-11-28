import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { GameClient, GameError, ordered, parseSchema, retryAfterMs } from '../src/game/client.ts';
import { get, obj, write } from '../src/playkit/jv.ts';
import { nodeFetch, systemClock } from '../src/node/index.ts';
import { FakeClock, MemoryKeyVault } from '../src/testing/index.ts';
import { Redactor } from '../src/util/redact.ts';
import { drive, httpServer, sendJson } from './helpers.ts';

// A made-up agent key, assembled from parts so that secret scanners do not mistake the fixture for a real one.
const KEY = ['ajwf', 'sk', 'PLANTEDKEY', '0123456789'].join('_');
const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')) as Record<string, unknown>;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup(handler: Parameters<typeof httpServer>[0], opts: { clock?: FakeClock; retries?: number; timeoutMs?: number } = {}) {
  const srv = await httpServer(handler);
  closers.push(srv.close);
  const vault = new MemoryKeyVault();
  await vault.set('k', KEY);
  const reach: boolean[] = [];
  const client = new GameClient(srv.url, {
    fetch: nodeFetch,
    clock: opts.clock ?? systemClock,
    vault,
    redactor: new Redactor(),
    retries: opts.retries ?? 2,
    timeoutMs: opts.timeoutMs ?? 15_000,
    onReachable: (r) => reach.push(r),
  });
  return { srv, client, reach };
}

describe('GameClient', () => {
  it('returns a refusal (HTTP 200, ok: false) from /act as a result and sends the key and the idempotency key', async () => {
    const { srv, client } = await setup((_req, res) => sendJson(res, 200, fixture('act-refused.json')));
    const r = await client.act('k', 'say', obj(['text', 'hi']), 'idem-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNCLAIMED_LIMIT');
    const hit = srv.hits[0]!;
    expect(hit.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(hit.headers['idempotency-key']).toBe('idem-1');
    expect(JSON.parse(hit.body)).toEqual({ action: 'say', params: { text: 'hi' } });
  });

  it('parses real look, me, events and register answers', async () => {
    const { client } = await setup((req, res) => {
      const map: Record<string, string> = { '/api/v1/look': 'look.json', '/api/v1/me': 'me.json', '/api/v1/events': 'events.json', '/api/v1/agents/register': 'register.json' };
      const f = map[(req.url ?? '').split('?')[0]!];
      if (f) sendJson(res, 200, fixture(f));
      else sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'nope' } });
    });
    expect((await client.look('k')).room?.id).toBe('village.square');
    expect((await client.me('k')).agent.claimed).toBe(false);
    expect((await client.events('k', '0')).events[0]?.kind).toBe('arrival');
    const reg = await client.register({ name: 'X', class: 'mage', language: 'en', appearance: 'surprise_me' });
    expect(reg.ok).toBe(true);
  });

  it('throws on a refusal from a read route, without the key in the message', async () => {
    const { client } = await setup((_req, res) => sendJson(res, 200, { ok: false, error: { code: 'WEIRD', message: `echo ${KEY}` } }));
    const e = await client.me('k').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GameError);
    expect((e as GameError).code).toBe('WEIRD');
    expect((e as Error).message).not.toContain(KEY);
    expect((e as Error).message).toMatch(/\[(hidden|key)\]/);
  });

  it('waits out a 429 Retry-After and retries', async () => {
    const clock = new FakeClock();
    let n = 0;
    const { srv, client } = await setup((_req, res) => (n++ === 0 ? sendJson(res, 429, { ok: false, error: { code: 'RATE_LIMITED', message: 'slow' } }, { 'retry-after': '3' }) : sendJson(res, 200, fixture('look.json'))), { clock });
    const t0 = clock.now();
    const r = await drive(clock, client.look('k'));
    expect(r.ok).toBe(true);
    expect(srv.hits.length).toBe(2);
    expect(clock.now() - t0).toBeGreaterThanOrEqual(3000);
  });

  it('gives up on a long Retry-After and reports it', async () => {
    const { client } = await setup((_req, res) => sendJson(res, 429, { ok: false, error: { code: 'RATE_LIMITED', message: 'slow' } }, { 'retry-after': '600' }));
    const e = (await client.look('k').catch((x: unknown) => x)) as GameError;
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.retryAfterMs).toBe(600_000);
  });

  it('keeps itself under 50 requests a minute per key', async () => {
    const clock = new FakeClock();
    const { srv, client } = await setup((_req, res) => sendJson(res, 200, fixture('look.json')), { clock });
    const t0 = clock.now();
    await drive(clock, Promise.all(Array.from({ length: 55 }, () => client.look('k'))), 500);
    expect(srv.hits.length).toBe(55);
    // 50 at once (the playkit's limit, under the server's 60), then one every 1.2 s.
    expect(clock.now() - t0).toBeGreaterThanOrEqual(5_500);
  });

  it('retries a 5xx and an /act keeps the same idempotency key on the retry', async () => {
    const clock = new FakeClock();
    let n = 0;
    const { srv, client } = await setup((_req, res) => (n++ < 1 ? sendJson(res, 502, { ok: false }) : sendJson(res, 200, fixture('act-talk.json'))), { clock });
    const r = await drive(clock, client.act('k', 'talk', obj(['npc', 'olga']), 'same-key'));
    expect(r.ok).toBe(true);
    expect(srv.hits.map((h) => h.headers['idempotency-key'])).toEqual(['same-key', 'same-key']);
  });

  it('does not repeat a register after a failure (it could register twice)', async () => {
    const clock = new FakeClock();
    const { srv, client } = await setup((_req, res) => sendJson(res, 503, {}), { clock });
    const e = (await drive(clock, client.register({ name: 'A', class: 'mage', language: 'en', appearance: 'surprise_me' }).catch((x: unknown) => x))) as GameError;
    expect(e.code).toBe('SERVER_ERROR');
    expect(srv.hits.length).toBe(1);
  });

  it('times out a server that never answers', async () => {
    const clock = new FakeClock();
    const { client, reach } = await setup(() => undefined, { clock, retries: 1, timeoutMs: 5_000 });
    const e = (await drive(clock, client.look('k').catch((x: unknown) => x), 500)) as GameError;
    expect(e.code).toBe('TIMEOUT');
    expect(reach).toContain(false);
  });

  it('reports a server that is down', async () => {
    const srv = await httpServer(() => undefined);
    const url = srv.url;
    await srv.close();
    const vault = new MemoryKeyVault();
    await vault.set('k', KEY);
    const client = new GameClient(url, { fetch: nodeFetch, clock: new FakeClock(), vault, redactor: new Redactor(), retries: 0 });
    const e = (await client.look('k').catch((x: unknown) => x)) as GameError;
    expect(e.code).toBe('NETWORK');
    expect(e.message).not.toContain(KEY);
  });

  it('reports a refused key (401) and a missing key', async () => {
    const { client } = await setup((_req, res) => sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'bad' } }));
    expect(((await client.look('k').catch((x: unknown) => x)) as GameError).code).toBe('UNAUTHORIZED');
    expect(((await client.look('missing').catch((x: unknown) => x)) as GameError).code).toBe('NO_KEY');
  });

  it('never follows a redirect to another host with the key', async () => {
    const other = await httpServer((_req, res) => sendJson(res, 200, fixture('look.json')));
    closers.push(other.close);
    const { client } = await setup((_req, res) => {
      res.writeHead(302, { location: `${other.url}/api/v1/look` });
      res.end();
    });
    const e = (await client.look('k').catch((x: unknown) => x)) as GameError;
    expect(e.code).toBe('REDIRECT');
    expect(other.hits.length).toBe(0);
  });

  it('reads /schema, and falls back to /help on a server without it', async () => {
    const { client } = await setup((req, res) => (req.url === '/api/v1/schema' ? sendJson(res, 200, fixture('schema.json')) : sendJson(res, 404, {})));
    const s = await client.schema();
    expect(s.actions.length).toBe(80);
    expect(s.actions.find((a) => a.name === 'attack')?.ap).toBe(1);
    expect(s.skillVersion).toBe('1.3.0');

    const old = await setup((req, res) =>
      req.url === '/api/v1/help' ? sendJson(res, 200, { ok: true, skill_version: '1.0', actions: [{ name: 'move', ap: 1, params: { type: 'object' } }] }) : sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'x' } }),
    );
    expect((await old.client.schema()).actions.map((a) => a.name)).toEqual(['move']);
  });

  it('keeps member order as received (integer-like keys too) and refuses duplicate keys', async () => {
    const { client } = await setup((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url === '/api/v1/me' ? '{"ok":true,"inventory":{"z":1,"10":2,"a":3}}' : '{"ok":true,"ok":true}');
    });
    const me = await client.me('k');
    expect(write(get(ordered(me), 'inventory')!)).toBe('{"z":1,"10":2,"a":3}');
    expect(Object.keys(JSON.parse(JSON.stringify(me)))).toEqual(['ok', 'inventory']);
    expect(((await client.look('k').catch((x: unknown) => x)) as GameError).code).toBe('BAD_RESPONSE');
  });

  it('revalidates the action schema with its ETag (304 keeps the copy)', async () => {
    const schema = readFileSync(new URL('./fixtures/schema.json', import.meta.url), 'utf8');
    const { srv, client } = await setup((req, res) => {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304, { etag: '"v1"' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' });
      res.end(schema);
    });
    const first = await client.schemaDoc();
    expect(first?.etag).toBe('"v1"');
    expect(first?.doc.actions.length).toBe(80);
    expect(first?.doc.get('attack')?.ap).toBe(1);
    expect(await client.schemaDoc('"v1"')).toBeNull();
    expect(srv.hits[1]!.headers['if-none-match']).toBe('"v1"');
  });

  it('parses Retry-After in seconds and as a date, and refuses junk schemas', () => {
    expect(retryAfterMs('5', 0)).toBe(5000);
    expect(retryAfterMs(null, 0)).toBe(1000);
    expect(retryAfterMs(new Date(60_000).toUTCString(), 0)).toBe(60_000);
    expect(() => parseSchema({ actions: [{ name: '__proto__' }, { name: 'Bad Name' }] })).toThrow(GameError);
    expect(parseSchema({ actions: { move: { ap: 1, params: { type: 'object' } } } }).actions[0]?.name).toBe('move');
  });
});
