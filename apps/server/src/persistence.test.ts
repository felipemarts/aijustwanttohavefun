import { describe, expect, it } from 'vitest';
import { MemoryStore } from './store/memory';
import { makeServer, type TestServer } from './test-helpers';

/** Monster uids per room: proof that the world itself, not only the agents, survived. */
function monsters(s: TestServer): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of s.game.state.rooms.values()) if (r.monsters.length) out[r.id] = r.monsters.map((m) => `${m.uid}:${m.kind}:${m.hp}`);
  return out;
}

describe('persistence', () => {
  it('restarting the server preserves agents, keys and the world', async () => {
    const store = new MemoryStore();
    const first = await makeServer({ store });
    const { key } = await first.register('Pip');
    const bread = Object.keys(first.game.agentByName('Pip')!.inv).find((id) => id === 'bread') ?? Object.keys(first.game.agentByName('Pip')!.inv)[0]!;
    expect((await first.act(key, 'drop', { item: bread, qty: 1 })).json().ok).toBe(true);
    expect((await first.act(key, 'move', { dir: 'north' })).json().ok).toBe(true);
    const before = structuredClone(first.game.agentByName('Pip')!);
    const world = monsters(first);
    const eventSeq = first.game.state.meta.eventSeq;
    await first.persistence.stop();
    expect(store.events.length).toBe(eventSeq);

    const second = await makeServer({ store });
    const pip = second.game.agentByName('Pip')!;
    expect(pip.room).toBe('village.tavern');
    expect(pip.inv).toEqual(before.inv);
    expect(pip.ap).toBe(before.ap);
    expect(second.game.state.rooms.get('village.square')!.ground[bread]).toBe(1);
    expect(monsters(second)).toEqual(world);
    expect((await second.get(key, '/api/v1/me')).json().agent.name).toBe('Pip');
    // Sequences continue where they stopped.
    await second.register('Brasa');
    expect(second.game.agentByName('Brasa')!.id).not.toBe(pip.id);
    expect(second.game.state.meta.eventSeq).toBeGreaterThan(eventSeq);
  });

  it('never reuses an id when the last meta snapshot was lost', async () => {
    const store = new MemoryStore();
    const first = await makeServer({ store });
    await first.register('Pip');
    await first.persistence.flushEvents();
    // Crash before any snapshot: the agent row and its first snapshot exist, the meta snapshot does not.
    store.worldSnapshots.clear();
    const second = await makeServer({ store });
    await second.register('Brasa');
    expect(second.game.agentByName('Brasa')!.id).not.toBe(second.game.agentByName('Pip')!.id);
    expect(second.game.state.meta.eventSeq).toBeGreaterThan(Math.max(...store.events.map((e) => e.id)) - 1);
  });

  it('keeps unsaved changes dirty when a snapshot fails, and retries them', async () => {
    const store = new MemoryStore();
    const s = await makeServer({ store });
    const { key } = await s.register('Pip');
    await s.persistence.snapshot();
    await s.act(key, 'move', { dir: 'north' });
    store.failNext = new Error('database down');
    await s.persistence.snapshot();
    expect(JSON.parse(store.agentSnapshots.get(s.game.agentByName('Pip')!.id)!).room).toBe('village.square');
    await s.persistence.snapshot();
    expect(JSON.parse(store.agentSnapshots.get(s.game.agentByName('Pip')!.id)!).room).toBe('village.tavern');
  });

  it('keeps events buffered when the write fails', async () => {
    const store = new MemoryStore();
    const s = await makeServer({ store });
    await s.register('Pip');
    store.failNext = new Error('database down');
    await s.persistence.flushEvents();
    expect(store.events).toHaveLength(0);
    expect(s.persistence.buffered).toBeGreaterThan(0);
    await s.persistence.flushEvents();
    expect(store.events.length).toBeGreaterThan(0);
    expect(s.persistence.buffered).toBe(0);
  });

  it('serializes every second and writes one consistent cut every five', async () => {
    const store = new MemoryStore();
    const s = await makeServer({ store });
    const pip = await s.register('Pip');
    const brasa = await s.register('Brasa');
    await s.persistence.snapshot();
    const id = (name: string) => s.game.agentByName(name)!.id;
    const saved = (name: string) => JSON.parse(store.agentSnapshots.get(id(name))!) as { room: string; gold: number };

    // Brasa moves, a collection serializes it; then only Pip moves twice, with a collection in between.
    await s.act(brasa.key, 'move', { dir: 'north' });
    s.persistence.collect();
    await s.act(pip.key, 'move', { dir: 'north' });
    s.persistence.collect();
    expect(s.game.state.dirty.size).toBe(0);
    await s.act(pip.key, 'move', { dir: 'south' });
    // Nothing reaches the store before the write...
    expect(saved('Brasa').room).toBe('village.square');
    await s.persistence.snapshot();
    // ...and the write holds each entity as it is now: the latest serialization wins.
    expect(saved('Brasa').room).toBe('village.tavern');
    expect(saved('Pip').room).toBe('village.square');
    expect(s.persistence.stats.snapshots).toBe(2);
    expect(s.persistence.stats.serialize.count).toBeGreaterThanOrEqual(3);
  });

  it('after a failed write, a newer serialization of an entity replaces the one that failed', async () => {
    const store = new MemoryStore();
    const s = await makeServer({ store });
    const { key } = await s.register('Pip');
    await s.persistence.snapshot();
    await s.act(key, 'move', { dir: 'north' });
    store.failNext = new Error('database down');
    await s.persistence.snapshot();
    expect(s.persistence.stats.snapshotFailures).toBe(1);
    await s.act(key, 'move', { dir: 'south' });
    s.persistence.collect();
    await s.persistence.snapshot();
    expect(JSON.parse(store.agentSnapshots.get(s.game.agentByName('Pip')!.id)!).room).toBe('village.square');
    expect(s.persistence.stats.lastSnapshotAt).toBeGreaterThan(0);
  });
});
