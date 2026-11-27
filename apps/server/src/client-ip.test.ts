import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@ajwf/mcp/client';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { clientIp, ipMatches, type ClientIpSettings } from './client-ip';
import { loadConfig, type Config } from './config';
import { makeServer, ORIGIN, type TestServer } from './test-helpers';

const FLY: ClientIpSettings = { clientIpHeader: 'fly-client-ip', trustProxy: false };
/** The edge proxy, as the server sees it: every request arrives from this socket address. */
const PROXY = '10.0.0.1';
const A = '203.0.113.20';
const B = '203.0.113.21';
const FORGED = '192.0.2.66';

const open: TestServer[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) {
    s.spectators.stop();
    await s.app.close();
  }
});

describe('clientIp with CLIENT_IP_HEADER set', () => {
  it('takes the one address in that header and ignores X-Forwarded-For entirely, even with TRUST_PROXY', () => {
    const headers = { 'fly-client-ip': A, 'x-forwarded-for': `${FORGED}, ${B}` };
    expect(clientIp({ remoteAddress: PROXY, headers }, FLY)).toBe(A);
    expect(clientIp({ remoteAddress: PROXY, headers }, { ...FLY, trustProxy: true })).toBe(A);
    expect(clientIp({ remoteAddress: PROXY, headers }, { ...FLY, trustProxy: ['10.0.0.0/8'] })).toBe(A);
    // Fastify's own trustProxy result is not consulted either.
    expect(clientIp({ remoteAddress: PROXY, headers, fastifyIp: FORGED }, { ...FLY, trustProxy: true })).toBe(A);
    // X-Forwarded-For alone is ignored: the socket address.
    expect(clientIp({ remoteAddress: PROXY, headers: { 'x-forwarded-for': FORGED } }, { ...FLY, trustProxy: true })).toBe(PROXY);
    // Surrounding whitespace is trimmed; IPv6 addresses are accepted.
    expect(clientIp({ remoteAddress: PROXY, headers: { 'fly-client-ip': `  ${A}\t` } }, FLY)).toBe(A);
    expect(clientIp({ remoteAddress: PROXY, headers: { 'fly-client-ip': '2001:db8::7' } }, FLY)).toBe('2001:db8::7');
  });

  it('falls back to the socket address for a missing, empty, malformed or multi-valued header', () => {
    const bad = ['', '   ', 'unknown', 'not-an-ip', '999.1.1.1', '1.2.3', `${A}:443`, `[2001:db8::7]`, `${A} ${B}`, `${A}, ${B}`, `${A},${B}`, `${FORGED}, ${A}`, `,${A}`];
    for (const v of bad) expect(clientIp({ remoteAddress: PROXY, headers: { 'fly-client-ip': v } }, FLY), JSON.stringify(v)).toBe(PROXY);
    expect(clientIp({ remoteAddress: PROXY, headers: { 'fly-client-ip': [A, B] } }, FLY)).toBe(PROXY);
    expect(clientIp({ remoteAddress: PROXY, headers: {} }, FLY)).toBe(PROXY);
    expect(clientIp({ remoteAddress: undefined, headers: {} }, FLY)).toBe('unknown');
  });
});

