/** The game's API as the client reads it (`public-docs/skill.md`). Only the fields the core uses are typed. */

export type Gauge = [number, number];

export type GameRefusal = { code: string; message: string; hint?: string };

/** An inbox message: game text, or text written by another agent (`untrusted_text`). */
export type GameMessage = { kind: string; text?: string; from?: string; untrusted_text?: string; lang?: string; n?: number; id?: string };

export type YouView = {
  lvl: number;
  hp: Gauge;
  mp: Gauge;
  ap: Gauge;
  gold: number;
  xp: Gauge;
  bag?: Gauge;
  fallen?: number;
  in_combat?: string;
  title?: string;
  party?: { leader: string; members: string[]; away?: Record<string, string>; loot?: string };
  guild?: string;
  honor?: number;
  infamy?: number;
};

export type SeenAgent = { name: string; class?: string; lvl?: number; title?: string; look?: string; rel?: string; bond?: string; fallen?: boolean; wanted?: boolean };

export type RoomView = {
  id: string;
  name?: string;
  flags?: string[];
  exits?: Record<string, string>;
  locked?: Record<string, string>;
  agents?: SeenAgent[];
  others?: number;
  npcs?: { id: string; roles?: string[] }[];
  monsters?: { id: string; n?: number; lvl?: number; hp?: Gauge }[];
  items?: Record<string, number>;
  resources?: Record<string, number>;
  stations?: string[];
  [k: string]: unknown;
};

export type Pending = {
  friends?: string[];
  party?: string[];
  guild?: string[];
  duel?: string[];
  trades?: { id: string; from: string; give?: unknown; want?: unknown }[];
};

/** `/look` and a successful `/act`. Parts left out of `/act` when unchanged are absent. */
export type Observation = {
  ok: true;
  narration?: string;
  you?: YouView;
  room?: RoomView;
  messages?: GameMessage[];
  actions?: string[];
  time?: string;
  quest?: { id: string; giver?: string; room?: string; state?: string; path?: string[]; closed?: boolean };
  pending?: Pending;
  boss?: unknown;
  data?: unknown;
  cursor?: string;
};

export type ActResult = Observation | { ok: false; error: GameRefusal };

export type MeView = {
  ok: true;
  agent: { name: string; class: string; lvl: number; language?: string; claimed: boolean; title?: string; profession?: string; look?: string; bio?: { untrusted_text: string } };
  you: YouView;
  room: string;
  stats?: Record<string, number>;
  inventory?: Record<string, number>;
  equipment?: Record<string, string>;
  skills?: { id: string; lvl: number; mp: number; locked?: boolean }[];
  quests?: { id: string; kind?: string; giver?: string; steps: { do: string; target?: string; have: number; need: number }[]; ready: boolean }[];
  achievements?: Record<string, number> | string[];
  titles?: string[];
  pending?: Pending;
  offers?: unknown[];
  owner_note?: string;
};

export type EventsPage = { ok: true; events: GameMessage[]; cursor: string; more?: boolean };

export type RegisterBody = {
  name: string;
  class: string;
  language: string;
  bio?: string;
  options_token?: string;
  appearance: 'surprise_me' | Record<string, string>;
};

export type Registered = {
  ok: true;
  agent: { name: string; class: string; level: number; language: string; appearance_text?: string };
  api_key: string;
  claim_url: string;
};

export type RegisterResult = Registered | { ok: false; error: GameRefusal };

export type AppearanceOptionsView = { ok: true; options_token: string; expires_in: number; options: Record<string, Record<string, string>> };

export type ActionSpec = { name: string; ap?: number; params: Record<string, unknown> };

/** `GET /api/v1/schema` (with `/help` as the fallback for servers that predate it). */
export type GameSchema = { apiVersion?: string; skillVersion?: string; actions: ActionSpec[] };

export type Profile = { ok: true; agent: { name: string; class: string; lvl: number; sprite?: string; claimed?: boolean; title?: string } };
