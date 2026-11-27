/**
 * Director mode: the camera follows one agent, the star, like a live broadcast that picks a character and stays with
 * them, then hands over to whoever is most interesting. The broadcast runs behind real time, so the director knows
 * from the scout what each agent is about to do (their interest, see `scout.ts`) and can cut to someone a few seconds
 * before their big moment. Who the star is, when to switch and the caption are pure functions so they can be tested
 * without a renderer.
 */
import type { AgentPos, SpectatorEvent } from '@ajwf/shared';

export const DIRECTOR = {
  /** Never switch star before this (except when the star leaves the world, falls, or a big moment is coming). */
  minStayMs: 12_000,
  /** Switch by this time when anyone else has interest. */
  maxStayMs: 60_000,
  /** After the minimum stay, a challenger whose interest beats the star's by this factor takes over... */
  challengerRatio: 1.3,
  /** ...if it has at least this much interest at all (the size of the smallest increment sent). */
  challengerFloor: 2,
  /** A big moment coming to another agent justifies a cut after only this long. */
  bigCutAfterMs: 6_000,
  /** An agent who was the star within this window counts at `recentFactor` of their interest (the cast rotates). */
  recentStarMs: 120_000,
  recentFactor: 0.5,
  /** A candidate whose room is not buffered yet counts at this fraction (their detail would arrive late). */
  unbufferedFactor: 0.6,
  /** A star that falls is held this long so the viewer sees it, then the director switches. */
  fallenHoldMs: 5_000,
  /** Rooms with less drama than this are considered quiet (fallback choice without interest data). */
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

/** What the scout foresees for the display time (see `scout.ts`). */
export type Foresight = {
  /** Interest of each agent: points coming in the next seconds plus recent points, decayed. */
  interest: ReadonlyMap<string, number>;
  /** Agents with a big moment within the next few seconds, and its points. */
  big: ReadonlyMap<string, { p: number }>;
  /** Whether a room's detail has been buffered since before now (its topic held longer than the lag). */
  buffered: (room: string) => boolean;
};

const NO_FORESIGHT: Foresight = { interest: new Map(), big: new Map(), buffered: () => true };

/** The world as the director sees it at one step: what the screen shows, plus what the scout foresees. */
export type DirectorWorld = {
  /** Local clock, ms. All memory times use it. */
  now: number;
  /** Server time of what the screen shows (the display clock), ms, for the age of events. */
  nowTs: number;
  /** Decayed drama per room. */
  drama: Record<string, number>;
  agents: ReadonlyMap<string, StarAgent>;
  /** Recent events per room, oldest first. */
  logs: ReadonlyMap<string, readonly SpectatorEvent[]>;
  /** Without it (no scout data), the director chooses by room drama alone. */
  foresight?: Foresight;
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
  /** When the star was first seen fallen, 0 while standing. */
  fallenAt: number;
  /** A special moment (welcome postcard, finished project) holding the camera, local ms. */
  moment: { from: number; until: number } | null;
  /** Recent stars: name -> when they stopped being the star (local ms). */
  recent: Readonly<Record<string, number>>;
};

/** A change of star: the camera glides to them. */
export type Cut = { star: string; room: string };

export function initialDirector(): DirectorMemory {
  return { star: null, room: null, prev: null, since: 0, fallenAt: 0, moment: null, recent: {} };
}

/** A special moment takes the camera until `now + durMs`; the star (if any) is kept to come back to. */
export function startMoment(mem: DirectorMemory, now: number, durMs: number): DirectorMemory {
  // A moment that interrupts another keeps the original start, so the star's time is shifted by the whole hold.
  const from = mem.moment ? mem.moment.from : now;
  return { ...mem, moment: { from, until: now + durMs } };
}

/** Memory after the viewer resumes the director: a new star right away, avoiding the one shown before the pause. */
export function resumedDirector(mem: DirectorMemory, now: number): DirectorMemory {
  return { ...initialDirector(), prev: mem.star ?? mem.prev, recent: withRecent(mem.recent, mem.star, now) };
}

/** The recent-stars record with `star` stopping now, and entries older than the window dropped. */
function withRecent(recent: Readonly<Record<string, number>>, star: string | null, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [n, at] of Object.entries(recent)) if (now - at < DIRECTOR.recentStarMs) out[n] = at;
  if (star) out[star] = now;
  return out;
}

const isFallen = (a: StarAgent) => !!a.f?.includes('d');
const isBot = (a: StarAgent) => !!a.f?.includes('b');

