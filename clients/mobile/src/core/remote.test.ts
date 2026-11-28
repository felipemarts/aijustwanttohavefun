/**
 * RemoteCore against a small fake of the Go program: plain node:http, the session exchange, JSON routes and SSE.
 * Node's fetch has no cookie jar, so `browserFetch` plays the browser: it keeps the session cookie the program sets
 * and sends it back on same-origin requests made with `credentials: 'same-origin'`, as a browser would.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteCore, parseEvent } from './remote';
import { CoreFailure, type ConnectionStatus, type CoreEvent } from './types';

const TOKEN = 'tok_one-time-123';
const SESSION = 'sess_abc';

type Seen = { method: string; url: string; auth: string | undefined; cookie: string | undefined; type: string | undefined; body: string };
type Sent = { url: string; credentials: RequestCredentials | undefined; headers: Record<string, string>; body: string | undefined };

let server: Server;
let base: string;
let seen: Seen[];
let sent: Sent[];
let streams: ServerResponse[];
let rejectEvents: boolean;
let tokenUsed: boolean;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function handler(req: IncomingMessage, res: ServerResponse) {
  let body = '';
  for await (const chunk of req) body += chunk;
  seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, cookie: req.headers.cookie, type: req.headers['content-type'], body });
  const url = new URL(req.url ?? '/', 'http://x');
  // As the Go side does: state-changing requests must be JSON.
  if (req.method !== 'GET' && req.headers['content-type'] !== 'application/json') return json(res, 415, { error: { code: 'bad_type', message: 'JSON only' } });
  if (url.pathname === '/core/session') {
    const token = (JSON.parse(body || '{}') as { token?: string }).token;
    if (token !== TOKEN || tokenUsed) return json(res, 401, { error: { code: 'unauthorized', message: 'bad token' } });
    tokenUsed = true;
    return json(res, 200, { ok: true }, { 'Set-Cookie': `ajwf_session=${SESSION}; HttpOnly; SameSite=Strict; Path=/` });
  }
  if (req.headers.cookie !== `ajwf_session=${SESSION}`) return json(res, 401, { error: { code: 'unauthorized', message: 'no session' } });
  if (url.pathname === '/core/events') {
    if (rejectEvents) return json(res, 503, { error: { code: 'busy', message: 'later' } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write(': hello\n\n');
    streams.push(res);
    return;
  }
  if (url.pathname === '/core/state') return json(res, 200, { version: '1.0.0', playkit: '0.1.0', platform: 'desktop', characters: [] });
  if (url.pathname.startsWith('/core/characters/') && url.pathname.endsWith('/log')) return json(res, 200, []);
  if (url.pathname === '/core/engine/providers') {
    const probe = url.searchParams.get('url');
    return json(res, 200, probe ? { kind: 'openai', label: 'OpenAI-compatible', url: probe, reachable: true, models: ['m1'] } : []);
  }
  if (url.pathname === '/core/characters' && req.method === 'POST') return json(res, 409, { error: { code: 'NAME_TAKEN', message: 'That name is taken.' } });
  if (url.pathname.endsWith('/command')) return json(res, 200, { ok: true });
  if (url.pathname.endsWith('/seen')) return json(res, 200, { id: 'c1', name: 'Pip', claimPending: false });
  if (url.pathname === '/core/characters/c1/claim') return json(res, 200, { url: 'https://game.example/claim/abc' });
  if (url.pathname === '/core/characters/c2/claim') return json(res, 200, { url: null });
  if (url.pathname === '/core/engine/download/pause' || url.pathname === '/core/engine/download') return json(res, 200, { choice: { kind: 'builtin' }, status: 'not_installed' });
  if (url.pathname.startsWith('/core/characters/') && req.method === 'DELETE') return json(res, 200, { ok: true });
  if (url.pathname === '/core/engine/test') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('not json');
  }
  return json(res, 404, { error: { code: 'not_found', message: 'no route' } });
}

/** A fetch with a cookie jar, standing in for the browser. One jar per "browser profile". */
function browserFetch(jar: Map<string, string> = new Map()): typeof fetch {
  return async (input, init = {}) => {
    const url = String(input);
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    sent.push({ url, credentials: init.credentials, headers: { ...headers }, body: typeof init.body === 'string' ? init.body : undefined });
    if (init.credentials === 'same-origin' && url.startsWith(base) && jar.size) {
      headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const res = await fetch(url, { ...init, headers });
    const set = res.headers.get('set-cookie');
    if (set && init.credentials !== 'omit') {
      const [pair] = set.split(';');
      const [k, v] = pair!.split('=');
      jar.set(k!.trim(), v!.trim());
    }
    return res;
  };
}

function until<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined && v !== false) return resolve(v);
      if (Date.now() - start > ms) return reject(new Error('timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function send(ev: unknown) {
  for (const s of streams) s.write(`data: ${JSON.stringify(ev)}\n\n`);
}

/** A core that has already been opened with the one-time token. */
function opened(backoff = [10]) {
  return new RemoteCore({ base, token: TOKEN, fetch: browserFetch(), backoff });
}

beforeEach(async () => {
  seen = [];
  sent = [];
  streams = [];
  rejectEvents = false;
  tokenUsed = false;
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const s of streams) s.destroy();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('RemoteCore session', () => {
  it('trades the token for a cookie once, then never sends the token again', async () => {
    const core = new RemoteCore({ base: `${base}/`, token: TOKEN, fetch: browserFetch(), backoff: [10] });
    const stop = core.subscribe(() => {});
    const [st] = await Promise.all([core.state(), core.log('c1'), core.engine().catch(() => null)]);
    await until(() => streams.length === 1 || undefined);
    stop();
    expect(st.version).toBe('1.0.0');
    const exchanges = seen.filter((s) => s.url === '/core/session');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({ method: 'POST', type: 'application/json' });
    expect(JSON.parse(exchanges[0]!.body)).toEqual({ token: TOKEN });
    // The exchange comes first; everything after rides on the cookie alone.
    expect(seen[0]!.url).toBe('/core/session');
    for (const s of seen.slice(1)) {
      expect(s.auth).toBeUndefined();
      expect(s.cookie).toBe(`ajwf_session=${SESSION}`);
      expect(`${s.url} ${s.body}`).not.toContain(TOKEN);
    }
    expect(sent.every((r) => r.credentials === 'same-origin')).toBe(true);
    expect(sent.every((r) => !('Authorization' in r.headers))).toBe(true);
  });

  it('after a reload (no fragment), the cookie alone opens the session', async () => {
    const jar = new Map<string, string>();
    await new RemoteCore({ base, token: TOKEN, fetch: browserFetch(jar) }).state();
    const reloaded = new RemoteCore({ base, token: null, fetch: browserFetch(jar) });
    expect((await reloaded.state()).version).toBe('1.0.0');
    expect(seen.filter((s) => s.url === '/core/session')).toHaveLength(1);
  });

  it('without fragment and without cookie it is unauthorized, and the stream is not attempted', async () => {
    const core = new RemoteCore({ base, token: null, fetch: browserFetch(), backoff: [10] });
    const statuses: ConnectionStatus[] = [];
    core.onConnection((s) => statuses.push(s));
    await expect(core.state()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    const stop = core.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(statuses).toEqual(['connecting', 'unauthorized']);
    expect(seen.filter((s) => s.url === '/core/events')).toHaveLength(0);
    expect(seen.filter((s) => s.url === '/core/session')).toHaveLength(0);
  });

  it('a token that was already used is refused once, and not retried', async () => {
    await opened().state();
    const other = new RemoteCore({ base, token: TOKEN, fetch: browserFetch(), backoff: [10] });
    await expect(other.state()).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(other.state()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(seen.filter((s) => s.url === '/core/session')).toHaveLength(2);
  });

  it('sends a JSON content type on every state-changing request, even without a body', async () => {
    const core = opened();
    await core.startDownload();
    await core.pauseDownload();
    await core.cancelDownload();
    expect(await core.seen('c1')).toMatchObject({ id: 'c1' });
    await core.forget('c1');
    const changes = seen.filter((s) => s.method !== 'GET');
    expect(changes.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST /core/session',
      'POST /core/engine/download',
      'POST /core/engine/download/pause',
      'DELETE /core/engine/download',
      'POST /core/characters/c1/seen',
      'DELETE /core/characters/c1',
    ]);
    expect(changes.every((s) => s.type === 'application/json')).toBe(true);
  });
});

describe('RemoteCore routes', () => {
  it('encodes ids and builds queries', async () => {
    const core = opened();
    await core.log('a/b c', { before: '00000042', limit: 40 });
    expect(await core.probeProvider('http://127.0.0.1:8000')).toMatchObject({ url: 'http://127.0.0.1:8000', reachable: true, models: ['m1'] });
    await core.providers();
    const gets = seen.filter((s) => s.method === 'GET').map((s) => s.url);
    expect(gets).toEqual(['/core/characters/a%2Fb%20c/log?before=00000042&limit=40', '/core/engine/providers?url=http%3A%2F%2F127.0.0.1%3A8000', '/core/engine/providers']);
  });

  it('asks for the claim link only when called', async () => {
    const core = opened();
    expect(await core.claimLink('c1')).toBe('https://game.example/claim/abc');
    expect(await core.claimLink('c2')).toBeNull();
    expect(seen.filter((s) => s.url.endsWith('/claim')).map((s) => s.method)).toEqual(['GET', 'GET']);
  });

  it('posts JSON bodies', async () => {
    await opened().command('c1', 'sell the pelts');
    const cmd = seen.find((s) => s.url.endsWith('/command'))!;
    expect(cmd).toMatchObject({ method: 'POST', url: '/core/characters/c1/command', type: 'application/json' });
    expect(JSON.parse(cmd.body)).toEqual({ text: 'sell the pelts' });
  });

  it('turns a CoreError into a CoreFailure with its code and status', async () => {
    const err = await opened()
      .createCharacter({ name: 'Pip', class: 'mage', language: 'en', persona: '', appearance: 'surprise_me' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreFailure);
    expect(err).toMatchObject({ code: 'NAME_TAKEN', status: 409 });
  });

  it('reports a body that is not JSON', async () => {
    await expect(opened().testEngine()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('reports an unreachable program as core_unreachable (not the game server), and keeps the token for a retry', async () => {
    const core = new RemoteCore({ base: 'http://127.0.0.1:1', token: TOKEN, fetch: browserFetch() });
    await expect(core.state()).rejects.toMatchObject({ code: 'core_unreachable' });
    await expect(core.state()).rejects.toMatchObject({ code: 'core_unreachable' });
    expect(sent.filter((r) => r.url.endsWith('/core/session'))).toHaveLength(2);
  });
});

describe('RemoteCore events', () => {
  it('delivers events from the stream and skips unknown ones', async () => {
    const core = opened();
    const got: CoreEvent[] = [];
    const stop = core.subscribe((ev) => got.push(ev));
    await until(() => streams.length === 1 || undefined);
    send({ type: 'server', server: { reachable: true } });
    send({ type: 'nonsense' });
    for (const s of streams) s.write('data: not json\n\n');
    send({ type: 'chat', id: 'c1', messageId: 'm1', token: 'Hel' });
    await until(() => (got.length >= 2 ? true : undefined));
    stop();
    expect(got).toEqual([
      { type: 'server', server: { reachable: true } },
      { type: 'chat', id: 'c1', messageId: 'm1', token: 'Hel' },
    ]);
    const ev = seen.find((s) => s.url === '/core/events')!;
    expect(ev.cookie).toBe(`ajwf_session=${SESSION}`);
    expect(ev.auth).toBeUndefined();
  });

  it('reconnects when the stream drops, and says so', async () => {
    const core = opened([20]);
    const statuses: ConnectionStatus[] = [];
    core.onConnection((s) => statuses.push(s));
    const stop = core.subscribe(() => {});
    await until(() => streams.length === 1 || undefined);
    streams[0]!.end();
    await until(() => streams.length === 2 || undefined);
    await until(() => (statuses.at(-1) === 'live' ? true : undefined));
    stop();
    expect(statuses).toEqual(['connecting', 'live', 'reconnecting', 'live']);
    expect(seen.filter((s) => s.url === '/core/session')).toHaveLength(1);
  });

  it('reopens a stream that goes silent (no keepalive), and says so', async () => {
    const core = new RemoteCore({ base, token: TOKEN, fetch: browserFetch(), backoff: [10], silenceMs: 400 });
    const statuses: ConnectionStatus[] = [];
    core.onConnection((s) => statuses.push(s));
    const stop = core.subscribe(() => {});
    await until(() => streams.length === 1 || undefined);
    // The fake server sends nothing more on this stream: the watchdog must give up on it and open another.
    await until(() => streams.length === 2 || undefined, 5000);
    await until(() => (statuses.at(-1) === 'live' ? true : undefined), 5000);
    stop();
    // Timing-tolerant: on a loaded machine the first connection may be dropped before it went live.
    expect(statuses[0]).toBe('connecting');
    expect(statuses).toContain('reconnecting');
    expect(statuses.at(-1)).toBe('live');
  });

  it('keeps retrying while the stream is refused', async () => {
    rejectEvents = true;
    const core = opened([10, 20]);
    const stop = core.subscribe(() => {});
    await until(() => (seen.filter((s) => s.url === '/core/events').length >= 3 ? true : undefined));
    rejectEvents = false;
    await until(() => streams.length === 1 || undefined);
    stop();
  });
});

describe('parseEvent', () => {
  it('accepts the six contract event types only', () => {
    expect(parseEvent('{"type":"removed","id":"c1"}')).toEqual({ type: 'removed', id: 'c1' });
    expect(parseEvent('{"type":"__proto__"}')).toBeNull();
    expect(parseEvent('[1,2]')).toBeNull();
    expect(parseEvent('null')).toBeNull();
  });
});
