import { exportDirty } from '@ajwf/engine';
import type { GameEvent } from '@ajwf/shared';
import type { Logger } from 'pino';
import type { EventConsumer, Game } from './game';
import type { EventRow, SerializedSnapshot } from './store/types';

const EVENTS_EVERY_MS = 1000;
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
 */
export class Persistence implements EventConsumer {
  readonly name = 'persistence';
  private buffer: EventRow[] = [];
  private timers: NodeJS.Timeout[] = [];
  private eventsBusy: Promise<void> | null = null;
  private snapshotBusy: Promise<void> | null = null;

  constructor(
    private game: Game,
    private log: Logger,
  ) {}

  consume(events: readonly GameEvent[]): void {
    for (const ev of events) this.buffer.push(toRow(ev));
    const over = this.buffer.length - MAX_BUFFERED_EVENTS;
    if (over > 0) {
      this.buffer.splice(0, over);
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
      } catch (err) {
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

  private async writeSnapshot(): Promise<void> {
    const { state } = this.game;
    const dirty = exportDirty(state);
    // exportDirty hands out live objects: serialize now, before any await lets the game change them.
    const snap: SerializedSnapshot = { agents: [], world: [] };
    for (const a of dirty.agents) {
      if (this.game.isPending(a.id)) state.dirty.add(`agent:${a.id}`);
      else snap.agents.push({ id: a.id, json: JSON.stringify(a) });
    }
    for (const w of dirty.world) snap.world.push({ key: w.key, json: JSON.stringify(w.data) });
    if (!snap.agents.length && !snap.world.length) return;
    try {
      await this.game.store.saveSnapshot(snap, this.game.now());
    } catch (err) {
      for (const a of snap.agents) state.dirty.add(`agent:${a.id}`);
      for (const w of snap.world) state.dirty.add(w.key);
      this.log.error({ err, agents: snap.agents.length, world: snap.world.length }, 'snapshot failed; will retry');
    }
  }

  start(): void {
    if (this.timers.length) return;
    this.timers.push(
      setInterval(() => void this.flushEvents(), EVENTS_EVERY_MS),
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
