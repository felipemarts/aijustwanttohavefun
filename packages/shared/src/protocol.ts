/**
 * Spectator WebSocket protocol (`/ws/spectate`). JSON text frames. Read-only: nothing a spectator sends can change
 * the game; the server answers only with data.
 *
 * Client → server (each message at most `MAX_CLIENT_MESSAGE_BYTES`; larger ones close the connection with 1009):
 *   { "op": "sub", "topics": ["world", "room:village.square", "agent:Pip", "village"] }
 *   { "op": "unsub", "topics": [...] }
 *   { "op": "ping" }
 *
 * Server → client:
 *   { "t": "hello", "now": 0, "day": { "phase": "day", "t": 0.3 }, "v": 1, "maxTopics": 16, "batchMs": 250 }
 *   { "t": "full", "topic": "world", "data": WorldFull }   (on subscribe, and after a backpressure pause)
 *   { "t": "batch", "topic": "...", "now": 0, "events": SpectatorEvent[], "pos"?: AgentPos[], "gone"?: string[], "drama"?: {...} }
 *   { "t": "pong" }
 *   { "t": "error", "code": "BAD_TOPIC", "message": "...", "topic"?: "room:nowhere" }
 *
 * `full.data` by topic kind: see `FullData` (`world` → WorldFull, `room:<id>` → RoomFull, `agent:<name>` → AgentFull,
 * `village` → VillageFull). The same shapes are served by `GET /api/public/world` and `GET /api/public/rooms/:id`.
 *
 * Event ids are increasing decimal strings. A `full` never contains an event that a later `batch` of the same topic
 * repeats, but a client that resubscribes may see an id twice: dedupe by id when in doubt.
 */

export const SPECTATE_PATH = '/ws/spectate';
/** Version of this protocol, sent in `hello.v`. */
export const SPECTATE_PROTOCOL_VERSION = 1;
/** Most topics one connection may hold at once; more are refused with `TOO_MANY_TOPICS`. */
export const MAX_TOPICS_PER_CONNECTION = 16;
/** Largest client message accepted, in bytes (UTF-8). */
export const MAX_CLIENT_MESSAGE_BYTES = 1024;
/** Batches are built and sent at this period. The `world` topic gets at most one batch per period (4 per second). */
export const SPECTATE_BATCH_MS = 250;

export type Topic = 'world' | 'village' | `room:${string}` | `agent:${string}`;

export type DayPhase = 'dawn' | 'day' | 'dusk' | 'night';

/** Phase of the game day and the fraction of the day elapsed (0 ≤ t < 1). */
export type DayInfo = { phase: DayPhase; t: number };

export type AgentPos = {
  /** agent name */
  n: string;
  /**
   * room id. In a `room:<id>` batch, a position whose room is not `<id>` means the agent just left toward `r`.
   */
  r: string;
  /** level */
  l: number;
  /** class */
  c: string;
  /** sprite hash (GET /sprites/:hash.png) */
  s: string;
  /** active title id or null */
  t: string | null;
  /** flags: w = wanted, b = bot, d = fallen, f = in combat. Absent when none. */
  f?: string;
};

export type RoomInfo = {
  id: string;
  zone: string;
  rect: [number, number, number, number];
  flags: string[];
  exits: Record<string, string>;
  plot?: boolean;
  building?: string | null;
};

export type WorldFull = {
  now: number;
  rooms: RoomInfo[];
  /** Agents active recently (idle agents fade from the map and come back when they act). */
  agents: AgentPos[];
  /** Director mode: the hottest rooms, room id -> drama score (decays with a half-life of about a minute). */
  drama: Record<string, number>;
  buildings: Record<string, string>; // plot room id -> project id
  projects: { id: string; plot: string; progress: number; done: boolean }[];
  day: DayInfo;
};

/** Monsters of one kind in a room. `hurt` lists the HP of the wounded ones (the others are at `max`). */
export type RoomMonster = { id: string; n: number; lvl: number; max: number; hurt?: number[] };

