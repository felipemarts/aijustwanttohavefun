import type { AddressInfo } from 'node:net';
import type { SpectatorServerMsg } from '@ajwf/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { makeServer, type TestServer } from '../test-helpers';
import { clientIp, ipMatches } from './socket';

const open: TestServer[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) {
    s.spectators.stop();
    await s.app.close();
  }
});

async function listening(o: { wsMaxPerIp?: number } = {}) {
  const s = await makeServer(o);
  open.push(s);
  await s.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = s.app.server.address() as AddressInfo;
  return { s, port, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws/spectate` };
}

/** A ws client that records every message and can wait for one matching a predicate. */
function client(url: string) {
  const ws = new WebSocket(url, { perMessageDeflate: true });
  const msgs: SpectatorServerMsg[] = [];
  const waiters: { pred: (m: SpectatorServerMsg) => boolean; resolve: (m: SpectatorServerMsg) => void }[] = [];
  ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as SpectatorServerMsg;
    msgs.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  });
  const next = (pred: (m: SpectatorServerMsg) => boolean, ms = 3000) =>
    new Promise<SpectatorServerMsg>((resolve, reject) => {
      const hit = msgs.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), ms);
      waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const closed = new Promise<{ code: number }>((resolve) => ws.once('close', (code) => resolve({ code })));
  return { ws, msgs, next, opened, closed };
}

describe('spectator WebSocket (real socket)', () => {
  it('subscribes to a room and receives a say made through the API', async () => {
    const { s, base, ws } = await listening();
    s.spectators.start();
    const reg = await fetch(`${base}/api/v1/agents/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'test-admin-token-0123456789' },
      body: JSON.stringify({ name: 'Pip', class: 'warrior', claimed: true }),
    });
    const { api_key: key } = (await reg.json()) as { api_key: string };

    const c = client(ws);
    await c.opened;
    expect(c.ws.extensions).toContain('permessage-deflate');
    expect(await c.next((m) => m.t === 'hello')).toMatchObject({ t: 'hello', v: 1 });
    c.ws.send(JSON.stringify({ op: 'sub', topics: ['room:village.square'] }));
    const full = await c.next((m) => m.t === 'full');
    expect(full).toMatchObject({ topic: 'room:village.square', data: { room: { id: 'village.square' }, agents: [{ n: 'Pip' }] } });

    const said = await fetch(`${base}/api/v1/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ action: 'say', params: { text: 'Hello, spectators!' } }),
    });
    expect(((await said.json()) as { ok: boolean }).ok).toBe(true);
    const batch = await c.next((m) => m.t === 'batch' && m.events.some((e) => e.type === 'say'));
    expect(batch).toMatchObject({ topic: 'room:village.square' });
    const events = batch.t === 'batch' ? batch.events : [];
    expect(events.find((e) => e.type === 'say')).toEqual({
      id: expect.any(String),
      ts: expect.any(Number),
      type: 'say',
      room: 'village.square',
      actor: 'Pip',
      text: 'Hello, spectators!',
      lang: 'en',
      drama: 1,
    });
    // The arrival is either in the full state's log or (if not flushed yet when we subscribed) in a batch: once.
    const log = full.t === 'full' ? (full.data as { log: { type: string }[] }).log : [];
    const later = c.msgs.flatMap((m) => (m.t === 'batch' ? m.events : []));
    expect([...log, ...later].filter((e) => e.type === 'arrival')).toHaveLength(1);

    c.ws.send(JSON.stringify({ op: 'ping' }));
    expect(await c.next((m) => m.t === 'pong')).toEqual({ t: 'pong' });
    expect(s.spectators.connections).toBe(1);
    c.ws.close();
    await c.closed;
  });

  it('closes on messages over 1 KB, refuses other paths and enforces the per-IP limit before the handshake', async () => {
    const { s, ws, base } = await listening({ wsMaxPerIp: 2 });
    const big = client(ws);
    await big.opened;
    big.ws.send(JSON.stringify({ op: 'sub', topics: ['x'.repeat(2000)] }));
    expect((await big.closed).code).toBe(1009);

    const wrong = new WebSocket(`${base.replace('http', 'ws')}/ws/other`);
    wrong.on('error', () => {});
    const status = await new Promise<number>((resolve) => wrong.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(404);
    wrong.terminate();

    const a = client(ws);
    const b = client(ws);
    await Promise.all([a.opened, b.opened]);
    const third = new WebSocket(ws);
    third.on('error', () => {});
    const refused = await new Promise<number>((resolve) => third.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    expect(refused).toBe(429);
    third.terminate();
    expect(s.metrics.wsRejected).toBe(1);
    a.ws.close();
    b.ws.close();
    await Promise.all([a.closed, b.closed]);
  });
});

describe('client IP behind proxies', () => {
  it('ignores X-Forwarded-For unless the proxy is trusted', () => {
    expect(clientIp('10.0.0.5', '1.2.3.4', false)).toBe('10.0.0.5');
    expect(clientIp('10.0.0.5', '1.2.3.4, 10.0.0.9', true)).toBe('1.2.3.4');
    expect(clientIp('10.0.0.5', '6.6.6.6, 1.2.3.4', ['10.0.0.0/8'])).toBe('1.2.3.4');
    expect(clientIp('10.0.0.5', '6.6.6.6, 1.2.3.4, 10.1.1.1', ['10.0.0.0/8'])).toBe('1.2.3.4');
    expect(clientIp('192.0.2.1', '1.2.3.4', ['10.0.0.0/8'])).toBe('192.0.2.1');
    expect(clientIp('::ffff:10.0.0.5', '1.2.3.4', ['10.0.0.0/8'])).toBe('1.2.3.4');
  });

  it('matches exact addresses and IPv4 ranges', () => {
    expect(ipMatches('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipMatches('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipMatches('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(ipMatches('::1', '::1')).toBe(true);
    expect(ipMatches('1.2.3.4', '0.0.0.0/0')).toBe(true);
    expect(ipMatches('1.2.3.4', 'bad/99')).toBe(false);
  });
});
