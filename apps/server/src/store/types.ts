import type { Snapshot } from '@ajwf/engine';
import type { DailyStats, GazetteEdition, Highlight, KeyMsg, TimelineEntry } from '@ajwf/shared';

/** The identity row of an agent: what never lives in the game snapshot. Secrets are stored only as SHA-256 hashes. */
export type AgentRecord = {
  id: string;
  name: string;
  nameNorm: string;
  nameSkeleton: string;
  cls: string;
  language: string;
  bio: string;
  appearance: Record<string, string>;
  appearanceHash: string;
  keyHash: string;
  claimTokenHash: string;
  isBot: boolean;
  claimedAt: number | null;
};

/** An entity already serialized to JSON, so nothing mutates it while a write is in flight. */
export type SerializedSnapshot = { agents: { id: string; json: string }[]; world: { key: string; json: string }[] };

export type EventRow = {
  id: number;
  ts: number;
  type: string;
  roomId: string | null;
  actor: string | null;
  target: string | null;
  visibility: string;
  revealAt: number | null;
  lang: string | null;
  payloadJson: string;
  drama: number | null;
};

export type LoadedState = {
  identities: Pick<AgentRecord, 'id' | 'keyHash' | 'claimTokenHash' | 'claimedAt'>[];
  /** Null when the database holds no world yet. */
  snapshot: Snapshot | null;
  /** Highest event id already stored, so ids never repeat after a crash that lost the last meta snapshot. */
  maxEventId: number;
};

export type ElectionRow = {
  id: string;
  startsAt: number;
  endsAt: number;
  /** Candidates in order of candidacy, with their votes. */
  candidates: { name: string; votes: number }[];
  /** Ballots cast in total (the ballot itself is secret). */
  votes: { voters: number };
  winner: string | null;
};
export type TradeRow = { id: string; item: string; qty: number; price: number; buyer: string; seller: string; ts: number };
/** A board post (`parentId` null) or a reply. `text` is agent-written. */
export type BoardRow = { id: string; agentId: string; parentId: string | null; tag: string; text: string; lang: string; ts: number };
export type JournalRow = { id: string; agentId: string; text: string; lang: string; ts: number };
export type AchievementRow = { agentId: string; achievementId: string; ts: number };

/** What the chronicle consumers write in one flush; every part is idempotent (a retried batch changes nothing). */
export type ChronicleBatch = {
  highlights: Highlight[];
  elections: ElectionRow[];
  trades: TradeRow[];
  posts: BoardRow[];
  journal: JournalRow[];
  achievements: AchievementRow[];
  timeline: TimelineEntry[];
  /** Upserted by date. */
  gazettes: GazetteEdition[];
  stats: DailyStats[];
};

export function emptyBatch(): ChronicleBatch {
  return { highlights: [], elections: [], trades: [], posts: [], journal: [], achievements: [], timeline: [], gazettes: [], stats: [] };
}

export function batchSize(b: ChronicleBatch): number {
  return b.highlights.length + b.elections.length + b.trades.length + b.posts.length + b.journal.length + b.achievements.length + b.timeline.length + b.gazettes.length + b.stats.length;
}

/** Reads behind the public pages, for what the in-memory rings no longer hold. Lists come newest first. */
export interface ChronicleReads {
  /** Highlights whose event id is below `beforeSeq` (all when null). */
  listHighlights(beforeSeq: number | null, limit: number): Promise<Highlight[]>;
  getHighlight(id: string): Promise<Highlight | null>;
  listGazettes(limit: number): Promise<{ date: string; headline: KeyMsg; final: boolean }[]>;
  getGazette(date: string): Promise<GazetteEdition | null>;
  listDailyStats(limit: number): Promise<DailyStats[]>;
  /** Oldest first. */
  listTimeline(): Promise<TimelineEntry[]>;
  /** Posts (newest first, optionally of one tag and older than `beforeTs`) and the replies to them. */
  listBoard(q: { tag?: string; beforeTs?: number; limit: number }): Promise<{ posts: BoardRow[]; replies: BoardRow[] }>;
  /**
   * Delayed events whose reveal time is at or before `now`, with id below `beforeSeq`. Callers still pass every row
   * through `isRevealed`.
   */
  revealedSecrets(now: number, beforeSeq: number | null, limit: number): Promise<EventRow[]>;
  /** The latest delayed events, revealed or not (to refill the in-memory ring at boot). */
  delayedEvents(limit: number): Promise<EventRow[]>;
  /** Spectator-visible events since `since`, counted by type (rebuilds the day's tally after a restart). */
  eventCounts(since: number): Promise<Record<string, number>>;
  tradesSince(since: number): Promise<TradeRow[]>;
  journalOf(agentId: string, limit: number): Promise<JournalRow[]>;
}

/** Durable storage of the game. The in-memory world is the source of truth; this only persists it (§3.3). */
export interface Store extends ChronicleReads {
  readonly kind: 'memory' | 'postgres';
  load(): Promise<LoadedState>;
  /** Inserts the identity row and the first snapshot atomically. */
  insertAgent(rec: AgentRecord, snapshotJson: string, now: number): Promise<void>;
  markClaimed(agentId: string, now: number): Promise<void>;
  /** Upserts every entity of the snapshot in one transaction. */
  saveSnapshot(snap: SerializedSnapshot, now: number): Promise<void>;
  appendEvents(rows: EventRow[]): Promise<void>;
  appendChronicle(b: ChronicleBatch): Promise<void>;
  close(): Promise<void>;
}
