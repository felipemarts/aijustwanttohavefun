/**
 * Spec smoke test (§16.4, web): the map store loads, receives events and director mode switches rooms. Logic level,
 * against the mock source; no WebGL needed.
 */
import { describe, expect, it } from 'vitest';
import { MockSource } from './data/mock';
import { dramaSnapshot } from './data/reducers';
import { LiveStore } from './data/store';
import { directorStep, initialDirector } from './map/director';
import { loadStaticWorld } from './test/fixtures';

describe('live map smoke test (mock source)', () => {
  it('loads, receives events and the director switches rooms', () => {
    const world = loadStaticWorld();
    expect(world.rooms.length).toBeGreaterThan(40);
    let clock = 0;
    const store = new LiveStore(() => clock);
    const source = new MockSource(world, { seed: 42, agents: 60, autoTick: false });
    store.start(source);
    store.setTopics('director', ['room:village.square']);

    // loads
    expect(store.status).toBe('live');
    expect(store.state.hasWorld).toBe(true);
    expect(store.state.rooms.size).toBe(world.rooms.length);
    expect(store.state.agents.size).toBeGreaterThanOrEqual(60);

    // receives events, and the director tours
    const seen = new Set<string>();
    let events = 0;
    store.onChanges((ch) => (events += ch.events.length));
    let mem = initialDirector();
    const visited: string[] = [];
    for (let step = 0; step < 4 * 300; step++) {
      clock += 250;
      source.tick(250);
      for (const a of store.state.agents.values()) seen.add(a.r);
      if (step % 4 === 0) {
        const r = directorStep(mem, dramaSnapshot(store.state, clock), clock);
        mem = r.mem;
        if (r.cut) visited.push(r.cut);
      }
    }
    expect(events).toBeGreaterThan(100);
    expect(seen.size).toBeGreaterThan(5);
    expect([...store.state.roomLogs.values()].some((log) => log.length > 0)).toBe(true);
    expect(visited.length).toBeGreaterThanOrEqual(3);
    // never the same room twice in a row
    for (let i = 1; i < visited.length; i++) expect(visited[i]).not.toBe(visited[i - 1]);
    store.stop();
  });
});
