import { hasOwnKey } from '@ajwf/shared';
import { removeBoardPost, villageView, type WorldState } from '@ajwf/engine';
import type { DailyStats, GameEvent, GazetteEdition, Highlight, KeyMsg, SecretConversation, TimelineEntry } from '@ajwf/shared';
import type { Logger } from 'pino';
import type { Census } from '../census';
import { buildGazette } from '../chronicle/gazette';
import { HighlightDetector, highlightSeq, type ChronicleLookup } from '../chronicle/highlights';
import { isRevealed, revealedConversations, SECRET_TYPES, type SecretInput } from '../chronicle/secrets';
import { dailyStats, DayTally, dayKey, dayStart, goldInCirculation } from '../chronicle/stats';
import { newTimelineMemory, TIMELINE_TYPES, timelineEntry, type TimelineMemory } from '../chronicle/timeline';
import type { EventConsumer } from '../game';
import { isSpectatorVisible } from '../spectate/visibility';
import { batchSize, emptyBatch, type BoardRow, type ChronicleBatch, type EventRow, type JournalRow, type Store } from '../store/types';
import { Ring } from './ring';

export const CHRONICLE = {
  highlightsRing: 1000,
  secretsRing: 5000,
  journalPerAgent: 5,
  editionsKept: 14,
  flushMs: 2000,
  /** Rows waiting for the store beyond this are dropped (oldest first) while the database is down. */
  maxPending: 50_000,
  /** The running day's edition is rebuilt at most this often (or when a highlight arrives). */
  todayCacheMs: 30_000,
  onlineSampleMs: 30_000,
  /** The gazette index (dates and headlines) is cached this long. */
  indexCacheMs: 60_000,
} as const;

export type ChronicleDeps = { state: WorldState; store: Store; census: Census; log: Logger; now: () => number; seed: number };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * The server side of the chronicle: runs the highlight detector and the day's tally over public events, keeps the
 * recent highlights, secrets, timeline and journal entries in bounded rings, publishes the Village Gazette at day
 * rollover, and writes everything to the store in batches, off the request path.
 */
export class Chronicle implements EventConsumer {
  readonly name = 'chronicle';
  readonly detector: HighlightDetector;
  private readonly s: WorldState;
  private readonly d: ChronicleDeps;
  private tally: DayTally;
  private onlinePeak = 0;
  private highlightRing = new Ring<Highlight>(CHRONICLE.highlightsRing);
  /** False when the store may hold older highlights than the ring. */
  private highlightsComplete = true;
  private secretRing = new Ring<SecretInput>(CHRONICLE.secretsRing);
  private secretsComplete = true;
  private timeline: TimelineEntry[] = [];
  private timelineMem: TimelineMemory;
  private journals = new Map<string, JournalRow[]>();
  private journalsLoaded = new Set<string>();
  private editions = new Map<string, GazetteEdition>();
  private today: { at: number; n: number; edition: GazetteEdition } | null = null;
  private index: { at: number; list: { date: string; headline: KeyMsg; final: boolean }[] } | null = null;
  private pending: ChronicleBatch = emptyBatch();
  private busy: Promise<void> | null = null;
  private listeners: ((h: Highlight) => void)[] = [];
  private timers: NodeJS.Timeout[] = [];
  private readonly lookup: ChronicleLookup;

  constructor(d: ChronicleDeps) {
    this.d = d;
    this.s = d.state;
    this.lookup = {
      agentName: (id) => this.s.agents.get(id)?.name,
      monsterKind: (id) => {
        const m = this.s.content.monsters.get(id);
        return m ? (m.world_boss ? 'world_boss' : m.boss ? 'boss' : 'normal') : undefined;
      },
    };
    this.detector = new HighlightDetector(this.lookup);
    this.tally = new DayTally(dayKey(d.now()));
    this.timelineMem = this.freshTimelineMemory();
  }

