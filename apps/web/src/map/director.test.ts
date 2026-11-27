import type { SpectatorEvent } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import {
  chooseStar,
  DIRECTOR,
  type DirectorMemory,
  type DirectorWorld,
  directorStep,
  initialDirector,
  rankMoments,
  resumedDirector,
  type StarAgent,
  starCaption,
  startMoment,
} from './director';

let seq = 0;
const ev = (type: string, ts: number, actor: string, room: string, extra: Partial<SpectatorEvent> = {}): SpectatorEvent => ({
  id: String(++seq),
  ts,
  type,
  actor,
  room,
  ...extra,
});

const agent = (n: string, r: string, f?: string, l = 5): StarAgent => ({ n, r, l, ...(f ? { f } : {}) });

function world(
  agents: StarAgent[],
  drama: Record<string, number> = {},
  events: SpectatorEvent[] = [],
  now = 0,
): DirectorWorld {
  const logs = new Map<string, SpectatorEvent[]>();
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    const list = logs.get(e.room!) ?? [];
    list.push(e);
    logs.set(e.room!, list);
  }
  return { now, nowTs: now, drama, agents: new Map(agents.map((a) => [a.n, a])), logs };
}

/** Runs the director once a second from `from` to `to` (inclusive) and returns the time of the first cut. */
function firstCut(mem: DirectorMemory, from: number, to: number, w: (t: number) => DirectorWorld) {
  for (let t = from; t <= to; t += 1000) {
    const r = directorStep(mem, w(t));
    mem = r.mem;
    if (r.cut) return { at: t, cut: r.cut, mem };
  }
  return { at: -1, cut: null, mem };
}

describe('chooseStar', () => {
  it('picks the actor of the strongest moment in the room with the most drama', () => {
    const w = world(
      [agent('Pip', 'a'), agent('Bo', 'a'), agent('Cy', 'b')],
      { a: 9, b: 4 },
      [ev('say', 0, 'Pip', 'a'), ev('level_up', 1000, 'Bo', 'a'), ev('fallen', 1000, 'Cy', 'b')],
      2000,
    );
    expect(chooseStar(w, null, null)).toEqual({ star: 'Bo', room: 'a' });
  });

  it('skips actors who are gone, fallen or elsewhere, then takes anyone standing in the room', () => {
    const agents = [agent('Pip', 'a', 'd'), agent('Bo', 'b'), agent('Cy', 'a', 'b'), agent('Di', 'a')];
    const events = [ev('fallen', 1000, 'Pip', 'a'), ev('kill', 1000, 'Bo', 'a'), ev('say', 1000, 'Gone', 'a')];
    // Pip fell, Bo walked away, Gone left the world: nobody of the moment is usable, so a non-bot in the room
    expect(chooseStar(world(agents, { a: 9 }, events, 2000), null, null)).toEqual({ star: 'Di', room: 'a' });
    // a room with drama but nobody usable is passed over
    expect(chooseStar(world([agent('Pip', 'a', 'd'), agent('Bo', 'b')], { a: 9, b: 1 }), null, null)).toEqual({
      star: 'Bo',
      room: 'b',
    });
  });

  it('falls back to someone in the busiest room when nothing is happening', () => {
    // in the busiest room: not a bot first, then the highest level
    const w = world([agent('Pip', 'a'), agent('Bo', 'b'), agent('Cy', 'b', 'b', 9), agent('Di', 'b', undefined, 2)]);
    expect(chooseStar(w, null, null)).toEqual({ star: 'Bo', room: 'b' });
    expect(chooseStar(world([]), null, null)).toBeNull();
  });

  it('prefers agents that are not bots when the moment is otherwise equal', () => {
    const agents = [agent('Bot', 'a', 'b'), agent('Pip', 'a')];
    // the bot's moment is the newer of two equal ones, so it would win without the preference
    const tie = world(agents, { a: 5 }, [ev('kill', 1000, 'Pip', 'a'), ev('kill', 1000, 'Bot', 'a')], 1000);
    expect(chooseStar(tie, null, null)?.star).toBe('Pip');
    // a stronger moment still wins over the preference
    const strong = world(agents, { a: 5 }, [ev('say', 1000, 'Pip', 'a'), ev('level_up', 1000, 'Bot', 'a')], 1000);
    expect(chooseStar(strong, null, null)?.star).toBe('Bot');
  });

  it('never the current star, and not the previous one while anyone else qualifies', () => {
    const w = world([agent('Pip', 'a'), agent('Bo', 'a'), agent('Cy', 'b')], { a: 9 }, [ev('kill', 0, 'Pip', 'a')]);
    expect(chooseStar(w, 'Pip', null)?.star).toBe('Bo');
    expect(chooseStar(w, 'Pip', 'Bo')?.star).toBe('Cy');
    expect(chooseStar(world([agent('Pip', 'a'), agent('Bo', 'a')]), 'Pip', 'Bo')?.star).toBe('Bo');
    expect(chooseStar(world([agent('Pip', 'a')]), 'Pip', null)).toBeNull();
  });
});

