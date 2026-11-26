import type { Run } from './run';
import type { AgentState } from './types';

/**
 * The agent plus the members of its party standing in the same room and able to act.
 * Parties arrive with the cooperation milestone; until then an agent is always alone.
 */
export function partyHere(_run: Run, a: AgentState): AgentState[] {
  return [a];
}
