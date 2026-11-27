import { isIPv6 } from 'node:net';

type Bucket = { tokens: number; at: number };

/**
 * The key of a client address for per-IP limits: IPv4 as is (IPv4-mapped IPv6 folded to IPv4), IPv6 by its /64.
 * One IPv6 customer usually holds a whole /64 (often far more), so limiting single /128 addresses limits nothing.
 */
export function ipKey(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const lower = ip.toLowerCase().replace(/%.*$/, '');
  const mapped = /^(?:0{0,4}:){0,5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower.replace(/^::/, ''));
  if (mapped) return mapped[1]!;
  const [head = '', tail = ''] = lower.split('::');
  const h = head ? head.split(':') : [];
  const t = lower.includes('::') ? (tail ? tail.split(':') : []) : [];
  // An embedded IPv4 tail ("64:ff9b::1.2.3.4") counts as two groups; only the first four groups matter here.
  const groups = lower.includes('::') ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

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
    /** Keys are client addresses: IPv6 ones are limited by their /64 (see `ipKey`). */
    private readonly byIp = false,
  ) {
    this.perMs = capacity / windowMs;
  }

  take(rawKey: string, now: number): Take {
    const key = this.byIp ? ipKey(rawKey) : rawKey;
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
  const ip = (capacity: number, windowMs: number) => new RateLimiter(capacity, windowMs, undefined, true);
  return {
    /** Per API key, across the whole API. */
    agent: new RateLimiter(60, MIN),
    /** Per IP. */
    register: ip(5, 60 * MIN),
    options: ip(30, MIN),
    /** Per IP, on every route that is not authenticated with a valid key (including failed authentication). */
    anonymous: ip(120, MIN),
    /** Per IP, for the spectator read API (`/api/public`): page loads, room and agent cards, polling stats. */
    publicRead: ip(240, MIN),
    /** Per IP, for sprites and docs: a spectator page loads one sprite per visible agent. */
    files: ip(1200, MIN),
    /** Per IP, for everything under /api/owner (the dashboard polls little). */
    owner: ip(120, MIN),
    /** Per IP, for both claim routes: strict, so claim tokens cannot be probed in bulk. */
    claim: ip(20, 60 * MIN),
    /** Per IP, OAuth starts, callbacks and the dev login. */
    login: ip(20, 10 * MIN),
    /** Per IP, public content reports. */
    report: ip(10, 60 * MIN),
    /** Per IP, share cards (each new one is composed on the CPU). */
    og: ip(120, MIN),
    /**
     * Per IP, `/mcp` messages other than tool calls with a valid key (initialize, tools/list, ping, unauthenticated
     * calls). Tool calls themselves go through the API and its limits (`agent`, `anonymous`, `register`).
     */
    mcp: ip(120, MIN),
  };
}
export type Limiters = ReturnType<typeof createLimiters>;
