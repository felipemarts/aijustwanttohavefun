/**
 * Types shared by the scripted bot profiles. A profile is a pure decision function over what an agent can know
 * through the public API (its observation, the `/me` data, its own inbox, the answer to its last action and the
 * public `/village` read model) plus a small private memory. Bots never share memory: they coordinate only through
 * the game (board posts, invites, party chat, trades).
 */
import type { Content } from '@ajwf/content';
import type { VillageView } from '@ajwf/engine';
import type { ActionName, ClassId, LaunchLanguage, Rng } from '@ajwf/shared';
import type { BotStep } from '../solo';
import type { BotView } from '../view';

export const PROFILE_IDS = ['explorer', 'fighter', 'social', 'trader', 'politician', 'traitor'] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

/** One step of an active quest, as `/me` and `quest_list` show it. */
export type QuestStepView = { do: string; target?: string; have: number; need: number };
export type QuestView = { id: string; kind: string; giver: string; steps: QuestStepView[]; ready: boolean; party_min?: number };

/** One inbox message as the API gives it: agent text comes with its author's name. */
export type InboxMsg = { kind: string; from?: string; text?: string };

/** The answer to the bot's previous action. */
export type LastResult = { action: ActionName; params: Record<string, unknown>; ok: boolean; code?: string; data?: Record<string, unknown> };

/** Everything a bot may read before deciding. */
export type AgentView = BotView & {
  now: number;
  name: string;
  cls: ClassId;
  /** From `/me`. */
  profession: string | null;
  /** Active quests, from `/me`. */
  quests: QuestView[];
  /** Inbox messages received since the previous decision (`GET /events`): chat with its author's name, other events by kind. */
  inbox: InboxMsg[];
  last: LastResult | null;
  /** The public `GET /village` read model, fetched only when asked for. */
  village: () => VillageView;
};

/** Private memory of one bot, kept between decisions. Nothing in here is ever shared with another bot. */
export type BotMem = {
  /** room id -> until when the bot avoids it (no prey or nothing to gather there). */
  avoid: Map<string, number>;
  lastChatAt: number;
  /** Daily quests on offer, as answered by `quest_list`, and the real day of that answer. */
  daily: { day: number; level: number; ids: string[] } | null;
  /** Dailies looked at and skipped today. */
  skipped: Set<string>;
  /** Quests the bot gave up on (e.g. a step it cannot do). */
  abandoned: Set<string>;
  /** The hunting room the party agreed on (from the leader's party chat) and when it was set. */
  camp: { room: string; at: number } | null;
  /** When this bot last posted on the board, read it, or asked for a heal. */
  postedAt: number;
  boardReadAt: number;
  askedHealAt: number;
  /** Names that posted `lfg` recently, from the board. */
  lfg: Map<string, number>;
  /** Candidates seen on the board (campaign posts) for the current election. */
  candidates: string[];
  /** Agents asking for a heal through party chat: name -> when. */
  healRequests: Map<string, number>;
  /** Levels of party members, as last seen in the same room. */
  partyLevels: Map<string, number>;
  /** Party join time (to measure how long we stay in one) and when the bot last saw a party member. */
  partySince: number;
  /** Free-form per-profile state. */
  ext: Record<string, unknown>;
};

export function newBotMem(): BotMem {
  return {
    avoid: new Map(),
    lastChatAt: -Infinity,
    daily: null,
    skipped: new Set(),
    abandoned: new Set(),
    camp: null,
    postedAt: -Infinity,
    boardReadAt: -Infinity,
    askedHealAt: -Infinity,
    lfg: new Map(),
    candidates: [],
    healRequests: new Map(),
    partyLevels: new Map(),
    partySince: 0,
    ext: {},
  };
}

export type DecideCtx = { c: Content; rng: Rng; lang: LaunchLanguage; mem: BotMem; profile: ProfileId; seed: number };

export type Profile = {
  id: ProfileId;
  /** Grouped profiles hunt in parties; the others hunt alone (the M4 acceptance compares the two). */
  grouped: boolean;
  decide(view: AgentView, x: DecideCtx): BotStep;
};
