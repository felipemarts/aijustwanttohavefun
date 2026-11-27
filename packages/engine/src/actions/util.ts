import type { Npc, Room } from '@ajwf/content';
import { maskBlockedWords, normalizeName, ref, sanitizeAgentText, type ActionName, type ActionParams } from '@ajwf/shared';
import { BALANCE } from '../balance';
import { fail, type Run } from '../run';
import type { AgentState } from '../types';

/** An action handler. It validates first (calling `fail`), then mutates the world and narrates. */
export type Handler<A extends ActionName> = (run: Run, a: AgentState, p: ActionParams<A>) => void;

export type HandlerMap = { [A in ActionName]?: Handler<A> };

/** Agents write ids loosely ("Iron Sword", "iron-sword"); fold them to the canonical form. */
export function normId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * A name an agent typed, for a refusal: a reference to the content entry it resolves to (rendered as that entry's
 * localized name), or the raw text when it names nothing known.
 */
export function typedRef(run: Run, kind: 'item' | 'mon' | 'npc', raw: string, id = normId(raw)): string {
  const known = kind === 'item' ? run.c.items.has(id) : kind === 'mon' ? run.c.monsters.has(id) : run.c.npcs.has(id);
  return known ? ref[kind](id) : raw;
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
  if (!npc) fail('TARGET_NOT_FOUND', 'npc_not_here', { npc: typedRef(run, 'npc', raw, id) });
  return npc;
}

export function agentByName(run: Run, name: string): AgentState | undefined {
  const id = run.s.byName.get(normalizeName(name));
  const b = id ? run.s.agents.get(id) : undefined;
  return b && b.status === 'active' ? b : undefined;
}

/** Refuses an action aimed at `b`, who is not in `a`'s room; when `b` just walked out of it, says which way. */
export function notHere(run: Run, a: AgentState, b: AgentState | undefined, name: string): never {
  const exit = b?.lastExit;
  if (b && exit && exit.room === a.room && run.now - b.roomAt <= BALANCE.social.leftHintMs) {
    fail('TARGET_NOT_FOUND', 'agent_left', { name: b.name, dir: ref.dir(exit.dir), dir_id: exit.dir, seconds: Math.max(1, Math.ceil((run.now - b.roomAt) / 1000)) });
  }
  fail('TARGET_NOT_FOUND', 'agent_not_here', { name });
}

/** Another agent, by name, who must be in the same room. */
export function agentHere(run: Run, a: AgentState, name: string): AgentState {
  const b = agentByName(run, name);
  if (!b || b.room !== a.room) notHere(run, a, b, name);
  return b;
}

/**
 * A whole-number parameter (quantity, price, gold) of at least `min`. The schemas already bound every one of them;
 * this second check keeps the engine sound for any caller that skips them (`applyParsed`), so a float, NaN or
 * Infinity never reaches a balance.
 */
export function wholeNumber(v: number, field: string, min: number): number {
  if (!(Number.isSafeInteger(v) && v >= min)) fail('INVALID_PARAMS', 'bad_number', { field, min });
  return v;
}

/**
 * A wait for a hint, rounded up so it is never shorter than the real one: `seconds`, plus `minutes` (0 under
 * `BALANCE.waitHint.minutesFromSec`) for messages that switch to minutes for long waits.
 */
export function waitParams(ms: number): { seconds: number; minutes: number } {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return { seconds, minutes: seconds >= BALANCE.waitHint.minutesFromSec ? Math.ceil(seconds / 60) : 0 };
}

/** A value of a closed list (enum param); refused otherwise, like the schema would. */
export function oneOf<T extends string>(v: unknown, list: readonly T[], action: ActionName, field: string): T {
  if (!(list as readonly unknown[]).includes(v)) fail('INVALID_PARAMS', 'invalid_params', { action, field });
  return v as T;
}

/** Cleans free text written by an agent: invisible characters, links, secrets and blocked words. */
export function cleanText(raw: string, max: number, multiline = false): string {
  const res = sanitizeAgentText(raw, max, { multiline });
  if (res.empty) fail('INVALID_PARAMS', 'empty_text');
  return maskBlockedWords(res.text);
}