  private freshTimelineMemory(): TimelineMemory {
    const mem = newTimelineMemory();
    const c = this.s.content;
    for (const p of c.projects.values()) mem.sites.set(p.id, { site: p.site, building: p.building });
    for (const p of villageView(this.s, this.d.now()).projects) {
      if (p.status === 'done') mem.quarters.set(p.id, 4);
      else if (hasOwnKey(this.s.village.projects, p.id)) mem.quarters.set(p.id, Math.floor(p.progress / 0.25));
    }
    for (const [plot, h] of Object.entries(this.s.village.halls)) mem.halls.set(h.guild, plot);
    return mem;
  }

  /** Refills the rings and today's tally from the store after a restart. Call once, before the game runs. */
  async hydrate(): Promise<void> {
    const st = this.d.store;
    const hs = await st.listHighlights(null, CHRONICLE.highlightsRing);
    for (const h of hs.reverse()) this.highlightRing.push(h);
    this.highlightsComplete = hs.length < CHRONICLE.highlightsRing;
    const rows = await st.delayedEvents(CHRONICLE.secretsRing);
    for (const r of rows.reverse()) {
      const m = this.secretFromRow(r);
      if (m) this.secretRing.push(m);
    }
    this.secretsComplete = rows.length < CHRONICLE.secretsRing;
    this.timeline = await st.listTimeline();
    const date = this.tally.date;
    const since = dayStart(date);
    const counts = await st.eventCounts(since);
    const t = new DayTally(date, { counts });
    for (const tr of await st.tradesSince(since)) t.trade(tr.item, tr.qty, tr.price);
    const fresh = [...this.s.agents.values()].filter((a) => a.createdAt >= since).sort((a, b) => a.createdAt - b.createdAt);
    t.data.newcomerCount = counts.arrival ?? fresh.length;
    t.data.newcomers = fresh.slice(0, 50).map((a) => a.name);
    this.tally = t;
  }

  onHighlight(fn: (h: Highlight) => void): void {
    this.listeners.push(fn);
  }

  // ── events in ─────────────────────────────────────────────────────────────────────────────────────────────

  consume(events: readonly GameEvent[]): void {
    for (const ev of events) {
      // Delayed chat is kept apart (Secrets Revealed); it never feeds highlights, the tally or the gazette.
      if (ev.visibility === 'delayed') {
        const m = SECRET_TYPES.has(ev.type) ? this.secretFrom(ev) : null;
        if (m) this.secretRing.push(m);
        continue;
      }
      if (!isSpectatorVisible(ev)) continue;
      if (dayKey(ev.ts) !== this.tally.date) this.rollover(ev.ts);
      this.tally.consume(ev, this.lookup.agentName);
      this.record(ev);
      for (const h of this.detector.detect(ev)) this.addHighlight(h);
    }
    this.trim();
  }

  private addHighlight(h: Highlight): void {
    this.highlightRing.push(h);
    if (this.highlightRing.overflowed) this.highlightsComplete = false;
    this.pending.highlights.push(h);
    this.today = null;
    for (const fn of this.listeners) {
      try {
        fn(h);
      } catch (err) {
        this.d.log.error({ err }, 'highlight listener failed');
      }
    }
  }

