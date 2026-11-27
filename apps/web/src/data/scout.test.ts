import { describe, expect, it } from 'vitest';
import { parseIncrements } from './parse';
import { bigAhead, FORESIGHT, interestAt, reasonFor, Scout, type TimedIncrement } from './scout';

const inc = (n: string, p: number, ts: number, r = 'square'): TimedIncrement => ({ n, r, p, e: 'kill', ts });

describe('interestAt', () => {
  it('counts the points coming in the next 25 s, nearer ones more', () => {
    const i = interestAt([inc('Pip', 10, 1000), inc('Bo', 10, 20_000), inc('Cy', 10, 30_000)], 0);
    expect(i.get('Pip')).toBeCloseTo(10 * (1 - 0.6 * (1000 / 25_000)));
    expect(i.get('Bo')).toBeCloseTo(10 * (1 - 0.6 * (20_000 / 25_000)));
    expect(i.get('Pip')!).toBeGreaterThan(i.get('Bo')!);
    // beyond the lookahead: not counted
    expect(i.has('Cy')).toBe(false);
    expect(i.get('Bo')!).toBeGreaterThanOrEqual(10 * FORESIGHT.farWeight);
  });

  it('adds the points already earned, halving every 45 s', () => {
    const i = interestAt([inc('Pip', 8, -45_000), inc('Pip', 4, 0), inc('Bo', 8, -90_000)], 0);
    expect(i.get('Pip')).toBeCloseTo(4 + 4);
    expect(i.get('Bo')).toBeCloseTo(2);
  });
});

describe('bigAhead', () => {
  it('finds big moments in the next 8 s, the largest per agent', () => {
    const b = bigAhead([inc('Pip', 16, 3000), inc('Pip', 12, 4000), inc('Bo', 9, 2000), inc('Cy', 20, 9000), inc('Di', 15, -1000)], 0);
    expect([...b.keys()]).toEqual(['Pip']);
    expect(b.get('Pip')!.p).toBe(16);
  });
});

describe('reasonFor', () => {
  const x = (e: string, p: number, ts: number): TimedIncrement => ({ n: 'Pip', r: 'a', p, e, ts });

  it('a big moment ahead first, else the kind of event worth the most around the display time', () => {
    expect(reasonFor([x('say', 3, -1000), x('fallen', 16, 4000)], 'Pip', 0)).toBe('big');
    expect(reasonFor([x('attack', 4, -2000), x('kill', 6, 1000), x('say', 5, -1000)], 'Pip', 0)).toBe('fight');
    expect(reasonFor([x('say', 5, -1000), x('say', 5, 2000), x('attack', 4, -60_000)], 'Pip', 0)).toBe('talk');
    expect(reasonFor([x('wish', 2, 1000)], 'Pip', 0)).toBe('fortune');
    expect(reasonFor([x('mystery', 9, 1000)], 'Pip', 0)).toBeNull();
    expect(reasonFor([], 'Pip', 0)).toBeNull();
  });
});

describe('parseIncrements', () => {
  it('keeps well-formed increments and drops the rest one by one', () => {
    expect(
      parseIncrements([
        { n: 'Pip', r: 'village.square', p: 4, e: 'kill' },
        { n: 'Bo', r: 'village.square', p: -1, e: 'kill' },
        { n: 'Cy', r: '<script>', p: 4, e: 'kill' },
        { n: '', r: 'village.square', p: 4, e: 'kill' },
        { n: 'Di', r: 'village.square', p: Number.POSITIVE_INFINITY, e: 'kill' },
        { n: 'Ed', r: 'village.square', p: 4, e: 'Kill!' },
        'nope',
        { n: 'Fi', r: 'forest.glade', p: 2.5, e: 'say' },
      ]),
    ).toEqual([
      { n: 'Pip', r: 'village.square', p: 4, e: 'kill' },
      { n: 'Fi', r: 'forest.glade', p: 2.5, e: 'say' },
    ]);
    expect(parseIncrements('x')).toEqual([]);
    expect(parseIncrements(Array.from({ length: 80 }, () => ({ n: 'A', r: 'a', p: 3, e: 'kill' }))).length).toBe(50);
  });
});

describe('Scout', () => {
  it('keeps the increments of world batches with their server time, and where agents are now', () => {
    const s = new Scout();
    s.ingest({ t: 'full', topic: 'world', data: { now: 5000, agents: [{ n: 'Pip', r: 'a' }, { n: 'Bo', r: 'b' }] } }, 0);
    expect(s.realNow(100)).toBe(5100);
    s.ingest({ t: 'batch', topic: 'world', now: 6000, events: [], pos: [{ n: 'Bo', r: 'c' }], interest: [{ n: 'Pip', r: 'a', p: 6, e: 'kill' }] }, 1000);
    s.ingest({ t: 'batch', topic: 'room:a', now: 6000, events: [], interest: [{ n: 'Zed', r: 'a', p: 99, e: 'kill' }] }, 1000);
    s.ingest({ t: 'batch', topic: 'world', now: 7000, events: [], gone: ['Pip'] }, 2000);
    expect(s.increments()).toEqual([{ n: 'Pip', r: 'a', p: 6, e: 'kill', ts: 6000 }]);
    expect(s.roomOf('Bo')).toBe('c');
    expect(s.roomOf('Pip')).toBeUndefined();
    // old increments are forgotten
    s.ingest({ t: 'batch', topic: 'world', now: 6000 + FORESIGHT.keepMs + 1, events: [] }, 3000);
    expect(s.increments()).toEqual([]);
  });

  it('names the rooms of the agents most interesting right now, skipping the room already held', () => {
    const s = new Scout();
    s.ingest(
      {
        t: 'batch',
        topic: 'world',
        now: 1000,
        events: [],
        interest: [
          { n: 'Pip', r: 'a', p: 10, e: 'kill' },
          { n: 'Bo', r: 'b', p: 20, e: 'fallen' },
          { n: 'Cy', r: 'b', p: 5, e: 'kill' },
          { n: 'Di', r: 'd', p: 3, e: 'say' },
        ],
      },
      1000,
    );
    expect(s.leaderRooms(1000, 4)).toEqual(['b', 'a', 'd']);
    expect(s.leaderRooms(1000, 2, new Set(['b']))).toEqual(['a', 'd']);
  });
});
