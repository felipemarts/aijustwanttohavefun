/** Random bytes. Phone: expo-crypto's `getRandomValues` (React Native has no global `crypto`). */
export type RandomSource = (n: number) => Uint8Array;

export const webRandom: RandomSource = (n) => {
  const c = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) throw new Error('No random source: pass `random` in the ports.');
  return c.getRandomValues(new Uint8Array(n));
};

/**
 * Ids that sort as strings in creation order: fixed-width base-36 time, a counter, and randomness. Log entry ids
 * double as storage keys, so `before=<id>` paging is a key range.
 */
export class Ids {
  private counter = 0;
  private lastMs = -1;
  private readonly random: RandomSource;

  constructor(random: RandomSource) {
    this.random = random;
  }

  private chars(n: number): string {
    return Array.from(this.random(n), (b) => (b % 36).toString(36)).join('');
  }

  sortable(now: number): string {
    const ms = Math.max(0, Math.floor(now));
    // Within one millisecond the counter keeps order; it restarts when time moves on.
    this.counter = ms === this.lastMs ? this.counter + 1 : 0;
    this.lastMs = ms;
    return `${ms.toString(36).padStart(9, '0')}${this.counter.toString(36).padStart(4, '0')}${this.chars(4)}`;
  }

  /** A random opaque id (character ids, idempotency keys). */
  opaque(prefix: string, n = 16): string {
    return `${prefix}${this.chars(n)}`;
  }
}
