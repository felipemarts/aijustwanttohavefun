import type { AgentState, WorldState } from '@ajwf/engine';
import {
  normalizeName,
  SPECTATE_PROTOCOL_VERSION,
  type AgentFull,
  type AgentPos,
  type GameEvent,
  type Highlight,
  type MsgParams,
  type RoomFull,
  type SpectatorErrorCode,
  type SpectatorEvent,
  type SpectatorServerMsg,
  type VillageDelta,
  type VillageFull,
  type WorldFull,
} from '@ajwf/shared';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Census } from '../census';
import type { EventConsumer } from '../game';
import type { Metrics } from '../metrics';
import { CLOSE, SPECTATE } from './constants';
import { DramaBoard } from './drama';
import { RoomLogs } from './room-log';
import { agentCard, agentPos, dayInfo, liveRoomInfos, posKey, roomFull, villageMap, type VillageMap } from './views';
import { isSpectatorVisible, toSpectatorEvent, type EventLookup } from './visibility';

/** The part of a WebSocket the broadcaster uses; the real one is `ws`, tests use fakes. */
export interface SpectatorSocket {
  /** Bytes queued but not yet written to the network. */
  readonly bufferedAmount: number;
  /** Sends a UTF-8 JSON text frame. The same buffer goes to every subscriber of a topic. */
  send(data: Buffer): void;
  close(code: number, reason?: string): void;
  terminate(): void;
  /** Protocol-level ping; sockets without it are never considered dead. */
  ping?(): void;
  /** Bytes written to the network so far (after compression and framing). */
  wireBytes?(): number;
}

type TopicKind = 'world' | 'village' | 'room' | 'agent';

type TopicState = {
  /** As the client spelled it; batches echo it. */
  name: string;
  kind: TopicKind;
  /** Room id or agent id; the kind itself for world and village. */
  key: string;
  subs: Set<SpectatorConn>;
  events: SpectatorEvent[];
  /** Positions changed since the last batch, by agent name (latest wins). */
  pos: Map<string, AgentPos>;
  gone: Set<string>;
  lastSent: number;
};

export class SpectatorConn {
  readonly topics = new Set<TopicState>();
  /** When the socket went above the high-water mark; 0 while it keeps up. */
  stalledSince = 0;
  alive = true;
  closed = false;
  tokens: number = SPECTATE.msgBurst;
  tokensAt: number;
  /** Since when the connection follows no topic (0 while it follows some). */
  idleSince: number;

  constructor(
    readonly id: number,
    readonly ip: string,
    readonly socket: SpectatorSocket,
    now: number,
  ) {
    this.tokensAt = now;
    this.idleSince = now;
  }
}

/** Public village-level events (projects, halls, elections, the mayor's acts, the world boss warning). */
const VILLAGE_EVENT_TYPES = new Set([
  'day_phase',
  'project_contribution',
  'project_completed',
  'project_available',
  'guild_hall_built',
  'guild_disbanded',
  'statue_honor',
  'election_phase',
  'election_result',
  'run_for_mayor',
  'mayor_priority',
  'mayor_tax',
  'mayor_fund',
  'mayor_embezzle',
  'mayor_bounty',
  'world_boss_soon',
]);
/** Events after which the village state (projects, buildings, mayor, election, treasury) may have changed. */
const VILLAGE_STATE_TYPES = new Set([...VILLAGE_EVENT_TYPES, 'market_trade', 'vote', 'bounty_placed']);
/** Population and online counts in `village` batches are refreshed at most this often. */
const COUNTS_EVERY_MS = 5000;
/** Highlights waiting for the next world batch, at most. */
const MAX_PENDING_HIGHLIGHTS = 50;

const topicsSchema = z.array(z.string().min(1).max(120)).min(1).max(SPECTATE.maxTopics);
const clientMsgSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('sub'), topics: topicsSchema }),
  z.object({ op: z.literal('unsub'), topics: topicsSchema }),
  z.object({ op: z.literal('ping') }),
]);
const KNOWN_OPS = new Set(['sub', 'unsub', 'ping']);