  /** The rows each kind of event leaves in its table. */
  private record(ev: GameEvent): void {
    const p = ev.payload;
    const b = this.pending;
    switch (ev.type) {
      case 'market_trade':
        b.trades.push({ id: `t${ev.id}`, item: str(p.item), qty: num(p.qty), price: num(p.price), buyer: ev.actor ?? '', seller: ev.target ?? '', ts: ev.ts });
        break;
      case 'board_post':
        b.posts.push({ id: str(p.post), agentId: ev.actor ?? '', parentId: null, tag: str(p.tag) || 'general', text: str(p.text), lang: ev.lang ?? '', ts: ev.ts });
        break;
      case 'board_reply': {
        const parent = str(p.post);
        const tag = this.s.board.find((x) => x.id === parent)?.tag ?? 'general';
        b.posts.push({ id: `r${ev.id}`, agentId: ev.actor ?? '', parentId: parent, tag, text: str(p.text), lang: ev.lang ?? '', ts: ev.ts });
        break;
      }
      case 'journal': {
        const row: JournalRow = { id: `j${ev.id}`, agentId: ev.actor ?? '', text: str(p.text), lang: ev.lang ?? '', ts: ev.ts };
        b.journal.push(row);
        const list = this.journals.get(row.agentId) ?? [];
        list.unshift(row);
        if (list.length > CHRONICLE.journalPerAgent) list.length = CHRONICLE.journalPerAgent;
        this.journals.set(row.agentId, list);
        break;
      }
      case 'achievement':
        if (ev.actor) b.achievements.push({ agentId: ev.actor, achievementId: str(p.ach), ts: ev.ts });
        break;
      case 'election_result': {
        const votes = Array.isArray(p.votes) ? (p.votes as { name?: unknown; votes?: unknown }[]) : [];
        b.elections.push({
          id: String(num(p.n)),
          startsAt: num(p.start),
          endsAt: num(p.end),
          candidates: votes.map((v) => ({ name: str(v.name), votes: num(v.votes) })),
          votes: { voters: num(p.voters) },
          winner: typeof p.winner === 'string' ? p.winner : null,
        });
        break;
      }
    }
    if (TIMELINE_TYPES.has(ev.type)) {
      const e = timelineEntry(ev, this.timelineMem, this.lookup.agentName);
      if (e) {
        this.timeline.push(e);
        b.timeline.push(e);
      }
    }
  }

  private trim(): void {
    const b = this.pending;
    if (batchSize(b) <= CHRONICLE.maxPending) return;
    for (const list of [b.trades, b.posts, b.journal, b.achievements, b.highlights, b.timeline]) if (list.length > CHRONICLE.maxPending / 6) list.splice(0, list.length - CHRONICLE.maxPending / 6);
    this.d.log.warn('chronicle buffer full; oldest rows dropped');
  }

  private secretFrom(ev: Pick<GameEvent, 'id' | 'ts' | 'type' | 'actor' | 'target' | 'visibility' | 'revealAt' | 'lang' | 'payload'>): SecretInput | null {
    if (typeof ev.revealAt !== 'number') return null;
    const name = (id: string | undefined) => (id ? this.lookup.agentName(id) : undefined) ?? '?';
    const base = { id: ev.id, seq: Number(ev.id), ts: ev.ts, revealAt: ev.revealAt, visibility: ev.visibility, from: name(ev.actor), text: str(ev.payload.text), lang: ev.lang ?? '' };
    if (ev.type === 'whisper') return { ...base, channel: 'whisper', to: name(ev.target) };
    if (ev.type === 'party_say') return { ...base, channel: 'party', group: ev.target ?? '' };
    const g = ev.target ? this.s.guilds.get(ev.target) : undefined;
    return { ...base, channel: 'guild', group: ev.target ?? '', guild: g?.name ?? '?' };
  }