const WEIGHT: Record<string, number> = {
  fallen: 9,
  world_first: 9,
  boss_kill: 9,
  fountain_jackpot: 9,
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

/** Interest of a candidate as the director weighs it: halved for a recent star, lowered when their room is not buffered. */
function weighed(w: DirectorWorld, f: Foresight, mem: DirectorMemory, a: StarAgent): number {
  const i = f.interest.get(a.n) ?? 0;
  if (i <= 0) return 0;
  const at = mem.recent[a.n];
  const recent = at !== undefined && w.now - at < DIRECTOR.recentStarMs ? DIRECTOR.recentFactor : 1;
  const buffered = f.buffered(a.r) || f.big.has(a.n) ? 1 : DIRECTOR.unbufferedFactor;
  return i * recent * buffered;
}

/** The most interesting agent on screen (not fallen, not `current`); null when nobody has interest. */
export function chooseByInterest(
  w: DirectorWorld,
  mem: DirectorMemory,
  current: string | null,
): { cut: Cut; value: number } | null {
  const f = w.foresight ?? NO_FORESIGHT;
  let best: StarAgent | null = null;
  let bestV = 0;
  for (const a of w.agents.values()) {
    if (a.n === current || isFallen(a)) continue;
    const v = weighed(w, f, mem, a);
    if (v > bestV || (best && v === bestV && v > 0 && isBot(best) && !isBot(a))) {
      best = a;
      bestV = v;
    }
  }
  return best ? { cut: { star: best.n, room: best.r }, value: bestV } : null;
}

/** Someone on screen with a big moment just ahead (the largest first), other than `current`. */
function bigAheadCut(w: DirectorWorld, current: string | null): Cut | null {
  const f = w.foresight ?? NO_FORESIGHT;
  let best: { a: StarAgent; p: number } | null = null;
  for (const [name, m] of f.big) {
    const a = w.agents.get(name);
    if (!a || a.n === current || isFallen(a)) continue;
    if (!best || m.p > best.p) best = { a, p: m.p };
  }
  return best ? { star: best.a.n, room: best.a.r } : null;
}

function cutTo(w: DirectorWorld, mem: DirectorMemory, pick: Cut, prev: string | null): { mem: DirectorMemory; cut: Cut } {
  return {
    mem: {
      star: pick.star,
      room: pick.room,
      prev,
      since: w.now,
      fallenAt: 0,
      moment: null,
      recent: withRecent(mem.recent, mem.star, w.now),
    },
    cut: pick,
  };
}

/**
 * One step of the director. Returns the new memory and, when the star changes (or the camera comes back to the star
 * after a special moment), the cut to make. Call it about once a second.
 *
 * Follow the most interesting agent. Stay at least 12 s; then switch when a challenger's interest beats the star's by
 * 30 %, and at 60 s at the latest. A big moment coming to someone else within a few seconds justifies a cut after
 * 6 s, so the camera arrives before it happens. A star who falls is held 5 s; one who leaves is replaced at once.
 */
export function directorStep(mem: DirectorMemory, w: DirectorWorld): { mem: DirectorMemory; cut: Cut | null } {
  const { now } = w;
  const f = w.foresight ?? NO_FORESIGHT;
  // The best pick: a big moment just ahead, else the most interesting agent, else (no interest data) by room drama.
  const pickFor = (current: string | null) =>
    bigAheadCut(w, current) ?? chooseByInterest(w, mem, current)?.cut ?? chooseStar(w, current, mem.prev);
  if (mem.moment) {
    if (now < mem.moment.until) return { mem, cut: null };
    // Back to the star after the moment, the time it took not counted against their stay; a star whose time is
    // nearly up is not brought back only to be cut away from a moment later.
    const back = mem.star ? w.agents.get(mem.star) : undefined;
    const held = now - mem.moment.from;
    if (back && !isFallen(back) && now - (mem.since + held) < DIRECTOR.maxStayMs - DIRECTOR.returnMinLeftMs) {
      return {
        mem: { ...mem, moment: null, room: back.r, since: mem.since + held, fallenAt: 0 },
        cut: { star: back.n, room: back.r },
      };
    }
    const old = mem.star;
    mem = { ...mem, moment: null, star: null, room: null, prev: old ?? mem.prev, recent: withRecent(mem.recent, old, now) };
    const pick = pickFor(old);
    return pick ? cutTo(w, mem, pick, mem.prev) : { mem, cut: null };
  }

  if (!mem.star) {
    const pick = pickFor(null);
    return pick ? cutTo(w, mem, pick, mem.prev) : { mem, cut: null };
  }

  const switchStar = (fallback: DirectorMemory, pick: Cut | null = pickFor(mem.star)) =>
    pick ? cutTo(w, mem, pick, mem.star) : { mem: fallback, cut: null };

  const a = w.agents.get(mem.star);
  // The star left the world: switch at once (or wait with no star when nobody else is around).
  if (!a)
    return switchStar({ ...initialDirector(), prev: mem.star, recent: withRecent(mem.recent, mem.star, now) });

  // The star fell: hold a few seconds on them, then switch.
  if (isFallen(a)) {
    const fallenAt = mem.fallenAt || now;
    const next = { ...mem, room: a.r, fallenAt };
    return now - fallenAt >= DIRECTOR.fallenHoldMs ? switchStar(next) : { mem: next, cut: null };
  }

  const next: DirectorMemory = { ...mem, room: a.r, fallenAt: 0 };
  const stayed = now - mem.since;
  // Arrive before a big moment, unless the star has one coming too.
  if (stayed >= DIRECTOR.bigCutAfterMs && !f.big.has(a.n)) {
    const big = bigAheadCut(w, a.n);
    if (big) return switchStar(next, big);
  }
  if (stayed < DIRECTOR.minStayMs) return { mem: next, cut: null };
  const challenger = chooseByInterest(w, mem, a.n);
  const starInterest = f.interest.get(a.n) ?? 0;
  if (
    challenger &&
    challenger.value >= DIRECTOR.challengerFloor &&
    challenger.value > starInterest * DIRECTOR.challengerRatio
  )
    return switchStar(next, challenger.cut);
  if (stayed >= DIRECTOR.maxStayMs) {
    // Anyone else with interest; in a world where nobody has any, the room-drama choice keeps the cast moving.
    const quiet = ![...f.interest.values()].some((v) => v > 0);
    const pick = challenger?.cut ?? (quiet ? chooseStar(w, a.n, mem.prev) : null);
    if (pick) return switchStar(next, pick);
  }
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
  fountain_jackpot: 'ui.director.caption.jackpot',
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
