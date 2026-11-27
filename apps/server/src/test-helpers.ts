import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Catalogs } from '@ajwf/i18n';
import type { DestinationStream } from 'pino';
import { boot } from './boot';
import type { Config } from './config';
import { createLogger } from './logger';
import type { FetchLike } from './owner/oauth';
import type { PushSender } from './owner/push';
import { MemoryStore } from './store/memory';
import type { Store } from './store/types';

/** Daytime on the game clock (a game day lasts 2 h), so night-only spawns do not vary between runs. */
export const T0 = Date.UTC(2026, 0, 1, 12, 30);
export const ADMIN = 'test-admin-token-0123456789';
/** PUBLIC_URL of test servers, and so the only origin owner routes accept. */
export const ORIGIN = 'http://test.local';

export type TestServer = Awaited<ReturnType<typeof makeServer<MemoryStore>>>;

/**
 * Average characters per token for compact JSON with English text. Real tokenizers give about 3.5 to 4 for this
 * mix of keys, punctuation and prose; 3.5 errs on the side of counting more tokens.
 */
export const CHARS_PER_TOKEN = 3.5;
export function estimateTokens(body: string): number {
  return Math.ceil(body.length / CHARS_PER_TOKEN);
}

export async function makeServer<S extends Store = MemoryStore>(
  o: {
    store?: S;
    catalogs?: Catalogs;
    logStream?: DestinationStream;
    /** Level of the logs written to `logStream` (default info). */
    logLevel?: string;
    docsDir?: string;
    devLogin?: boolean;
    wsMaxConnections?: number;
    wsMaxPerIp?: number;
    config?: Partial<Config>;
    fetch?: FetchLike;
    pushSender?: PushSender;
    cardsDir?: string;
  } = {},
) {
  const clock = { t: T0, now: () => clock.t, advance: (ms: number) => (clock.t += ms) };
  const config: Config = {
    production: false,
    port: 0,
    databaseUrl: undefined,
    publicUrl: ORIGIN,
    sessionSecret: 's'.repeat(32),
    adminToken: ADMIN,
    devLogin: o.devLogin ?? true,
    oauth: {},
    vapid: null,
    extraOrigins: [],
    webDist: null,
    cacheDir: join(tmpdir(), 'ajwf-cache-unused'),
    trustProxy: false,
    logLevel: 'silent',
    worldSeed: 42,
    wsMaxConnections: o.wsMaxConnections ?? 100,
    wsMaxPerIp: o.wsMaxPerIp ?? 10,
    ...o.config,
  };
  // Without an explicit store, S is its default (MemoryStore), so tests can inspect what was written.
  const store = o.store ?? (new MemoryStore() as Store as S);
  const logger = createLogger(o.logStream ? (o.logLevel ?? 'info') : 'silent', o.logStream);
  const server = await boot({
    config,
    store,
    logger,
    now: clock.now,
    catalogs: o.catalogs,
    spritesDir: mkdtempSync(join(tmpdir(), 'ajwf-sprites-')),
    docsDir: o.docsDir ?? mkdtempSync(join(tmpdir(), 'ajwf-docs-')),
    cardsDir: o.cardsDir ?? mkdtempSync(join(tmpdir(), 'ajwf-og-')),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.pushSender ? { pushSender: o.pushSender } : {}),
  });
  const { app } = server;

  /** Registers with the admin token (no registration limit), claimed by default so the agent may chat. */
  async function register(name: string, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/register',
      headers: { 'x-admin-token': ADMIN },
      payload: { name, class: 'warrior', claimed: true, ...extra },
    });
    const body = res.json();
    if (!body.ok) throw new Error(`register ${name} failed: ${res.body}`);
    return { key: body.api_key as string, body };
  }

  const auth = (key: string) => ({ authorization: `Bearer ${key}` });

  function get(key: string, url: string) {
    return app.inject({ method: 'GET', url, headers: auth(key) });
  }

  function act(key: string, action: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}, query = '') {
    return app.inject({ method: 'POST', url: `/api/v1/act${query}`, headers: { ...auth(key), ...headers }, payload: { action, params } });
  }

  /** Registers an unclaimed agent (as an agent would) and returns its key and claim token. */
  async function registerUnclaimed(name: string, extra: Record<string, unknown> = {}) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/agents/register', headers: { 'x-admin-token': ADMIN }, payload: { name, class: 'mage', ...extra } });
    const body = res.json();
    if (!body.ok) throw new Error(`register ${name} failed: ${res.body}`);
    return { key: body.api_key as string, token: (body.claim_url as string).split('/').pop()!, id: server.game.agentByName(name)!.id };
  }

  /** Logs in through the dev login and returns the session cookie (`name=value`). */
  async function ownerLogin(name = 'Ada', remoteAddress = '203.0.113.7') {
    const res = await app.inject({ method: 'POST', url: '/api/owner/dev-login', remoteAddress, headers: { origin: ORIGIN }, payload: { name } });
    if (res.statusCode !== 200) throw new Error(`dev login failed: ${res.body}`);
    const set = String(res.headers['set-cookie']);
    return set.split(';')[0]!;
  }

  /** An owner request from the game's own page: session cookie, same Origin, JSON body on writes. */
  function owner(cookie: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
    const write = method !== 'GET';
    return app.inject({
      method,
      url,
      headers: { cookie, ...(write ? { origin: ORIGIN } : {}), ...headers },
      ...(write ? { payload: (payload ?? {}) as Record<string, unknown> } : {}),
    });
  }

  /** Directions from one room to another (breadth-first over the content's exits). */
  function path(from: string, to: string): string[] {
    const rooms = server.game.content.rooms;
    const prev = new Map<string, [string, string]>();
    const queue = [from];
    const seen = new Set(queue);
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === to) break;
      for (const [dir, next] of Object.entries(rooms.get(cur)?.exits ?? {})) {
        if (seen.has(next) || rooms.get(cur)?.gates[dir]) continue;
        seen.add(next);
        prev.set(next, [cur, dir]);
        queue.push(next);
      }
    }
    const dirs: string[] = [];
    for (let at = to; at !== from; ) {
      const step = prev.get(at);
      if (!step) throw new Error(`no path ${from} -> ${to}`);
      dirs.unshift(step[1]);
      at = step[0];
    }
    return dirs;
  }

  return { ...server, clock, store, config, register, registerUnclaimed, ownerLogin, owner, auth, get, act, path };
}
