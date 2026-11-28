/** The store wired to the mock core, on fake timers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockCore } from '../core/mock/mock-core';
import type { Core, CoreEvent, EngineState } from '../core/types';
import { Store } from './store';

function seeded(seed = 42) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let core: MockCore;
let store: Store;

beforeEach(() => {
  vi.useFakeTimers();
  core = new MockCore({ random: seeded(), tickMs: 100, tokenMs: 5 });
  store = new Store({ kind: 'mock', core });
});

afterEach(() => {
  store.stop();
  core.dispose();
  vi.useRealTimers();
});

describe('Store with MockCore', () => {
  it('loads three characters and an engine that is ready', async () => {
    await store.start();
    expect(store.state.phase).toBe('ready');
    expect(store.state.characters.map((c) => c.name)).toEqual(['Bruna', 'Pip', 'Sly']);
    expect(store.state.core?.engine.status).toBe('ready');
    expect(store.state.characters.filter((c) => c.away)).toHaveLength(2);
  });

  it('opening a character keeps its "away" summary; seen() clears it', async () => {
    await store.start();
    const id = store.state.characters[0]!.id;
    await store.openCharacter(id);
    expect(store.state.characters[0]!.away).toBeDefined();
    await store.seen(id);
    expect(store.state.characters[0]!.away).toBeUndefined();
    expect((await core.state()).characters[0]!.away).toBeUndefined();
  });

  it('the detail carries stat and slot names; loads the first log page and older ones', async () => {
    await store.start();
    const id = store.state.characters[0]!.id;
    await store.openCharacter(id);
    const d = store.state.details[id]!;
    expect(d.stats.map((s) => s.name)).toContain('Strength');
    expect(d.inventory.find((i) => i.slot)?.slot).toEqual({ id: 'weapon', name: 'Weapon' });
    await store.openLog(id);
    expect(store.state.logs[id]!.entries.length).toBe(40);
    await store.loadOlder(id);
    expect(store.state.logs[id]!.entries.length).toBe(80);
    const ids = store.state.logs[id]!.entries.map((e) => e.id);
    expect([...ids].sort().reverse()).toEqual(ids);
  });

  it('characters keep playing: numbers move and live entries arrive', async () => {
    await store.start();
    const id = store.state.characters[1]!.id;
    await store.openLog(id);
    const before = store.state.logs[id]!.entries.length;
    const xpBefore = store.state.characters[1]!.xp[0] + store.state.characters[1]!.level * 1e6;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.state.logs[id]!.entries.length).toBeGreaterThan(before);
    const c = store.state.characters[1]!;
    expect(c.xp[0] + c.level * 1e6).not.toBe(xpBefore);
  });

  it('pausing stops a character and play resumes it', async () => {
    await store.start();
    const id = store.state.characters[0]!.id;
    await store.control(id, false);
    expect(store.state.characters[0]!.status).toBe('paused');
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.state.characters[0]!.status).toBe('paused');
    await store.control(id, true);
    expect(store.state.characters[0]!.status).not.toBe('paused');
  });

  it('chat: the owner line shows at once, the reply streams in and is filed once', async () => {
    await store.start();
    const id = store.state.characters[1]!.id;
    const p = store.sendChat(id, 'How is it going?');
    expect(store.state.chats[id]!.at(-1)).toMatchObject({ from: 'owner', text: 'How is it going?' });
    await vi.advanceTimersByTimeAsync(450);
    expect(store.state.streams[id]?.text.length ?? 0).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(5000);
    const reply = await p;
    expect(store.state.streams[id]).toBeUndefined();
    expect(store.state.chats[id]!.filter((m) => m.id === reply.id)).toHaveLength(1);
  });

  it('probing a custom address reports it, with its models when it answers', async () => {
    const pending = core.probeProvider('http://127.0.0.1:8000');
    await vi.advanceTimersByTimeAsync(400);
    const custom = await pending;
    expect(custom).toMatchObject({ url: 'http://127.0.0.1:8000', reachable: true });
    expect(custom.models.length).toBeGreaterThan(0);
    const far = core.probeProvider('https://example.org');
    await vi.advanceTimersByTimeAsync(400);
    expect(await far).toMatchObject({ reachable: false, models: [] });
  });

  it('the engine download progresses, can be paused, resumed and finishes', async () => {
    core.dispose();
    core = new MockCore({ empty: true, random: seeded(), tickMs: 100 });
    store = new Store({ kind: 'mock-empty', core });
    await store.start();
    expect(store.state.characters).toHaveLength(0);
    expect(store.state.core?.engine.status).toBe('not_installed');
    await core.startDownload();
    await vi.advanceTimersByTimeAsync(2000);
    const mid = store.state.core!.engine.builtin!.bytesDone;
    expect(store.state.core?.engine.status).toBe('downloading');
    expect(mid).toBeGreaterThan(0);
    await core.pauseDownload();
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.state.core!.engine.builtin!.bytesDone).toBe(mid);
    expect(store.state.core?.engine.status).toBe('not_installed');
    await core.startDownload();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.state.core?.engine.status).toBe('ready');
  });

  it('a new character with a taken name is refused; a good one appears', async () => {
    await store.start();
    await expect(core.createCharacter({ name: 'Pip', class: 'rogue', language: 'en', persona: '', appearance: 'surprise_me' })).rejects.toMatchObject({ code: 'NAME_TAKEN' });
    await expect(core.createCharacter({ name: 'Long', class: 'mage', language: 'en', persona: '', bio: 'x'.repeat(301), appearance: 'surprise_me' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const c = await core.createCharacter({ name: 'Nova', class: 'cleric', language: 'pt-BR', persona: 'x', bio: 'A healer who sings badly.', appearance: 'surprise_me' });
    expect((await core.character(c.id)).bio).toBe('A healer who sings badly.');
    expect(store.state.characters.map((x) => x.id)).toContain(c.id);
    expect(c).toMatchObject({ level: 1, claimed: false, claimPending: true });
    expect('claimUrl' in c).toBe(false);
    expect(await core.claimLink(c.id)).toMatch(/^https:\/\//);
    expect(await core.claimLink(store.state.characters[0]!.id)).toBeNull(); // Bruna is claimed
  });

  it('forgetting removes the character', async () => {
    await store.start();
    const id = store.state.characters[2]!.id;
    await core.forget(id);
    expect(store.state.characters.find((c) => c.id === id)).toBeUndefined();
  });

  it('a store without a core says there is no session', async () => {
    const s = new Store({ kind: 'remote', core: null });
    await s.start();
    expect(s.state).toMatchObject({ phase: 'error', error: { code: 'no_session' } });
  });
});

describe('answers older than the stream', () => {
  it('an engine answer does not overwrite a newer engine event', async () => {
    let emit: (ev: CoreEvent) => void = () => {};
    const ready: EngineState = { choice: { kind: 'openai', url: 'http://127.0.0.1:8797' }, status: 'ready' };
    const fake = {
      state: async () => ({ ...(await core.state()), characters: [] }),
      subscribe: (l: (ev: CoreEvent) => void) => {
        emit = l;
        return () => {};
      },
      // The program says "ready" on the stream before the PUT's own answer ("starting") reaches the page.
      setEngine: async () => {
        emit({ type: 'engine', engine: ready });
        return { ...ready, status: 'starting' } as EngineState;
      },
    } as unknown as Core;
    const s = new Store({ kind: 'remote', core: fake });
    await s.start();
    await s.engineAction((c) => c.setEngine({ kind: 'openai', url: 'http://127.0.0.1:8797' }));
    expect(s.state.core?.engine.status).toBe('ready');
  });
});