export type BroadcasterOptions = {
  state: WorldState;
  now: () => number;
  metrics: Metrics;
  census: Census;
  log: Logger;
  /** English diagnostics for client developers (`api.ws.*`). */
  text: (key: string, params?: MsgParams) => string;
  maxConnections: number;
  maxPerIp: number;
};

export type Admission = { ok: true } | { ok: false; reason: 'server_full' | 'ip_limit' };

/**
 * The spectator side of the world (§13.2): turns engine events into public spectator events, keeps the room logs
 * and drama scores, and fans batches out to the WebSocket topics every 250 ms. Each topic's batch is serialized
 * once and the same buffer is sent to every subscriber. Read-only: nothing a spectator sends reaches the game.
 */
export class Broadcaster implements EventConsumer {
  readonly name = 'spectators';
  readonly drama = new DramaBoard();
  readonly logs = new RoomLogs();

  private readonly state: WorldState;
  private readonly now: () => number;
  private readonly o: BroadcasterOptions;
  private readonly lookup: EventLookup;

  private conns = new Set<SpectatorConn>();
  private perIp = new Map<string, number>();
  private stalled = new Set<SpectatorConn>();
  private connSeq = 0;
  private closedWireBytes = 0;

  private topics = new Map<string, TopicState>();
  private roomTopics = new Map<string, TopicState>();
  private agentTopics = new Map<string, Set<TopicState>>();

  /** Agents on the map: id -> last activity. Ordered by last activity (oldest first). */
  private visible = new Map<string, number>();
  /** Agents whose position may have changed since the last batch. */
  private dirty = new Set<string>();
  /** Last position sent for each agent on the map. */
  private lastPos = new Map<string, { key: string; room: string }>();

  /** Id of the newest visible event consumed, and of the newest already sent in batches. */
  private lastSeq = 0;
  private flushedSeq = 0;
  /** Full states built since the last flush, by topic name: many subscribers, one serialization. */
  private fullCache = new Map<string, Buffer>();

  /** The village as last sent, and whether an event may have changed it since. */
  private lastVillage: VillageMap;
  private villageDirty = false;
  private lastCounts = { population: -1, online: -1, at: -Infinity };
  private pendingHighlights: Highlight[] = [];

  private dramaSentAt = -Infinity;
  private dramaWasEmpty = true;
  private lastSweep = -Infinity;
  private lastPing = -Infinity;
  private lastHousekeeping = -Infinity;
  private timer: NodeJS.Timeout | null = null;

  constructor(o: BroadcasterOptions) {
    this.o = o;
    this.state = o.state;
    this.now = o.now;
    this.lookup = {
      agentName: (id) => this.state.agents.get(id)?.name,
      isNpc: (id) => this.state.content.npcs.has(id),
    };
    // After a restart, agents that were active recently are still on the map.
    const now = o.now();
    const recent = [...this.state.agents.values()].filter((a) => a.status === 'active' && now - a.lastActiveAt <= SPECTATE.visibleMs);
    recent.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    for (const a of recent) this.visible.set(a.id, a.lastActiveAt);
    this.lastVillage = villageMap(this.state, now);
  }

  /** A highlight was detected: it rides the next `world` batch (the ticker). */
  pushHighlight(h: Highlight): void {
    this.pendingHighlights.push(h);
    if (this.pendingHighlights.length > MAX_PENDING_HIGHLIGHTS) this.pendingHighlights.shift();
  }

