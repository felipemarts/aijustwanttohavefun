import type { Snapshot } from '@ajwf/engine';
import type { AgentStatus, DailyStats, GazetteEdition, Highlight, KeyMsg, TimelineEntry } from '@ajwf/shared';

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

/** What the game keeps in memory about each agent's identity and ownership. */
export type IdentityRow = {
  id: string;
  keyHash: string;
  /** Null once the claim token was used. */
  claimTokenHash: string | null;
  claimedAt: number | null;
  ownerId: string | null;
  ownerNote: string;
  ownerSeenAt: number | null;
  status: AgentStatus;
};

export type LoadedState = {
  identities: IdentityRow[];
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

/** A human owner (§15.1). Only the provider's stable id and display name are kept: never an email or a token. */
export type OwnerRow = {
  id: string;
  provider: string;
  externalId: string;
  name: string;
  language: string;
  createdAt: number;
};
export type NewOwner = Pick<OwnerRow, 'provider' | 'externalId' | 'name' | 'language'>;

/** `id` is the SHA-256 of the session cookie. */
export type SessionRow = { id: string; ownerId: string; expiresAt: number; refreshedAt: number };

export type PushKeys = { p256dh: string; auth: string };
export type PushSubscriptionRow = { id: string; ownerId: string; endpoint: string; keys: PushKeys };

export type ReportRow = { id: string; kind: string; targetId: string; reason: string; details: string; reporterHash: string; ts: number; resolved: boolean };

/** A board post or reply to tombstone: by id (posts) or by thread, author and time (replies, which have no shared id). */
export type BoardRemoval = { id: string } | { parentId: string; agentId: string; ts: number };

/** Owners, sessions, push subscriptions and moderation (M7). */
export interface OwnerStore {
  /** Finds the owner by provider and external id (updating the display name) or creates one. */
  upsertOwner(o: NewOwner, now: number): Promise<OwnerRow>;
  getOwner(id: string): Promise<OwnerRow | null>;
  setOwnerLanguage(id: string, language: string): Promise<void>;
  /**
   * Account deletion, in one transaction: sessions and push subscriptions deleted, the owner's agents retired and
   * unlinked (note cleared), and the owner row anonymized (provider `deleted`, no external id, no name).
   */
  deleteOwner(id: string): Promise<void>;

  createSession(s: SessionRow): Promise<void>;
  getSession(id: string): Promise<SessionRow | null>;
  refreshSession(id: string, expiresAt: number, refreshedAt: number): Promise<void>;
  deleteSession(id: string): Promise<void>;

  /** Binds an unclaimed agent to an owner and burns its claim token. False when the token was already used. */
  claimAgent(agentId: string, ownerId: string, now: number): Promise<boolean>;
  updateKeyHash(agentId: string, keyHash: string): Promise<void>;
  setAgentStatus(agentId: string, status: AgentStatus): Promise<void>;
  setOwnerNote(agentId: string, note: string): Promise<void>;
  setOwnerSeen(agentId: string, ts: number): Promise<void>;
  /** Stored events where the agent is actor or target, of the given types, from `since` on, oldest first. */
  agentEvents(agentId: string, since: number, types: readonly string[], limit: number): Promise<EventRow[]>;

  /** Insert or replace (by endpoint). */
  savePushSubscription(row: PushSubscriptionRow): Promise<void>;
  listPushSubscriptions(ownerId: string): Promise<PushSubscriptionRow[]>;
  /** Removes one subscription by endpoint; with `ownerId`, only if it belongs to that owner. */
  deletePushSubscription(endpoint: string, ownerId?: string): Promise<void>;

  addReport(r: ReportRow): Promise<void>;
  listReports(q: { limit: number; resolved?: boolean }): Promise<ReportRow[]>;
  resolveReport(id: string): Promise<boolean>;
  /** Tombstones a post (blanked, never served again). False when nothing matched. */
  removeBoardPost(r: BoardRemoval): Promise<boolean>;
  removeJournalEntry(id: string): Promise<boolean>;
  /** Drops the quote from stored highlights that quote exactly this text. */
  scrubHighlightQuotes(text: string): Promise<void>;
  addBlockedWords(words: string[], now: number): Promise<void>;
  listBlockedWords(): Promise<string[]>;
}

/** Durable storage of the game. The in-memory world is the source of truth; this only persists it (§3.3). */
export interface Store extends ChronicleReads, OwnerStore {
  readonly kind: 'memory' | 'postgres';
  load(): Promise<LoadedState>;
  /** Inserts the identity row and the first snapshot atomically. */
  insertAgent(rec: AgentRecord, snapshotJson: string, now: number): Promise<void>;
  /** Upserts every entity of the snapshot in one transaction. */
  saveSnapshot(snap: SerializedSnapshot, now: number): Promise<void>;
  appendEvents(rows: EventRow[]): Promise<void>;
  appendChronicle(b: ChronicleBatch): Promise<void>;
  close(): Promise<void>;
}
