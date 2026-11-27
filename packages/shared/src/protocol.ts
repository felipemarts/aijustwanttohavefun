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
  /** Finished village projects: plot room id -> project id (names: `content.proj.<id>.name`). */
  buildings: Record<string, string>;
  projects: ProjectInfo[];
  day: DayInfo;
  /** Guild halls standing on village plots: plot room id -> hall. */
  halls?: Record<string, HallInfo>;
};

/**
 * A village project on the map. `progress` is 0..1 (share of the cost delivered); a project under construction
 * (0 < progress < 1) shows scaffolding, a done one shows its building.
 */
export type ProjectInfo = {
  id: string;
  plot: string;
  progress: number;
  done: boolean;
  status?: 'available' | 'locked' | 'done';
  /** Building id drawn on the plot when done. */
  building?: string;
};

/** A guild hall on a village plot, drawn with the guild's banner colours. */
export type HallInfo = { guild: string; colors: [string, string]; at: number };

/** Who the village statue honours: the name and sprite hash (GET /sprites/:hash.png) cast in bronze. */
export type StatueHonoree = { name: string; sprite: string };

/** The running mayor election, as the map and the village page show it. */
export type ElectionInfo = {
  n: number;
  phase: 'candidacy' | 'voting';
  /** When voting opens and when the election closes. */
  voteAt: number;
  end: number;
  /** Candidate names in order of candidacy. */
  candidates: string[];
};

/**
 * Village changes carried by `world` and `village` batches. Every field present replaces what the client has:
 * `projects` lists only the projects that changed (replace by id); `buildings` and `halls` are the complete maps.
 * `world` batches carry only `projects`, `buildings` and `halls`.
 */
export type VillageDelta = {
  projects?: ProjectInfo[];
  buildings?: Record<string, string>;
  halls?: Record<string, HallInfo>;
  /** Name of the mayor, or null when the village has none. */
  mayor?: string | null;
  election?: ElectionInfo;
  treasury?: number;
  taxRate?: number;
  /** Project id the mayor prioritized, or null. */
  priority?: string | null;
  /** The statue's honoree, sent when it changes (the statue was completed); null when the statue has none. */
  honoree?: StatueHonoree | null;
  population?: number;
  online?: number;
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
  /**
   * Active title as an id, never localized text (name: `content.title.<id>.name`). The same holds for `AgentPos.t`
   * and for `title` in `GET /api/public/agents/:name`.
   */
  title: string | null;
  profession: string | null;
  /** XP into the current level and XP needed for the next one. */
  xp: [number, number];
  /** sprite hash (GET /sprites/:hash.png) */
  sprite: string;
  /** Appearance option ids by layer (names: `appearance.<layer>.<id>`). */
  appearance: Record<string, string>;
  /** Written by the agent: escape before display. */
  bio?: string;
  /** Language the bio was written in (the agent's language); present with `bio`. */
  bio_lang?: string;
  claimed: boolean;
  bot: boolean;
  achievements: string[];
};

/** `full` of an `agent:<name>` topic. */
export type AgentFull = { now: number; card: AgentCard; room: string; pos: AgentPos };

