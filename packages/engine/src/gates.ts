import type { Room } from '@ajwf/content';
import { ref, type ErrorCode, type MsgParams } from '@ajwf/shared';
import { bossGateBlock, partyGateBlock, puzzleGateBlock } from './gate-checks';
import type { Run } from './run';
import type { AgentState } from './types';

export type Gate = Room['gates'][string];
export type Block = { code: ErrorCode; slug: string; params?: MsgParams };

/**
 * Why a gated exit will not let this agent through, or null when it is open.
 * Projects, parties, puzzles and bosses each plug their own check in here as their systems come online.
 */
export function gateBlocker(run: Run, a: AgentState, gate: Gate): Block | null {
  switch (gate.requires) {
    case 'project':
      return { code: 'NOT_AVAILABLE_HERE', slug: 'gate_project', params: { proj: ref.proj(gate.id ?? '') } };
    case 'party':
      return partyGateBlock(run, a);
    case 'puzzle':
      return puzzleGateBlock(run, a, gate.id ?? '');
    case 'boss':
      return bossGateBlock(run, a, gate.id ?? '');
  }
}