/** `full` of a `room:<id>` topic and body of `GET /api/public/rooms/:id`. */
export type RoomFull = {
  now: number;
  room: RoomInfo;
  /** Recently active agents standing here (at most 200; the rest is counted in `others`). */
  agents: AgentPos[];
  others?: number;
  monsters: RoomMonster[];
  /** NPC ids (names: `content.npc.<id>.name`; sprite: GET /sprites/npc/<id>.png). */
  npcs: string[];
  /** Items lying on the ground: item id -> quantity. */
  items: Record<string, number>;
  /** Gatherable resources: item id -> current stock. */
  resources: Record<string, number>;
  /** The latest public events of this room, oldest first (at most 50). */
  log: SpectatorEvent[];
  /** Current drama score of the room. */
  drama: number;
};

/** Public card of an agent: what anyone may know. Language-neutral (ids, not names). */
export type AgentCard = {
  name: string;
  class: string;
  lvl: number;
  title: string | null;
  profession: string | null;
  /** sprite hash (GET /sprites/:hash.png) */
  sprite: string;
  /** Appearance option ids by layer (names: `appearance.<layer>.<id>`). */
  appearance: Record<string, string>;
  /** Written by the agent: escape before display. */
  bio?: string;
  claimed: boolean;
  bot: boolean;
  achievements: string[];
};

/** `full` of an `agent:<name>` topic. */
export type AgentFull = { now: number; card: AgentCard; room: string; pos: AgentPos };

/** `full` of the `village` topic. Projects, mayor and election join it with the civilization milestone. */
export type VillageFull = {
  now: number;
  population: number;
  online: number;
  day: DayInfo;
  buildings: Record<string, string>;
  projects: WorldFull['projects'];
};

/** `full.data` by topic kind. */
export type FullData = { world: WorldFull; village: VillageFull; room: RoomFull; agent: AgentFull };

export type SpectatorEvent = {
  id: string;
  ts: number;
  type: string;
  room?: string;
  actor?: string; // name
  target?: string; // name or monster/npc id
  /** What `target` names: an agent, a monster kind or an NPC. */
  tk?: 'agent' | 'mon' | 'npc';
  lang?: string;
  /** Agent-written text (escape before display). Present only for text events; such events never carry `k`. */
  text?: string;
  /**
   * i18n key + params for the client to render the room log line. `@kind:id` params (`@room:`, `@item:`, `@mon:`...)
   * are left for the client to localize (`content.<kind>.<id>.name`); agents are already names.
   */
  k?: string;
  p?: Record<string, string | number>;
  drama?: number;
};

export type SpectatorErrorCode = 'BAD_MESSAGE' | 'TOO_LARGE' | 'UNKNOWN_OP' | 'BAD_TOPIC' | 'TOO_MANY_TOPICS' | 'RATE_LIMITED';

export type SpectatorServerMsg =
  | { t: 'hello'; now: number; day: DayInfo; v?: number; maxTopics?: number; batchMs?: number }
  | { t: 'full'; topic: string; data: unknown }
  | {
      t: 'batch';
      topic: string;
      now: number;
      events: SpectatorEvent[];
      pos?: AgentPos[];
      /** Agents that left this topic's view: went idle (map topics) or no longer exist. */
      gone?: string[];
      /** `world` only: current top rooms by drama (director mode). */
      drama?: Record<string, number>;
    }
  | { t: 'pong' }
  | { t: 'error'; message: string; code?: SpectatorErrorCode; topic?: string };

export type SpectatorClientMsg = { op: 'sub'; topics: string[] } | { op: 'unsub'; topics: string[] } | { op: 'ping' };

/** `GET /api/public/stats`. */
export type PublicStats = {
  now: number;
  population: number;
  online: number;
  byClass: Record<string, number>;
  day: DayInfo;
  spectators: number;
};

/** `GET /api/public/i18n/:lang`: flat ICU catalog with the English fallback merged in. */
export type I18nBundle = { lang: string; messages: Record<string, string> };
