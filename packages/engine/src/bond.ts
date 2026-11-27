import { own } from '@ajwf/shared';
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
  return own(a.bonds, b.id)?.v ?? own(b.bonds, a.id)?.v ?? 0;
}

function lastTalkOf(a: AgentState, b: AgentState): number {
  return own(a.bonds, b.id)?.talk ?? own(b.bonds, a.id)?.talk ?? 0;
}

export function isBestFriend(a: AgentState, b: AgentState): boolean {
  return bondScore(a, b) >= BALANCE.bond.bestFriend;
}

/**
 * Writes the entry, evicting the weakest one when the agent is over the limit (possibly the new one itself).
 * Returns whether the agent's stored bonds changed: a new entry evicted at once, or an identical write, changes nothing.
 */
function store(a: AgentState, otherId: string, v: number, talk: number): boolean {
  const old = own(a.bonds, otherId);
  if (old && old.v === v && old.talk === talk) return false;
  a.bonds[otherId] = { v, talk };
  const entries = Object.entries(a.bonds);
  if (entries.length <= BALANCE.bond.keep) return true;
  let [weakest, low] = entries[0]!;
  for (const [id, bond] of entries) if (bond.v < low.v) [weakest, low] = [id, bond];
  delete a.bonds[weakest];
  return weakest !== otherId || old !== undefined;
}

/** Stores the pair's score on both sides; only a side whose stored bonds changed is marked for saving. */
function setBond(run: Run, a: AgentState, b: AgentState, v: number, talk: number): void {
  if (store(a, b.id, v, talk)) markAgent(run.s, a);
  if (store(b, a.id, v, talk)) markAgent(run.s, b);
}

/** Raises the bond of a pair, announcing a new level. `talk` marks a raise from chatting (rate-limited by the caller). */
export function raiseBond(run: Run, a: AgentState, b: AgentState, amount: number, talk = false): void {
  if (a === b || amount <= 0) return;
  const before = bondScore(a, b);
  const after = Math.min(BALANCE.bond.max, before + amount);
  if (after === before) return;
  const lastTalk = talk ? run.now : lastTalkOf(a, b);
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
  setBond(run, a, b, Math.max(0, before - amount), lastTalkOf(a, b));
}

/** Talking near each other counts at most once per pair per `talkEveryMs`, so chat spam cannot farm bonds. */
export function talkBond(run: Run, a: AgentState, b: AgentState): void {
  const last = lastTalkOf(a, b);
  if (run.now - last < BALANCE.bond.talkEveryMs) return;
  raiseBond(run, a, b, BALANCE.bond.talk, true);
}