describe('rankMoments', () => {
  it('orders recent moments by strength and drops old ones', () => {
    const r = rankMoments([ev('fallen', 0, 'A', 'a'), ev('say', 100_000, 'B', 'a'), ev('kill', 110_000, 'C', 'a')], 110_000);
    expect(r.map((x) => x.ev.actor)).toEqual(['C', 'B']);
  });
});

describe('directorStep (with foresight)', () => {
  const cast = [agent('Pip', 'a'), agent('Bo', 'b'), agent('Cy', 'c')];
  /** A world where the scout foresees the given interest (and big moments, and rooms not buffered yet). */
  const seen = (
    interest: Record<string, number>,
    t: number,
    o: { big?: Record<string, number>; unbuffered?: string[]; agents?: StarAgent[]; drama?: Record<string, number> } = {},
  ): DirectorWorld => ({
    ...world(o.agents ?? cast, o.drama ?? {}, [], t),
    foresight: {
      interest: new Map(Object.entries(interest)),
      big: new Map(Object.entries(o.big ?? {}).map(([n, p]) => [n, { p }])),
      buffered: (room) => !o.unbuffered?.includes(room),
    },
  });
  const starting = (star: string, interest: Record<string, number>) => {
    const r = directorStep(initialDirector(), seen(interest, 0));
    expect(r.cut?.star).toBe(star);
    return r.mem;
  };

  it('follows the most interesting agent; without interest data, the drama of the rooms decides', () => {
    expect(directorStep(initialDirector(), seen({ Pip: 3, Bo: 9, Cy: 4 }, 0)).cut).toEqual({ star: 'Bo', room: 'b' });
    expect(directorStep(initialDirector(), { ...world(cast, { c: 5 }), foresight: undefined }).cut?.star).toBe('Cy');
  });

  it('stays the minimum time, then switches to a challenger 30 % more interesting', () => {
    const mem = starting('Bo', { Bo: 10, Pip: 5 });
    const strong = (t: number) => seen({ Bo: 10, Pip: 14 }, t);
    expect(firstCut(mem, 1000, 30_000, strong)).toMatchObject({ at: DIRECTOR.minStayMs, cut: { star: 'Pip' } });
    // 20 % more is not enough until the maximum stay
    const close = (t: number) => seen({ Bo: 10, Pip: 12 }, t);
    expect(firstCut(mem, 1000, 90_000, close)).toMatchObject({ at: DIRECTOR.maxStayMs, cut: { star: 'Pip' } });
    // a challenger below the floor never counts as one
    const tiny = (t: number) => seen({ Bo: 0.5, Pip: 1.5 }, t);
    expect(firstCut(mem, 1000, DIRECTOR.maxStayMs - 1000, tiny).at).toBe(-1);
  });

  it('at the maximum stay, holds a star nobody else rivals; in a world with no interest at all, the drama decides', () => {
    const mem = starting('Bo', { Bo: 10 });
    expect(firstCut(mem, 1000, 120_000, (t) => seen({ Bo: 10 }, t)).at).toBe(-1);
    const quiet = (t: number) => seen({}, t, { drama: { c: 3 } });
    expect(firstCut(mem, 1000, 120_000, quiet)).toMatchObject({ at: DIRECTOR.maxStayMs, cut: { star: 'Cy' } });
  });

  it('cuts after only 6 s to arrive before a big moment of someone else', () => {
    const mem = starting('Bo', { Bo: 10, Cy: 3 });
    const coming = (t: number) => seen({ Bo: 10, Cy: 3 }, t, { big: { Cy: 16 } });
    expect(firstCut(mem, 1000, 30_000, coming)).toMatchObject({ at: DIRECTOR.bigCutAfterMs, cut: { star: 'Cy', room: 'c' } });
    // not when the star has a big moment coming too
    const both = (t: number) => seen({ Bo: 10, Cy: 3 }, t, { big: { Cy: 16, Bo: 12 } });
    expect(firstCut(mem, 1000, DIRECTOR.minStayMs - 1000, both).at).toBe(-1);
    // a big moment is the first choice when there is no star yet, buffered or not
    expect(directorStep(initialDirector(), seen({ Bo: 30, Cy: 3 }, 0, { big: { Cy: 12 }, unbuffered: ['c'] })).cut?.star).toBe('Cy');
  });

  it('a recent star counts at half interest, so the cast rotates', () => {
    const mem = starting('Bo', { Bo: 10, Pip: 5 });
    const pip = firstCut(mem, 1000, 30_000, (t) => seen({ Bo: 10, Pip: 14 }, t));
    expect(pip).toMatchObject({ at: DIRECTOR.minStayMs, cut: { star: 'Pip' } });
    expect(pip.mem.recent.Bo).toBe(DIRECTOR.minStayMs);
    // Pip has been the star for 20 s; Bo would beat Pip by 1.6x, but counts at half while recent...
    const onPip = { ...pip.mem, since: 100_000 };
    expect(directorStep(onPip, seen({ Bo: 22, Pip: 14 }, 120_000)).cut).toBeNull();
    // ...and at full interest two minutes after he stopped being the star
    const after = DIRECTOR.minStayMs + DIRECTOR.recentStarMs;
    expect(directorStep(onPip, seen({ Bo: 22, Pip: 14 }, after)).cut?.star).toBe('Bo');
  });

  it('prefers a candidate whose room is already buffered', () => {
    expect(directorStep(initialDirector(), seen({ Pip: 10, Cy: 9 }, 0, { unbuffered: ['a'] })).cut?.star).toBe('Cy');
    expect(directorStep(initialDirector(), seen({ Pip: 20, Cy: 9 }, 0, { unbuffered: ['a'] })).cut?.star).toBe('Pip');
  });

  it('never picks a fallen agent; holds a fallen star 5 s; replaces a star who leaves at once', () => {
    const withFallen = [agent('Pip', 'a', 'd'), agent('Bo', 'b'), agent('Cy', 'c')];
    expect(directorStep(initialDirector(), seen({ Pip: 50, Bo: 2 }, 0, { agents: withFallen })).cut?.star).toBe('Bo');
    let mem = starting('Bo', { Bo: 10, Cy: 3 });
    const fell = (t: number) => seen({ Bo: 10, Cy: 3 }, t, { agents: [agent('Bo', 'b', 'd'), agent('Cy', 'c')] });
    mem = directorStep(mem, fell(2000)).mem;
    expect(directorStep(mem, fell(2000 + DIRECTOR.fallenHoldMs - 1000)).cut).toBeNull();
    expect(directorStep(mem, fell(2000 + DIRECTOR.fallenHoldMs)).cut?.star).toBe('Cy');
    const fresh = starting('Bo', { Bo: 10, Cy: 3 });
    const gone = directorStep(fresh, seen({ Cy: 3 }, 1000, { agents: [agent('Cy', 'c')] }));
    expect(gone.cut?.star).toBe('Cy');
    expect(gone.mem.prev).toBe('Bo');
    const empty = directorStep(fresh, seen({}, 1000, { agents: [] }));
    expect(empty.cut).toBeNull();
    expect(empty.mem.star).toBeNull();
  });

  it('follows the star into another room', () => {
    const mem = starting('Bo', { Bo: 10 });
    const r = directorStep(mem, seen({ Bo: 10 }, 3000, { agents: [agent('Bo', 'c'), agent('Pip', 'a')] }));
    expect(r.cut).toBeNull();
    expect(r.mem.room).toBe('c');
  });

  it('a special moment holds the camera, then the director comes back to the star', () => {
    const mem = starting('Bo', { Bo: 10, Cy: 3 });
    const held = startMoment(mem, 10_000, DIRECTOR.projectMs);
    expect(directorStep(held, seen({ Bo: 10, Cy: 3 }, 15_000)).cut).toBeNull();
    const back = directorStep(held, seen({ Bo: 10, Cy: 3 }, 10_000 + DIRECTOR.projectMs));
    expect(back.cut).toEqual({ star: 'Bo', room: 'b' });
    expect(back.mem.since).toBe(DIRECTOR.projectMs);
    // a star whose time is nearly up is not brought back
    const late = startMoment(mem, 55_000, DIRECTOR.projectMs);
    expect(directorStep(late, seen({ Bo: 10, Cy: 3 }, 55_000 + DIRECTOR.projectMs)).cut?.star).toBe('Cy');
    // the welcome postcard has no star: the director picks one when it ends
    const welcome = startMoment(initialDirector(), 0, DIRECTOR.welcomeMs);
    expect(directorStep(welcome, seen({ Bo: 10 }, DIRECTOR.welcomeMs)).cut?.star).toBe('Bo');
  });

  it('after a resume, picks a star right away, the one before the pause at half interest', () => {
    const mem = starting('Bo', { Bo: 10, Cy: 6 });
    expect(directorStep(resumedDirector(mem, 5000), seen({ Bo: 10, Cy: 6 }, 5000)).cut?.star).toBe('Cy');
  });
});

