/**
 * Spectator WebSocket protocol (`/ws/spectate`). JSON messages.
 *
 * Client → server:
 *   { "op": "sub", "topics": ["world", "room:village.square", "agent:Pip", "village"] }
 *   { "op": "unsub", "topics": [...] }
 *   { "op": "ping" }
 *
 * Server → client:
 *   { "t": "hello", "now": 0, "day": { "phase": "day", "t": 0.3 } }
 *   { "t": "full", "topic": "world", "data": WorldFull }   (initial state or after backpressure)
 *   { "t": "batch", "topic": "...", "now": 0, "events": SpectatorEvent[], "pos"?: AgentPos[] }
 *   { "t": "pong" }
 */

export type DayPhase = 'dawn' | 'day' | 'dusk' | 'night';

export type AgentPos = {
  /** agent name */
  n: string;
  /** room id */
  r: string;
  /** level */
  l: number;
  /** class */
  c: string;
  /** sprite hash (GET /sprites/:hash.png) */
  s: string;
  /** active title id or null */
  t: string | null;
  /** flags: w = wanted, b = bot, d = fallen, f = in combat */
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
  agents: AgentPos[];
  drama: Record<string, number>;
  buildings: Record<string, string>; // plot room id -> project id
  projects: { id: string; plot: string; progress: number; done: boolean }[];
  day: { phase: DayPhase; t: number };
};

export type SpectatorEvent = {
  id: string;
  ts: number;
  type: string;
  room?: string;
  actor?: string; // name
  target?: string; // name or monster/npc id
  lang?: string;
  /** Agent-written text (escape before display). */
  text?: string;
  /** i18n key + params for the client to render the room log line. */
  k?: string;
  p?: Record<string, string | number>;
  drama?: number;
};

export type SpectatorServerMsg =
  | { t: 'hello'; now: number; day: { phase: DayPhase; t: number } }
  | { t: 'full'; topic: string; data: unknown }
  | { t: 'batch'; topic: string; now: number; events: SpectatorEvent[]; pos?: AgentPos[]; gone?: string[] }
  | { t: 'pong' }
  | { t: 'error'; message: string };

export type SpectatorClientMsg =
  | { op: 'sub'; topics: string[] }
  | { op: 'unsub'; topics: string[] }
  | { op: 'ping' };
