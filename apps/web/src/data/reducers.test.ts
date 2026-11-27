import { describe, expect, it } from 'vitest';
import {
  applyBatch,
  applyFull,
  createState,
  dayFractionAt,
  dramaAt,
  dramaSnapshot,
  ROOM_LOG_MAX,
} from './reducers';

const room = (id: string, x: number) => ({
  id,
  zone: 'village',
  rect: [x, 0, 10, 8],
  flags: ['safe'],
  exits: {},
});
const pos = (n: string, r: string, extra: Record<string, unknown> = {}) => ({
  n,
  r,
  l: 1,
  c: 'mage',
  s: 'abcdef0123',
  t: null,
  ...extra,
});

function world() {
  return {
    now: 1000,
    rooms: [room('a', 0), room('b', 12)],
    agents: [pos('Pip', 'a'), pos('Bo', 'b')],
    drama: { a: 4 },
    buildings: {},
    projects: [{ id: 'bridge', plot: 'b', progress: 0.5, done: false }],
    day: { phase: 'day', t: 0.3 },
  };
}

describe('applyFull', () => {
  it('replaces the world state', () => {
    const s = createState();
    applyFull(s, 'world', world(), 0);
    expect(s.rooms.size).toBe(2);
    expect([...s.agents.keys()]).toEqual(['Pip', 'Bo']);
    expect(s.projects[0]!.progress).toBe(0.5);
    // a second full replaces, it does not merge
    applyFull(s, 'world', { ...world(), agents: [pos('Zed', 'b')] }, 10);
    expect([...s.agents.keys()]).toEqual(['Zed']);
  });

  it('room full replaces the log and records monsters and NPCs', () => {
    const s = createState();
    applyFull(s, 'world', world(), 0);
    applyFull(
      s,
      'room:a',
      {
        now: 1,
        room: room('a', 0),
        agents: [],
        monsters: [{ id: 'slime', n: 2 }],
        npcs: ['olga'],
        log: [{ id: '5', ts: 1, type: 'say', text: 'hi', actor: 'Pip' }],
        drama: 3,
      },
      0,
    );
    expect(s.roomLogs.get('a')!.map((e) => e.id)).toEqual(['5']);
    expect(s.roomExtras.get('a')!.monsters).toEqual([{ id: 'slime', n: 2 }]);
    expect(s.roomExtras.get('a')!.npcs).toEqual(['olga']);
  });

  it('ignores garbage', () => {
    const s = createState();
    expect(() => applyFull(s, 'world', 'nope', 0)).not.toThrow();
    expect(() => applyFull(s, 'world', { rooms: [{ id: 1 }], agents: [{ n: 5 }, null] }, 0)).not.toThrow();
    expect(s.agents.size).toBe(0);
  });
});

