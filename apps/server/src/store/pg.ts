import type { AgentState } from '@ajwf/engine';
import type { AgentStatus, DailyStats, GazetteEdition, Highlight, KeyMsg, TimelineEntry } from '@ajwf/shared';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { runMigrations } from '../db/migrate';
import {
  achievementsUnlocked,
  agents,
  agentSnapshots,
  blockedWords,
  boardPosts,
  elections,
  events,
  gazetteEditions,
  highlights,
  journalEntries,
  marketTrades,
  owners,
  pushSubscriptions,
  reports,
  sessions,
  villageStatsDaily,
  villageTimeline,
  worldSnapshots,
} from '../db/schema';
import { newOwnerId } from './memory';
import type {
  AgentRecord,
  BoardRemoval,
  BoardRow,
  ChronicleBatch,
  EventRow,
  JournalRow,
  LoadedState,
  NewOwner,
  OwnerRow,
  PushKeys,
  PushSubscriptionRow,
  ReportRow,
  SerializedSnapshot,
  SessionRow,
  Store,
  TradeRow,
} from './types';

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

function toOwner(r: typeof owners.$inferSelect): OwnerRow {
  return { id: r.id, provider: r.provider, externalId: r.externalId, name: r.name, language: r.language, createdAt: r.createdAt.getTime() };
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
      .select({
        id: agents.id,
        keyHash: agents.keyHash,
        claimTokenHash: agents.claimToken,
        claimedAt: agents.claimedAt,
        ownerId: agents.ownerId,
        ownerNote: agents.ownerNote,
        ownerSeenAt: agents.ownerSeenAt,
        status: agents.status,
      })
      .from(agents);
    const agentRows = await this.db.select({ state: agentSnapshots.state }).from(agentSnapshots);
    const worldRows = await this.db.select({ key: worldSnapshots.key, state: worldSnapshots.state }).from(worldSnapshots);
    const [max] = await this.db.select({ id: sql<string | null>`max(${events.id})` }).from(events);
    const empty = agentRows.length === 0 && worldRows.length === 0;
    return {
      identities: ids.map((r) => ({ ...r, status: r.status as AgentStatus })),
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
    where.push(eq(boardPosts.removed, false));
    const strip = ({ removed: _r, ...row }: typeof boardPosts.$inferSelect): BoardRow => row;
    const posts = (await this.db.select().from(boardPosts).where(and(...where)).orderBy(desc(boardPosts.ts), desc(boardPosts.id)).limit(q.limit)).map(strip);
    const ids = posts.map((p) => p.id);
    const replies = ids.length
      ? (await this.db.select().from(boardPosts).where(and(inArray(boardPosts.parentId, ids), eq(boardPosts.removed, false))).orderBy(asc(boardPosts.ts))).map(strip)
      : [];
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
    const rows = await this.db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.agentId, agentId), eq(journalEntries.removed, false)))
      .orderBy(desc(journalEntries.ts))
      .limit(limit);
    return rows.map(({ removed: _r, ...row }) => row);
  }

  // ── owners ────────────────────────────────────────────────────────────────────────────────────────────────

  async upsertOwner(o: NewOwner, now: number): Promise<OwnerRow> {
    const [row] = await this.db
      .insert(owners)
      .values({ id: newOwnerId(), provider: o.provider, externalId: o.externalId, name: o.name, language: o.language, lastSeenAt: now })
      .onConflictDoUpdate({ target: [owners.provider, owners.externalId], set: { name: o.name, lastSeenAt: now } })
      .returning();
    return toOwner(row!);
  }

  async getOwner(id: string): Promise<OwnerRow | null> {
    const [row] = await this.db.select().from(owners).where(and(eq(owners.id, id), ne(owners.provider, 'deleted')));
    return row ? toOwner(row) : null;
  }

  async setOwnerLanguage(id: string, language: string): Promise<void> {
    await this.db.update(owners).set({ language }).where(eq(owners.id, id));
  }

  async deleteOwner(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(sessions).where(eq(sessions.ownerId, id));
      await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.ownerId, id));
      await tx
        .update(agents)
        .set({ ownerId: null, ownerNote: '', status: sql`case when ${agents.status} = 'banned' then 'banned' else 'retired' end` })
        .where(eq(agents.ownerId, id));
      await tx.update(owners).set({ provider: 'deleted', externalId: id, name: '', language: 'en', lastSeenAt: null }).where(eq(owners.id, id));
    });
  }

  async createSession(s: SessionRow): Promise<void> {
    await this.db.insert(sessions).values({ id: s.id, ownerId: s.ownerId, expiresAt: s.expiresAt, refreshedAt: s.refreshedAt, createdAt: s.createdAt });
  }

  async getSession(id: string): Promise<SessionRow | null> {
    const [r] = await this.db
      .select({ id: sessions.id, ownerId: sessions.ownerId, expiresAt: sessions.expiresAt, refreshedAt: sessions.refreshedAt, createdAt: sessions.createdAt })
      .from(sessions)
      .where(eq(sessions.id, id));
    return r ?? null;
  }

  async refreshSession(id: string, expiresAt: number, refreshedAt: number): Promise<void> {
    await this.db.update(sessions).set({ expiresAt, refreshedAt }).where(eq(sessions.id, id));
  }

  async deleteSession(id: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, id));
  }

  async claimAgent(agentId: string, ownerId: string, now: number): Promise<boolean> {
    const rows = await this.db
      .update(agents)
      .set({ ownerId, claimedAt: now, claimToken: null })
      .where(and(eq(agents.id, agentId), isNotNull(agents.claimToken), isNull(agents.ownerId)))
      .returning({ id: agents.id });
    return rows.length === 1;
  }

  async updateKeyHash(agentId: string, keyHash: string): Promise<void> {
    await this.db.update(agents).set({ keyHash }).where(eq(agents.id, agentId));
  }

  async setAgentStatus(agentId: string, status: AgentStatus): Promise<void> {
    await this.db.update(agents).set({ status }).where(eq(agents.id, agentId));
  }

  async setOwnerNote(agentId: string, note: string): Promise<void> {
    await this.db.update(agents).set({ ownerNote: note }).where(eq(agents.id, agentId));
  }

  async setOwnerSeen(agentId: string, ts: number): Promise<void> {
    await this.db.update(agents).set({ ownerSeenAt: ts }).where(eq(agents.id, agentId));
  }

  async agentEvents(agentId: string, since: number, types: readonly string[], limit: number): Promise<EventRow[]> {
    if (!types.length) return [];
    const rows = await this.db
      .select()
      .from(events)
      .where(and(or(eq(events.actor, agentId), eq(events.target, agentId)), gte(events.ts, since), inArray(events.type, [...types])))
      .orderBy(asc(events.id))
      .limit(limit);
    return rows.map(toEventRow);
  }

  async savePushSubscription(row: PushSubscriptionRow): Promise<void> {
    const subscription = { endpoint: row.endpoint, keys: row.keys };
    await this.db
      .insert(pushSubscriptions)
      .values({ id: row.id, ownerId: row.ownerId, endpoint: row.endpoint, subscription })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { ownerId: row.ownerId, subscription } });
  }

  async listPushSubscriptions(ownerId: string): Promise<PushSubscriptionRow[]> {
    const rows = await this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.ownerId, ownerId));
    return rows.map((r) => ({ id: r.id, ownerId: r.ownerId, endpoint: r.endpoint, keys: (r.subscription as { keys: PushKeys }).keys }));
  }

  async deletePushSubscription(endpoint: string, ownerId?: string): Promise<void> {
    const where = ownerId === undefined ? eq(pushSubscriptions.endpoint, endpoint) : and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.ownerId, ownerId));
    await this.db.delete(pushSubscriptions).where(where);
  }

  async addReport(r: ReportRow): Promise<void> {
    await this.db.insert(reports).values({ id: r.id, kind: r.kind, targetId: r.targetId, reason: r.reason, details: r.details, reporterIp: r.reporterHash, ts: r.ts, resolved: r.resolved });
  }

  async listReports(q: { limit: number; resolved?: boolean }): Promise<ReportRow[]> {
    const rows = await this.db
      .select()
      .from(reports)
      .where(q.resolved === undefined ? undefined : eq(reports.resolved, q.resolved))
      .orderBy(desc(reports.ts))
      .limit(q.limit);
    return rows.map(({ reporterIp, ...r }) => ({ ...r, reporterHash: reporterIp }));
  }

  async resolveReport(id: string): Promise<boolean> {
    const rows = await this.db.update(reports).set({ resolved: true }).where(eq(reports.id, id)).returning({ id: reports.id });
    return rows.length === 1;
  }

  async removeBoardPost(r: BoardRemoval): Promise<boolean> {
    const where = 'id' in r ? or(eq(boardPosts.id, r.id), eq(boardPosts.parentId, r.id)) : and(eq(boardPosts.parentId, r.parentId), eq(boardPosts.agentId, r.agentId), eq(boardPosts.ts, r.ts));
    const rows = await this.db.update(boardPosts).set({ text: '', removed: true }).where(where).returning({ id: boardPosts.id });
    return rows.length > 0;
  }

  async removeJournalEntry(id: string): Promise<boolean> {
    const rows = await this.db.update(journalEntries).set({ text: '', removed: true }).where(eq(journalEntries.id, id)).returning({ id: journalEntries.id });
    return rows.length === 1;
  }

  async scrubHighlightQuotes(text: string): Promise<void> {
    await this.db
      .update(highlights)
      .set({ extra: sql`${highlights.extra} - 'quote'` })
      .where(sql`${highlights.extra}->'quote'->>'text' = ${text}`);
  }

  async addBlockedWords(words: string[], now: number): Promise<void> {
    if (!words.length) return;
    await this.db
      .insert(blockedWords)
      .values(words.map((word) => ({ word, addedAt: now })))
      .onConflictDoNothing();
  }

  async listBlockedWords(): Promise<string[]> {
    return (await this.db.select({ word: blockedWords.word }).from(blockedWords)).map((r) => r.word);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
