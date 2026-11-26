import { describe, expect, it } from 'vitest';
import { captionFor, chooseRoom, DIRECTOR, directorStep, initialDirector } from './director';

describe('chooseRoom', () => {
  it('picks the hottest room but never the current one', () => {
    expect(chooseRoom({ a: 9, b: 5, c: 1 }, null, null)).toBe('a');
    expect(chooseRoom({ a: 9, b: 5, c: 1 }, 'a', null)).toBe('b');
  });

  it('avoids ping-pong back to the previous room while another room has drama', () => {
    expect(chooseRoom({ a: 9, b: 5, c: 1 }, 'b', 'a')).toBe('c');
    // only the previous room has drama: going back is allowed
    expect(chooseRoom({ a: 9 }, 'b', 'a')).toBe('a');
  });

  it('falls back to the busiest room when nothing is happening', () => {
    expect(chooseRoom({}, 'a', null, { a: 9, b: 3, c: 4 })).toBe('c');
    expect(chooseRoom({}, null, null, {})).toBeNull();
  });
});

describe('directorStep', () => {
  it('stays at least the minimum time, then moves on', () => {
    let { mem, cut } = directorStep(initialDirector(), { a: 5, b: 4 }, 0);
    expect(cut).toBe('a');
    for (let t = 1000; t < DIRECTOR.minStayMs; t += 1000) {
      ({ mem, cut } = directorStep(mem, { a: 1, b: 8 }, t));
      expect(cut).toBeNull();
    }
    ({ mem, cut } = directorStep(mem, { a: 1, b: 8 }, DIRECTOR.minStayMs + 1000));
    expect(cut).toBe('b');
    expect(mem.prev).toBe('a');
  });

  it('stays longer while the drama keeps rising, but not forever', () => {
    let { mem } = directorStep(initialDirector(), { a: 2, b: 1 }, 0);
    let left = -1;
    for (let t = 1000; t <= DIRECTOR.hardStayMs + 2000; t += 1000) {
      const r = directorStep(mem, { a: 2 + t / 1000, b: 1 }, t);
      mem = r.mem;
      if (r.cut) {
        left = t;
        break;
      }
    }
    expect(left).toBeGreaterThan(DIRECTOR.maxStayMs);
    expect(left).toBeLessThanOrEqual(DIRECTOR.hardStayMs + 1000);
  });

  it('leaves by the maximum stay when drama is flat', () => {
    let { mem } = directorStep(initialDirector(), { a: 9, b: 2 }, 0);
    let cutAt = -1;
    for (let t = 1000; t <= DIRECTOR.maxStayMs + 1000; t += 1000) {
      const r = directorStep(mem, { a: 9, b: 2 }, t);
      mem = r.mem;
      if (r.cut) {
        cutAt = t;
        break;
      }
    }
    expect(cutAt).toBe(DIRECTOR.maxStayMs);
  });
});

describe('captionFor', () => {
  const ev = (type: string, ts: number, extra: Record<string, unknown> = {}) => ({
    id: String(ts),
    ts,
    type,
    actor: 'Pip',
    ...extra,
  });

  it('names the strongest recent moment', () => {
    const c = captionFor('ruins.plaza', [ev('say', 1000), ev('fallen', 2000), ev('say', 3000)], 4000);
    expect(c).toEqual({
      key: 'ui.director.caption.fallen',
      params: { room: '@room:ruins.plaza', actor: 'Pip' },
    });
  });

  it('calls fights in lawless rooms ambushes and boss fights by the boss', () => {
    expect(
      captionFor('ruins.plaza', [ev('attack', 1000, { target: 'bandit', tk: 'mon' })], 1000, {
        lawless: true,
      }).key,
    ).toBe('ui.director.caption.ambush');
    const boss = captionFor(
      'dungeon.boss_lair',
      [ev('attack', 1000, { target: 'the_hollow_regent', tk: 'mon' })],
      1000,
      { bosses: new Set(['the_hollow_regent']) },
    );
    expect(boss).toEqual({
      key: 'ui.director.caption.boss',
      params: { room: '@room:dungeon.boss_lair', mon: '@mon:the_hollow_regent' },
    });
  });

  it('falls back to the room name', () => {
    expect(captionFor('village.square', [], 0)).toEqual({
      key: 'ui.director.caption.room',
      params: { room: '@room:village.square' },
    });
    expect(captionFor('village.square', [ev('fallen', 0)], 10 * 60_000).key).toBe('ui.director.caption.room');
  });
});
