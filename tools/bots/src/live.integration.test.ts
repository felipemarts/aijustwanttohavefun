/**
 * The SDK and the live bots against the real server, booted in-process the way the server's own tests do and
 * listening on a random local port, so every call goes through real HTTP and `fetch`.
 */
import type { AddressInfo } from 'node:net';
import { ADMIN, makeServer, type TestServer } from '@ajwf/server/src/test-helpers';
import { ApiError, createClient } from '@ajwf/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { runLiveBots } from './live-runner';
import { Stopper } from './pacing';

let server: TestServer | null = null;
let ticker: NodeJS.Timeout | null = null;

/** A test server whose game clock follows real time, so cooldowns and rate limits refill as they do in production. */
async function listen(): Promise<{ s: TestServer; url: string }> {
  const s = await makeServer();
  server = s;
  let last = Date.now();
  ticker = setInterval(() => {
    const now = Date.now();
    s.clock.advance(now - last);
    last = now;
  }, 50);
  await s.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = s.app.server.address() as AddressInfo;
  return { s, url: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  if (ticker) clearInterval(ticker);
  await server?.app.close();
  server = null;
});

describe('SDK against the real server', () => {
  it('registers, looks and acts', async () => {
    const { s, url } = await listen();
    const anon = createClient({ baseUrl: url, adminToken: ADMIN });

    const help = await anon.help();
    expect(help.ok && help.actions.some((a) => a.name === 'move')).toBe(true);

    const reg = await anon.register({ name: 'Sdkling', class: 'warrior', language: 'pt-BR', bot: true, claimed: true });
    if (!reg.ok) throw new Error(reg.error.code);
    expect(reg.api_key).toMatch(/^ajwf_sk_/);
    const c = anon.withApiKey(reg.api_key);

    const look = await c.look();
    if (!look.ok) throw new Error(look.error.code);
    expect(look.room?.id).toBe('village.square');
    expect(look.you?.ap).toEqual([240, 240]);
    expect(look.actions).toContain('move');

    const north = Object.entries(look.room!.exits).find(([, to]) => to === 'village.tavern')![0];
    const moved = await c.act('move', { dir: north });
    if (!moved.ok) throw new Error(moved.error.code);
    expect(moved.room?.id).toBe('village.tavern');
    expect(moved.you.ap[0]).toBe(239);

    // A refusal comes back as data, in the agent's language.
    const refused = await c.act('attack', { target: 'nobody_here' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('TARGET_NOT_FOUND');

    // The same idempotency key twice: the second answer is the stored one, the action happens once.
    const first = await c.act('move', { dir: 'south' }, { idempotencyKey: 'step-1' });
    const again = await c.act('move', { dir: 'south' }, { idempotencyKey: 'step-1' });
    expect(again).toEqual(first);
    const me = await c.me();
    if (!me.ok) throw new Error(me.error.code);
    expect(me.room).toBe('village.square');
    expect(me.you.ap[0]).toBe(238);
    expect(me.agent.bot).toBe(true);

    const events = await c.events(0);
    expect(events.ok).toBe(true);
    const profile = await anon.profile('Sdkling');
    expect(profile.ok && profile.agent.bot).toBe(true);
    expect((await anon.village()).ok).toBe(true);
    expect((await anon.appearanceOptions('fr')).ok).toBe(true);

    // A wrong key is a transport error, and the message does not echo the key.
    const bad = 'ajwf_sk_' + 'x'.repeat(43);
    const err = await anon
      .withApiKey(bad)
      .me()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
    expect(String(err)).not.toContain(bad);
    expect(s.game.state.agents.size).toBe(1);
  });
});

describe('live bots', () => {
  it('register as bots and play over HTTP without transport errors', async () => {
    const { s, url } = await listen();
    const stopper = new Stopper();
    const lines: string[] = [];
    const summary = await runLiveBots(s.game.content, { url, count: 6, rate: 15, seed: 3, duration: 4, adminToken: ADMIN, stopper, statusEveryMs: 2_000, log: (l) => lines.push(l) });
    expect(summary.registered).toBe(6);
    expect(summary.total.acts).toBeGreaterThan(20);
    expect(summary.total.transport).toEqual({});
    expect(Object.keys(summary.total.http)).toEqual(['200']);
    expect(lines.at(-1)).toMatch(/^\[summary/);
    const agents = [...s.game.state.agents.values()];
    expect(agents).toHaveLength(6);
    expect(agents.every((a) => a.bot && a.claimed)).toBe(true);
    // They went somewhere.
    expect(agents.some((a) => a.room !== 'village.square')).toBe(true);
  });
});