describe('clientIp without CLIENT_IP_HEADER (TRUST_PROXY semantics, unchanged)', () => {
  const off = (trustProxy: Config['trustProxy']): ClientIpSettings => ({ clientIpHeader: undefined, trustProxy });
  const via = (remoteAddress: string, xff: string, trust: Config['trustProxy']) => clientIp({ remoteAddress, headers: { 'x-forwarded-for': xff } }, off(trust));

  it('ignores X-Forwarded-For unless the proxy is trusted, and never reads a client-IP header', () => {
    expect(via('10.0.0.5', '1.2.3.4', false)).toBe('10.0.0.5');
    expect(via('10.0.0.5', '1.2.3.4, 10.0.0.9', true)).toBe('1.2.3.4');
    expect(via('10.0.0.5', '6.6.6.6, 1.2.3.4', ['10.0.0.0/8'])).toBe('1.2.3.4');
    expect(via('10.0.0.5', '6.6.6.6, 1.2.3.4, 10.1.1.1', ['10.0.0.0/8'])).toBe('1.2.3.4');
    expect(via('192.0.2.1', '1.2.3.4', ['10.0.0.0/8'])).toBe('192.0.2.1');
    expect(via('::ffff:10.0.0.5', '1.2.3.4', ['10.0.0.0/8'])).toBe('1.2.3.4');
    expect(clientIp({ remoteAddress: PROXY, headers: { 'fly-client-ip': A } }, off(true))).toBe(PROXY);
    // HTTP requests keep Fastify's own derivation (proxy-addr) for the same setting.
    expect(clientIp({ remoteAddress: PROXY, headers: { 'x-forwarded-for': FORGED }, fastifyIp: A }, off(true))).toBe(A);
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

describe('MIGRATE_ON_BOOT config', () => {
  it('migrates at boot unless turned off', () => {
    expect(loadConfig({}).migrateOnBoot).toBe(true);
    expect(loadConfig({ MIGRATE_ON_BOOT: '1' }).migrateOnBoot).toBe(true);
    expect(loadConfig({ MIGRATE_ON_BOOT: '0' }).migrateOnBoot).toBe(false);
    expect(loadConfig({ MIGRATE_ON_BOOT: 'false' }).migrateOnBoot).toBe(false);
  });
});

describe('CLIENT_IP_HEADER config', () => {
  it('is opt-in, lower-cased, refuses non-header names, and wins over TRUST_PROXY', () => {
    expect(loadConfig({}).clientIpHeader).toBeUndefined();
    expect(loadConfig({ CLIENT_IP_HEADER: '' }).clientIpHeader).toBeUndefined();
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    const fly = loadConfig({ CLIENT_IP_HEADER: 'Fly-Client-IP', TRUST_PROXY: 'true' });
    expect(fly.clientIpHeader).toBe('fly-client-ip');
    expect(fly.trustProxy).toBe(false);
    expect(() => loadConfig({ CLIENT_IP_HEADER: 'Fly Client IP' })).toThrow();
    expect(() => loadConfig({ CLIENT_IP_HEADER: 'x:y' })).toThrow();
  });
});

/** A server behind an edge proxy that sets Fly-Client-IP. TRUST_PROXY is on too, to show the header still wins. */
const flyServer = (o: { logStream?: { write(line: string): void }; logLevel?: string; wsMaxPerIp?: number } = {}) =>
  makeServer({ ...o, config: { clientIpHeader: 'fly-client-ip', trustProxy: true } });

describe('every per-IP check follows CLIENT_IP_HEADER', () => {
  const register = (s: TestServer, name: string, headers: Record<string, string>, remoteAddress = PROXY) =>
    s.app.inject({ method: 'POST', url: '/api/v1/agents/register', remoteAddress, headers, payload: { name, class: 'cleric' } });

  it('registration limit: counted per header address, a forged X-Forwarded-For cannot dodge it', async () => {
    const s = await flyServer();
    for (let i = 0; i < 5; i++) expect((await register(s, `Newbie${i}x`, { 'fly-client-ip': A })).json().ok).toBe(true);
    expect((await register(s, 'Newbie5x', { 'fly-client-ip': A })).statusCode).toBe(429);
    expect((await register(s, 'Newbie6x', { 'fly-client-ip': A, 'x-forwarded-for': FORGED })).statusCode).toBe(429);
    // The same client through another proxy socket is still the same client.
    expect((await register(s, 'Newbie7x', { 'fly-client-ip': A }, '10.0.0.2')).statusCode).toBe(429);
    // Another client behind the same proxy has its own budget.
    expect((await register(s, 'Otherx', { 'fly-client-ip': B })).json().ok).toBe(true);
  });

  it('registration limit: a malformed, missing or multi-valued header counts against the socket address', async () => {
    const s = await flyServer();
    const forged: Record<string, string>[] = [{ 'fly-client-ip': `${FORGED}, ${A}` }, { 'fly-client-ip': 'nope' }, {}, { 'x-forwarded-for': FORGED }, { 'fly-client-ip': '' }];
    for (const [i, h] of forged.entries()) expect((await register(s, `Forger${i}x`, h)).json().ok, JSON.stringify(h)).toBe(true);
    // All five landed in the proxy's bucket, so a sixth forged value (a new second address) is refused...
    expect((await register(s, 'Forger5x', { 'fly-client-ip': `${A}, ${B}` })).statusCode).toBe(429);
    // ...while neither of the addresses it named was charged.
    expect((await register(s, 'Realax', { 'fly-client-ip': A })).json().ok).toBe(true);
    expect((await register(s, 'Realbx', { 'fly-client-ip': B })).json().ok).toBe(true);
  });

  it('report hash: keyed by the header address, not the proxy socket or X-Forwarded-For', async () => {
    const s = await flyServer();
    const report = (target: string, headers: Record<string, string>, remoteAddress = PROXY) =>
      s.app.inject({ method: 'POST', url: '/api/public/report', remoteAddress, headers, payload: { kind: 'board_post', target, reason: 'spam' } });
    expect((await report('b1', { 'fly-client-ip': A })).statusCode).toBe(200);
    expect((await report('b2', { 'fly-client-ip': A, 'x-forwarded-for': FORGED }, '10.0.0.2')).statusCode).toBe(200);
    expect((await report('b3', { 'fly-client-ip': B })).statusCode).toBe(200);
    const hash = (target: string) => [...s.store.reports.values()].find((r) => r.targetId === target)!.reporterHash;
    expect(hash('b2')).toBe(hash('b1'));
    expect(hash('b3')).not.toBe(hash('b1'));
  });

  it('MCP: tool calls reach the API in-process from the header address', async () => {
    const s = await flyServer();
    const call = await mcpClient(s, { 'fly-client-ip': A, 'x-forwarded-for': FORGED });
    for (let i = 0; i < 5; i++) expect(body(await call('village_register', { name: `Mcp${i}x`, class: 'cleric' })).ok).toBe(true);
    expect(text(await call('village_register', { name: 'Mcp5x', class: 'cleric' }))).toMatch(/RATE_LIMITED/);
    // The REST budget of that address is the one spent; the proxy's socket address and another client are untouched.
    expect((await register(s, 'Restax', { 'fly-client-ip': A })).statusCode).toBe(429);
    expect((await register(s, 'Restbx', {})).json().ok).toBe(true);
    const other = await mcpClient(s, { 'fly-client-ip': B });
    expect(body(await other('village_register', { name: 'Mcpbx', class: 'cleric' })).ok).toBe(true);
  });

  it('request log: records the header address, never a forged X-Forwarded-For', async () => {
    const lines: string[] = [];
    const s = await flyServer({ logStream: { write: (line: string) => void lines.push(line) }, logLevel: 'debug' });
    await s.app.inject({ method: 'GET', url: '/api/v1/help', remoteAddress: PROXY, headers: { 'fly-client-ip': A, 'x-forwarded-for': FORGED } });
    await s.app.inject({ method: 'GET', url: '/api/v1/help', remoteAddress: PROXY, headers: { 'fly-client-ip': `${FORGED}, ${B}` } });
    const logged = lines.map((l) => JSON.parse(l) as { req?: { url: string; remoteAddress: string } }).filter((l) => l.req?.url === '/api/v1/help');
    expect(logged.map((l) => l.req!.remoteAddress)).toEqual([A, PROXY]);
    expect(lines.join('\n')).not.toContain(FORGED);
  });

  it('spectator WebSocket: the per-IP cap counts header addresses', async () => {
    const s = await flyServer({ wsMaxPerIp: 1 });
    open.push(s);
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${(s.app.server.address() as AddressInfo).port}/ws/spectate`;
    const connect = (headers: Record<string, string>) =>
      new Promise<{ ws: WebSocket; status: number }>((resolve) => {
        const ws = new WebSocket(url, { headers });
        ws.on('error', () => {});
        ws.once('open', () => resolve({ ws, status: 101 }));
        ws.once('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode ?? 0 }));
      });
    // Every connection comes from 127.0.0.1: only the header tells clients apart.
    const a = await connect({ 'fly-client-ip': A });
    const b = await connect({ 'fly-client-ip': B });
    const local = await connect({ 'x-forwarded-for': FORGED });
    expect([a.status, b.status, local.status]).toEqual([101, 101, 101]);
    // A second connection for A is refused, a forged X-Forwarded-For does not help, nor does a forged second value
    // (it falls back to the socket address, which already has its one connection).
    expect((await connect({ 'fly-client-ip': A, 'x-forwarded-for': FORGED })).status).toBe(429);
    expect((await connect({ 'fly-client-ip': `${FORGED}, ${A}` })).status).toBe(429);
    expect(s.spectators.connections).toBe(3);
    for (const c of [a, b, local]) c.ws.terminate();
  });
});

describe('without CLIENT_IP_HEADER', () => {
  it('ignores a client-IP header and keeps the TRUST_PROXY behaviour for X-Forwarded-For', async () => {
    const s = await makeServer({ config: { trustProxy: true } });
    const reg = (name: string, headers: Record<string, string>) =>
      s.app.inject({ method: 'POST', url: '/api/v1/agents/register', remoteAddress: PROXY, headers, payload: { name, class: 'cleric' } });
    for (let i = 0; i < 5; i++) expect((await reg(`Trusty${i}x`, { 'x-forwarded-for': A, 'fly-client-ip': B })).json().ok).toBe(true);
    expect((await reg('Trusty5x', { 'x-forwarded-for': A, 'fly-client-ip': B })).statusCode).toBe(429);
    // B (only in the ignored header) and the proxy socket itself still have their budgets.
    expect((await reg('Trustbx', { 'x-forwarded-for': B })).json().ok).toBe(true);
    expect((await reg('Trustpx', { 'fly-client-ip': A })).json().ok).toBe(true);
  });
});

const text = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
/** The API body a tool returned (first text block). */
const body = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text) as { ok: boolean };

/** The official MCP client over `app.inject`, from the proxy's socket address with the given headers. */
async function mcpClient(s: TestServer, extra: Record<string, string>) {
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const res = await s.app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE',
      url: url.pathname + url.search,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), ...extra },
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
      remoteAddress: PROXY,
    });
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, String(v));
    return new Response(res.body || null, { status: res.statusCode, headers });
  };
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch }));
  return async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
}
