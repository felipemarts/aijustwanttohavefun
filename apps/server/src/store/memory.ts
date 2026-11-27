import { randomBytes } from 'node:crypto';
import type { AgentState, Snapshot } from '@ajwf/engine';
import type { AgentStatus, DailyStats, GazetteEdition, Highlight, KeyMsg, TimelineEntry } from '@ajwf/shared';
import type {
  AchievementRow,
  AgentRecord,
  BoardRemoval,
  BoardRow,
  ChronicleBatch,
  ElectionRow,
  EventRow,
  JournalRow,
  LoadedState,
  NewOwner,
  OwnerRow,
  PushSubscriptionRow,
  ReportRow,
  SerializedSnapshot,
  SessionRow,
  Store,
  TradeRow,
} from './types';

/** The ownership columns of an agent row (the rest of `AgentRecord` never changes). */
type Ownership = { ownerId: string | null; ownerNote: string; ownerSeenAt: number | null; status: AgentStatus };

export const newOwnerId = () => `o${randomBytes(12).toString('base64url')}`;

const seqOf = (id: string) => Number(/^h(\d+)/.exec(id)?.[1] ?? 0);
const VISIBLE = new Set(['public', 'room']);

/** Recent events kept by the in-memory store; older ones are dropped (nothing reads them back yet). */
const MAX_EVENTS = 10_000;

/**
 * Keeps everything in process memory, so `pnpm dev` runs without Postgres. State is lost on restart, but one
 * instance can be shared by several `Game`s to simulate a restart in tests.
 */
