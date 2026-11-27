import type { Content, Puzzle } from '@ajwf/content';
import { ref, type ActionName, type ClassId } from '@ajwf/shared';
import { bump } from './agent';
import type { Block } from './gates';
import { markParty, partyHere, partyOf } from './party';
import { questEvent } from './quests';
import { emit, fail, markAgent, msg, type Run } from './run';
import type { AgentState, PuzzleState, WorldState } from './types';
import { freshPuzzle } from './world';

export type PuzzleType = Puzzle['type'];

/** The action that works each kind of puzzle, and the class it needs (null: anyone). */
export const PUZZLE_ACTION: Record<PuzzleType, ActionName> = { levers: 'pull_lever', trap: 'disarm', seal: 'read_runes', gate: 'hold_gate', lock: 'pick_lock' };
export const PUZZLE_CLASS: Record<PuzzleType, ClassId | null> = { levers: null, trap: 'rogue', seal: 'mage', gate: 'warrior', lock: 'rogue' };
/** Counter of the agent who did the class's part. */
const PUZZLE_STAT: Partial<Record<PuzzleType, string>> = { lock: 'locks_picked', trap: 'traps_disarmed', seal: 'seals_opened', gate: 'gates_held' };

/** The winch that raises a gate from its far side. */
export const WINCH = 'winch';

export const puzzleRef = (id: string): string => `@puzzle:${id}`;

const FRESH: PuzzleState = Object.freeze(freshPuzzle()) as PuzzleState;

/** The live state of a puzzle, for reading. */
export function peekPuzzle(s: WorldState, id: string): PuzzleState {
  return s.puzzles[id] ?? FRESH;
}

/** The live state of a puzzle, for changing it (created when the content gained the puzzle after a snapshot). */
export function puzzleState(s: WorldState, id: string): PuzzleState {
  let st = s.puzzles[id];
  if (!st) s.puzzles[id] = st = freshPuzzle();
  s.dirty.add('puzzles');
  return st;
}

const winchCache = new WeakMap<Content, Map<string, Puzzle[]>>();

/** Gate puzzles whose winch stands in this room. */
export function winchesIn(c: Content, roomId: string): Puzzle[] {
  let byRoom = winchCache.get(c);
  if (!byRoom) {
    byRoom = new Map();
    for (const pz of c.puzzles.values()) {
      if (pz.type !== 'gate' || !pz.winch_room) continue;
      byRoom.set(pz.winch_room, [...(byRoom.get(pz.winch_room) ?? []), pz]);
    }
    winchCache.set(c, byRoom);
  }
  return byRoom.get(roomId) ?? [];
}

/** The Warrior holding a gate up right now: present since before the hold, standing, and within the time limit. */
export function gateHolder(s: WorldState, pz: Puzzle, now: number): AgentState | null {
  const st = peekPuzzle(s, pz.id);
  if (!st.hold || st.open <= now) return null;
  const b = s.agents.get(st.hold.by);
  if (!b || b.status !== 'active' || b.room !== pz.room || b.fallen || b.roomAt > st.hold.at) return null;
  return b;
}

/** Whether the way a puzzle guards lets this agent through now. A Warrior's own hold does not carry itself. */
export function puzzleOpenFor(s: WorldState, pz: Puzzle, now: number, a?: AgentState): boolean {
  const st = peekPuzzle(s, pz.id);
  switch (pz.type) {
    case 'gate': {
      if (st.winch > now) return true;
      const holder = gateHolder(s, pz, now);
      return !!holder && holder !== a;
    }
    case 'lock':
      return false;
    default:
      return st.open > now;
  }
}

/** Why a puzzle-gated exit stays shut for this agent, or null when it is open. */
export function puzzleBlock(run: Run, a: AgentState, id: string): Block | null {
  const pz = run.c.puzzles.get(id);
  if (!pz) return null;
  if (puzzleOpenFor(run.s, pz, run.now, a)) return null;
  if (pz.type === 'gate' && gateHolder(run.s, pz, run.now) === a) return { code: 'NOT_ALLOWED', slug: 'gate_holding', params: { puzzle: puzzleRef(id) } };
  return { code: 'NOT_AVAILABLE_HERE', slug: 'gate_puzzle', params: { puzzle: puzzleRef(id), action: PUZZLE_ACTION[pz.type] } };
}

/** Opens the way for `ms` and schedules the check that closes it. */
export function openPuzzle(run: Run, pz: Puzzle, st: PuzzleState, ms: number): void {
  st.open = Math.max(st.open, run.now + ms);
  run.s.timers.push({ at: st.open, kind: 'puzzle', id: pz.id });
  run.s.dirty.add('puzzles');
}

/**
 * Credit for solving: `puzzles_solved` and the quest step for the solvers and the party members standing with them,
 * plus the class counter for the solvers themselves.
 */
