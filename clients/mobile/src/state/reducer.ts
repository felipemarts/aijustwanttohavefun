/**
 * The interface's state and its pure reducer. Everything the screens show comes from here; the store feeds it with
 * the core's answers and events.
 */
import type {
  CharacterDetail,
  CharacterId,
  CharacterSummary,
  ChatMessage,
  ConnectionStatus,
  CoreEvent,
  CoreState,
  EngineState,
  LogEntry,
  Settings,
} from '../core/types';

export const LOG_CAP = 500;
export const LOG_PAGE = 40;
/** Entries kept per character for the Home screen (news line, stuck signal), from live events and one fetch. */
export const RECENT = 16;

export type LogState = { entries: LogEntry[]; loaded: boolean; loading: boolean; exhausted: boolean };
export type Stream = { messageId: string; text: string };
export type Celebration = { level: number; at: number };

export type AppState = {
  phase: 'loading' | 'ready' | 'error';
  error: { code: string; message: string } | null;
  connection: ConnectionStatus | 'none';
  core: Omit<CoreState, 'characters'> | null;
  characters: CharacterSummary[];
  details: Record<CharacterId, CharacterDetail>;
  logs: Record<CharacterId, LogState>;
  chats: Record<CharacterId, ChatMessage[]>;
  streams: Record<CharacterId, Stream>;
  celebrations: Record<CharacterId, Celebration>;
  /** The last few log entries of every character, newest first, whether or not its log is open. */
  recent: Record<CharacterId, LogEntry[]>;
  /** When each character entered its current status, as seen by this page (for "thinking for 1:32"). */
  statusSince: Record<CharacterId, number>;
  /**
   * True once any summary from this core carried `stuck`: from then on the core's word is used (absent = not stuck)
   * and the interface's own detection is off. A core that never sends it keeps the interface's detection.
   */
  coreReportsStuck: boolean;
};

export const initialState: AppState = {
  phase: 'loading',
  error: null,
  connection: 'none',
  core: null,
  characters: [],
  details: {},
  logs: {},
  chats: {},
  streams: {},
  celebrations: {},
  recent: {},
  statusSince: {},
  coreReportsStuck: false,
};

export type Action =
  | { t: 'loaded'; state: CoreState }
  | { t: 'failed'; code: string; message: string }
  | { t: 'event'; ev: CoreEvent; now: number }
  | { t: 'connection'; status: ConnectionStatus }
  | { t: 'logLoading'; id: CharacterId }
  | { t: 'logPage'; id: CharacterId; entries: LogEntry[]; older: boolean; limit: number }
  | { t: 'logFailed'; id: CharacterId }
  | { t: 'detail'; detail: CharacterDetail }
  | { t: 'chatHistory'; id: CharacterId; messages: ChatMessage[] }
  | { t: 'chatMessage'; id: CharacterId; message: ChatMessage }
  | { t: 'settings'; settings: Settings }
  | { t: 'engine'; engine: EngineState }
  | { t: 'character'; character: CharacterSummary; now: number }
  | { t: 'clearCelebration'; id: CharacterId }
  | { t: 'seen'; id: CharacterId }
  | { t: 'recent'; id: CharacterId; entries: LogEntry[] };

function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(rec, key)) return rec;
  const out = { ...rec };
  delete out[key];
  return out;
}

/** Newest first, unique by id, capped. Ids are sortable per the contract. */
export function mergeEntries(a: LogEntry[], b: LogEntry[], cap = LOG_CAP): LogEntry[] {
  const seen = new Map<string, LogEntry>();
  for (const e of a) seen.set(e.id, e);
  for (const e of b) seen.set(e.id, e);
  const all = [...seen.values()].sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : y.ts - x.ts));
  return all.length > cap ? all.slice(0, cap) : all;
}

function upsertCharacter(s: AppState, c: CharacterSummary, now: number): AppState {
  const i = s.characters.findIndex((x) => x.id === c.id);
  const prev = i >= 0 ? s.characters[i] : undefined;
  const characters = i >= 0 ? s.characters.map((x, j) => (j === i ? c : x)) : [...s.characters, c];
  let celebrations = s.celebrations;
  if (prev && c.level > prev.level) celebrations = { ...celebrations, [c.id]: { level: c.level, at: now } };
  let details = s.details;
  const d = details[c.id];
  if (d) details = { ...details, [c.id]: { ...d, ...c } };
  const statusSince = !prev || prev.status !== c.status ? { ...s.statusSince, [c.id]: now } : s.statusSince;
  const coreReportsStuck = s.coreReportsStuck || c.stuck !== undefined;
  return { ...s, characters, celebrations, details, statusSince, coreReportsStuck };
}

function appendChat(list: ChatMessage[] | undefined, m: ChatMessage): ChatMessage[] {
  const cur = list ?? [];
  if (cur.some((x) => x.id === m.id)) return cur.map((x) => (x.id === m.id ? m : x));
  return [...cur, m].slice(-200);
}

