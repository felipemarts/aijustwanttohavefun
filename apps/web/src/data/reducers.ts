/**
 * Live world state and the pure-ish reducers that apply server messages to it. `full` replaces the slice of its topic,
 * `batch` patches it. Everything coming from the wire is treated as untrusted JSON: unknown message types and fields
 * are ignored, malformed entries are skipped one by one, and a bad event never aborts the rest of the batch.
 */
import type { AgentPos, DayPhase, RoomInfo, SpectatorEvent } from '@ajwf/shared';

export const ROOM_LOG_MAX = 150;
export const HIGHLIGHTS_MAX = 30;
export const DAY_LENGTH_MS = 2 * 60 * 60 * 1000;
/** Drama half-life used when the server has not sent fresh scores (matches the server's "about a minute"). */
export const DRAMA_HALF_LIFE_MS = 60_000;

export type Project = { id: string; plot: string; progress: number; done: boolean };
export type RoomMonsterLive = { id: string; n: number; lvl?: number; max?: number; hurt?: number[] };
export type RoomExtras = { monsters: RoomMonsterLive[]; npcs: string[]; others: number; at: number };
export type DayState = { phase: DayPhase; t: number; at: number; lengthMs: number };

export type WorldState = {
  rooms: Map<string, RoomInfo>;
  agents: Map<string, AgentPos>;
  /** room -> [score, local time it was set]; read through `dramaAt()` for the decayed value. */
  drama: Map<string, [number, number]>;
  buildings: Record<string, string>;
  projects: Project[];
  day: DayState;
  roomLogs: Map<string, SpectatorEvent[]>;
  roomExtras: Map<string, RoomExtras>;
  highlights: SpectatorEvent[];
  seen: Set<string>;
  seenOrder: string[];
  population: number | null;
  online: number | null;
  /** Server clock minus local clock, ms. */
  clockSkew: number;
  hasWorld: boolean;
};

/** What a message changed, so the store wakes only the interested listeners. */
export type Changes = {
  agents: boolean;
  rooms: boolean;
  logs: Set<string>;
  extras: Set<string>;
  highlights: boolean;
  counts: boolean;
  day: boolean;
  drama: boolean;
  /** New events in arrival order (deduplicated), for the map's effects. */
  events: SpectatorEvent[];
  /** Agents whose position arrived in this message. */
  moved: string[];
};

export function emptyChanges(): Changes {
  return {
    agents: false,
    rooms: false,
    logs: new Set(),
    extras: new Set(),
    highlights: false,
    counts: false,
    day: false,
    drama: false,
    events: [],
    moved: [],
  };
}