export function creditSolve(run: Run, pz: Puzzle, solvers: AgentState[]): void {
  const all = new Set<AgentState>();
  for (const x of solvers) for (const b of partyHere(run, x)) all.add(b);
  for (const b of all) {
    bump(run, b, 'puzzles_solved');
    questEvent(run, b, 'puzzle', pz.id);
    markAgent(run.s, b);
  }
  const stat = PUZZLE_STAT[pz.type];
  if (stat) for (const x of solvers) bump(run, x, stat);
}

/** Who gets a puzzle's loot: the picker alone, or the party's loot rule among the members standing here. */
export function puzzleLootReceiver(run: Run, a: AgentState): AgentState {
  const p = partyOf(run.s, a);
  if (!p) return a;
  // In join order, like monster drops, so the rotation does not favour whoever opened the lock.
  const here = p.members.map((id) => run.s.agents.get(id)!).filter((b) => b === a || (b.room === a.room && !b.fallen));
  if (here.length === 1) return a;
  if (p.loot === 'leader') return here.find((b) => b.id === p.leader) ?? a;
  const b = here[p.rr % here.length]!;
  p.rr++;
  markParty(run.s, p);
  return b;
}

/** A puzzle timer: closes what is due (and refills locks). Duplicates and stale timers find nothing to do. */
export function puzzleTimer(run: Run, id: string): void {
  const { s, now } = run;
  const pz = s.content.puzzles.get(id);
  const st = s.puzzles[id];
  if (!pz || !st) return;
  if (pz.type === 'lock') {
    if (st.ready && st.ready <= now) {
      st.ready = 0;
      s.dirty.add('puzzles');
    }
    return;
  }
  if (st.open > now || st.winch > now) return;
  if (!st.open && !st.winch && !st.hold) return;
  st.open = 0;
  st.winch = 0;
  st.hold = null;
  st.pulls = {};
  s.dirty.add('puzzles');
  emit(run, 'puzzle_closed', { room: pz.room, to: 'room', m: msg('ev.puzzle_closed', { puzzle: puzzleRef(id) }), data: { puzzle: id } });
}

/** A Warrior walking away lets go of the gate it holds. */
export function releaseHold(run: Run, a: AgentState): boolean {
  let released = false;
  for (const pz of run.c.puzzlesByRoom.get(a.room) ?? []) {
    if (pz.type !== 'gate') continue;
    const st = run.s.puzzles[pz.id];
    if (!st?.hold || st.hold.by !== a.id) continue;
    st.hold = null;
    st.open = 0;
    run.s.dirty.add('puzzles');
    released = true;
    if (st.winch <= run.now) emit(run, 'puzzle_closed', { room: pz.room, to: 'room', m: msg('ev.puzzle_closed', { puzzle: puzzleRef(pz.id) }), data: { puzzle: pz.id } });
  }
  return released;
}

/** Compact view of a puzzle for `observe`: what works on it and its live state. */
export type PuzzleView = {
  id: string;
  do: ActionName;
  targets: string[];
  /** Class needed to work it. */
  cls?: ClassId;
  /** Seconds the way stays open. */
  open?: number;
  /** Levers already pulled in the current window. */
  pulled?: string[];
  /** Name of the Warrior holding a gate. */
  held?: string;
  /** Seconds until a lock has loot again. */
  wait?: number;
};

export function puzzleViews(s: WorldState, roomId: string, now: number): PuzzleView[] {
  const out: PuzzleView[] = [];
  const secs = (t: number) => Math.max(1, Math.ceil((t - now) / 1000));
  for (const pz of s.content.puzzlesByRoom.get(roomId) ?? []) {
    const st = peekPuzzle(s, pz.id);
    const cls = PUZZLE_CLASS[pz.type];
    const v: PuzzleView = { id: pz.id, do: PUZZLE_ACTION[pz.type], targets: pz.targets, ...(cls ? { cls } : {}) };
    if (pz.type === 'lock') {
      if (st.ready > now) v.wait = secs(st.ready);
    } else if (pz.type === 'gate') {
      const holder = gateHolder(s, pz, now);
      if (holder) {
        v.held = holder.name;
        v.open = secs(st.open);
      } else if (st.winch > now) v.open = secs(st.winch);
    } else if (st.open > now) v.open = secs(st.open);
    if (pz.type === 'levers' && !v.open) {
      const pulled = Object.keys(st.pulls).filter((t) => st.pulls[t]!.at > now - pz.window_sec * 1000);
      if (pulled.length) v.pulled = pulled;
    }
    out.push(v);
  }
  for (const pz of winchesIn(s.content, roomId)) {
    const st = peekPuzzle(s, pz.id);
    out.push({ id: pz.id, do: 'pull_lever', targets: [WINCH], ...(st.winch > now ? { open: secs(st.winch) } : {}) });
  }
  return out;
}

/** Refuses an action the agent's class cannot do, naming the class to look for. */
export function needClass(a: AgentState, cls: ClassId, action: ActionName): void {
  if (a.cls !== cls) fail('CLASS_REQUIRED', 'class_action', { class: ref.cls(cls), action });
}