  /** What changed in the village since the last batch; null when nothing did. */
  private villageDelta(now: number): VillageDelta | null {
    const d: VillageDelta = {};
    if (this.villageDirty) {
      this.villageDirty = false;
      const cur = villageMap(this.state, now);
      const prev = this.lastVillage;
      const before = new Map(prev.projects.map((p) => [p.id, JSON.stringify(p)]));
      const changed = cur.projects.filter((p) => before.get(p.id) !== JSON.stringify(p));
      if (changed.length) d.projects = changed;
      if (JSON.stringify(cur.buildings) !== JSON.stringify(prev.buildings)) d.buildings = cur.buildings;
      if (JSON.stringify(cur.halls) !== JSON.stringify(prev.halls)) d.halls = cur.halls;
      if (cur.mayor !== prev.mayor) d.mayor = cur.mayor;
      if (JSON.stringify(cur.election) !== JSON.stringify(prev.election)) d.election = cur.election;
      if (cur.treasury !== prev.treasury) d.treasury = cur.treasury;
      if (cur.taxRate !== prev.taxRate) d.taxRate = cur.taxRate;
      if (cur.priority !== prev.priority) d.priority = cur.priority;
      if (cur.honoree?.name !== prev.honoree?.name || cur.honoree?.sprite !== prev.honoree?.sprite) d.honoree = cur.honoree;
      this.lastVillage = cur;
    }
    return Object.keys(d).length ? d : null;
  }

  /** Fresh head counts for the `village` topic, when they changed (checked every few seconds). */
  private countsDelta(now: number): Pick<VillageDelta, 'population' | 'online'> | null {
    if (now - this.lastCounts.at < COUNTS_EVERY_MS) return null;
    const population = this.o.census.counts(now).population;
    const online = this.o.census.online(now);
    const prev = this.lastCounts;
    this.lastCounts = { population, online, at: now };
    if (population === prev.population && online === prev.online) return null;
    return { population, online };
  }

  /** The one serializer of everything sent to spectators (a method, so tests can count calls). */
  encode(msg: SpectatorServerMsg): string {
    return JSON.stringify(msg);
  }

  private frame(msg: SpectatorServerMsg): Buffer {
    return Buffer.from(this.encode(msg), 'utf8');
  }

  // ── events in ─────────────────────────────────────────────────────────────────────────────────────────────

  consume(events: readonly GameEvent[]): void {
    const now = this.now();
    const world = this.topics.get('world');
    const village = this.topics.get('village');
    for (const ev of events) {
      // The boundary: nothing private or delayed goes past this line, not even into positions or logs.
      if (!isSpectatorVisible(ev)) continue;
      const se = toSpectatorEvent(ev, this.lookup);
      const seq = Number(ev.id);
      if (seq > this.lastSeq) this.lastSeq = seq;
      if (ev.actor) {
        this.markActive(ev.actor, now);
        this.dirty.add(ev.actor);
      }
      if (ev.target && this.state.agents.has(ev.target)) this.dirty.add(ev.target);

      if (ev.roomId) {
        this.logs.push(ev.roomId, se);
        if (ev.drama) this.drama.add(ev.roomId, ev.drama, now);
        this.roomTopics.get(ev.roomId)?.events.push(se);
        if ((ev.drama ?? 0) >= SPECTATE.worldMinDrama) world?.events.push(se);
      } else if (ev.visibility === 'public') world?.events.push(se);
      if (village && (VILLAGE_EVENT_TYPES.has(ev.type) || (!ev.roomId && ev.visibility === 'public'))) village.events.push(se);
      if (VILLAGE_STATE_TYPES.has(ev.type)) this.villageDirty = true;

      if (ev.actor) for (const t of this.agentTopics.get(ev.actor) ?? []) t.events.push(se);
      if (ev.target && ev.target !== ev.actor) for (const t of this.agentTopics.get(ev.target) ?? []) t.events.push(se);
    }
  }

  /** The agent acted or called the API: it is on the map (again). */
  markActive(agentId: string, now = this.now()): void {
    if (!this.visible.has(agentId)) this.dirty.add(agentId);
    this.visible.delete(agentId);
    this.visible.set(agentId, now);
  }

  isVisible(agentId: string): boolean {
    return this.visible.has(agentId);
  }

  get onMap(): number {
    return this.visible.size;
  }

  // ── batches out ───────────────────────────────────────────────────────────────────────────────────────────

