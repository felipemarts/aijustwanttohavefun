import { own, ref } from '@ajwf/shared';
import { BALANCE } from './balance';
import type { Block } from './gates';
import { puzzleBlock } from './puzzles';
import type { Run } from './run';
import type { AgentState } from './types';

/**
 * Party gates (§6.3): a party of 3 or 4 with at least 2 classes. Members count when standing in this room or already
 * past one of its party gates, so the last members can follow the first ones through.
 */
export function partyGateBlock(run: Run, a: AgentState): Block | null {
  const P = BALANCE.puzzle;
  const block: Block = { code: 'PARTY_REQUIRED', slug: 'gate_party', params: { n: P.partyMin, classes: P.partyClasses } };
  const p = a.party ? run.s.parties.get(a.party) : undefined;
  if (!p || p.members.length < P.partyMin) return block;
  const room = run.c.rooms.get(a.room)!;
  const sides = new Set([a.room]);
  for (const [dir, g] of Object.entries(room.gates)) if (g.requires === 'party') sides.add(own(room.exits, dir)!);
  const classes = new Set<string>();
  let n = 0;
  for (const id of p.members) {
    const b = run.s.agents.get(id);
    if (!b || b.fallen || !sides.has(b.room)) continue;
    n++;
    classes.add(b.cls);
  }
  return n >= P.partyMin && classes.size >= P.partyClasses ? null : block;
}

/** Puzzle gates: open while the puzzle is (see puzzles.ts). */
export function puzzleGateBlock(run: Run, a: AgentState, id: string): Block | null {
  return puzzleBlock(run, a, id);
}

/** Boss gates: open while that boss is dead in this room, waiting to respawn. */
export function bossGateBlock(run: Run, a: AgentState, mon: string): Block | null {
  const room = run.s.rooms.get(a.room);
  const alive = room?.monsters.some((m) => m.kind === mon);
  return alive ? { code: 'NOT_AVAILABLE_HERE', slug: 'gate_boss', params: { mon: ref.mon(mon) } } : null;
}
