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

describe('directorStep', () => {
  const busy = (star: string) => (t: number) =>
    world(
      [agent('Pip', 'a'), agent('Bo', 'b'), agent('Cy', 'c')],
      { a: 2, b: 8, c: 4 },
      // the star keeps busy, so the idle rule never applies
      [ev('gather', t, star, star === 'Pip' ? 'a' : star === 'Bo' ? 'b' : 'c'), ev('kill', t, 'Bo', 'b'), ev('kill', t, 'Cy', 'c')],
      t,
    );

  it('picks a star at once, stays the minimum time, and switches by the maximum stay when drama is flat', () => {
    const first = directorStep(initialDirector(), busy('Bo')(0));
    expect(first.cut).toEqual({ star: 'Bo', room: 'b' });
    const r = firstCut(first.mem, 1000, DIRECTOR.hardStayMs, busy('Bo'));
    expect(r.at).toBe(DIRECTOR.maxStayMs);
    expect(r.cut?.star).not.toBe('Bo');
    expect(r.mem.prev).toBe('Bo');
  });

  it('holds a star longer while the drama of their room keeps rising, but not past the hard limit', () => {
    const w = (t: number) => ({ ...busy('Bo')(t), drama: { a: 2, b: 8 * Math.pow(1.1, t / 1000), c: 4 } });
    const first = directorStep(initialDirector(), w(0));
    const r = firstCut(first.mem, 1000, DIRECTOR.hardStayMs + 2000, w);
    expect(r.at).toBe(DIRECTOR.hardStayMs);
  });

  it('switches early, after the minimum stay, when the star is idle and another room has drama', () => {
    const quiet = (t: number) =>
      world([agent('Pip', 'a'), agent('Bo', 'b')], { a: 9, b: 4 }, [ev('kill', 0, 'Pip', 'a'), ev('kill', t, 'Bo', 'b')], t);
    const first = directorStep(initialDirector(), quiet(0));
    expect(first.cut?.star).toBe('Pip');
    const r = firstCut(first.mem, 1000, DIRECTOR.maxStayMs, quiet);
    expect(r.at).toBe(DIRECTOR.minStayMs);
    expect(r.cut).toEqual({ star: 'Bo', room: 'b' });
    // with no drama anywhere else, an idle star is kept until the maximum stay
    const alone = (t: number) => ({ ...quiet(t), drama: { a: 9 } });
    expect(firstCut(directorStep(initialDirector(), alone(0)).mem, 1000, DIRECTOR.hardStayMs, alone).at).toBe(DIRECTOR.maxStayMs);
  });

  it('switches at once when the star leaves the world', () => {
    const first = directorStep(initialDirector(), busy('Bo')(0));
    const gone = { ...busy('Bo')(3000), agents: new Map([['Pip', agent('Pip', 'a')], ['Cy', agent('Cy', 'c')]]) };
    const r = directorStep(first.mem, gone);
    expect(r.cut?.star).toBe('Cy');
    expect(r.mem.prev).toBe('Bo');
    // nobody left: no star, and one is picked as soon as someone shows up
    const empty = directorStep(first.mem, world([], {}, [], 3000));
    expect(empty.cut).toBeNull();
    expect(empty.mem.star).toBeNull();
    expect(directorStep(empty.mem, world([agent('Zed', 'z')], {}, [], 4000)).cut?.star).toBe('Zed');
  });

  it('holds a fallen star a few seconds, then switches; a fallen agent is never picked', () => {
    const w = (t: number, f?: string) => ({
      ...busy('Bo')(t),
      agents: new Map([
        ['Bo', agent('Bo', 'b', f)],
        ['Cy', agent('Cy', 'c')],
        ['Pip', agent('Pip', 'a', 'd')],
      ]),
    });
    let mem = directorStep(initialDirector(), w(0)).mem;
    mem = directorStep(mem, w(2000, 'd')).mem;
    expect(mem.fallenAt).toBe(2000);
    expect(directorStep(mem, w(2000 + DIRECTOR.fallenHoldMs - 1000, 'd')).cut).toBeNull();
    const r = directorStep(mem, w(2000 + DIRECTOR.fallenHoldMs, 'd'));
    expect(r.cut).toEqual({ star: 'Cy', room: 'c' });
  });

  it('follows the star into another room and measures the rise there', () => {
    let mem = directorStep(initialDirector(), busy('Bo')(0)).mem;
    const moved = { ...busy('Bo')(5000), agents: new Map([['Bo', agent('Bo', 'c')], ['Pip', agent('Pip', 'a')]]) };
    const r = directorStep(mem, moved);
    expect(r.cut).toBeNull();
    mem = r.mem;
    expect(mem.star).toBe('Bo');
    expect(mem.room).toBe('c');
    expect(mem.peak).toBe(4);
  });

  it('a special moment holds the camera, then the director comes back to the star', () => {
    const first = directorStep(initialDirector(), busy('Bo')(0));
    const held = startMoment(first.mem, 10_000, DIRECTOR.projectMs);
    expect(directorStep(held, busy('Bo')(15_000)).cut).toBeNull();
    const back = directorStep(held, busy('Bo')(10_000 + DIRECTOR.projectMs));
    expect(back.cut).toEqual({ star: 'Bo', room: 'b' });
    expect(back.mem.moment).toBeNull();
    // the moment's time is not counted against the star's stay
    expect(back.mem.since).toBe(DIRECTOR.projectMs);
    // a star whose time is nearly up is not brought back
    const late = startMoment(first.mem, 40_000, DIRECTOR.projectMs);
    const after = directorStep(late, busy('Bo')(40_000 + DIRECTOR.projectMs));
    expect(after.cut?.star).toBe('Cy');
    expect(after.mem.prev).toBe('Bo');
    // the welcome postcard has no star: the director picks one when it ends
    const welcome = startMoment(initialDirector(), 0, DIRECTOR.welcomeMs);
    expect(directorStep(welcome, busy('Bo')(DIRECTOR.welcomeMs)).cut?.star).toBe('Bo');
  });

  it('after a resume, picks a new star right away, avoiding the one shown before', () => {
    const first = directorStep(initialDirector(), busy('Bo')(0));
    const r = directorStep(resumedDirector(first.mem), busy('Bo')(5000));
    expect(r.cut?.star).toBe('Cy');
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