export function createState(): WorldState {
  return {
    rooms: new Map(),
    agents: new Map(),
    drama: new Map(),
    buildings: {},
    projects: [],
    day: { phase: 'day', t: 0.3, at: 0, lengthMs: DAY_LENGTH_MS },
    roomLogs: new Map(),
    roomExtras: new Map(),
    highlights: [],
    seen: new Set(),
    seenOrder: [],
    population: null,
    online: null,
    clockSkew: 0,
    hasWorld: false,
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const PHASES: readonly DayPhase[] = ['dawn', 'day', 'dusk', 'night'];

export function parseAgentPos(v: unknown): AgentPos | null {
  if (!isObj(v) || !isStr(v.n) || !isStr(v.r) || v.n.length === 0 || v.n.length > 64) return null;
  return {
    n: v.n,
    r: v.r,
    l: isNum(v.l) ? v.l : 1,
    c: isStr(v.c) ? v.c : 'warrior',
    s: isStr(v.s) ? v.s : '',
    t: isStr(v.t) ? v.t : null,
    ...(isStr(v.f) && v.f ? { f: v.f } : {}),
  };
}

export function parseRoom(v: unknown): RoomInfo | null {
  if (!isObj(v) || !isStr(v.id) || !Array.isArray(v.rect) || v.rect.length !== 4 || !v.rect.every(isNum))
    return null;
  const exits: Record<string, string> = {};
  if (isObj(v.exits)) for (const [d, to] of Object.entries(v.exits)) if (isStr(to)) exits[d] = to;
  return {
    id: v.id,
    zone: isStr(v.zone) ? v.zone : 'village',
    rect: v.rect as [number, number, number, number],
    flags: Array.isArray(v.flags) ? v.flags.filter(isStr) : [],
    exits,
    ...(typeof v.plot === 'boolean' ? { plot: v.plot } : {}),
    ...(isStr(v.building) ? { building: v.building } : {}),
  };
}

export function parseEvent(v: unknown): SpectatorEvent | null {
  if (!isObj(v) || (!isStr(v.id) && !isNum(v.id)) || !isStr(v.type)) return null;
  const ev: SpectatorEvent = { id: String(v.id), ts: isNum(v.ts) ? v.ts : 0, type: v.type };
  if (isStr(v.room)) ev.room = v.room;
  if (isStr(v.actor)) ev.actor = v.actor;
  if (isStr(v.target)) ev.target = v.target;
  if (v.tk === 'agent' || v.tk === 'mon' || v.tk === 'npc') ev.tk = v.tk;
  if (isStr(v.lang)) ev.lang = v.lang;
  if (isStr(v.text)) ev.text = v.text;
  if (isStr(v.k)) ev.k = v.k;
  if (isObj(v.p)) {
    const p: Record<string, string | number> = {};
    for (const [k, x] of Object.entries(v.p)) if (isStr(x) || isNum(x)) p[k] = x;
    ev.p = p;
  }
  if (isNum(v.drama)) ev.drama = v.drama;
  return ev;
}

function parseDay(v: unknown): { phase: DayPhase; t: number; lengthMs?: number } | null {
  if (!isObj(v)) return null;
  const phase = PHASES.includes(v.phase as DayPhase) ? (v.phase as DayPhase) : null;
  if (!phase) return null;
  const t = isNum(v.t) ? ((v.t % 1) + 1) % 1 : 0.3;
  return { phase, t, ...(isNum(v.lengthMs) && v.lengthMs > 0 ? { lengthMs: v.lengthMs } : {}) };
}

function setDay(state: WorldState, v: unknown, localNow: number, ch: Changes) {
  const d = parseDay(v);
  if (!d) return;
  state.day = { phase: d.phase, t: d.t, at: localNow, lengthMs: d.lengthMs ?? state.day.lengthMs };
  ch.day = true;
}

/** Decayed drama score of a room right now. */
export function dramaAt(state: WorldState, room: string, localNow: number): number {
  const d = state.drama.get(room);
  if (!d) return 0;
  return d[0] * Math.pow(0.5, Math.max(0, localNow - d[1]) / DRAMA_HALF_LIFE_MS);
}

export function dramaSnapshot(state: WorldState, localNow: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const room of state.drama.keys()) {
    const v = dramaAt(state, room, localNow);
    if (v > 0.05) out[room] = v;
  }
  return out;
}

const SEEN_MAX = 4000;

function markSeen(state: WorldState, id: string): boolean {
  if (state.seen.has(id)) return false;
  state.seen.add(id);
  state.seenOrder.push(id);
  if (state.seenOrder.length > SEEN_MAX) {
    for (const old of state.seenOrder.splice(0, state.seenOrder.length - SEEN_MAX)) state.seen.delete(old);
  }
  return true;
}

/** Event types worth the highlights ticker (big world moments). */
const HIGHLIGHT_TYPES = new Set([
  'world_first',
  'achievement',
  'rare_drop',
  'level_up',
  'fallen',
  'revive',
  'project_completed',
  'project_progress',
  'boss_kill',
  'guild_created',
  'betrayal',
  'mayor_elected',
  'arrival',
  'title',
]);

export function isHighlight(ev: SpectatorEvent): boolean {
  if (!ev.k) return false;
  if (HIGHLIGHT_TYPES.has(ev.type)) return true;
  return (ev.drama ?? 0) >= 5;
}

function pushLog(state: WorldState, room: string, ev: SpectatorEvent, ch: Changes) {
  const prev = state.roomLogs.get(room) ?? [];
  // Replace the array (do not mutate): React selectors compare by identity.
  const next = prev.length >= ROOM_LOG_MAX ? prev.slice(prev.length - ROOM_LOG_MAX + 1) : prev.slice();
  next.push(ev);
  state.roomLogs.set(room, next);
  ch.logs.add(room);
}

function applyEvents(state: WorldState, events: unknown, localNow: number, addDrama: boolean, ch: Changes) {
  if (!Array.isArray(events)) return;
  for (const raw of events) {
    try {
      const ev = parseEvent(raw);
      if (!ev || !markSeen(state, ev.id)) continue;
      ch.events.push(ev);
      if (ev.room) pushLog(state, ev.room, ev, ch);
      if (isHighlight(ev)) {
        state.highlights = [...state.highlights.slice(-(HIGHLIGHTS_MAX - 1)), ev];
        ch.highlights = true;
      }
      if (addDrama && ev.room && ev.drama && ev.drama > 0) {
        state.drama.set(ev.room, [dramaAt(state, ev.room, localNow) + ev.drama, localNow]);
        ch.drama = true;
      }
    } catch {
      // one broken event never breaks the others
    }
  }
}

function upsertPositions(state: WorldState, pos: unknown, ch: Changes) {
  if (!Array.isArray(pos)) return;
  for (const raw of pos) {
    const p = parseAgentPos(raw);
    if (!p) continue;
    state.agents.set(p.n, p);
    ch.moved.push(p.n);
    ch.agents = true;
  }
}

function setDramaMap(state: WorldState, v: unknown, localNow: number, ch: Changes) {
  if (!isObj(v)) return;
  state.drama.clear();
  for (const [room, score] of Object.entries(v))
    if (isNum(score) && score > 0) state.drama.set(room, [score, localNow]);
  ch.drama = true;
}

export function applyHello(state: WorldState, msg: Obj, localNow: number): Changes {
  const ch = emptyChanges();
  if (isNum(msg.now)) state.clockSkew = msg.now - localNow;
  setDay(state, msg.day, localNow, ch);
  return ch;
}

/** `full`: replaces the state of its topic. */
export function applyFull(state: WorldState, topic: string, data: unknown, localNow: number): Changes {
  const ch = emptyChanges();
  if (!isObj(data)) return ch;
  if (isNum(data.now)) state.clockSkew = data.now - localNow;
  if (topic === 'world') {
    const rooms = Array.isArray(data.rooms)
      ? data.rooms.map(parseRoom).filter((r): r is RoomInfo => !!r)
      : [];
    if (rooms.length) {
      state.rooms = new Map(rooms.map((r) => [r.id, r]));
      ch.rooms = true;
    }
    state.agents = new Map();
    upsertPositions(state, data.agents, ch);
    ch.agents = true;
    setDramaMap(state, data.drama, localNow, ch);
    if (isObj(data.buildings)) {
      const b: Record<string, string> = {};
      for (const [k, v] of Object.entries(data.buildings)) if (isStr(v)) b[k] = v;
      state.buildings = b;
    }
    state.projects = parseProjects(data.projects) ?? state.projects;
    setDay(state, data.day, localNow, ch);
    state.hasWorld = true;
    ch.rooms = true;
    return ch;
  }
  if (topic === 'village') {
    if (isNum(data.population)) state.population = data.population;
    if (isNum(data.online)) state.online = data.online;
    ch.counts = true;
    setDay(state, data.day, localNow, ch);
    if (isObj(data.buildings)) {
      const b: Record<string, string> = {};
      for (const [k, v] of Object.entries(data.buildings)) if (isStr(v)) b[k] = v;
      state.buildings = b;
      ch.rooms = true;
    }
    const projects = parseProjects(data.projects);
    if (projects) {
      state.projects = projects;
      ch.rooms = true;
    }
    return ch;
  }
  if (topic.startsWith('room:')) {
    const roomId = topic.slice(5);
    const room = parseRoom(data.room);
    if (room && room.id === roomId) {
      state.rooms.set(room.id, room);
      ch.rooms = true;
    }
    upsertPositions(state, data.agents, ch);
    const monsters: RoomMonsterLive[] = Array.isArray(data.monsters)
      ? data.monsters
          .filter(isObj)
          .flatMap((m) =>
            isStr(m.id) && isNum(m.n)
              ? [
                  {
                    id: m.id,
                    n: m.n,
                    ...(isNum(m.lvl) ? { lvl: m.lvl } : {}),
                    ...(isNum(m.max) ? { max: m.max } : {}),
                    ...(Array.isArray(m.hurt) ? { hurt: m.hurt.filter(isNum) } : {}),
                  },
                ]
              : [],
          )
      : [];
    const npcs = Array.isArray(data.npcs) ? data.npcs.filter(isStr) : [];
    state.roomExtras.set(roomId, {
      monsters,
      npcs,
      others: isNum(data.others) ? data.others : 0,
      at: localNow,
    });
    ch.extras.add(roomId);
    // The room log is replaced by the server's recent history.
    const log = Array.isArray(data.log)
      ? data.log.map(parseEvent).filter((e): e is SpectatorEvent => !!e)
      : [];
    for (const e of log) markSeen(state, e.id);
    state.roomLogs.set(roomId, log.slice(-ROOM_LOG_MAX));
    ch.logs.add(roomId);
    if (isNum(data.drama)) {
      state.drama.set(roomId, [data.drama, localNow]);
      ch.drama = true;
    }
    return ch;
  }
  if (topic.startsWith('agent:')) {
    const pos = parseAgentPos(data.pos);
    if (pos) {
      state.agents.set(pos.n, pos);
      ch.agents = true;
      ch.moved.push(pos.n);
    }
  }
  return ch;
}

function parseProjects(v: unknown): Project[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .filter(isObj)
    .filter((p) => isStr(p.id) && isStr(p.plot))
    .map((p) => ({
      id: p.id as string,
      plot: p.plot as string,
      progress: isNum(p.progress) ? Math.max(0, Math.min(1, p.progress)) : 0,
      done: p.done === true,
    }));
}

/** `batch`: patches the state of its topic. */
export function applyBatch(state: WorldState, msg: Obj, localNow: number): Changes {
  const ch = emptyChanges();
  const topic = isStr(msg.topic) ? msg.topic : '';
  if (isNum(msg.now)) state.clockSkew = msg.now - localNow;
  upsertPositions(state, msg.pos, ch);
  if (Array.isArray(msg.gone)) {
    const roomTopic = topic.startsWith('room:') ? topic.slice(5) : null;
    for (const name of msg.gone) {
      if (!isStr(name)) continue;
      const a = state.agents.get(name);
      if (!a) continue;
      if (roomTopic && a.r !== roomTopic) continue;
      state.agents.delete(name);
      ch.agents = true;
    }
  }
  const hasDramaMap = topic === 'world' && isObj(msg.drama);
  applyEvents(state, msg.events, localNow, !hasDramaMap, ch);
  if (hasDramaMap) setDramaMap(state, msg.drama, localNow, ch);
  for (const ev of ch.events) {
    if (ev.type === 'day_phase' && ev.p && isStr(ev.p.phase))
      setDay(state, { phase: ev.p.phase, t: isNum(ev.p.t) ? ev.p.t : state.day.t }, localNow, ch);
  }
  return ch;
}

/** Day fraction now, advancing locally between server updates. */
export function dayFractionAt(state: WorldState, localNow: number): number {
  const d = state.day;
  if (!d.at) return d.t;
  return (((d.t + (localNow - d.at) / d.lengthMs) % 1) + 1) % 1;
}

/** `GET /api/public/stats` (polled): population and online counters. */
export function applyStats(state: WorldState, body: unknown): Changes {
  const ch = emptyChanges();
  if (!isObj(body)) return ch;
  if (isNum(body.population)) state.population = body.population;
  if (isNum(body.online)) state.online = body.online;
  ch.counts = true;
  return ch;
}
