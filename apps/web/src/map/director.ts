/**
 * Director mode: the camera tours the rooms with the most drama, like a live broadcast. The choice of room and the
 * caption are pure functions so they can be tested without a renderer.
 */
import type { SpectatorEvent } from '@ajwf/shared';

export const DIRECTOR = {
  /** Never leave before this. */
  minStayMs: 20_000,
  /** Leave by this time unless the drama keeps rising. */
  maxStayMs: 40_000,
  /** Even rising drama does not hold the camera longer than this. */
  hardStayMs: 75_000,
  /** Drama "keeps rising" when the score went up within this window. */
  riseWindowMs: 8_000,
  /** Minimum increase that counts as rising: absolute floor and fraction of the peak (a busy hub always ticks up). */
  riseEpsilon: 0.5,
  riseFraction: 0.15,
  /** Rooms with less drama than this are considered quiet. */
  quiet: 0.5,
};

export type DirectorMemory = {
  room: string | null;
  /** The room before the current one. */
  prev: string | null;
  since: number;
  peak: number;
  lastRiseAt: number;
};

export function initialDirector(): DirectorMemory {
  return { room: null, prev: null, since: 0, peak: 0, lastRiseAt: 0 };
}

/**
 * Best room to cut to: the highest drama, never the current room, and not the previous one either while another room
 * has drama (no ping-pong). With no drama anywhere, the busiest room by population.
 */
export function chooseRoom(
  drama: Record<string, number>,
  current: string | null,
  prev: string | null,
  population: Record<string, number> = {},
): string | null {
  const hot = Object.entries(drama)
    .filter(([room, d]) => room !== current && d >= DIRECTOR.quiet)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const notPrev = hot.filter(([room]) => room !== prev);
  if (notPrev.length) return notPrev[0]![0];
  if (hot.length) return hot[0]![0];
  const busy = Object.entries(population)
    .filter(([room, n]) => room !== current && room !== prev && n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return busy[0]?.[0] ?? null;
}

/**
 * One step of the director. Returns the new memory and the room to cut to (null = stay). Call it about once a
 * second with the current drama scores.
 */
export function directorStep(
  mem: DirectorMemory,
  drama: Record<string, number>,
  now: number,
  population: Record<string, number> = {},
): { mem: DirectorMemory; cut: string | null } {
  if (!mem.room) {
    const room = chooseRoom(drama, null, mem.prev, population);
    if (!room) return { mem, cut: null };
    const d = drama[room] ?? 0;
    return { mem: { room, prev: mem.prev, since: now, peak: d, lastRiseAt: now }, cut: room };
  }
  const d = drama[mem.room] ?? 0;
  let { peak, lastRiseAt } = mem;
  if (d > peak + Math.max(DIRECTOR.riseEpsilon, peak * DIRECTOR.riseFraction)) {
    peak = d;
    lastRiseAt = now;
  } else if (d < peak) peak = Math.max(d, peak * 0.98);
  const next = { ...mem, peak, lastRiseAt };
  const stayed = now - mem.since;
  if (stayed < DIRECTOR.minStayMs) return { mem: next, cut: null };
  const rising = now - lastRiseAt < DIRECTOR.riseWindowMs;
  if (rising && stayed < DIRECTOR.hardStayMs) return { mem: next, cut: null };
  const candidate = chooseRoom(drama, mem.room, mem.prev, population);
  if (!candidate) return { mem: next, cut: null };
  const candidateHot = (drama[candidate] ?? 0) >= DIRECTOR.quiet;
  // Between min and max stay, leave only for a room that actually has something going on.
  if (stayed < DIRECTOR.maxStayMs && !candidateHot) return { mem: next, cut: null };
  if (stayed < DIRECTOR.maxStayMs && d >= (drama[candidate] ?? 0)) return { mem: next, cut: null };
  const cd = drama[candidate] ?? 0;
  return { mem: { room: candidate, prev: mem.room, since: now, peak: cd, lastRiseAt: now }, cut: candidate };
}

/** Caption template keys (`ui.director.caption.*`) by what happened. */
export type Caption = { key: string; params: Record<string, string | number> };

const WEIGHT: Record<string, number> = {
  fallen: 9,
  world_first: 9,
  boss_kill: 9,
  revive: 7,
  rare_drop: 7,
  achievement: 6,
  level_up: 5,
  kill: 4,
  attack: 3,
  heal: 3,
  arrival: 3,
  say: 2,
  craft: 2,
  gather: 1,
  move: 1,
};

/**
 * Builds the chapter-title caption of a room from its recent events: the strongest recent moment wins
 * (weight by type and drama, fading with age). Falls back to the room name.
 */
export function captionFor(
  roomId: string,
  events: readonly SpectatorEvent[],
  nowTs: number,
  opts: { lawless?: boolean; bosses?: ReadonlySet<string> } = {},
): Caption {
  const room = `@room:${roomId}`;
  let best: SpectatorEvent | null = null;
  let bestScore = 0;
  let talk = 0;
  let fights = 0;
  for (let i = events.length - 1; i >= 0 && i >= events.length - 60; i--) {
    const ev = events[i]!;
    const age = Math.max(0, nowTs - ev.ts);
    if (age > 90_000) break;
    if (ev.type === 'say') talk++;
    if (ev.type === 'attack' || ev.type === 'kill') fights++;
    const w = (WEIGHT[ev.type] ?? 1) + (ev.drama ?? 0);
    const s = w * Math.pow(0.5, age / 30_000);
    if (s > bestScore) {
      bestScore = s;
      best = ev;
    }
  }
  if (!best) return { key: 'ui.director.caption.room', params: { room } };
  const actor = best.actor ?? '';
  const target = best.tk === 'mon' || (best.target && !best.tk) ? (best.target ?? '') : '';
  const mon = target ? `@mon:${target.split(/[#:]/)[0]}` : '';
  switch (best.type) {
    case 'fallen':
      return { key: 'ui.director.caption.fallen', params: { room, actor } };
    case 'revive':
      return { key: 'ui.director.caption.revive', params: { room, actor } };
    case 'rare_drop':
      return { key: 'ui.director.caption.loot', params: { room, actor } };
    case 'achievement':
    case 'world_first':
      return { key: 'ui.director.caption.achievement', params: { room, actor } };
    case 'level_up':
      return { key: 'ui.director.caption.level_up', params: { room, actor, level: best.p?.level ?? '' } };
    case 'attack':
    case 'kill':
    case 'boss_kill':
      if (mon && opts.bosses?.has(mon.slice(5)))
        return { key: 'ui.director.caption.boss', params: { room, mon } };
      if (opts.lawless) return { key: 'ui.director.caption.ambush', params: { room } };
      return fights >= 4
        ? { key: 'ui.director.caption.brawl', params: { room } }
        : { key: 'ui.director.caption.battle', params: { room, mon: mon || room } };
    case 'arrival':
      return { key: 'ui.director.caption.arrival', params: { room, actor } };
    case 'say':
      return talk >= 3
        ? { key: 'ui.director.caption.gossip', params: { room } }
        : { key: 'ui.director.caption.chat', params: { room, actor } };
    case 'heal':
      return { key: 'ui.director.caption.heal', params: { room, actor } };
    default:
      return { key: 'ui.director.caption.room', params: { room } };
  }
}