describe('applyBatch', () => {
  it('patches positions, removes gone agents and appends events to room logs', () => {
    const s = createState();
    applyFull(s, 'world', world(), 0);
    const ch = applyBatch(
      s,
      {
        t: 'batch',
        topic: 'world',
        now: 2000,
        pos: [pos('Pip', 'b', { l: 2 })],
        gone: ['Bo'],
        events: [
          {
            id: '10',
            ts: 2000,
            type: 'level_up',
            room: 'b',
            actor: 'Pip',
            k: 'ev.level_up',
            p: { actor: 'Pip', level: 2 },
            drama: 3,
          },
        ],
      },
      100,
    );
    expect(s.agents.get('Pip')!.r).toBe('b');
    expect(s.agents.get('Pip')!.l).toBe(2);
    expect(s.agents.has('Bo')).toBe(false);
    expect(s.roomLogs.get('b')!.length).toBe(1);
    expect(ch.moved).toEqual(['Pip']);
    // the ticker now takes highlights from `world` batches, not from events
    expect(ch.highlights).toBe(false);
  });

  it('dedupes events by id and keeps the log bounded', () => {
    const s = createState();
    const ev = (id: number) => ({
      id: String(id),
      ts: id,
      type: 'say',
      room: 'a',
      actor: 'Pip',
      text: `t${id}`,
    });
    applyBatch(s, { topic: 'room:a', events: [ev(1), ev(1), ev(2)] }, 0);
    expect(s.roomLogs.get('a')!.length).toBe(2);
    applyBatch(
      s,
      { topic: 'room:a', events: Array.from({ length: ROOM_LOG_MAX + 20 }, (_, i) => ev(i + 10)) },
      0,
    );
    expect(s.roomLogs.get('a')!.length).toBe(ROOM_LOG_MAX);
  });

  it('skips a malformed event without dropping the rest', () => {
    const s = createState();
    const ch = applyBatch(
      s,
      {
        topic: 'world',
        events: [
          null,
          { id: {}, type: 3 },
          {
            id: '7',
            ts: 1,
            type: 'kill',
            room: 'a',
            k: 'ev.kill',
            p: { actor: 'X', target: { evil: true } },
          },
        ],
      },
      0,
    );
    expect(ch.events.map((e) => e.id)).toEqual(['7']);
    // non-primitive params are dropped
    expect(ch.events[0]!.p).toEqual({ actor: 'X' });
  });

  it('a room topic only removes agents that were in that room', () => {
    const s = createState();
    applyFull(s, 'world', world(), 0);
    applyBatch(s, { topic: 'room:a', gone: ['Bo', 'Pip'], events: [] }, 0);
    expect(s.agents.has('Bo')).toBe(true);
    expect(s.agents.has('Pip')).toBe(false);
  });

  it('world drama maps replace the scores; otherwise event drama accumulates and decays', () => {
    const s = createState();
    applyBatch(
      s,
      { topic: 'room:a', events: [{ id: '1', ts: 0, type: 'attack', room: 'a', k: 'ev.attack', drama: 2 }] },
      0,
    );
    expect(dramaAt(s, 'a', 0)).toBeCloseTo(2);
    expect(dramaAt(s, 'a', 60_000)).toBeCloseTo(1);
    applyBatch(s, { topic: 'world', events: [], drama: { b: 9 } }, 1000);
    expect(dramaSnapshot(s, 1000)).toEqual({ b: 9 });
  });
});

describe('statue honoree (village topic)', () => {
  const village = (extra: Record<string, unknown> = {}) => ({ now: 1000, population: 3, online: 1, day: { phase: 'day', t: 0.3 }, buildings: {}, projects: [], ...extra });

  it('is kept from the village full and replaced by a delta that carries it', () => {
    const s = createState();
    applyFull(s, 'village', village({ honoree: null }), 1000);
    expect(s.honoree).toBeNull();
    let ch = applyBatch(s, { topic: 'village', now: 1200, events: [], village: { buildings: { sq: 'statue' }, honoree: { name: 'Pip', sprite: 'abcdef0123' } } }, 1200);
    expect(s.honoree).toEqual({ name: 'Pip', sprite: 'abcdef0123' });
    expect(ch.village).toBe(true);
    // A delta without the field leaves it alone; the same honoree again is not a change.
    applyBatch(s, { topic: 'village', now: 1300, events: [], village: { treasury: 5 } }, 1300);
    expect(s.honoree).toEqual({ name: 'Pip', sprite: 'abcdef0123' });
    ch = applyBatch(s, { topic: 'village', now: 1400, events: [], village: { honoree: { name: 'Pip', sprite: 'abcdef0123' } } }, 1400);
    expect(ch.village).toBe(false);
    applyFull(s, 'village', village({ honoree: { name: 'Bo', sprite: '0123456789' } }), 1500);
    expect(s.honoree).toEqual({ name: 'Bo', sprite: '0123456789' });
  });

  it('ignores a malformed honoree, and a world full never clears it', () => {
    const s = createState();
    applyFull(s, 'village', village({ honoree: { name: 'Pip', sprite: 'abcdef0123' } }), 1000);
    for (const bad of [{ name: 'X', sprite: '../../evil' }, { name: 7, sprite: 'abcdef0123' }, 'Pip', { name: 'X' }])
      applyBatch(s, { topic: 'village', now: 1100, events: [], village: { honoree: bad } }, 1100);
    applyFull(s, 'world', world(), 1200);
    expect(s.honoree).toEqual({ name: 'Pip', sprite: 'abcdef0123' });
  });
});

describe('day clock', () => {
  it('advances locally between server updates', () => {
    const s = createState();
    applyFull(s, 'world', world(), 1000);
    expect(dayFractionAt(s, 1000)).toBeCloseTo(0.3);
    expect(dayFractionAt(s, 1000 + s.day.lengthMs * 0.1)).toBeCloseTo(0.4);
  });
});
