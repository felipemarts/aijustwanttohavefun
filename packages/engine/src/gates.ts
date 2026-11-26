import type { Room } from '@ajwf/content';
import { ref, type ErrorCode, type MsgParams } from '@ajwf/shared';
import type { Run } from './run';
import type { AgentState } from './types';

export type Gate = Room['gates'][string];
export type Block = { code: ErrorCode; slug: string; params?: MsgParams };

/**
 * Why a gated exit will not let this agent through, or null when it is open.
 * Projects, parties, puzzles and bosses each plug their own check in here as their systems come online.
 */
export function gateBlocker(_run: Run, _a: AgentState, gate: Gate): Block | null {
  switch (gate.requires) {
    case 'project':
      return { code: 'NOT_AVAILABLE_HERE', slug: 'gate_project', params: { proj: ref.proj(gate.id ?? '') } };
    case 'party':
      return { code: 'PARTY_REQUIRED', slug: 'gate_party' };
    case 'puzzle':
      return { code: 'NOT_AVAILABLE_HERE', slug: 'gate_puzzle' };
    case 'boss':
      return { code: 'NOT_AVAILABLE_HERE', slug: 'gate_boss', params: { mon: ref.mon(gate.id ?? '') } };
  }
}
