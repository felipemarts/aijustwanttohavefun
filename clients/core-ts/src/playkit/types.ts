/** The playkit's data shapes (README 1; Go: the types of `internal/playkit/prompt.go`, `memory.go`, `world.go`). */
import type { JV } from './jv.ts';
import type { Menu } from './schema.ts';

/** The part of a character that enters prompts. Never a key or a URL. */
export type Character = { name: string; class: string; language: string; persona: string; wish: string; allowPvp: boolean };

/** A refusal (`ok: false`) from POST /act. */
export type GameErr = { code: string; message: string; hint?: string };

/** The outcome of the previous action this session, or the session's opening /look (action "look"). */
export type Last = { action: string; params: JV; ok: boolean; narration?: string; data?: JV; error?: GameErr };

/** One message written by another player's agent, in the rolling chat buffer. */
export type ChatLine = { from: string; kind: string; text: string };

/** One of the character's last actions and how it went. */
export type Recent = { action: string; params: JV; ok: boolean; text: string };

export type QuestTold = { quest: string; text: string };

/** What the character has seen of the map (README 5.3). */
export type World = { rooms: Map<string, [string, string][]>; npcs: Map<string, string>; monsters: Map<string, string> };

export type Memory = {
  notes: string[];
  recent: Recent[];
  chat: ChatLine[];
  /** Turns left before a new note is accepted. */
  noteWait: number;
  world: World;
  /** What the game said when each quest was accepted, newest last. */
  told: QuestTold[];
};

export type TurnInput = {
  character: Character;
  observation: JV;
  me: JV;
  last: Last | null;
  /** Texts of the game messages received with the last response. */
  events: string[];
  memory: Memory;
  /** The owner's current wish for the next turns, or "". */
  command: string;
};

export type Message = { role: 'system' | 'user' | 'assistant'; content: string };

export type Turn = { messages: Message[]; menu: Menu };

export type Decision = { thought: string; action: string; params: JV; note: string };

export type Resolution = { decision: Decision | null; source: 'first' | 'retry' | 'fallback' | 'none'; firstProblem?: string; retryProblem?: string };

export type ChatInput = {
  character: Character;
  observation: JV;
  me: JV;
  memory: Memory;
  /** Earlier messages of this conversation, oldest first. */
  history: { from: 'owner' | 'character'; text: string }[];
  text: string;
};

export function emptyWorld(): World {
  return { rooms: new Map(), npcs: new Map(), monsters: new Map() };
}

export function emptyMemory(): Memory {
  return { notes: [], recent: [], chat: [], noteWait: 0, world: emptyWorld(), told: [] };
}
