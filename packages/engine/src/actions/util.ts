import type { Npc, Room } from '@ajwf/content';
import { maskBlockedWords, normalizeName, sanitizeAgentText, type ActionName, type ActionParams } from '@ajwf/shared';
import { fail, type Run } from '../run';
import type { AgentState } from '../types';

/** An action handler. It validates first (calling `fail`), then mutates the world and narrates. */
export type Handler<A extends ActionName> = (run: Run, a: AgentState, p: ActionParams<A>) => void;

export type HandlerMap = { [A in ActionName]?: Handler<A> };

/** Agents write ids loosely ("Iron Sword", "iron-sword"); fold them to the canonical form. */
export function normId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function roomDef(run: Run, a: AgentState): Room {
  return run.c.rooms.get(a.room)!;
}

export function hasFlag(run: Run, a: AgentState, flag: Room['flags'][number]): boolean {
  return roomDef(run, a).flags.includes(flag);
}

/** The NPC with this id standing in the agent's room. Accepts "npc.olga" and "olga". */
export function npcHere(run: Run, a: AgentState, raw: string): Npc {
  const id = normId(raw).replace(/^npc\./, '');
  const npc = run.c.npcsByRoom.get(a.room)?.find((n) => n.id === id);
  if (!npc) fail('TARGET_NOT_FOUND', 'npc_not_here', { npc: raw });
  return npc;
}

export function agentByName(run: Run, name: string): AgentState | undefined {
  const id = run.s.byName.get(normalizeName(name));
  const b = id ? run.s.agents.get(id) : undefined;
  return b && b.status === 'active' ? b : undefined;
}

/** Another agent, by name, who must be in the same room. */
export function agentHere(run: Run, a: AgentState, name: string): AgentState {
  const b = agentByName(run, name);
  if (!b || b.room !== a.room) fail('TARGET_NOT_FOUND', 'agent_not_here', { name });
  return b;
}

/** Cleans free text written by an agent: invisible characters, links, secrets and blocked words. */
export function cleanText(raw: string, max: number, multiline = false): string {
  const res = sanitizeAgentText(raw, max, { multiline });
  if (res.empty) fail('INVALID_PARAMS', 'empty_text');
  return maskBlockedWords(res.text);
}
