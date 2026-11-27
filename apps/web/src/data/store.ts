/**
 * The live state lives here, outside React. The Pixi scene reads `store.state` directly every frame; React panels
 * subscribe to small channels (`counts`, `log:<room>`, ...) through the hooks below, so a batch never re-renders
 * the whole app.
 */
import type { AgentPos, Highlight, SpectatorEvent } from '@ajwf/shared';
import { useCallback, useSyncExternalStore } from 'react';
import {
  applyBatch,
  applyFull,
  applyHello,
  applyHighlights,
  type Changes,
  createState,
  dayFractionAt,
  emptyChanges,
  type RoomExtras,
  type WorldState,
} from './reducers';
import type { ConnStatus, DataSource } from './source';
import { phaseOf } from '../map/daylight';

type Listener = () => void;
export type ChangesListener = (ch: Changes) => void;

/** Topics that are always kept, in priority order, before the per-feature ones. */
const BASE_TOPICS = ['world', 'village'];
const MAX_TOPICS = 16;

export class LiveStore {
  state: WorldState = createState();
  status: ConnStatus = 'connecting';
  source: DataSource | null = null;
  private channels = new Map<string, Set<Listener>>();
  private changeListeners = new Set<ChangesListener>();
  private holders = new Map<string, string[]>();
  private countsSnap = {
    population: null as number | null,
    online: null as number | null,
    agents: 0,
    phase: 'day' as string,
  };
  private now: () => number;
  private villageSnap: VillageSnapshot = emptyVillage();

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  start(source: DataSource) {
    this.source = source;
    source.connect({
      message: (m) => this.handle(m),
      status: (s) => {
        this.status = s;
        this.emit('status');
      },
    });
    this.pushTopics();
    // Population and online come with `village` batches; the ticker is seeded once with the latest highlights so it
    // is not empty until the next big moment.
    void source.getJson('/api/public/highlights?limit=8').then((body) => {
      if (!body || this.source !== source || typeof body !== 'object') return;
      const ch = emptyChanges();
      applyHighlights(this.state, (body as { highlights?: unknown }).highlights, ch);
      if (ch.highlights) this.dispatch(ch);
    });
  }

  stop() {
    this.source?.close();
    this.source = null;
  }

  /** Applies one server message. Never throws. */
  handle(raw: unknown): Changes | null {
    if (!raw || typeof raw !== 'object') return null;
    const msg = raw as Record<string, unknown>;
    const now = this.now();
    let ch: Changes | null = null;
    try {
      switch (msg.t) {
        case 'hello':
          ch = applyHello(this.state, msg, now);
          // A fresh connection: ask again for everything we hold (the source resubscribes, the server sends fulls).
          break;
        case 'full':
          if (typeof msg.topic === 'string') ch = applyFull(this.state, msg.topic, msg.data, now);
          break;
        case 'batch':
          ch = applyBatch(this.state, msg, now);
          break;
        default:
          return null; // pong, error and unknown types are ignored
      }
    } catch (err) {
      console.warn('[ajwf] dropped a malformed message', err);
      return null;
    }
    if (ch) this.dispatch(ch);
    return ch;
  }

  private dispatch(ch: Changes) {
    if (ch.agents || ch.counts || ch.day) this.refreshCounts();
    for (const room of ch.logs) this.emit(`log:${room}`);
    for (const room of ch.extras) this.emit(`extras:${room}`);
    if (ch.highlights) this.emit('highlights');
    if (ch.village || ch.counts) this.refreshVillage();
    if (ch.rooms) this.emit('rooms');
    if (ch.agents) {
      for (const n of ch.moved) this.emit(`agent:${n}`);
    }
    for (const l of this.changeListeners) {
      try {
        l(ch);
      } catch (err) {
        console.warn('[ajwf] change listener failed', err);
      }
    }
  }

  private refreshCounts() {
    const s = this.state;
    const phase = phaseOf(dayFractionAt(s, this.now()));
    const c = this.countsSnap;
    if (
      c.population === s.population &&
      c.online === s.online &&
      c.agents === s.agents.size &&
      c.phase === phase
    )
      return;
    this.countsSnap = { population: s.population, online: s.online, agents: s.agents.size, phase };
    this.emit('counts');
  }

