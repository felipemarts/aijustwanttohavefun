import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Catalogs } from '@ajwf/i18n';
import type { DestinationStream } from 'pino';
import { boot } from './boot';
import type { Config } from './config';
import { createLogger } from './logger';
import { MemoryStore } from './store/memory';
import type { Store } from './store/types';

/** Daytime on the game clock (a game day lasts 2 h), so night-only spawns do not vary between runs. */
export const T0 = Date.UTC(2026, 0, 1, 12, 30);
export const ADMIN = 'test-admin-token-0123456789';

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
    docsDir?: string;
    devLogin?: boolean;
    wsMaxConnections?: number;
    wsMaxPerIp?: number;
    config?: Partial<Config>;
  } = {},
) {
  const clock = { t: T0, now: () => clock.t, advance: (ms: number) => (clock.t += ms) };
  const config: Config = {
    production: false,
    port: 0,
    databaseUrl: undefined,
    publicUrl: 'http://test.local',
    sessionSecret: 's'.repeat(32),
    adminToken: ADMIN,
    devLogin: o.devLogin ?? true,
    trustProxy: false,
    logLevel: 'silent',
    worldSeed: 42,
    wsMaxConnections: o.wsMaxConnections ?? 100,
    wsMaxPerIp: o.wsMaxPerIp ?? 10,
    ...o.config,
  };
  // Without an explicit store, S is its default (MemoryStore), so tests can inspect what was written.
  const store = o.store ?? (new MemoryStore() as Store as S);
  const logger = createLogger(o.logStream ? 'info' : 'silent', o.logStream);
  const server = await boot({
    config,
    store,
    logger,
    now: clock.now,
    catalogs: o.catalogs,
    spritesDir: mkdtempSync(join(tmpdir(), 'ajwf-sprites-')),
    docsDir: o.docsDir ?? mkdtempSync(join(tmpdir(), 'ajwf-docs-')),
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

  return { ...server, clock, store, config, register, auth, get, act, path };
}
