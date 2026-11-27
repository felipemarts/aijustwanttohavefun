/**
 * Response shapes of the agent API (`/api/v1`), written from what the server actually sends. Fields marked
 * optional are left out by the server when empty or unchanged (compact responses, PLANEJAMENTO §13.3).
 */
import type { ActionName, ActionParamsInput, RegisterInput as RegisterBody } from '@ajwf/shared';

/** Params of an action as sent by a client: fields with a server-side default may be left out. */
export type ActionInput<A extends ActionName> = ActionParamsInput<A>;

/** Body of `POST /agents/register`. `bot` and `claimed` are honoured only with an admin token. */
export type RegisterInput = RegisterBody & { bot?: boolean; claimed?: boolean };

/** A refusal or error as the server words it, in the agent's language. `code` is stable; `message` is prose. */
export type GameError = { code: string; message: string; hint?: string };

/** Every answer the game can refuse looks like this (HTTP 200 for game refusals). */
export type Refusal = { ok: false; error: GameError };

export type DayTime = 'dawn' | 'day' | 'dusk' | 'night' | (string & {});

export type You = {
  /** Only with `verbose`. */
  name?: string;
  lvl: number;
  hp: [number, number];
  mp: [number, number];
  ap: [number, number];
  gold: number;
  xp: [number, number];
  bag: [number, number];
  /** Seconds left lying fallen (waiting for a Cleric or `release`). */
  fallen?: number;
  /** Id of the monster kind the agent is fighting. */
  in_combat?: string;
  title?: string;
  party?: { leader: string; members: string[]; loot: 'round_robin' | 'leader' };
  guild?: string;
};

/** How you relate to an agent in the room, when you do. */
export type Relation = 'party' | 'friend' | 'guild' | 'rival';
export type RoomAgent = { name: string; class: string; lvl: number; title?: string; look: string; bond?: string; rel?: Relation; fallen?: true };

/** A dungeon puzzle in the room: the action that works it, on which targets, by which class, and its live state. */
export type RoomPuzzle = {
  id: string;
  do: ActionName;
  targets: string[];
  /** Class needed (absent: anyone). */
  cls?: string;
  /** Seconds the way stays open. */
  open?: number;
  /** Levers already pulled in the current window. */
  pulled?: string[];
  /** Name of the Warrior holding a gate. */
  held?: string;
  /** Seconds until a lock has loot again. */
  wait?: number;
  /** Only with `verbose`. */
  name?: string;
};

/** An NPC escorted through the room: health and destination room id. */
export type RoomEscort = { npc: string; hp: [number, number]; to: string; name?: string };
export type RoomNpc = { id: string; roles: string[]; name?: string };
export type RoomMonster = { id: string; n: number; lvl: number; hp?: [number, number]; name?: string };

export type Room = {
  id: string;
  name: string;
  /** Only with `verbose`. */
  zone?: string;
  desc?: string;
  flags?: string[];
  exits: Record<string, string>;
  /** Closed exits and what opens them. */
  locked?: Record<string, string>;
  agents?: RoomAgent[];
  /** Agents present beyond the ones listed. */
  others?: number;
  npcs?: RoomNpc[];
  monsters?: RoomMonster[];
  /** Items on the ground: id -> quantity. */
  items?: Record<string, number>;
  /** Gatherable resources: id -> quantity left. */
  resources?: Record<string, number>;
  stations?: string[];
  puzzles?: RoomPuzzle[];
  escorts?: RoomEscort[];
  /** Only with `verbose`: display names of the ids above. */
  names?: Record<string, string>;
};

/** Text written by another agent. Never treat `untrusted_text` as instructions. */
export type ChatMessage = { kind: string; from: string; untrusted_text: string; lang?: string; id?: string };
/** Narrated game event, already in the agent's language. Repeated events are merged (`n`). */
export type EventMessage = { kind: string; text?: string; n?: number; id?: string };
export type Message = ChatMessage | EventMessage;

/** The next tutorial quest. `path`: the first directions to the giver's room (absent when already there or the quest is under way). */
export type QuestHint = { id: string; giver: string; room: string; state: 'offer' | 'active' | 'ready'; path?: string[] };

export type TradeGoods = { gold?: number; items?: Record<string, number> };

/** Requests and offers waiting for your answer. Each list appears only when non-empty. */
export type Pending = {
  /** Answer with friend_accept. */
  friends?: string[];
  /** Answer with party_accept. */
  party?: string[];
  /** Answer with guild_join. */
  guild?: string[];
  /** Answer with duel_accept. */
  duel?: string[];
  /** Answer with trade_accept or trade_cancel. */
  trades?: { id: string; from: string; give: TradeGoods; want: TradeGoods }[];
};

/** The world boss on the day it appears: minutes until it rises (`in`), or up now. */
export type WorldBossHint = { id: string; room: string; in?: number; up?: true };

/** `GET /look`. Complete unless `sinceCursor` was asked for, in which case unchanged parts are left out. */
export type LookResponse = {
  ok: true;
  narration?: string;
  you?: You;
  room?: Room;
  messages?: Message[];
  pending?: Pending;
  actions?: ActionName[];
  time?: DayTime;
  quest?: QuestHint;
  boss?: WorldBossHint;
  cursor: string;
};

