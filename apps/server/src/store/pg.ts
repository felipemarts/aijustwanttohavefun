import type { AgentState } from '@ajwf/engine';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { runMigrations } from '../db/migrate';
import { agents, agentSnapshots, events, worldSnapshots } from '../db/schema';
import type { AgentRecord, EventRow, LoadedState, SerializedSnapshot, Store } from './types';

/** Rows per INSERT: keeps every statement well under Postgres' 65,535 bind parameters. */
const CHUNK = 1000;

function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** JSON already serialized by the caller goes in as is, instead of being stringified a second time. */
const jsonb = (json: string) => sql`${json}::jsonb`;

export class PgStore implements Store {
  readonly kind = 'postgres';
  private constructor(
    private pool: pg.Pool,
    private db: NodePgDatabase,
  ) {}

  /** Connects and applies pending migrations. */
  static async open(url: string): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    try {
      await runMigrations(pool);
    } catch (err) {
      await pool.end();
      throw err;
    }
    return new PgStore(pool, drizzle(pool));
  }

  async load(): Promise<LoadedState> {
    const ids = await this.db
      .select({ id: agents.id, keyHash: agents.keyHash, claimTokenHash: agents.claimToken, claimedAt: agents.claimedAt })
      .from(agents);
    const agentRows = await this.db.select({ state: agentSnapshots.state }).from(agentSnapshots);
    const worldRows = await this.db.select({ key: worldSnapshots.key, state: worldSnapshots.state }).from(worldSnapshots);
    const [max] = await this.db.select({ id: sql<string | null>`max(${events.id})` }).from(events);
    const empty = agentRows.length === 0 && worldRows.length === 0;
    return {
      identities: ids,
      snapshot: empty ? null : { agents: agentRows.map((r) => r.state as AgentState), world: worldRows.map((r) => ({ key: r.key, data: r.state })) },
      maxEventId: Number(max?.id ?? 0),
    };
  }

  async insertAgent(rec: AgentRecord, snapshotJson: string, now: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(agents).values({
        id: rec.id,
        name: rec.name,
        nameNorm: rec.nameNorm,
        nameSkeleton: rec.nameSkeleton,
        class: rec.cls,
        language: rec.language,
        bio: rec.bio,
        appearance: rec.appearance,
        appearanceHash: rec.appearanceHash,
        keyHash: rec.keyHash,
        claimToken: rec.claimTokenHash,
        claimedAt: rec.claimedAt,
        isBot: rec.isBot,
      });
      await tx.insert(agentSnapshots).values({ agentId: rec.id, state: jsonb(snapshotJson), updatedAt: now });
    });
  }

  async markClaimed(agentId: string, now: number): Promise<void> {
    await this.db.update(agents).set({ claimedAt: now }).where(eq(agents.id, agentId));
  }

  async saveSnapshot(snap: SerializedSnapshot, now: number): Promise<void> {
    if (!snap.agents.length && !snap.world.length) return;
    await this.db.transaction(async (tx) => {
      for (const part of chunks(snap.agents)) {
        await tx
          .insert(agentSnapshots)
          .values(part.map((a) => ({ agentId: a.id, state: jsonb(a.json), updatedAt: now })))
          .onConflictDoUpdate({ target: agentSnapshots.agentId, set: { state: sql`excluded.state`, updatedAt: sql`excluded.updated_at` } });
      }
      for (const part of chunks(snap.world)) {
        await tx
          .insert(worldSnapshots)
          .values(part.map((w) => ({ key: w.key, state: jsonb(w.json), updatedAt: now })))
          .onConflictDoUpdate({ target: worldSnapshots.key, set: { state: sql`excluded.state`, updatedAt: sql`excluded.updated_at` } });
      }
    });
  }

  async appendEvents(rows: EventRow[]): Promise<void> {
    for (const part of chunks(rows)) {
      await this.db
        .insert(events)
        .values(part.map(({ payloadJson, ...r }) => ({ ...r, payload: jsonb(payloadJson) })))
        // A retried batch after a timeout may already be stored.
        .onConflictDoNothing({ target: events.id });
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
