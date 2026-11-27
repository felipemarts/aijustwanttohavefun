import type { AgentState } from '@ajwf/engine';
import type { DailyStats, GazetteEdition, Highlight, KeyMsg, TimelineEntry } from '@ajwf/shared';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql, type SQL } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { runMigrations } from '../db/migrate';
import {
  achievementsUnlocked,
  agents,
  agentSnapshots,
  boardPosts,
  elections,
  events,
  gazetteEditions,
  highlights,
  journalEntries,
  marketTrades,
  villageStatsDaily,
  villageTimeline,
  worldSnapshots,
} from '../db/schema';
import type { AgentRecord, BoardRow, ChronicleBatch, EventRow, JournalRow, LoadedState, SerializedSnapshot, Store, TradeRow } from './types';

type HighlightDb = typeof highlights.$inferSelect;
type EventDb = typeof events.$inferSelect;

function toHighlight(r: HighlightDb): Highlight {
  const extra = (r.extra ?? {}) as Pick<Highlight, 'ref' | 'quote'>;
  return {
    id: r.id,
    type: r.type,
    ts: r.ts,
    titleKey: r.titleKey,
    params: r.params as Highlight['params'],
    agents: r.agents as string[],
    ...(r.roomId ? { room: r.roomId } : {}),
    drama: r.drama,
    ...extra,
  };
}

