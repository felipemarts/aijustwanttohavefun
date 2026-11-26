import type { Snapshot } from '@ajwf/engine';

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

/** Durable storage of the game. The in-memory world is the source of truth; this only persists it (§3.3). */
export interface Store {
  readonly kind: 'memory' | 'postgres';
  load(): Promise<LoadedState>;
  /** Inserts the identity row and the first snapshot atomically. */
  insertAgent(rec: AgentRecord, snapshotJson: string, now: number): Promise<void>;
  markClaimed(agentId: string, now: number): Promise<void>;
  /** Upserts every entity of the snapshot in one transaction. */
  saveSnapshot(snap: SerializedSnapshot, now: number): Promise<void>;
  appendEvents(rows: EventRow[]): Promise<void>;
  close(): Promise<void>;
}
