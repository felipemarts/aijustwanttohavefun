/**
 * Director mode: the camera follows one agent, the star, like a live broadcast that picks a character and stays with
 * them, then hands over to someone else where the drama is. Who the star is, when to switch and the caption are pure
 * functions so they can be tested without a renderer.
 */
import type { AgentPos, SpectatorEvent } from '@ajwf/shared';

export const DIRECTOR = {
  /** Never switch star before this (except when the star leaves the world or falls). */
  minStayMs: 20_000,
  /** Switch by this time unless the drama of the star's room keeps rising. */
  maxStayMs: 45_000,
  /** Even rising drama does not hold a star longer than this. */
  hardStayMs: 75_000,
  /** After the minimum stay, a star with no event for this long hands over to a room with drama. */
  idleMs: 15_000,
  /** A star that falls is held this long so the viewer sees it, then the director switches. */
  fallenHoldMs: 5_000,
  /** Drama "keeps rising" when the score went up within this window. */
  riseWindowMs: 8_000,
  /** Minimum increase that counts as rising: absolute floor and fraction of the peak (a busy hub always ticks up). */
  riseEpsilon: 0.5,
  riseFraction: 0.15,
  /** Rooms with less drama than this are considered quiet. */
  quiet: 0.5,
  /** Moments considered when ranking a room: the newest events up to this many, no older than the age below. */
  momentEvents: 60,
  momentMaxAgeMs: 90_000,
  /** The caption tells what the star is doing from their events no older than this. */
  captionMaxAgeMs: 30_000,
  /** How long the special moments hold the camera before the director goes back to a star. */
  welcomeMs: 12_000,
  projectMs: 10_000,
  /** After a moment, the camera goes back to the star only if they have at least this long left before the max stay. */
  returnMinLeftMs: 10_000,
};

/** What the director needs to know about an agent (the public world view's position record). */
export type StarAgent = Pick<AgentPos, 'n' | 'r' | 'l' | 'f'>;

/** The world as the director sees it at one step. */
export type DirectorWorld = {
  /** Local clock, ms. All memory times use it. */
  now: number;
  /** Server clock, ms, for the age of events. */
  nowTs: number;
  /** Decayed drama per room. */
  drama: Record<string, number>;
  agents: ReadonlyMap<string, StarAgent>;
  /** Recent events per room, oldest first. */
  logs: ReadonlyMap<string, readonly SpectatorEvent[]>;
};

export type DirectorMemory = {
  /** The agent the camera follows, or null when none is chosen yet. */
  star: string | null;
  /** The star's room at the last step. */
  room: string | null;
  /** The star before the current one. */
  prev: string | null;
  /** When the current star was chosen (local ms). */
  since: number;
  /** Drama of the star's current room: peak and the last time it rose. */
  peak: number;
  lastRiseAt: number;
  /** When the star was first seen fallen, 0 while standing. */
  fallenAt: number;
  /** A special moment (welcome postcard, finished project) holding the camera, local ms. */
  moment: { from: number; until: number } | null;
};

/** A change of star: the camera glides to them. */
export type Cut = { star: string; room: string };

export function initialDirector(): DirectorMemory {
  return { star: null, room: null, prev: null, since: 0, peak: 0, lastRiseAt: 0, fallenAt: 0, moment: null };
}

/** A special moment takes the camera until `now + durMs`; the star (if any) is kept to come back to. */
export function startMoment(mem: DirectorMemory, now: number, durMs: number): DirectorMemory {
  // A moment that interrupts another keeps the original start, so the star's time is shifted by the whole hold.
  const from = mem.moment ? mem.moment.from : now;
  return { ...mem, moment: { from, until: now + durMs } };
}

/** Memory after the viewer resumes the director: a new star right away, avoiding the one shown before the pause. */
export function resumedDirector(mem: DirectorMemory): DirectorMemory {
  return { ...initialDirector(), prev: mem.star ?? mem.prev };
}

const isFallen = (a: StarAgent) => !!a.f?.includes('d');
const isBot = (a: StarAgent) => !!a.f?.includes('b');

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

/** Strength of a moment: weight by type plus its drama, halving every 30 s. */
export function momentScore(ev: SpectatorEvent, nowTs: number): number {
  const age = Math.max(0, nowTs - ev.ts);
  return ((WEIGHT[ev.type] ?? 1) + (ev.drama ?? 0)) * Math.pow(0.5, age / 30_000);
}