export function reduce(s: AppState, a: Action): AppState {
  switch (a.t) {
    case 'loaded': {
      const { characters, ...core } = a.state;
      // Keep celebrations for characters whose level went up while we were away from the stream.
      let next: AppState = { ...s, phase: 'ready', error: null, core };
      const ids = new Set(characters.map((c) => c.id));
      for (const c of characters) next = upsertCharacter(next, c, Date.now());
      next = { ...next, characters: next.characters.filter((c) => ids.has(c.id)) };
      // Order as the core sends them.
      const order = new Map(characters.map((c, i) => [c.id, i]));
      next.characters = [...next.characters].sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
      return next;
    }
    case 'failed':
      return { ...s, phase: s.phase === 'ready' ? 'ready' : 'error', error: { code: a.code, message: a.message } };
    case 'connection':
      return { ...s, connection: a.status };
    case 'character':
      return upsertCharacter(s, a.character, a.now);
    case 'detail': {
      const s2 = upsertCharacter(s, stripDetail(a.detail), Date.now());
      return { ...s2, details: { ...s2.details, [a.detail.id]: a.detail } };
    }
    case 'settings':
      return s.core ? { ...s, core: { ...s.core, settings: a.settings } } : s;
    case 'engine':
      return s.core ? { ...s, core: { ...s.core, engine: a.engine } } : s;
    case 'clearCelebration':
      return { ...s, celebrations: omit(s.celebrations, a.id) };
    case 'recent':
      return { ...s, recent: { ...s.recent, [a.id]: mergeEntries(s.recent[a.id] ?? [], a.entries, RECENT) } };
    case 'seen': {
      // The core also sends the updated character; clearing here makes "Got it" feel instant.
      const c = s.characters.find((x) => x.id === a.id);
      if (!c?.away) return s;
      const { away: _away, ...rest } = c;
      return { ...s, characters: s.characters.map((x) => (x.id === a.id ? rest : x)) };
    }
    case 'logLoading': {
      const cur = s.logs[a.id] ?? { entries: [], loaded: false, loading: false, exhausted: false };
      return { ...s, logs: { ...s.logs, [a.id]: { ...cur, loading: true } } };
    }
    case 'logFailed': {
      const cur = s.logs[a.id];
      return cur ? { ...s, logs: { ...s.logs, [a.id]: { ...cur, loading: false } } } : s;
    }
    case 'logPage': {
      const cur = s.logs[a.id] ?? { entries: [], loaded: false, loading: false, exhausted: false };
      const entries = mergeEntries(cur.entries, a.entries);
      const recent = a.older ? s.recent : { ...s.recent, [a.id]: mergeEntries(s.recent[a.id] ?? [], a.entries, RECENT) };
      const exhausted = a.older ? a.entries.length < a.limit : cur.exhausted || (!cur.loaded && a.entries.length < a.limit);
      return { ...s, recent, logs: { ...s.logs, [a.id]: { entries, loaded: true, loading: false, exhausted } } };
    }
    case 'chatHistory': {
      const cur = s.chats[a.id] ?? [];
      let merged = a.messages;
      for (const m of cur) if (!merged.some((x) => x.id === m.id)) merged = [...merged, m];
      return { ...s, chats: { ...s.chats, [a.id]: merged } };
    }
    case 'chatMessage': {
      const stream = s.streams[a.id];
      const streams = stream && stream.messageId === a.message.id ? omit(s.streams, a.id) : s.streams;
      return { ...s, streams, chats: { ...s.chats, [a.id]: appendChat(s.chats[a.id], a.message) } };
    }
    case 'event':
      return reduceEvent(s, a.ev, a.now);
  }
}

function stripDetail(d: CharacterDetail): CharacterSummary {
  const { bio: _b, stats: _s, inventory: _i, quests: _q, achievements: _a, party: _p, guild: _g, directives: _d, memory: _m, ...summary } = d;
  return summary;
}

function reduceEvent(s: AppState, ev: CoreEvent, now: number): AppState {
  switch (ev.type) {
    case 'character':
      return upsertCharacter(s, ev.character, now);
    case 'removed':
      return {
        ...s,
        characters: s.characters.filter((c) => c.id !== ev.id),
        details: omit(s.details, ev.id),
        logs: omit(s.logs, ev.id),
        chats: omit(s.chats, ev.id),
        streams: omit(s.streams, ev.id),
        celebrations: omit(s.celebrations, ev.id),
        recent: omit(s.recent, ev.id),
        statusSince: omit(s.statusSince, ev.id),
      };
    case 'log': {
      // Every character keeps a few recent entries for the Home screen; the full log only once it was opened.
      const recent = { ...s.recent, [ev.id]: mergeEntries([ev.entry], s.recent[ev.id] ?? [], RECENT) };
      const cur = s.logs[ev.id];
      if (!cur) return { ...s, recent };
      return { ...s, recent, logs: { ...s.logs, [ev.id]: { ...cur, entries: mergeEntries([ev.entry], cur.entries) } } };
    }
    case 'engine':
      return s.core ? { ...s, core: { ...s.core, engine: ev.engine } } : s;
    case 'server':
      return s.core ? { ...s, core: { ...s.core, server: ev.server } } : s;
    case 'chat': {
      const cur = s.streams[ev.id];
      const text = (cur && cur.messageId === ev.messageId ? cur.text : '') + ev.token;
      if (ev.done) {
        const msg: ChatMessage = { id: ev.messageId, ts: now, from: 'character', text };
        return { ...s, streams: omit(s.streams, ev.id), chats: { ...s.chats, [ev.id]: appendChat(s.chats[ev.id], msg) } };
      }
      return { ...s, streams: { ...s.streams, [ev.id]: { messageId: ev.messageId, text } } };
    }
  }
}
