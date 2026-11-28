/**
 * End to end over HTTP: LocalCore -> OpenAI-compatible provider -> the scripted model stub (test/fixtures/model-stub.ts),
 * with injected faults, on the in-process fake game. Real time, with the playkit's turn gap shortened.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LocalCore } from '../src/core/local-core.ts';
import { Playkit } from '../src/playkit/index.ts';
import { Kit, type Config } from '../src/playkit/kit.ts';
import { PLAYKIT_JSON } from '../src/playkit/kit-data.ts';
import type { Fetch } from '../src/ports.ts';
import { nodeFetch, nodeRandom, systemClock } from '../src/node/index.ts';
import { FakeGame, FakeRuntime, MemoryKeyVault, MemoryModelFiles, MemoryStorage } from '../src/testing/index.ts';
import { startModelStub } from './fixtures/model-stub.ts';
import { newChar } from './helpers.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function until(cond: () => Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('end to end with the model stub over HTTP', () => {
  it('plays 20+ turns through retry, fallback, a refused schema, a 429 and a timeout', async () => {
    const stub = await startModelStub({
      faults: { 2: 'garbage', 5: 'off-menu', 6: 'garbage', 9: 'refuse-schema', 13: '429', 17: 'timeout' },
      hangMs: 5_000,
      prefer: ['talk', 'move'],
    });
    closers.push(stub.close);
    const game = new FakeGame(systemClock);
    const fetch: Fetch = (url, init) => (url.startsWith(game.base) ? game.fetch(url, init) : nodeFetch(url, init));
    const cfg = JSON.parse(PLAYKIT_JSON) as Config;
    cfg.requests.turnGapMs = 20;
    const core = await LocalCore.create({
      ports: { vault: new MemoryKeyVault(), storage: new MemoryStorage(), files: new MemoryModelFiles(), runtime: new FakeRuntime(), clock: systemClock, fetch, random: nodeRandom },
      brain: new Playkit(new Kit(cfg)),
      defaults: { serverUrl: game.base },
      engineTimeoutMs: 2_000,
      tuning: { engineRetry: 200 },
    });
    closers.push(() => core.close());
    expect((await core.setEngine({ kind: 'openai', url: stub.url })).status).toBe('ready');
    const c = await core.createCharacter({ ...newChar(), pace: 'active' });
    await until(async () => (await core.stats(c.id)).turns >= 22, 40_000);
    await core.control(c.id, false);
    const st = await core.stats(c.id);
    const log = await core.log(c.id, { limit: 200 });

    expect(st.turns).toBeGreaterThanOrEqual(20);
    expect(st.retried).toBeGreaterThanOrEqual(1); // garbage, then a valid retry
    expect(st.fallbacks).toBeGreaterThanOrEqual(1); // off-menu, then garbage again: quest_list
    expect(st.unconstrained).toBeGreaterThanOrEqual(2); // refused schema and 429: asked once without it
    expect(st.firstValid + st.retried + st.fallbacks).toBe(st.turns);
    expect(log.some((e) => e.kind === 'system' && /The AI engine failed/.test(e.text))).toBe(true); // the timeout
    expect(log.some((e) => /fell back to a safe one/.test(e.text))).toBe(true);
    // Nothing off the menu was ever sent; the unconstrained answers came from the prompt's action lines.
    const sent = game.requests.filter((r) => r.path === '/api/v1/act').map((r) => (r.body as { action: string }).action);
    expect(sent).not.toContain('teleport');
    expect(stub.log.filter((e) => e.kind === 'decision' && !e.constrained).length).toBeGreaterThanOrEqual(2);
    expect(stub.log.map((e) => e.fault).filter(Boolean)).toEqual(['garbage', 'off-menu', 'garbage', 'refuse-schema', '429', 'timeout']);
  });
});
