/**
 * The core's own timing. Pacing (session turns, gaps, polls, AP, turn gap, cooldown) comes from the playkit
 * (`playkit.json`), so both cores play at the same rhythm; these are only what the playkit leaves to the core.
 */
export type Tuning = {
  /** Longest wait after repeated failures (server down). */
  maxBackoff: number;
  /** `/me` is re-read for the detail view when older than this. */
  detailTtl: number;
  /** An unanswered `/act` older than this is not repeated after a restart (the server keeps keys 10 minutes). */
  pendingActTtl: number;
  /** The action schema is revalidated with its ETag at most this often (README 3.1). */
  schemaTtl: number;
  /** A refused key is tried again after this long. */
  keyRetry: number;
  /** An engine that failed is tried again after this long. */
  engineRetry: number;
};

export const DEFAULT_TUNING: Tuning = {
  maxBackoff: 10 * 60_000,
  detailTtl: 30_000,
  pendingActTtl: 9 * 60_000,
  schemaTtl: 10 * 60_000,
  keyRetry: 10 * 60_000,
  engineRetry: 15_000,
};
