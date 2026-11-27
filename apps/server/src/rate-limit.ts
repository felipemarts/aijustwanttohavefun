type Bucket = { tokens: number; at: number };

export type Take = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * In-memory token buckets (PLANEJAMENTO §13.1): `capacity` requests per `windowMs`, refilled continuously.
 * Buckets that refilled completely carry no information and are swept, and the map never exceeds `maxKeys`.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private ops = 0;
  private readonly perMs: number;

  constructor(
    readonly capacity: number,
    readonly windowMs: number,
    private readonly maxKeys = 100_000,
  ) {
    this.perMs = capacity / windowMs;
  }

  take(key: string, now: number): Take {
    if (++this.ops % 1000 === 0 || this.buckets.size >= this.maxKeys) this.sweep(now);
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + Math.max(0, now - b.at) * this.perMs);
    b.at = now;
    // Re-insert so the map stays ordered by last use and the eviction below drops the idlest key.
    this.buckets.delete(key);
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / this.perMs / 1000)) };
  }

  sweep(now: number): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.at) * this.perMs >= this.capacity) this.buckets.delete(key);
    }
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

const MIN = 60_000;

/** Limits of §11.6 and §15.2. */
export function createLimiters() {
  return {
    /** Per API key, across the whole API. */
    agent: new RateLimiter(60, MIN),
    /** Per IP. */
    register: new RateLimiter(5, 60 * MIN),
    options: new RateLimiter(30, MIN),
    /** Per IP, on every route that is not authenticated with a valid key (including failed authentication). */
    anonymous: new RateLimiter(120, MIN),
    /** Per IP, for the spectator read API (`/api/public`): page loads, room and agent cards, polling stats. */
    publicRead: new RateLimiter(240, MIN),
    /** Per IP, for sprites and docs: a spectator page loads one sprite per visible agent. */
    files: new RateLimiter(1200, MIN),
    /** Per IP, for everything under /api/owner (the dashboard polls little). */
    owner: new RateLimiter(120, MIN),
    /** Per IP, for both claim routes: strict, so claim tokens cannot be probed in bulk. */
    claim: new RateLimiter(20, 60 * MIN),
    /** Per IP, OAuth starts, callbacks and the dev login. */
    login: new RateLimiter(20, 10 * MIN),
    /** Per IP, public content reports. */
    report: new RateLimiter(10, 60 * MIN),
    /** Per IP, share cards (each new one is composed on the CPU). */
    og: new RateLimiter(120, MIN),
  };
}
export type Limiters = ReturnType<typeof createLimiters>;