  /** Builds each topic's batch once, serializes it once and sends the same buffer to every subscriber. */
  flush(): void {
    const now = this.now();
    if (now - this.lastSweep >= SPECTATE.visibleSweepMs) this.sweepVisible(now);
    this.collectPositions(now);
    const world = this.topics.get('world');
    const village = this.topics.get('village');
    // Village changes and highlights wait for the world topic's own pace (at most 4 batches per second).
    const worldReady = !world || now - world.lastSent >= SPECTATE.worldMinIntervalMs;
    const delta = worldReady ? this.villageDelta(now) : null;
    const counts = village ? this.countsDelta(now) : null;
    const highlights = world && worldReady && this.pendingHighlights.length ? this.pendingHighlights : null;
    if (!world) this.pendingHighlights = [];
    const mapDelta: VillageDelta | null = delta && (delta.projects || delta.buildings || delta.halls) ? { ...(delta.projects ? { projects: delta.projects } : {}), ...(delta.buildings ? { buildings: delta.buildings } : {}), ...(delta.halls ? { halls: delta.halls } : {}) } : null;
    const villageMsg: VillageDelta | null = delta || counts ? { ...delta, ...counts } : null;
    for (const t of this.topics.values()) {
      const extra: Partial<Extract<SpectatorServerMsg, { t: 'batch' }>> = {};
      if (t.kind === 'world') {
        if (mapDelta) extra.village = mapDelta;
        if (highlights) extra.highlights = highlights;
      } else if (t.kind === 'village' && villageMsg) extra.village = villageMsg;
      const content = t.events.length > 0 || t.pos.size > 0 || t.gone.size > 0 || Object.keys(extra).length > 0;
      let drama: Record<string, number> | undefined;
      if (t.kind === 'world') {
        if (now - t.lastSent < SPECTATE.worldMinIntervalMs) continue;
        if (!content && now - this.dramaSentAt < SPECTATE.worldDramaRefreshMs) continue;
        drama = this.drama.top(SPECTATE.dramaTopRooms, now);
        const empty = Object.keys(drama).length === 0;
        const quiet = empty && this.dramaWasEmpty;
        this.dramaSentAt = now;
        this.dramaWasEmpty = empty;
        if (!content && quiet) continue;
      } else if (!content) continue;
      const msg: SpectatorServerMsg = { t: 'batch', topic: t.name, now, events: t.events };
      if (t.pos.size) msg.pos = [...t.pos.values()];
      if (t.gone.size) msg.gone = [...t.gone];
      if (drama) msg.drama = drama;
      if (extra.village) msg.village = extra.village;
      if (extra.highlights) {
        msg.highlights = extra.highlights;
        this.pendingHighlights = [];
      }
      const buf = this.frame(msg);
      t.events = [];
      t.pos.clear();
      t.gone.clear();
      t.lastSent = now;
      this.o.metrics.batches.add(now);
      for (const c of t.subs) this.deliver(c, buf, now);
    }
    this.flushedSeq = this.lastSeq;
    this.fullCache.clear();
    this.resumeStalled(now);
  }

  private collectPositions(now: number): void {
    if (!this.dirty.size) return;
    const world = this.topics.get('world');
    for (const id of this.dirty) {
      const a = this.state.agents.get(id);
      if (!a || a.status !== 'active' || !this.visible.has(id)) continue;
      const pos = agentPos(a, now);
      const key = posKey(pos);
      const prev = this.lastPos.get(id);
      if (prev?.key === key) continue;
      this.lastPos.set(id, { key, room: pos.r });
      const targets = [world, this.roomTopics.get(pos.r), ...(this.agentTopics.get(id) ?? [])];
      if (prev && prev.room !== pos.r) targets.push(this.roomTopics.get(prev.room));
      for (const t of targets) {
        if (!t) continue;
        t.pos.set(pos.n, pos);
        t.gone.delete(pos.n);
      }
    }
    this.dirty.clear();
  }