export class MemoryStore implements Store {
  readonly kind = 'memory';
  /** Agent rows: the claim token hash is null once used. */
  readonly agents = new Map<string, Omit<AgentRecord, 'claimTokenHash'> & { claimTokenHash: string | null } & Ownership>();
  readonly owners = new Map<string, OwnerRow>();
  readonly sessions = new Map<string, SessionRow>();
  readonly push = new Map<string, PushSubscriptionRow>();
  readonly reports = new Map<string, ReportRow>();
  readonly blockedWords = new Map<string, number>();
  /** Ids of board posts (and `parentId/agentId/ts` of replies) and journal entries deleted by moderators. */
  readonly removed = new Set<string>();
  readonly agentSnapshots = new Map<string, string>();
  readonly worldSnapshots = new Map<string, string>();
  readonly events: EventRow[] = [];
  readonly highlights = new Map<string, Highlight>();
  readonly elections = new Map<string, ElectionRow>();
  readonly trades = new Map<string, TradeRow>();
  readonly posts = new Map<string, BoardRow>();
  readonly journal = new Map<string, JournalRow>();
  readonly achievements = new Map<string, AchievementRow>();
  readonly timeline = new Map<string, TimelineEntry>();
  readonly gazettes = new Map<string, GazetteEdition>();
  readonly stats = new Map<string, DailyStats>();
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
      identities: [...this.agents.values()].map(({ id, keyHash, claimTokenHash, claimedAt, ownerId, ownerNote, ownerSeenAt, status }) => ({
        id,
        keyHash,
        claimTokenHash,
        claimedAt,
        ownerId,
        ownerNote,
        ownerSeenAt,
        status,
      })),
      snapshot,
      maxEventId: this.events.reduce((m, e) => Math.max(m, e.id), 0),
    };
  }

  async insertAgent(rec: AgentRecord, snapshotJson: string): Promise<void> {
    this.check();
    for (const other of this.agents.values()) {
      if (other.nameNorm === rec.nameNorm || other.keyHash === rec.keyHash) throw new Error('unique violation');
    }
    this.agents.set(rec.id, { ...rec, ownerId: null, ownerNote: '', ownerSeenAt: null, status: 'active' });
    this.agentSnapshots.set(rec.id, snapshotJson);
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

  async appendChronicle(b: ChronicleBatch): Promise<void> {
    this.check();
    const keep = <T>(m: Map<string, T>, k: string, v: T) => void (m.has(k) || m.set(k, structuredClone(v)));
    for (const h of b.highlights) keep(this.highlights, h.id, h);
    for (const e of b.elections) this.elections.set(e.id, structuredClone(e));
    for (const t of b.trades) keep(this.trades, t.id, t);
    for (const p of b.posts) if (!this.isRemovedPost(p)) keep(this.posts, p.id, p);
    for (const j of b.journal) if (!this.removed.has(j.id)) keep(this.journal, j.id, j);
    for (const a of b.achievements) keep(this.achievements, `${a.agentId}/${a.achievementId}`, a);
    for (const t of b.timeline) keep(this.timeline, t.id, t);
    for (const g of b.gazettes) this.gazettes.set(g.date, structuredClone(g));
    for (const st of b.stats) this.stats.set(st.date, structuredClone(st));
  }

  async listHighlights(beforeSeq: number | null, limit: number): Promise<Highlight[]> {
    return [...this.highlights.values()]
      .filter((h) => beforeSeq === null || seqOf(h.id) < beforeSeq)
      .sort((a, b) => seqOf(b.id) - seqOf(a.id) || b.id.localeCompare(a.id))
      .slice(0, limit);
  }

  async getHighlight(id: string): Promise<Highlight | null> {
    return this.highlights.get(id) ?? null;
  }

  async listGazettes(limit: number): Promise<{ date: string; headline: KeyMsg; final: boolean }[]> {
    return [...this.gazettes.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit)
      .map((g) => ({ date: g.date, headline: g.headline, final: g.final }));
  }

  async getGazette(date: string): Promise<GazetteEdition | null> {
    return this.gazettes.get(date) ?? null;
  }

  async listDailyStats(limit: number): Promise<DailyStats[]> {
    return [...this.stats.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  }

  async listTimeline(): Promise<TimelineEntry[]> {
    return [...this.timeline.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  }

  async listBoard(q: { tag?: string; beforeTs?: number; limit: number }): Promise<{ posts: BoardRow[]; replies: BoardRow[] }> {
    const posts = [...this.posts.values()]
      .filter((p) => p.parentId === null && (!q.tag || p.tag === q.tag) && (q.beforeTs === undefined || p.ts < q.beforeTs))
      .sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id))
      .slice(0, q.limit);
    const ids = new Set(posts.map((p) => p.id));
    const replies = [...this.posts.values()].filter((p) => p.parentId !== null && ids.has(p.parentId)).sort((a, b) => a.ts - b.ts);
    return { posts, replies };
  }

  async revealedSecrets(now: number, beforeSeq: number | null, limit: number): Promise<EventRow[]> {
    return this.events
      .filter((e) => e.visibility === 'delayed' && e.revealAt !== null && e.revealAt <= now && (beforeSeq === null || e.id < beforeSeq))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }

  async delayedEvents(limit: number): Promise<EventRow[]> {
    return this.events
      .filter((e) => e.visibility === 'delayed')
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }

  async eventCounts(since: number): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const e of this.events) if (e.ts >= since && VISIBLE.has(e.visibility)) out[e.type] = (out[e.type] ?? 0) + 1;
    return out;
  }

  async tradesSince(since: number): Promise<TradeRow[]> {
    return [...this.trades.values()].filter((t) => t.ts >= since).sort((a, b) => a.ts - b.ts);
  }

  async journalOf(agentId: string, limit: number): Promise<JournalRow[]> {
    return [...this.journal.values()]
      .filter((j) => j.agentId === agentId)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  private isRemovedPost(p: BoardRow): boolean {
    return this.removed.has(p.id) || (p.parentId !== null && this.removed.has(`${p.parentId}/${p.agentId}/${p.ts}`));
  }

  // ── owners ────────────────────────────────────────────────────────────────────────────────────────────────

  async upsertOwner(o: NewOwner, now: number): Promise<OwnerRow> {
    this.check();
    for (const row of this.owners.values()) {
      if (row.provider === o.provider && row.externalId === o.externalId) {
        row.name = o.name;
        return { ...row };
      }
    }
    const row: OwnerRow = { id: newOwnerId(), ...o, createdAt: now };
    this.owners.set(row.id, row);
    return { ...row };
  }

  async getOwner(id: string): Promise<OwnerRow | null> {
    const o = this.owners.get(id);
    return o && o.provider !== 'deleted' ? { ...o } : null;
  }

  async setOwnerLanguage(id: string, language: string): Promise<void> {
    this.check();
    const o = this.owners.get(id);
    if (o) o.language = language;
  }

  async deleteOwner(id: string): Promise<void> {
    this.check();
    for (const [k, s] of this.sessions) if (s.ownerId === id) this.sessions.delete(k);
    for (const [k, p] of this.push) if (p.ownerId === id) this.push.delete(k);
    for (const a of this.agents.values()) {
      if (a.ownerId !== id) continue;
      a.ownerId = null;
      a.ownerNote = '';
      a.status = a.status === 'banned' ? 'banned' : 'retired';
    }
    const o = this.owners.get(id);
    if (o) Object.assign(o, { provider: 'deleted', externalId: id, name: '', language: 'en' });
  }

  async createSession(s: SessionRow): Promise<void> {
    this.check();
    this.sessions.set(s.id, { ...s });
  }

  async getSession(id: string): Promise<SessionRow | null> {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }

  async refreshSession(id: string, expiresAt: number, refreshedAt: number): Promise<void> {
    const s = this.sessions.get(id);
    if (s) Object.assign(s, { expiresAt, refreshedAt });
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async claimAgent(agentId: string, ownerId: string, now: number): Promise<boolean> {
    this.check();
    const a = this.agents.get(agentId);
    if (!a || a.claimTokenHash === null || a.ownerId !== null) return false;
    Object.assign(a, { ownerId, claimedAt: now, claimTokenHash: null });
    return true;
  }

  async updateKeyHash(agentId: string, keyHash: string): Promise<void> {
    this.check();
    for (const other of this.agents.values()) if (other.keyHash === keyHash) throw new Error('unique violation');
    const a = this.agents.get(agentId);
    if (a) a.keyHash = keyHash;
  }

  async setAgentStatus(agentId: string, status: AgentStatus): Promise<void> {
    this.check();
    const a = this.agents.get(agentId);
    if (a) a.status = status;
  }

  async setOwnerNote(agentId: string, note: string): Promise<void> {
    this.check();
    const a = this.agents.get(agentId);
    if (a) a.ownerNote = note;
  }

  async setOwnerSeen(agentId: string, ts: number): Promise<void> {
    const a = this.agents.get(agentId);
    if (a) a.ownerSeenAt = ts;
  }

  async agentEvents(agentId: string, since: number, types: readonly string[], limit: number): Promise<EventRow[]> {
    const wanted = new Set(types);
    return this.events.filter((e) => e.ts >= since && wanted.has(e.type) && (e.actor === agentId || e.target === agentId)).slice(0, limit);
  }

  async savePushSubscription(row: PushSubscriptionRow): Promise<void> {
    this.check();
    this.push.set(row.endpoint, structuredClone(row));
  }

  async listPushSubscriptions(ownerId: string): Promise<PushSubscriptionRow[]> {
    return [...this.push.values()].filter((p) => p.ownerId === ownerId).map((p) => structuredClone(p));
  }

  async deletePushSubscription(endpoint: string, ownerId?: string): Promise<void> {
    const p = this.push.get(endpoint);
    if (p && (ownerId === undefined || p.ownerId === ownerId)) this.push.delete(endpoint);
  }

  async addReport(r: ReportRow): Promise<void> {
    this.check();
    this.reports.set(r.id, { ...r });
  }

  async listReports(q: { limit: number; resolved?: boolean }): Promise<ReportRow[]> {
    return [...this.reports.values()]
      .filter((r) => q.resolved === undefined || r.resolved === q.resolved)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, q.limit)
      .map((r) => ({ ...r }));
  }

  async resolveReport(id: string): Promise<boolean> {
    const r = this.reports.get(id);
    if (!r) return false;
    r.resolved = true;
    return true;
  }

  async removeBoardPost(r: BoardRemoval): Promise<boolean> {
    this.check();
    if ('id' in r) {
      this.removed.add(r.id);
      const hit = this.posts.has(r.id);
      this.posts.delete(r.id);
      for (const [k, p] of this.posts) if (p.parentId === r.id) this.posts.delete(k);
      return hit;
    }
    this.removed.add(`${r.parentId}/${r.agentId}/${r.ts}`);
    let hit = false;
    for (const [k, p] of this.posts) {
      if (p.parentId === r.parentId && p.agentId === r.agentId && p.ts === r.ts) {
        this.posts.delete(k);
        hit = true;
      }
    }
    return hit;
  }

  async removeJournalEntry(id: string): Promise<boolean> {
    this.check();
    this.removed.add(id);
    return this.journal.delete(id);
  }

  async scrubHighlightQuotes(text: string): Promise<void> {
    for (const h of this.highlights.values()) if (h.quote?.text === text) delete h.quote;
  }

  async addBlockedWords(words: string[], now: number): Promise<void> {
    for (const w of words) if (!this.blockedWords.has(w)) this.blockedWords.set(w, now);
  }

  async listBlockedWords(): Promise<string[]> {
    return [...this.blockedWords.keys()];
  }

  async close(): Promise<void> {}
}
