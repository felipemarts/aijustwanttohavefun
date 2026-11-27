import { exportDirty } from '@ajwf/engine';
import type { GameEvent } from '@ajwf/shared';
import type { Logger } from 'pino';
import type { EventConsumer, Game } from './game';
import { Histogram, LOOP_WORK_BUCKETS, type PersistenceStats } from './metrics';
import type { EventRow, SerializedSnapshot } from './store/types';

const EVENTS_EVERY_MS = 1000;
/** Dirty entities are serialized this often (short pauses of the game)... */
const COLLECT_EVERY_MS = 1000;
/** ...and written to the store this often, in one transaction. */
const SNAPSHOT_EVERY_MS = 5000;
/** Events kept in memory while the database is unreachable; beyond this the oldest are dropped. */
const MAX_BUFFERED_EVENTS = 200_000;
const EVENTS_PER_FLUSH = 5000;

function toRow(ev: GameEvent): EventRow {
  return {
    id: Number(ev.id),
    ts: ev.ts,
    type: ev.type,
    roomId: ev.roomId ?? null,
    actor: ev.actor ?? null,
    target: ev.target ?? null,
    visibility: ev.visibility,
    revealAt: ev.revealAt ?? null,
    lang: ev.lang ?? null,
    payloadJson: JSON.stringify(ev.payload),
    drama: ev.drama ?? null,
  };
}

/**
 * Writes the world to the store off the request path (§3.3): events in batches every second, dirty entities
 * every 5 seconds in one transaction. A hard crash loses at most one interval.
 *
 * Serializing a few thousand dirty entities at once blocks the game for tens of milliseconds, so it happens every
 * second instead (`collect`), into a map where a newer serialization of an entity replaces the older one. The
 * written set is still one consistent cut of the world: every change marks its entities dirty, so an entity last
 * serialized at an earlier collection has not changed since, and every entry equals its state at the last one.
 */
export class Persistence implements EventConsumer {
  readonly name = 'persistence';
  private buffer: EventRow[] = [];
  private timers: NodeJS.Timeout[] = [];
  private eventsBusy: Promise<void> | null = null;
  private snapshotBusy: Promise<void> | null = null;
  /** Serialized entities waiting for the next write: `agent:<id>` or a world key -> JSON. */
  private pending = new Map<string, string>();
  readonly stats: PersistenceStats = {
    snapshots: 0,
    snapshotFailures: 0,
    lastSnapshotAt: 0,
    lastSnapshotRows: 0,
    serialize: new Histogram(LOOP_WORK_BUCKETS),
    write: new Histogram([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]),
    eventsWritten: 0,
    eventWriteFailures: 0,
    eventsDropped: 0,
  };

  constructor(
    private game: Game,
    private log: Logger,
  ) {}

  consume(events: readonly GameEvent[]): void {
    for (const ev of events) this.buffer.push(toRow(ev));
    const over = this.buffer.length - MAX_BUFFERED_EVENTS;
    if (over > 0) {
      this.buffer.splice(0, over);
      this.stats.eventsDropped += over;
      this.log.warn({ dropped: over }, 'event buffer full; oldest events dropped');
    }
  }

  get buffered(): number {
    return this.buffer.length;
  }

  flushEvents(): Promise<void> {
    this.eventsBusy ??= this.writeEvents().finally(() => (this.eventsBusy = null));
    return this.eventsBusy;
  }

  private async writeEvents(): Promise<void> {
    while (this.buffer.length) {
      const batch = this.buffer.splice(0, EVENTS_PER_FLUSH);
      try {
        await this.game.store.appendEvents(batch);
        this.stats.eventsWritten += batch.length;
      } catch (err) {
        this.stats.eventWriteFailures++;
        this.buffer.unshift(...batch);
        this.log.error({ err, events: batch.length }, 'event write failed; will retry');
        return;
      }
    }
  }

  snapshot(): Promise<void> {
    this.snapshotBusy ??= this.writeSnapshot().finally(() => (this.snapshotBusy = null));
    return this.snapshotBusy;
  }

  /** Serializes the dirty entities now (synchronously: `exportDirty` hands out live objects). */
  collect(): void {
    const { state } = this.game;
    if (!state.dirty.size) return;
    const t0 = performance.now();
    const dirty = exportDirty(state);
    for (const a of dirty.agents) {
      // A registration whose row is not stored yet: its snapshot must wait for the row (foreign key).
      if (this.game.isPending(a.id)) state.dirty.add(`agent:${a.id}`);
      else this.pending.set(`agent:${a.id}`, JSON.stringify(a));
    }
    for (const w of dirty.world) this.pending.set(w.key, JSON.stringify(w.data));
    this.stats.serialize.observe((performance.now() - t0) / 1000);
  }

  private async writeSnapshot(): Promise<void> {
    this.collect();
    if (!this.pending.size) return;
    const batch = this.pending;
    this.pending = new Map();
    const snap: SerializedSnapshot = { agents: [], world: [] };
    for (const [key, json] of batch) {
      if (key.startsWith('agent:')) snap.agents.push({ id: key.slice(6), json });
      else snap.world.push({ key, json });
    }
    const t1 = performance.now();
    try {
      await this.game.store.saveSnapshot(snap, this.game.now());
      this.stats.write.observe((performance.now() - t1) / 1000);
      this.stats.snapshots++;
      this.stats.lastSnapshotAt = Date.now();
      this.stats.lastSnapshotRows = batch.size;
    } catch (err) {
      this.stats.snapshotFailures++;
      // Back in line for the next write, unless a newer serialization of the same entity arrived meanwhile.
      for (const [key, json] of batch) if (!this.pending.has(key)) this.pending.set(key, json);
      this.log.error({ err, agents: snap.agents.length, world: snap.world.length }, 'snapshot failed; will retry');
    }
  }

  start(): void {
    if (this.timers.length) return;
    this.timers.push(
      setInterval(() => void this.flushEvents(), EVENTS_EVERY_MS),
      setInterval(() => this.collect(), COLLECT_EVERY_MS),
      setInterval(() => void this.snapshot(), SNAPSHOT_EVERY_MS),
    );
  }

  /** Final flush on graceful shutdown: every buffered event and every dirty entity. */
  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.all([this.eventsBusy, this.snapshotBusy]);
    await this.flushEvents();
    await this.snapshot();
  }
}