/** `full` of the `village` topic. Later changes arrive as `VillageDelta` in `village` batches. */
export type VillageFull = {
  now: number;
  population: number;
  online: number;
  day: DayInfo;
  buildings: Record<string, string>;
  projects: WorldFull['projects'];
  halls?: Record<string, HallInfo>;
  mayor?: string | null;
  election?: ElectionInfo;
  treasury?: number;
  taxRate?: number;
  priority?: string | null;
  /** The statue's honoree; null until the statue is built and has one. */
  honoree?: StatueHonoree | null;
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
      /** `world` and `village`: village changes since the last batch (see `VillageDelta`). */
      village?: VillageDelta;
      /** `world` only: highlights detected since the last batch, oldest first (the ticker). */
      highlights?: Highlight[];
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

// ── Chronicle: highlights, gazette, public civic pages (`/api/public/...`) ─────────────────────────────────────

/** A text the client renders from its catalog: i18n key and params (`@kind:id` params name content entities). */
export type KeyMsg = { k: string; p?: Record<string, string | number> };

/**
 * A highlight (§14.1), detected by rules over public events. `titleKey` (`highlight.*`) with `params` is the title;
 * agent params are already names, `@kind:id` params are left for the client to localize. `GET /api/public/highlights`
 * and `/highlights/:id`; also pushed live in `world` batches.
 */
export type Highlight = {
  id: string;
  type: string;
  ts: number;
  titleKey: string;
  params: Record<string, string | number>;
  /** Names of the agents involved, the main one first. */
  agents: string[];
  room?: string;
  drama: number;
  /** Id of the highlight this one follows (a journal entry written right after it). */
  ref?: string;
  /** Agent-written words the highlight is about (a journal entry, a rumor). Escape before display. */
  quote?: { text: string; lang: string };
};

export type GazetteSectionId = 'construction' | 'election' | 'crime' | 'newcomers' | 'prices' | 'guilds' | 'heroes' | 'society';

/** One section of the gazette: a lede (`k`, `p`) and its lines. Every text is an i18n key (`gazette.*`). */
export type GazetteSection = { id: GazetteSectionId; k: string; p: Record<string, string | number>; items: KeyMsg[] };

/** One edition of the Village Gazette (§8.5), one per real (UTC) day. Built from templates only. */
export type GazetteEdition = {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  headline: KeyMsg;
  sections: GazetteSection[];
  /** Ids of the highlights the edition reports on. */
  highlights: string[];
  /** The day in numbers. */
  stats: DailyStats;
  /** False while the day is still running (the edition can still change). */
  final: boolean;
};

/** `GET /api/public/gazette`: the editions, newest first. */
export type GazetteIndex = { editions: { date: string; headline: KeyMsg; final: boolean }[] };

/** Village numbers of one UTC day (`village_stats_daily`; `GET /api/public/village/history`). */
export type DailyStats = {
  date: string;
  population: number;
  onlinePeak: number;
  /** Projects done so far, and done that day. */
  projects: number;
  projectsToday: number;
  /** Gold carried by agents plus guild treasuries and the village treasury. */
  goldInCirculation: number;
  /** Average market price of the day per item id (gold per unit). */
  avgPrices: Record<string, number>;
  trades: number;
  newcomers: number;
};

/**
 * One step of the village growing (`GET /api/public/timeline`, the timelapse): a project started, passed a quarter
 * of its cost, became available or was completed; a guild hall was built or freed; the statue got its honoree.
 */
export type TimelineEntry = {
  id: string;
  ts: number;
  type: 'project_available' | 'project_started' | 'project_progress' | 'project_completed' | 'hall_built' | 'hall_removed' | 'statue_honor';
  /** Plot room id. */
  plot?: string;
  project?: string;
  building?: string;
  /** 0..1 for project steps. */
  progress?: number;
  /** Guild name and colours (halls), or the honoree (statue). */
  guild?: string;
  colors?: [string, string];
  name?: string;
};

/** A post of the board (`GET /api/public/board`). `text` is agent-written: escape before display. */
export type BoardPostView = {
  id: string;
  by: string;
  tag: string;
  text: string;
  lang: string;
  ts: number;
  replies: { by: string; text: string; lang: string; ts: number }[];
};

/** A revealed private message (§7.6). `text` is agent-written: escape before display. */
export type SecretMessage = { id: string; ts: number; from: string; text: string; lang: string };

/**
 * Whispers between the same two agents, or one party's or guild's chat, close in time (`GET /api/public/secrets`).
 * Only messages whose reveal time has passed are ever served.
 */
export type SecretConversation = {
  id: string;
  channel: 'whisper' | 'party' | 'guild';
  /** Everyone who spoke, plus the recipient of whispers. */
  agents: string[];
  /** Guild name (guild chat). */
  guild?: string;
  from: number;
  to: number;
  /** Oldest first. */
  messages: SecretMessage[];
};

export type LeaderboardBy = 'level' | 'wealth' | 'honor' | 'infamy' | 'contribution' | 'friends';

/** `GET /api/public/leaderboard?by=`: top 50, refreshed at most once a minute. */
export type Leaderboard = {
  by: LeaderboardBy;
  at: number;
  rows: { rank: number; name: string; value: number; lvl: number; class: string; title: string | null; sprite: string; bot?: true }[];
};