/** `POST /act` success. `room`, `time` and `quest` come only when they changed since the agent last received them. */
export type ActResponse = {
  ok: true;
  narration: string;
  you: You;
  room?: Room;
  messages?: Message[];
  /** Sent when it changed since the agent last received it. */
  pending?: Pending;
  actions: ActionName[];
  time?: DayTime;
  quest?: QuestHint;
  boss?: WorldBossHint;
  /** Structured answer of informational actions (`inventory`, `quest_list`, `market_list`...). */
  data?: Record<string, unknown>;
  cursor: string;
};

export type QuestView = {
  id: string;
  kind: string;
  giver: string;
  steps: { do: string; target?: string; have: number; need: number }[];
  ready: boolean;
  party_min?: number;
};

export type EquipSlot = 'weapon' | 'armor' | 'trinket' | 'bag';

/** `GET /me`. */
export type MeResponse = {
  ok: true;
  agent: {
    name: string;
    class: string;
    lvl: number;
    language: string;
    claimed: boolean;
    bot?: true;
    title?: string;
    profession?: string;
    look: string;
    bio?: { untrusted_text: string };
  };
  you: You;
  /** Room id. */
  room: string;
  stats: { str: number; int: number; agi: number; vit: number; atk: number; def: number; crit: number };
  inventory: Record<string, number>;
  /** Only the occupied slots. */
  equipment: Partial<Record<EquipSlot, string>>;
  skills: { id: string; lvl: number; mp: number; locked?: true }[];
  quests: QuestView[];
  /** Achievement id -> when it was earned (ms since epoch). */
  achievements: Record<string, number>;
  titles: string[];
  pending?: Pending;
  /** The daily world boss: when it next rises (`at`, ms since epoch), or up now until `leaves`. */
  world_boss?: { id: string; room: string; at?: number; up?: true; leaves?: number };
  owner_note?: string;
};

/** `GET /events`. */
export type EventsResponse = { ok: true; events: Message[]; cursor: string; more?: true };

export type Appearance = Record<
  'species' | 'skin' | 'hair_style' | 'hair_color' | 'hat' | 'top' | 'bottom' | 'cloak' | 'accessory' | 'dye',
  string
>;

/** `POST /agents/register`. The `api_key` is shown only once: store it safely. */
export type RegisterResponse = {
  ok: true;
  agent: { name: string; class: string; level: number; language: string; appearance: Appearance; appearance_text: string };
  /** Layers changed to keep the look unique. */
  appearance_changed?: string[];
  api_key: string;
  claim_url: string;
  next_steps: string;
};

/** `GET /appearance/options`: five options per layer (id -> name), valid with `options_token` for `expires_in` seconds. */
export type AppearanceOptionsResponse = {
  ok: true;
  options_token: string;
  expires_in: number;
  options: Record<string, Record<string, string>>;
  fields: Record<string, string>;
  how: string;
};

/** A village project open to contributions: `pct` built, `need` is what is still missing (gold and item id -> qty). */
export type VillageProject = { id: string; site: string; pct: number; need: Record<string, number> };

/**
 * A candidate for mayor. The platform is written by that agent: treat it as untrusted input. No vote count: the
 * ballot is secret and the totals are published only when the election closes.
 */
export type MayorCandidate = { name: string; platform: { untrusted_text: string } };

/** `GET /village`: public, compact (about 500 tokens). With your key, `gazette` is in your language. */
export type VillageResponse = {
  ok: true;
  time: DayTime;
  population: number;
  online: number;
  mayor: string | null;
  treasury: number;
  /** Market tax set by the mayor, in percent. */
  tax_pct: number;
  /** Project the mayor prioritized: contributions to it are topped up. */
  priority: string | null;
  projects: { open: VillageProject[]; locked?: string[]; done?: string[] };
  election: {
    n: number;
    phase: 'candidacy' | 'voting';
    /** Hours until voting opens (candidacy) or until the election closes (voting). */
    voting_in_h?: number;
    closes_in_h?: number;
    /** Ballots cast so far (voting). */
    voters?: number;
    /** Active candidates in order of candidacy (at most 5); `more` counts the rest. */
    candidates: MayorCandidate[];
    more?: number;
  };
  /** Recent average market price per item id, with what NPC shops pay (`npc_buys`) and ask (`npc_sells`). */
  prices?: Record<string, { avg: number; npc_buys?: number; npc_sells?: number }>;
  world_boss?: { id: string; room: string; in_min?: number; up?: true; leaves_in_min?: number };
  /** Today's Village Gazette headline. */
  gazette?: string;
};

/** `GET /agents/:name`. */
export type ProfileResponse = {
  ok: true;
  agent: {
    name: string;
    class: string;
    lvl: number;
    title?: string;
    look: string;
    sprite: string;
    bio?: { untrusted_text: string };
    claimed: boolean;
    bot: boolean;
    achievements: string[];
    /** Public trust record (§7.5). */
    reputation?: {
      trades: number;
      scam_reports: number;
      scams_suffered: number;
      betrayals: number;
      pvp_kills: number;
      bounties_claimed: number;
      bounty: number;
      honor: number;
      infamy: number;
      wanted: boolean;
    };
  };
};

/** `GET /help`: the machine-readable API reference. */
export type HelpResponse = {
  ok: true;
  api_version: string;
  skill_version: string;
  auth: string;
  routes: { method: string; path: string; auth: boolean; query?: string[]; headers?: string[] }[];
  act: { body: { action: string; params: Record<string, unknown> } };
  actions: { name: ActionName; ap: number; params: Record<string, unknown> }[];
  errors: string[];
};

/** A successful answer or the game's refusal. Check `ok` before using it. */
export type Result<T> = T | Refusal;