function toEventRow(r: EventDb): EventRow {
  const { payload, ...rest } = r;
  return { ...rest, payloadJson: JSON.stringify(payload) };
}

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

  async appendChronicle(b: ChronicleBatch): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const part of chunks(b.highlights)) {
        await tx
          .insert(highlights)
          .values(
            part.map((h) => ({
              id: h.id,
              type: h.type,
              titleKey: h.titleKey,
              params: h.params,
              agents: h.agents,
              roomId: h.room ?? null,
              eventId: h.id.replace(/^h/, ''),
              ts: h.ts,
              seq: Number(/^h(\d+)/.exec(h.id)?.[1] ?? 0),
              drama: h.drama,
              extra: h.ref || h.quote ? { ...(h.ref ? { ref: h.ref } : {}), ...(h.quote ? { quote: h.quote } : {}) } : null,
            })),
          )
          .onConflictDoNothing({ target: highlights.id });
      }
      for (const e of b.elections) {
        const row = { id: e.id, startsAt: e.startsAt, endsAt: e.endsAt, candidates: e.candidates, votes: e.votes, winner: e.winner };
        await tx.insert(elections).values(row).onConflictDoUpdate({ target: elections.id, set: { candidates: row.candidates, votes: row.votes, winner: row.winner, endsAt: row.endsAt } });
      }
      for (const part of chunks(b.trades)) await tx.insert(marketTrades).values(part).onConflictDoNothing({ target: marketTrades.id });
      for (const part of chunks(b.posts)) await tx.insert(boardPosts).values(part).onConflictDoNothing({ target: boardPosts.id });
      for (const part of chunks(b.journal)) await tx.insert(journalEntries).values(part).onConflictDoNothing({ target: journalEntries.id });
      for (const part of chunks(b.achievements)) await tx.insert(achievementsUnlocked).values(part).onConflictDoNothing();
      for (const part of chunks(b.timeline)) {
        await tx
          .insert(villageTimeline)
          .values(part.map(({ id, ts, type, ...data }) => ({ id, seq: Number(id.slice(1)), ts, type, data })))
          .onConflictDoNothing({ target: villageTimeline.id });
      }
      for (const g of b.gazettes) {
        await tx.insert(gazetteEditions).values({ date: g.date, content: g, ts: Date.now() }).onConflictDoUpdate({ target: gazetteEditions.date, set: { content: g, ts: sql`excluded.ts` } });
      }
      for (const st of b.stats) {
        const row = {
          date: st.date,
          population: st.population,
          projects: st.projects,
          goldInCirculation: st.goldInCirculation,
          avgPrices: st.avgPrices,
          onlinePeak: st.onlinePeak,
          projectsToday: st.projectsToday,
          trades: st.trades,
          newcomers: st.newcomers,
        };
        const { date: _date, ...set } = row;
        await tx.insert(villageStatsDaily).values(row).onConflictDoUpdate({ target: villageStatsDaily.date, set });
      }
    });
  }

  async listHighlights(beforeSeq: number | null, limit: number): Promise<Highlight[]> {
    const rows = await this.db
      .select()
      .from(highlights)
      .where(beforeSeq === null ? undefined : lt(highlights.seq, beforeSeq))
      .orderBy(desc(highlights.seq), desc(highlights.id))
      .limit(limit);
    return rows.map(toHighlight);
  }

  async getHighlight(id: string): Promise<Highlight | null> {
    const [r] = await this.db.select().from(highlights).where(eq(highlights.id, id));
    return r ? toHighlight(r) : null;
  }

  async listGazettes(limit: number): Promise<{ date: string; headline: KeyMsg; final: boolean }[]> {
    const rows = await this.db
      .select({ date: gazetteEditions.date, headline: sql<KeyMsg>`${gazetteEditions.content}->'headline'`, final: sql<boolean | null>`(${gazetteEditions.content}->>'final')::boolean` })
      .from(gazetteEditions)
      .orderBy(desc(gazetteEditions.date))
      .limit(limit);
    return rows.map((r) => ({ date: r.date, headline: r.headline, final: r.final ?? true }));
  }

  async getGazette(date: string): Promise<GazetteEdition | null> {
    const [r] = await this.db.select({ content: gazetteEditions.content }).from(gazetteEditions).where(eq(gazetteEditions.date, date));
    return r ? (r.content as GazetteEdition) : null;
  }

  async listDailyStats(limit: number): Promise<DailyStats[]> {
    const rows = await this.db.select().from(villageStatsDaily).orderBy(desc(villageStatsDaily.date)).limit(limit);
    return rows.map((r) => ({ ...r, avgPrices: r.avgPrices as Record<string, number> }));
  }

  async listTimeline(): Promise<TimelineEntry[]> {
    const rows = await this.db.select().from(villageTimeline).orderBy(asc(villageTimeline.seq));
    return rows.map((r) => ({ id: r.id, ts: r.ts, type: r.type as TimelineEntry['type'], ...(r.data as object) }));
  }

  async listBoard(q: { tag?: string; beforeTs?: number; limit: number }): Promise<{ posts: BoardRow[]; replies: BoardRow[] }> {
    const where: SQL[] = [isNull(boardPosts.parentId)];
    if (q.tag) where.push(eq(boardPosts.tag, q.tag));
    if (q.beforeTs !== undefined) where.push(lt(boardPosts.ts, q.beforeTs));
    const posts = await this.db.select().from(boardPosts).where(and(...where)).orderBy(desc(boardPosts.ts), desc(boardPosts.id)).limit(q.limit);
    const ids = posts.map((p) => p.id);
    const replies = ids.length ? await this.db.select().from(boardPosts).where(inArray(boardPosts.parentId, ids)).orderBy(asc(boardPosts.ts)) : [];
    return { posts, replies };
  }

  async revealedSecrets(now: number, beforeSeq: number | null, limit: number): Promise<EventRow[]> {
    const where: SQL[] = [eq(events.visibility, 'delayed'), lte(events.revealAt, now)];
    if (beforeSeq !== null) where.push(lt(events.id, beforeSeq));
    const rows = await this.db.select().from(events).where(and(...where)).orderBy(desc(events.id)).limit(limit);
    return rows.map(toEventRow);
  }

  async delayedEvents(limit: number): Promise<EventRow[]> {
    const rows = await this.db.select().from(events).where(eq(events.visibility, 'delayed')).orderBy(desc(events.id)).limit(limit);
    return rows.map(toEventRow);
  }

  async eventCounts(since: number): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ type: events.type, n: sql<number>`count(*)::int` })
      .from(events)
      .where(and(gte(events.ts, since), inArray(events.visibility, ['public', 'room'])))
      .groupBy(events.type);
    return Object.fromEntries(rows.map((r) => [r.type, Number(r.n)]));
  }

  async tradesSince(since: number): Promise<TradeRow[]> {
    return this.db.select().from(marketTrades).where(gte(marketTrades.ts, since)).orderBy(asc(marketTrades.ts));
  }

  async journalOf(agentId: string, limit: number): Promise<JournalRow[]> {
    return this.db.select().from(journalEntries).where(eq(journalEntries.agentId, agentId)).orderBy(desc(journalEntries.ts)).limit(limit);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
