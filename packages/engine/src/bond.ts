import { bump } from './agent';
import { BALANCE } from './balance';
import { emit, markAgent, msg, tell, type Run } from './run';
import type { AgentState } from './types';

export type BondLevel = 'acquaintance' | 'friend' | 'best_friend';

export function bondLevel(v: number): BondLevel | null {
  const B = BALANCE.bond;
  if (v >= B.bestFriend) return 'best_friend';
  if (v >= B.friend) return 'friend';
  if (v >= B.acquaintance) return 'acquaintance';
  return null;
}

/**
 * The pair's score. Each side keeps only its strongest bonds, so one side may have dropped the entry: the other
 * side's copy is then the truth.
 */
export function bondScore(a: AgentState, b: AgentState): number {
  return a.bonds[b.id]?.v ?? b.bonds[a.id]?.v ?? 0;
}

export function isBestFriend(a: AgentState, b: AgentState): boolean {
  return bondScore(a, b) >= BALANCE.bond.bestFriend;
}

/** Writes the entry, evicting the weakest one when the agent is over the limit (possibly the new one itself). */
function store(a: AgentState, otherId: string, v: number, talk: number): void {
  a.bonds[otherId] = { v, talk };
  const ids = Object.keys(a.bonds);
  if (ids.length <= BALANCE.bond.keep) return;
  let weakest = ids[0]!;
  for (const id of ids) if (a.bonds[id]!.v < a.bonds[weakest]!.v) weakest = id;
  delete a.bonds[weakest];
}

function setBond(run: Run, a: AgentState, b: AgentState, v: number, talk: number): void {
  store(a, b.id, v, talk);
  store(b, a.id, v, talk);
  markAgent(run.s, a);
  markAgent(run.s, b);
}

/** Raises the bond of a pair, announcing a new level. `talk` marks a raise from chatting (rate-limited by the caller). */
export function raiseBond(run: Run, a: AgentState, b: AgentState, amount: number, talk = false): void {
  if (a === b || amount <= 0) return;
  const before = bondScore(a, b);
  const after = Math.min(BALANCE.bond.max, before + amount);
  if (after === before) return;
  const lastTalk = talk ? run.now : (a.bonds[b.id]?.talk ?? b.bonds[a.id]?.talk ?? 0);
  setBond(run, a, b, after, lastTalk);
  const level = bondLevel(after);
  if (!level || level === bondLevel(before)) return;
  const best = level === 'best_friend';
  if (best) {
    bump(run, a, 'best_friends');
    bump(run, b, 'best_friends');
  }
  for (const [x, y] of [
    [a, b],
    [b, a],
  ] as const) {
    if (run.actor === x) tell(run, 'n.bond_level', { name: y.name, level });
  }
  emit(run, 'bond', {
    room: a.room,
    actor: a.id,
    target: b.id,
    vis: best ? 'public' : 'private',
    to: [a.id, b.id],
    drama: best ? 7 : 1,
    m: msg(best ? 'ev.best_friends' : 'ev.bond_level', { actor: a.name, name: b.name, level }),
    data: { level },
  });
}

/** Lowers the bond of a pair (betrayal and the like). Levels fall silently. */
export function dropBond(run: Run, a: AgentState, b: AgentState, amount: number): void {
  if (a === b || amount <= 0) return;
  const before = bondScore(a, b);
  if (before <= 0) return;
  setBond(run, a, b, Math.max(0, before - amount), a.bonds[b.id]?.talk ?? b.bonds[a.id]?.talk ?? 0);
}

/** Talking near each other counts at most once per pair per `talkEveryMs`, so chat spam cannot farm bonds. */
export function talkBond(run: Run, a: AgentState, b: AgentState): void {
  const last = a.bonds[b.id]?.talk ?? b.bonds[a.id]?.talk ?? 0;
  if (run.now - last < BALANCE.bond.talkEveryMs) return;
  raiseBond(run, a, b, BALANCE.bond.talk, true);
}