  private secretFromRow(r: EventRow): SecretInput | null {
    if (!SECRET_TYPES.has(r.type)) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(r.payloadJson) as Record<string, unknown>;
    } catch {
      return null;
    }
    return this.secretFrom({
      id: String(r.id),
      ts: r.ts,
      type: r.type,
      actor: r.actor ?? undefined,
      target: r.target ?? undefined,
      visibility: r.visibility as GameEvent['visibility'],
      revealAt: r.revealAt ?? undefined,
      lang: r.lang ?? undefined,
      payload,
    });
  }

  // ── the day ───────────────────────────────────────────────────────────────────────────────────────────────

  /** Closes the running day when `now` is in a later one: its final edition and stats row are published. */
  rollover(now: number): void {
    const date = dayKey(now);
    if (date === this.tally.date) return;
    const edition = this.build(this.tally, now, true);
    this.editions.set(edition.date, edition);
    if (this.editions.size > CHRONICLE.editionsKept) this.editions.delete(this.editions.keys().next().value!);
    this.pending.gazettes.push(edition);
    this.pending.stats.push(edition.stats);
    this.tally = new DayTally(date);
    this.onlinePeak = this.d.census.online(now);
    this.today = null;
    this.index = null;
  }

  private dayHighlights(date: string): Highlight[] {
    return this.highlightRing.values().filter((h) => dayKey(h.ts) === date);
  }

  private stats(t: DayTally, now: number): DailyStats {
    const s = this.s;
    return dailyStats({
      population: this.d.census.counts(now).population,
      onlinePeak: Math.max(this.onlinePeak, this.d.census.online(now)),
      projectsDone: Object.values(s.village.projects).filter((p) => p.doneAt !== undefined).length,
      goldInCirculation: goldInCirculation(s),
      tally: t,
    });
  }

  private build(t: DayTally, now: number, final: boolean): GazetteEdition {
    return buildGazette({
      date: t.date,
      seed: this.d.seed,
      templates: this.s.content.gazetteTemplates,
      highlights: this.dayHighlights(t.date),
      village: villageView(this.s, now),
      stats: this.stats(t, now),
      tally: t,
      final,
    });
  }

  /** Today's edition so far, rebuilt at most every 30 s or when a highlight arrives. */
  todayEdition(now = this.d.now()): GazetteEdition {
    this.rollover(now);
    const n = this.highlightRing.size;
    if (!this.today || now - this.today.at > CHRONICLE.todayCacheMs || this.today.n !== n) this.today = { at: now, n, edition: this.build(this.tally, now, false) };
    return this.today.edition;
  }

  async edition(date: string): Promise<GazetteEdition | null> {
    this.rollover(this.d.now());
    if (date === this.tally.date) return this.todayEdition();
    return this.editions.get(date) ?? (await this.d.store.getGazette(date));
  }

  /** Dates and headlines, newest first, today's (still running) edition included. */
  async gazetteIndex(limit = 60): Promise<{ date: string; headline: KeyMsg; final: boolean }[]> {
    const now = this.d.now();
    if (!this.index || now - this.index.at > CHRONICLE.indexCacheMs) this.index = { at: now, list: await this.d.store.listGazettes(limit) };
    const today = this.todayEdition(now);
    const seen = new Set([today.date]);
    const extra = [...this.editions.values()].filter((e) => !seen.has(e.date)).map((e) => ({ date: e.date, headline: e.headline, final: e.final }));
    for (const e of extra) seen.add(e.date);
    const list = [{ date: today.date, headline: today.headline, final: false }, ...extra, ...this.index.list.filter((e) => !seen.has(e.date))];
    return list.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  }

  /** Daily stats, oldest first, with today's numbers so far at the end. */
  async history(limit = 90): Promise<DailyStats[]> {
    const now = this.d.now();
    const stored = await this.d.store.listDailyStats(limit);
    const byDate = new Map(stored.map((r) => [r.date, r]));
    for (const e of this.editions.values()) byDate.set(e.date, e.stats);
    byDate.set(this.tally.date, this.todayEdition(now).stats);
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-limit);
  }

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** Newest first, below `before` (a highlight id). From the ring; the store only for pages the ring no longer holds. */
  async highlights(before: string | null, limit: number, keep?: (h: Highlight) => boolean): Promise<Highlight[]> {
    const below = before ? highlightSeq(before) : Infinity;
    const out = this.highlightRing.newest(limit, (h) => highlightSeq(h.id) < below && (!keep || keep(h)));
    if (out.length < limit && !this.highlightsComplete && !keep) {
      const oldest = this.highlightRing.values()[0];
      const from = Math.min(below, oldest ? highlightSeq(oldest.id) : Infinity);
      out.push(...(await this.d.store.listHighlights(Number.isFinite(from) ? from : null, limit - out.length)));
    }
    return out;
  }

  /** Recent highlights in memory only (profiles, guild pages). */
  recentHighlights(limit: number, keep: (h: Highlight) => boolean): Highlight[] {
    return this.highlightRing.newest(limit, keep);
  }

  async highlight(id: string): Promise<Highlight | null> {
    return this.highlightRing.newest(1, (h) => h.id === id)[0] ?? (await this.d.store.getHighlight(id));
  }

  /**
   * Revealed conversations, newest first, from at most `limit` messages older than `before` (an event id). Every
   * message passes `isRevealed` against the server clock, whether it came from the ring or the store.
   */
  async secrets(before: number | null, limit: number): Promise<{ conversations: SecretConversation[]; next: string | null }> {
    const now = this.d.now();
    const below = before ?? Infinity;
    const msgs = this.secretRing.newest(limit, (m) => m.seq < below && isRevealed(m, now));
    if (msgs.length < limit && !this.secretsComplete) {
      const oldest = this.secretRing.values()[0];
      const from = Math.min(below, oldest ? oldest.seq : Infinity);
      const rows = await this.d.store.revealedSecrets(now, Number.isFinite(from) ? from : null, limit - msgs.length);
      for (const r of rows) {
        const m = this.secretFromRow(r);
        if (m && isRevealed(m, now)) msgs.push(m);
      }
    }
    const next = msgs.length >= limit ? String(Math.min(...msgs.map((m) => m.seq))) : null;
    return { conversations: revealedConversations(msgs, now), next };
  }

  timelineEntries(): TimelineEntry[] {
    return this.timeline;
  }

  async journalOf(agentId: string): Promise<JournalRow[]> {
    if (!this.journalsLoaded.has(agentId)) {
      this.journalsLoaded.add(agentId);
      const stored = await this.d.store.journalOf(agentId, CHRONICLE.journalPerAgent);
      const mine = this.journals.get(agentId) ?? [];
      const ids = new Set(mine.map((j) => j.id));
      this.journals.set(agentId, [...mine, ...stored.filter((j) => !ids.has(j.id))].sort((a, b) => b.ts - a.ts).slice(0, CHRONICLE.journalPerAgent));
    }
    return this.journals.get(agentId) ?? [];
  }

  /** Board posts older than `beforeTs`, newest first: the engine's board in memory, the store beyond it. */
  async board(q: { tag?: string; beforeTs?: number; limit: number }): Promise<{ posts: BoardRow[]; replies: BoardRow[] }> {
    const all = this.s.board;
    const posts: BoardRow[] = [];
    const replies: BoardRow[] = [];
    const lang = (id: string) => this.s.agents.get(id)?.lang ?? '';
    for (let i = all.length - 1; i >= 0 && posts.length < q.limit; i--) {
      const p = all[i]!;
      if ((q.tag && p.tag !== q.tag) || (q.beforeTs !== undefined && p.at >= q.beforeTs)) continue;
      posts.push({ id: p.id, agentId: p.by, parentId: null, tag: p.tag, text: p.text, lang: lang(p.by), ts: p.at });
      p.replies.forEach((r, n) => replies.push({ id: `${p.id}.${n}`, agentId: r.by, parentId: p.id, tag: p.tag, text: r.text, lang: lang(r.by), ts: r.at }));
    }
    // Posts left the board (trimmed by its count or text limits, or removed): older ones are in the store.
    if (posts.length < q.limit && this.s.meta.postSeq > all.length) {
      const oldest = Math.min(q.beforeTs ?? Infinity, all[0]?.at ?? Infinity);
      const more = await this.d.store.listBoard({ ...q, limit: q.limit - posts.length, ...(Number.isFinite(oldest) ? { beforeTs: oldest } : {}) });
      posts.push(...more.posts);
      replies.push(...more.replies);
    }
    return { posts, replies };
  }

  // ── moderation ────────────────────────────────────────────────────────────────────────────────────────────

  /** Drops the quote of every highlight (in memory and stored) that quotes exactly this text. */
  private async scrubQuotes(text: string): Promise<void> {
    if (!text) return;
    for (const h of this.highlightRing.values()) if (h.quote?.text === text) delete h.quote;
    for (const h of this.pending.highlights) if (h.quote?.text === text) delete h.quote;
    this.today = null;
    await this.d.store.scrubHighlightQuotes(text);
  }

  /**
   * Deletes a board post with its replies (`b12`) or one reply (`b12.0`, as `/api/public/board` lists them): gone
   * from the engine's board (`removeBoardPost`, which marks it dirty for the next snapshot), the pending writes and
   * the store (tombstoned), and from highlight quotes. A post already pushed off the board can still be removed
   * from the store.
   */
  async removeBoard(id: string): Promise<{ ok: boolean; agentId?: string }> {
    const m = /^(b[0-9a-z]+)(?:\.(\d+))?$/.exec(id);
    if (!m) return { ok: false };
    const postId = m[1]!;
    if (m[2] === undefined) {
      const post = removeBoardPost(this.s, postId)?.post;
      const texts = post ? [post.text, ...post.replies.map((r) => r.text)] : [];
      if (post) this.detector.st.rumors.delete(postId);
      this.pending.posts = this.pending.posts.filter((p) => p.id !== postId && p.parentId !== postId);
      const stored = await this.d.store.removeBoardPost({ id: postId });
      for (const t of texts) await this.scrubQuotes(t);
      return { ok: !!post || stored, ...(post ? { agentId: post.by } : {}) };
    }
    const reply = removeBoardPost(this.s, postId, Number(m[2]))?.reply;
    if (!reply) return { ok: false };
    this.pending.posts = this.pending.posts.filter((p) => !(p.parentId === postId && p.agentId === reply.by && p.ts === reply.at));
    await this.d.store.removeBoardPost({ parentId: postId, agentId: reply.by, ts: reply.at });
    await this.scrubQuotes(reply.text);
    return { ok: true, agentId: reply.by };
  }

  /** Deletes a journal entry (`j<event id>`): from the recent entries, the pending writes, the store and quotes. */
  async removeJournal(id: string): Promise<{ ok: boolean; agentId?: string }> {
    if (!/^j\d{1,15}$/.test(id)) return { ok: false };
    let text = '';
    let agentId: string | undefined;
    for (const [agent, list] of this.journals) {
      const i = list.findIndex((j) => j.id === id);
      if (i >= 0) {
        text = list[i]!.text;
        agentId = agent;
        list.splice(i, 1);
        // The next read refills the list from the store, which no longer serves the entry.
        this.journalsLoaded.delete(agent);
      }
    }
    const pending = this.pending.journal.find((j) => j.id === id);
    if (pending) {
      text ||= pending.text;
      agentId ??= pending.agentId;
    }
    this.pending.journal = this.pending.journal.filter((j) => j.id !== id);
    const stored = await this.d.store.removeJournalEntry(id);
    await this.scrubQuotes(text);
    return { ok: stored || !!agentId, ...(agentId ? { agentId } : {}) };
  }

  // ── writes ────────────────────────────────────────────────────────────────────────────────────────────────

  get buffered(): number {
    return batchSize(this.pending);
  }

  flush(): Promise<void> {
    this.busy ??= this.write().finally(() => (this.busy = null));
    return this.busy;
  }

  private async write(): Promise<void> {
    if (!batchSize(this.pending)) return;
    const b = this.pending;
    this.pending = emptyBatch();
    try {
      await this.d.store.appendChronicle(b);
    } catch (err) {
      const now = this.pending;
      this.pending = b;
      for (const k of Object.keys(now) as (keyof ChronicleBatch)[]) (b[k] as unknown[]).push(...(now[k] as unknown[]));
      this.trim();
      this.d.log.error({ err, rows: batchSize(b) }, 'chronicle write failed; will retry');
    }
  }

  /** Samples the online count for the day's peak. */
  sample(now = this.d.now()): void {
    this.onlinePeak = Math.max(this.onlinePeak, this.d.census.online(now));
  }

  start(): void {
    if (this.timers.length) return;
    this.timers.push(
      setInterval(() => void this.flush(), CHRONICLE.flushMs),
      setInterval(() => this.sample(), CHRONICLE.onlineSampleMs),
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.busy;
    await this.flush();
  }
}
