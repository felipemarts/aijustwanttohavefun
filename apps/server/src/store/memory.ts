import type { AgentState, Snapshot } from '@ajwf/engine';
import type { AgentRecord, EventRow, LoadedState, SerializedSnapshot, Store } from './types';

/** Recent events kept by the in-memory store; older ones are dropped (nothing reads them back yet). */
const MAX_EVENTS = 10_000;

/**
 * Keeps everything in process memory, so `pnpm dev` runs without Postgres. State is lost on restart, but one
 * instance can be shared by several `Game`s to simulate a restart in tests.
 */
export class MemoryStore implements Store {
  readonly kind = 'memory';
  readonly agents = new Map<string, AgentRecord>();
  readonly agentSnapshots = new Map<string, string>();
  readonly worldSnapshots = new Map<string, string>();
  readonly events: EventRow[] = [];
  /** Lets tests simulate a database outage. */
  failNext: Error | null = null;

  private check(): void {
    const err = this.failNext;
    if (err) {
      this.failNext = null;
      throw err;
    }
  }

  async load(): Promise<LoadedState> {
    const hasWorld = this.agentSnapshots.size > 0 || this.worldSnapshots.size > 0;
    const snapshot: Snapshot | null = hasWorld
      ? {
          agents: [...this.agentSnapshots.values()].map((j) => JSON.parse(j) as AgentState),
          world: [...this.worldSnapshots].map(([key, j]) => ({ key, data: JSON.parse(j) as unknown })),
        }
      : null;
    return {
      identities: [...this.agents.values()].map(({ id, keyHash, claimTokenHash, claimedAt }) => ({ id, keyHash, claimTokenHash, claimedAt })),
      snapshot,
      maxEventId: this.events.reduce((m, e) => Math.max(m, e.id), 0),
    };
  }

  async insertAgent(rec: AgentRecord, snapshotJson: string): Promise<void> {
    this.check();
    for (const other of this.agents.values()) {
      if (other.nameNorm === rec.nameNorm || other.keyHash === rec.keyHash) throw new Error('unique violation');
    }
    this.agents.set(rec.id, { ...rec });
    this.agentSnapshots.set(rec.id, snapshotJson);
  }

  async markClaimed(agentId: string, now: number): Promise<void> {
    this.check();
    const rec = this.agents.get(agentId);
    if (rec) rec.claimedAt = now;
  }

  async saveSnapshot(snap: SerializedSnapshot): Promise<void> {
    this.check();
    for (const a of snap.agents) if (!this.agents.has(a.id)) throw new Error(`snapshot of unknown agent ${a.id}`);
    for (const a of snap.agents) this.agentSnapshots.set(a.id, a.json);
    for (const w of snap.world) this.worldSnapshots.set(w.key, w.json);
  }

  async appendEvents(rows: EventRow[]): Promise<void> {
    this.check();
    this.events.push(...rows);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  async close(): Promise<void> {}
}