/**
 * The recent moments of a room, strongest first (the newer one first on a tie): the newest events, no older than
 * `momentMaxAgeMs`. Events are expected oldest first, as the room logs keep them.
 */
export function rankMoments(
  events: readonly SpectatorEvent[],
  nowTs: number,
): { ev: SpectatorEvent; score: number }[] {
  const out: { ev: SpectatorEvent; score: number }[] = [];
  for (let i = events.length - 1; i >= 0 && i >= events.length - DIRECTOR.momentEvents; i--) {
    const ev = events[i]!;
    if (nowTs - ev.ts > DIRECTOR.momentMaxAgeMs) break;
    out.push({ ev, score: momentScore(ev, nowTs) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Any agent of a group: not a bot first, then the highest level, then by name (stable). */
function pickAny(group: readonly StarAgent[]): StarAgent | null {
  let best: StarAgent | null = null;
  for (const a of group) {
    if (
      !best ||
      Number(isBot(a)) < Number(isBot(best)) ||
      (isBot(a) === isBot(best) && (a.l > best.l || (a.l === best.l && a.n < best.n)))
    )
      best = a;
  }
  return best;
}

function pickAmong(w: DirectorWorld, usable: (a: StarAgent) => boolean): Cut | null {
  const byRoom = new Map<string, StarAgent[]>();
  for (const a of w.agents.values()) {
    if (!usable(a)) continue;
    let list = byRoom.get(a.r);
    if (!list) byRoom.set(a.r, (list = []));
    list.push(a);
  }
  const hot = Object.entries(w.drama)
    .filter(([, d]) => d >= DIRECTOR.quiet)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [room] of hot) {
    const here = byRoom.get(room);
    if (!here?.length) continue;
    // The actor at the centre of the room's strongest moment; on equal moments, not a bot.
    let best: StarAgent | null = null;
    let bestScore = 0;
    for (const { ev, score } of rankMoments(w.logs.get(room) ?? [], w.nowTs)) {
      if (best && score < bestScore) break;
      const a = ev.actor ? here.find((x) => x.n === ev.actor) : undefined;
      if (!a) continue;
      if (!best || (isBot(best) && !isBot(a))) {
        best = a;
        bestScore = score;
      }
    }
    best ??= pickAny(here);
    if (best) return { star: best.n, room };
  }
  // Nothing going on where anyone usable stands: someone in the busiest room.
  const busy = [...byRoom.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))[0];
  const any = busy ? pickAny(busy[1]) : null;
  return any ? { star: any.n, room: any.r } : null;
}

/**
 * The next star: the room with the most drama, and in it the actor of its strongest recent moment (the agent at the
 * centre of what is happening), else anyone standing there; with no drama anywhere, someone in the busiest room.
 * Never the current star or a fallen agent, and not the previous star while anyone else qualifies.
 */
export function chooseStar(w: DirectorWorld, current: string | null, prev: string | null): Cut | null {
  const ok = (a: StarAgent) => a.n !== current && !isFallen(a);
  return pickAmong(w, (a) => ok(a) && a.n !== prev) ?? pickAmong(w, ok);
}

/** Newest event of an agent in a room log, by server time; null when none. */
function lastEventTs(name: string, events: readonly SpectatorEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.actor === name) return events[i]!.ts;
  return null;
}

function cutTo(w: DirectorWorld, pick: Cut, prev: string | null): { mem: DirectorMemory; cut: Cut } {
  return {
    mem: {
      star: pick.star,
      room: pick.room,
      prev,
      since: w.now,
      peak: w.drama[pick.room] ?? 0,
      lastRiseAt: w.now,
      fallenAt: 0,
      moment: null,
    },
    cut: pick,
  };
}

/**
 * One step of the director. Returns the new memory and, when the star changes (or the camera comes back to the star
 * after a special moment), the cut to make. Call it about once a second.
 */
export function directorStep(mem: DirectorMemory, w: DirectorWorld): { mem: DirectorMemory; cut: Cut | null } {
  const { now } = w;
  if (mem.moment) {
    if (now < mem.moment.until) return { mem, cut: null };
    // Back to the star after the moment, the time it took not counted against their stay; a star whose time is
    // nearly up is not brought back only to be cut away from a moment later.
    const back = mem.star ? w.agents.get(mem.star) : undefined;
    const held = now - mem.moment.from;
    if (back && !isFallen(back) && now - (mem.since + held) < DIRECTOR.maxStayMs - DIRECTOR.returnMinLeftMs) {
      return {
        mem: {
          ...mem,
          moment: null,
          room: back.r,
          since: mem.since + held,
          peak: w.drama[back.r] ?? 0,
          lastRiseAt: mem.lastRiseAt + held,
          fallenAt: 0,
        },
        cut: { star: back.n, room: back.r },
      };
    }
    mem = { ...initialDirector(), prev: mem.star ?? mem.prev };
  }

  if (!mem.star) {
    const pick = chooseStar(w, null, mem.prev);
    return pick ? cutTo(w, pick, mem.prev) : { mem, cut: null };
  }

  const switchStar = (fallback: DirectorMemory) => {
    const pick = chooseStar(w, mem.star, mem.prev);
    return pick ? cutTo(w, pick, mem.star) : { mem: fallback, cut: null };
  };

  const a = w.agents.get(mem.star);
  // The star left the world: switch at once (or wait with no star when nobody else is around).
  if (!a) return switchStar({ ...initialDirector(), prev: mem.star });

  // The star fell: hold a few seconds on them, then switch.
  if (isFallen(a)) {
    const fallenAt = mem.fallenAt || now;
    const next = { ...mem, room: a.r, fallenAt };
    return now - fallenAt >= DIRECTOR.fallenHoldMs ? switchStar(next) : { mem: next, cut: null };
  }

  // Rise of the drama around the star; a new room starts its own measure.
  const d = w.drama[a.r] ?? 0;
  let { peak, lastRiseAt } = mem;
  if (a.r !== mem.room) peak = d;
  else if (d > peak + Math.max(DIRECTOR.riseEpsilon, peak * DIRECTOR.riseFraction)) {
    peak = d;
    lastRiseAt = now;
  } else if (d < peak) peak = Math.max(d, peak * 0.98);
  const next: DirectorMemory = { ...mem, room: a.r, peak, lastRiseAt, fallenAt: 0 };

  const stayed = now - mem.since;
  if (stayed < DIRECTOR.minStayMs) return { mem: next, cut: null };
  if (stayed >= DIRECTOR.hardStayMs) return switchStar(next);
  const last = lastEventTs(a.n, w.logs.get(a.r) ?? []);
  const idle = last === null || w.nowTs - last >= DIRECTOR.idleMs;
  const dramaElsewhere = Object.entries(w.drama).some(([room, x]) => room !== a.r && x >= DIRECTOR.quiet);
  if (idle && dramaElsewhere) return switchStar(next);
  if (now - lastRiseAt < DIRECTOR.riseWindowMs) return { mem: next, cut: null };
  if (stayed >= DIRECTOR.maxStayMs) return switchStar(next);
  return { mem: next, cut: null };
}

/** Caption template keys (`ui.director.caption.*`) by what happened. */
export type Caption = { key: string; params: Record<string, string | number> };

/** Event types that tell what the star is doing, and the caption each one gets. */
const STAR_CAPTION: Record<string, string> = {
  fallen: 'ui.director.caption.fallen',
  achievement: 'ui.director.caption.achievement',
  world_first: 'ui.director.caption.achievement',
  level_up: 'ui.director.caption.level_up',
  say: 'ui.director.caption.chat',
};

/**
 * The chapter-title caption of the star: their name and room, and what they are doing when one of their recent
 * events in that room says so (the strongest one wins, fading with age). Otherwise "following {actor} in {room}".
 */
export function starCaption(
  star: string,
  roomId: string,
  events: readonly SpectatorEvent[],
  nowTs: number,
): Caption {
  const room = `@room:${roomId}`;
  let best: SpectatorEvent | null = null;
  let bestScore = 0;
  for (let i = events.length - 1; i >= 0 && i >= events.length - DIRECTOR.momentEvents; i--) {
    const ev = events[i]!;
    if (nowTs - ev.ts > DIRECTOR.captionMaxAgeMs) break;
    if (ev.actor !== star || !STAR_CAPTION[ev.type] || (ev.room && ev.room !== roomId)) continue;
    const s = momentScore(ev, nowTs);
    if (s > bestScore) {
      bestScore = s;
      best = ev;
    }
  }
  if (!best) return { key: 'ui.director.caption.following', params: { actor: star, room } };
  const params: Record<string, string | number> = { actor: star, room };
  if (best.type === 'level_up') params.level = best.p?.level ?? '';
  return { key: STAR_CAPTION[best.type]!, params };
}