  private refreshVillage() {
    const s = this.state;
    this.villageSnap = {
      projects: s.projects,
      buildings: s.buildings,
      halls: s.halls,
      civic: s.civic,
      population: s.population,
      online: s.online,
    };
    this.emit('village');
  }

  village() {
    return this.villageSnap;
  }

  /** Called by the map once a second so the day phase counter advances between server updates. */
  tick() {
    this.refreshCounts();
  }

  /** Several features want topics (map viewport, director, open panel, followed agent); the store merges them. */
  setTopics(holder: string, topics: string[]) {
    const prev = this.holders.get(holder);
    if (prev && prev.length === topics.length && prev.every((t, i) => t === topics[i])) return;
    this.holders.set(holder, topics);
    this.pushTopics();
  }

  private pushTopics() {
    const order = ['panel', 'follow', 'director', 'viewport'];
    const out: string[] = [...BASE_TOPICS];
    for (const h of [...order, ...this.holders.keys()]) {
      for (const t of this.holders.get(h) ?? []) {
        if (out.length >= MAX_TOPICS) break;
        if (!out.includes(t)) out.push(t);
      }
    }
    this.source?.setTopics(out);
  }

  onChanges(l: ChangesListener) {
    this.changeListeners.add(l);
    return () => this.changeListeners.delete(l);
  }

  subscribe(channel: string, l: Listener) {
    let set = this.channels.get(channel);
    if (!set) this.channels.set(channel, (set = new Set()));
    set.add(l);
    return () => {
      set.delete(l);
    };
  }

  emit(channel: string) {
    const set = this.channels.get(channel);
    if (!set) return;
    for (const l of set) l();
  }

  counts() {
    return this.countsSnap;
  }
}

export type VillageSnapshot = {
  projects: WorldState['projects'];
  buildings: WorldState['buildings'];
  halls: WorldState['halls'];
  civic: WorldState['civic'];
  population: number | null;
  online: number | null;
};

function emptyVillage(): VillageSnapshot {
  return {
    projects: [],
    buildings: {},
    halls: {},
    civic: { mayor: null, election: null, treasury: null, taxRate: null, priority: null },
    population: null,
    online: null,
  };
}

export const store = new LiveStore();

const EMPTY_LOG: SpectatorEvent[] = [];

export function useStatus(): ConnStatus {
  return useSyncExternalStore(
    useCallback((l: Listener) => store.subscribe('status', l), []),
    () => store.status,
  );
}

export function useCounts() {
  return useSyncExternalStore(
    useCallback((l: Listener) => store.subscribe('counts', l), []),
    () => store.counts(),
  );
}

export function useRoomLog(room: string | null): SpectatorEvent[] {
  return useSyncExternalStore(
    useCallback((l: Listener) => (room ? store.subscribe(`log:${room}`, l) : () => undefined), [room]),
    () => (room ? (store.state.roomLogs.get(room) ?? EMPTY_LOG) : EMPTY_LOG),
  );
}

export function useRoomExtras(room: string | null): RoomExtras | undefined {
  return useSyncExternalStore(
    useCallback((l: Listener) => (room ? store.subscribe(`extras:${room}`, l) : () => undefined), [room]),
    () => (room ? store.state.roomExtras.get(room) : undefined),
  );
}

/** The live village (projects, halls, mayor, election, counts) as the `village` topic keeps it. */
export function useLiveVillage(): VillageSnapshot {
  return useSyncExternalStore(
    useCallback((l: Listener) => store.subscribe('village', l), []),
    () => store.village(),
    () => store.village(),
  );
}

export function useHighlights(): Highlight[] {
  return useSyncExternalStore(
    useCallback((l: Listener) => store.subscribe('highlights', l), []),
    () => store.state.highlights,
    () => store.state.highlights,
  );
}

export function useAgentPos(name: string | null): AgentPos | undefined {
  return useSyncExternalStore(
    useCallback((l: Listener) => (name ? store.subscribe(`agent:${name}`, l) : () => undefined), [name]),
    () => (name ? store.state.agents.get(name) : undefined),
    () => undefined,
  );
}

export function useRoomsVersion(): number {
  return useSyncExternalStore(
    useCallback((l: Listener) => store.subscribe('rooms', l), []),
    () => store.state.rooms.size,
  );
}
