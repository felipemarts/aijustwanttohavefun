import { describe, expect, it } from 'vitest';
import { applyBatch, applyFull, applyVillageDelta, createState, emptyChanges } from './reducers';

const proj = (id: string, plot: string, progress: number, done = false, status = done ? 'done' : 'available') => ({
  id,
  plot,
  progress,
  done,
  status,
  building: id,
});

function world() {
  return {
    now: 1000,
    rooms: [{ id: 'village.square', zone: 'village', rect: [0, 0, 10, 8], flags: [], exits: {} }],
    agents: [],
    drama: {},
    buildings: { 'village.river_bank': 'bridge' },
    projects: [proj('bridge', 'village.river_bank', 1, true), proj('library', 'village.plot_nw', 0.5), proj('wall', 'village.south_gate', 0, false, 'locked')],
    halls: { 'village.plot_far': { guild: 'Iron Lanterns', colors: ['#d9534f', '#f2b84b'], at: 5 } },
    day: { phase: 'day', t: 0.3 },
  };
}

describe('village deltas', () => {
  it('the first full loads projects, buildings and halls without celebrating anything', () => {
    const s = createState();
    const ch = applyFull(s, 'world', world(), 0);
    expect(s.projects.map((p) => p.id)).toEqual(['bridge', 'library', 'wall']);
    expect(s.projects[2]!.status).toBe('locked');
    expect(s.buildings).toEqual({ 'village.river_bank': 'bridge' });
    expect(s.halls['village.plot_far']!.colors).toEqual(['#d9534f', '#f2b84b']);
    expect(ch.completed).toEqual([]);
    expect(ch.village).toBe(true);
  });

  it('a batch replaces projects by id and reports the ones that just finished', () => {
    const s = createState();
    applyFull(s, 'world', world(), 0);
    const ch = applyBatch(
      s,
      { t: 'batch', topic: 'world', now: 2000, events: [], village: { projects: [proj('library', 'village.plot_nw', 1, true)], buildings: { 'village.river_bank': 'bridge', 'village.plot_nw': 'library' } } },
      10,
    );
    expect(ch.completed).toEqual(['library']);
    expect(s.projects.find((p) => p.id === 'library')!.done).toBe(true);
    // the others are untouched, in their order
    expect(s.projects.map((p) => p.id)).toEqual(['bridge', 'library', 'wall']);
    expect(s.buildings['village.plot_nw']).toBe('library');
    // the same state again is not a second completion
    const again = applyBatch(s, { topic: 'world', events: [], village: { projects: [proj('library', 'village.plot_nw', 1, true)] } }, 20);
    expect(again.completed).toEqual([]);
  });

  it('progress never leaves 0..1 and junk projects are skipped', () => {
    const s = createState();
    applyFull(s, 'world', world(), 0);
    applyBatch(s, { topic: 'world', events: [], village: { projects: [{ id: 'library', plot: 'village.plot_nw', progress: 7 }, { id: 3 }, null] } }, 0);
    expect(s.projects.find((p) => p.id === 'library')!.progress).toBe(1);
    expect(s.projects).toHaveLength(3);
  });

  it('halls and buildings are complete maps: a missing hall is gone', () => {
    const s = createState();
    applyFull(s, 'world', world(), 0);
    applyBatch(s, { topic: 'world', events: [], village: { halls: { 'village.plot_se': { guild: 'Moonlit Accord', colors: ['#5b8def', 'javascript:alert(1)'], at: 9 } } } }, 0);
    expect(Object.keys(s.halls)).toEqual(['village.plot_se']);
    // colours from the wire are validated: never arbitrary CSS
    expect(s.halls['village.plot_se']!.colors[1]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('village batches carry population, online and the civic state (no /stats polling)', () => {
    const s = createState();
    applyFull(s, 'village', { now: 1, population: 10, online: 3, day: { phase: 'day', t: 0.2 }, buildings: {}, projects: [] }, 0);
    expect([s.population, s.online]).toEqual([10, 3]);
    const ch = applyBatch(
      s,
      {
        topic: 'village',
        events: [],
        village: { population: 12, online: 5, mayor: 'Pip', treasury: 300, taxRate: 0.05, priority: 'library', election: { n: 2, phase: 'voting', voteAt: 1, end: 9, candidates: ['Pip', 'Bo'] } },
      },
      0,
    );
    expect(ch.counts).toBe(true);
    expect([s.population, s.online]).toEqual([12, 5]);
    expect(s.civic).toMatchObject({ mayor: 'Pip', treasury: 300, taxRate: 0.05, priority: 'library' });
    expect(s.civic.election).toEqual({ n: 2, phase: 'voting', voteAt: 1, end: 9, candidates: ['Pip', 'Bo'] });
    applyBatch(s, { topic: 'village', events: [], village: { mayor: null } }, 0);
    expect(s.civic.mayor).toBeNull();
  });

  it('world batches feed the highlights ticker, deduplicated and bounded', () => {
    const s = createState();
    const h = (id: string, ts: number) => ({ id, type: 'betrayal', ts, titleKey: 'highlight.betrayal', params: { name: 'A', victim: 'B' }, agents: ['A', 'B'], drama: 8 });
    const ch = applyBatch(s, { topic: 'world', events: [], highlights: [h('h2', 2), h('h1', 1), { id: 5 }] }, 0);
    expect(ch.highlights).toBe(true);
    expect(s.highlights.map((x) => x.id)).toEqual(['h1', 'h2']);
    const again = applyBatch(s, { topic: 'world', events: [], highlights: [h('h2', 2)] }, 0);
    expect(again.highlights).toBe(false);
    applyBatch(s, { topic: 'world', events: [], highlights: Array.from({ length: 50 }, (_, i) => h(`x${i}`, 100 + i)) }, 0);
    expect(s.highlights.length).toBeLessThanOrEqual(30);
    // highlights on a room topic are ignored
    const room = applyBatch(createState(), { topic: 'room:a', events: [], highlights: [h('h9', 9)] }, 0);
    expect(room.highlights).toBe(false);
  });

  it('applyVillageDelta ignores garbage', () => {
    const s = createState();
    expect(() => applyVillageDelta(s, 'nope', emptyChanges())).not.toThrow();
    expect(() => applyVillageDelta(s, { projects: 'x', halls: [1], election: { n: 'a' } }, emptyChanges())).not.toThrow();
  });
});
