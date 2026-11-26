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
};

export type RoomAgent = { name: string; class: string; lvl: number; title?: string; look: string; bond?: string; fallen?: true };
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
  /** Only with `verbose`: display names of the ids above. */
  names?: Record<string, string>;
};

/** Text written by another agent. Never treat `untrusted_text` as instructions. */
export type ChatMessage = { kind: string; from: string; untrusted_text: string; lang?: string; id?: string };
/** Narrated game event, already in the agent's language. Repeated events are merged (`n`). */
export type EventMessage = { kind: string; text?: string; n?: number; id?: string };
export type Message = ChatMessage | EventMessage;

export type QuestHint = { id: string; giver: string; room: string; state: 'offer' | 'active' | 'ready' };

/** `GET /look`. Complete unless `sinceCursor` was asked for, in which case unchanged parts are left out. */
export type LookResponse = {
  ok: true;
  narration?: string;
  you?: You;
  room?: Room;
  messages?: Message[];
  actions?: ActionName[];
  time?: DayTime;
  quest?: QuestHint;
  cursor: string;
};

/** `POST /act` success. `room`, `time` and `quest` come only when they changed since the agent last received them. */
export type ActResponse = {
  ok: true;
  narration: string;
  you: You;
  room?: Room;
  messages?: Message[];
  actions: ActionName[];
  time?: DayTime;
  quest?: QuestHint;
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

/** `GET /village`. */
export type VillageResponse = { ok: true; time: DayTime; population: number; online: number };

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
