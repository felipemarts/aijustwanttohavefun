/**
 * Progress of the built-in model's integrity check on a phone (hashing 1.1 GB takes a while). The files adapter feeds
 * it directly, in the same process; the contract has no field for it yet (see the report). Never set on the web.
 */
export type VerifyProgress = { name: string; bytesDone: number; bytesTotal: number } | null;

let current: VerifyProgress = null;
const listeners = new Set<() => void>();

export const verifyProgress = {
  get: (): VerifyProgress => current,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** Called by the files adapter; a finished check (done === total) clears the indicator. */
  report(name: string, bytesDone: number, bytesTotal: number): void {
    const next = bytesDone >= bytesTotal ? null : { name, bytesDone, bytesTotal };
    if (next === null && current === null) return;
    current = next;
    for (const l of listeners) l();
  },
};