  /** Agents idle for too long (or retired) leave the map: `gone` in the world and in their room. */
  private sweepVisible(now: number): void {
    this.lastSweep = now;
    const world = this.topics.get('world');
    for (const [id, at] of this.visible) {
      const a = this.state.agents.get(id);
      const active = a?.status === 'active';
      if (active && now - at <= SPECTATE.visibleMs) break;
      this.visible.delete(id);
      const last = this.lastPos.get(id);
      this.lastPos.delete(id);
      if (!a) continue;
      for (const t of [world, this.roomTopics.get(last?.room ?? a.room)]) {
        if (!t) continue;
        t.gone.add(a.name);
        t.pos.delete(a.name);
      }
    }
  }

  private deliver(c: SpectatorConn, buf: Buffer, now: number): void {
    if (c.closed || c.stalledSince) return;
    if (c.socket.bufferedAmount > SPECTATE.highWaterBytes) {
      // Too slow: stop queueing. It gets fresh full states once it drains instead of the batches it missed.
      c.stalledSince = now;
      this.stalled.add(c);
      this.o.metrics.wsBackpressure++;
      return;
    }
    c.socket.send(buf);
    this.o.metrics.wsPayloadBytes += buf.length;
  }

  private resumeStalled(now: number): void {
    for (const c of this.stalled) {
      if (c.closed) this.stalled.delete(c);
      else if (c.socket.bufferedAmount <= SPECTATE.lowWaterBytes) {
        c.stalledSince = 0;
        this.stalled.delete(c);
        for (const t of c.topics) this.sendFull(c, t, now);
      } else if (now - c.stalledSince >= SPECTATE.stuckMs) {
        this.o.metrics.wsDropped++;
        this.drop(c);
      }
    }
  }

  // ── full states ───────────────────────────────────────────────────────────────────────────────────────────

  worldFull(now = this.now()): WorldFull {
    const agents: AgentPos[] = [];
    for (const id of this.visible.keys()) {
      const a = this.state.agents.get(id);
      if (a?.status === 'active') agents.push(agentPos(a, now));
    }
    const v = villageMap(this.state, now);
    return { now, rooms: liveRoomInfos(this.state), agents, drama: this.drama.top(SPECTATE.dramaTopRooms, now), buildings: v.buildings, projects: v.projects, halls: v.halls, day: dayInfo(now) };
  }

  /** `upTo` leaves out log events that are still waiting for the next batch (the subscriber gets them there). */
  roomFull(roomId: string, now = this.now(), upTo = Infinity): RoomFull | null {
    return roomFull({
      s: this.state,
      roomId,
      now,
      log: this.logs.list(roomId, upTo),
      drama: this.drama.score(roomId, now),
      isVisible: (id) => this.visible.has(id),
    });
  }

  agentFull(a: AgentState, now = this.now()): AgentFull {
    return { now, card: agentCard(a), room: a.room, pos: agentPos(a, now) };
  }

  villageFull(now = this.now()): VillageFull {
    const { population } = this.o.census.counts(now);
    const v = villageMap(this.state, now);
    return {
      now,
      population,
      online: this.o.census.online(now),
      day: dayInfo(now),
      buildings: v.buildings,
      projects: v.projects,
      halls: v.halls,
      mayor: v.mayor,
      election: v.election,
      treasury: v.treasury,
      taxRate: v.taxRate,
      priority: v.priority,
      honoree: v.honoree,
    };
  }

  private fullData(t: TopicState, now: number): unknown {
    switch (t.kind) {
      case 'world':
        return this.worldFull(now);
      case 'village':
        return this.villageFull(now);
      case 'room':
        return this.roomFull(t.key, now, this.flushedSeq);
      case 'agent': {
        const a = this.state.agents.get(t.key);
        return a ? this.agentFull(a, now) : null;
      }
    }
  }

  private sendFull(c: SpectatorConn, t: TopicState, now: number): void {
    let buf = this.fullCache.get(t.name);
    if (!buf) {
      buf = this.frame({ t: 'full', topic: t.name, data: this.fullData(t, now) });
      this.fullCache.set(t.name, buf);
    }
    this.o.metrics.wsFulls++;
    this.deliver(c, buf, now);
  }