describe('starCaption', () => {
  it('follows the star by default', () => {
    expect(starCaption('Pip', 'village.square', [], 0)).toEqual({
      key: 'ui.director.caption.following',
      params: { actor: 'Pip', room: '@room:village.square' },
    });
  });

  it("names what the star is doing from their strongest recent event in the room", () => {
    const log = [
      ev('say', 1000, 'Pip', 'r'),
      ev('fallen', 2000, 'Bo', 'r'),
      ev('level_up', 3000, 'Pip', 'r', { p: { level: 4 } }),
      ev('attack', 4000, 'Pip', 'r', { drama: 5 }),
    ];
    expect(starCaption('Pip', 'r', log, 5000)).toEqual({
      key: 'ui.director.caption.level_up',
      params: { actor: 'Pip', room: '@room:r', level: 4 },
    });
    expect(starCaption('Pip', 'r', [ev('say', 1000, 'Pip', 'r')], 2000).key).toBe('ui.director.caption.chat');
    expect(starCaption('Pip', 'r', [ev('fallen', 1000, 'Pip', 'r')], 2000).key).toBe('ui.director.caption.fallen');
  });

  it('forgets events that are too old', () => {
    expect(starCaption('Pip', 'r', [ev('level_up', 0, 'Pip', 'r')], DIRECTOR.captionMaxAgeMs + 1).key).toBe(
      'ui.director.caption.following',
    );
  });
});
