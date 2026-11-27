import type { AgentState, Snapshot } from '@ajwf/engine';
import type { DailyStats, GazetteEdition, Highlight, KeyMsg, TimelineEntry } from '@ajwf/shared';
import type {
  AchievementRow,
  AgentRecord,
  BoardRow,
  ChronicleBatch,
  ElectionRow,
  EventRow,
  JournalRow,
  LoadedState,
  SerializedSnapshot,
  Store,
  TradeRow,
} from './types';

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
  readonly agents = new Map<string, AgentRecord>();
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

  async appendChronicle(b: ChronicleBatch): Promise<void> {
    this.check();
    const keep = <T>(m: Map<string, T>, k: string, v: T) => void (m.has(k) || m.set(k, structuredClone(v)));
    for (const h of b.highlights) keep(this.highlights, h.id, h);
    for (const e of b.elections) this.elections.set(e.id, structuredClone(e));
    for (const t of b.trades) keep(this.trades, t.id, t);
    for (const p of b.posts) keep(this.posts, p.id, p);
    for (const j of b.journal) keep(this.journal, j.id, j);
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

  async close(): Promise<void> {}
}