  // ── connections ───────────────────────────────────────────────────────────────────────────────────────────

  admit(ip: string): Admission {
    if (this.conns.size >= this.o.maxConnections) return { ok: false, reason: 'server_full' };
    if ((this.perIp.get(ip) ?? 0) >= this.o.maxPerIp) return { ok: false, reason: 'ip_limit' };
    return { ok: true };
  }

  attach(socket: SpectatorSocket, ip: string): SpectatorConn {
    const now = this.now();
    const c = new SpectatorConn(++this.connSeq, ip, socket, now);
    this.conns.add(c);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    this.sendDirect(c, { t: 'hello', now, day: dayInfo(now), v: SPECTATE_PROTOCOL_VERSION, maxTopics: SPECTATE.maxTopics, batchMs: SPECTATE.batchMs });
    return c;
  }

  detach(c: SpectatorConn): void {
    if (c.closed) return;
    c.closed = true;
    this.closedWireBytes += c.socket.wireBytes?.() ?? 0;
    for (const t of [...c.topics]) this.leave(c, t);
    this.conns.delete(c);
    this.stalled.delete(c);
    const n = (this.perIp.get(c.ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(c.ip);
    else this.perIp.set(c.ip, n);
  }

  private drop(c: SpectatorConn): void {
    c.socket.terminate();
    this.detach(c);
  }

  get connections(): number {
    return this.conns.size;
  }

  wireBytes(): number {
    let n = this.closedWireBytes;
    for (const c of this.conns) n += c.socket.wireBytes?.() ?? 0;
    return n;
  }

  /** Messages for one connection only (hello, pong, errors): rare, serialized per connection. */
  private sendDirect(c: SpectatorConn, msg: SpectatorServerMsg): void {
    if (c.closed) return;
    const buf = this.frame(msg);
    c.socket.send(buf);
    this.o.metrics.wsPayloadBytes += buf.length;
  }

  private sendError(c: SpectatorConn, code: SpectatorErrorCode, params?: MsgParams, topic?: string): void {
    this.sendDirect(c, { t: 'error', code, message: this.o.text(`api.ws.${code.toLowerCase()}`, params), ...(topic ? { topic } : {}) });
  }

  /** Every client message. Validated, size-capped and rate-limited; it can only change what this connection follows. */
  handleMessage(c: SpectatorConn, data: Buffer | ArrayBuffer | Buffer[] | string, isBinary = false): void {
    if (c.closed) return;
    const now = this.now();
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (buf.length > SPECTATE.maxMessageBytes) {
      this.sendError(c, 'TOO_LARGE', { bytes: SPECTATE.maxMessageBytes });
      c.socket.close(CLOSE.tooBig, 'message too big');
      this.detach(c);
      return;
    }
    c.tokens = Math.min(SPECTATE.msgBurst, c.tokens + ((now - c.tokensAt) * SPECTATE.msgBurst) / SPECTATE.msgWindowMs);
    c.tokensAt = now;
    if (c.tokens < 1) {
      this.sendError(c, 'RATE_LIMITED');
      c.socket.close(CLOSE.policy, 'rate limited');
      this.detach(c);
      return;
    }
    c.tokens -= 1;
    let json: unknown;
    try {
      if (isBinary) throw new Error('binary');
      json = JSON.parse(buf.toString('utf8'));
    } catch {
      return this.sendError(c, 'BAD_MESSAGE');
    }
    const parsed = clientMsgSchema.safeParse(json);
    if (!parsed.success) {
      const op = typeof json === 'object' && json !== null ? (json as { op?: unknown }).op : undefined;
      return this.sendError(c, typeof op === 'string' && !KNOWN_OPS.has(op) ? 'UNKNOWN_OP' : 'BAD_MESSAGE');
    }
    const msg = parsed.data;
    if (msg.op === 'ping') return this.sendDirect(c, { t: 'pong' });
    if (msg.op === 'unsub') {
      for (const name of msg.topics) {
        const t = this.topics.get(name);
        if (t && c.topics.has(t)) this.leave(c, t);
      }
    } else this.join(c, msg.topics, now);
    c.idleSince = c.topics.size ? 0 : now;
  }

  private join(c: SpectatorConn, names: string[], now: number): void {
    for (const name of names) {
      const existing = this.topics.get(name);
      if (existing && c.topics.has(existing)) continue;
      if (c.topics.size >= SPECTATE.maxTopics) {
        this.sendError(c, 'TOO_MANY_TOPICS', { max: SPECTATE.maxTopics }, name);
        return;
      }
      const t = existing ?? this.createTopic(name);
      if (!t) {
        this.sendError(c, 'BAD_TOPIC', { topic: name }, name);
        continue;
      }
      t.subs.add(c);
      c.topics.add(t);
      this.sendFull(c, t, now);
    }
  }

  private leave(c: SpectatorConn, t: TopicState): void {
    c.topics.delete(t);
    t.subs.delete(c);
    if (t.subs.size) return;
    // Topics exist only while someone follows them, so their number stays bounded by the connections.
    this.topics.delete(t.name);
    if (t.kind === 'room') this.roomTopics.delete(t.key);
    if (t.kind === 'agent') {
      const set = this.agentTopics.get(t.key);
      set?.delete(t);
      if (!set?.size) this.agentTopics.delete(t.key);
    }
  }

  /** `world`, `village`, `room:<existing room id>` or `agent:<name of an active agent>`; null otherwise. */
  private createTopic(name: string): TopicState | null {
    const make = (kind: TopicKind, key: string): TopicState => ({ name, kind, key, subs: new Set(), events: [], pos: new Map(), gone: new Set(), lastSent: -Infinity });
    let t: TopicState | null = null;
    if (name === 'world' || name === 'village') t = make(name, name);
    else if (name.startsWith('room:')) {
      const id = name.slice(5);
      if (this.state.content.rooms.has(id)) {
        t = make('room', id);
        // Events consumed since the last flush are not in the full state (see roomFull's upTo): send them next.
        t.events = this.logs.since(id, this.flushedSeq);
        this.roomTopics.set(id, t);
      }
    } else if (name.startsWith('agent:')) {
      const id = this.state.byName.get(normalizeName(name.slice(6)));
      const a = id ? this.state.agents.get(id) : undefined;
      if (a?.status === 'active') {
        t = make('agent', a.id);
        let set = this.agentTopics.get(a.id);
        if (!set) this.agentTopics.set(a.id, (set = new Set()));
        set.add(t);
      }
    }
    if (t) this.topics.set(name, t);
    return t;
  }

  // ── timers ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Liveness: pings (a socket that missed the previous pong is dropped) and connections that follow nothing. */
  housekeeping(now = this.now()): void {
    this.lastHousekeeping = now;
    const ping = now - this.lastPing >= SPECTATE.pingMs;
    if (ping) this.lastPing = now;
    for (const c of this.conns) {
      if (c.topics.size === 0 && c.idleSince && now - c.idleSince >= SPECTATE.idleNoTopicsMs) {
        c.socket.close(CLOSE.idle, 'idle');
        this.detach(c);
        continue;
      }
      if (!ping || !c.socket.ping) continue;
      if (!c.alive) {
        this.o.metrics.wsDropped++;
        this.drop(c);
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }

  tick(): void {
    try {
      this.flush();
      const now = this.now();
      if (now - this.lastHousekeeping >= 1000) this.housekeeping(now);
    } catch (err) {
      this.o.log.error({ err }, 'spectator flush failed');
    }
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), SPECTATE.batchMs);
  }

  /** Stops the timer and says goodbye to every spectator. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of [...this.conns]) {
      c.socket.close(CLOSE.goingAway, 'server shutting down');
      this.detach(c);
    }
  }
}
