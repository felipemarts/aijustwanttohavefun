/** Waits that end early when the run stops (SIGINT, duration over). */
export class Stopper {
  private stopped = false;
  private wake: (() => void)[] = [];

  get isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const w of this.wake.splice(0)) w();
  }

  sleep = (ms: number): Promise<void> => {
    if (this.stopped || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = this.wake.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake.push(done);
    });
  };
}

type Clock = () => number;
type Sleep = (ms: number) => Promise<void>;

/** Hands out evenly spaced slots: `perSec` callers per second in total, no bursts. */
export class RatePacer {
  private next = 0;
  private readonly interval: number;

  constructor(
    perSec: number,
    private readonly sleep: Sleep,
    private readonly now: Clock = Date.now,
  ) {
    this.interval = 1000 / perSec;
  }

  async take(): Promise<void> {
    const t = this.now();
    const at = Math.max(t, this.next);
    this.next = at + this.interval;
    await this.sleep(at - t);
  }
}

/**
 * Client-side token bucket that stays under the server's per-key limit (60 requests per minute, refilled
 * continuously): a smaller burst and a slower refill, so the server's bucket never runs dry.
 */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly capacity: number,
    private readonly perMinute: number,
    private readonly sleep: Sleep,
    private readonly now: Clock = Date.now,
    private readonly stopped: () => boolean = () => false,
  ) {
    this.tokens = capacity;
    this.at = now();
  }

  async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.tokens = Math.min(this.capacity, this.tokens + ((t - this.at) * this.perMinute) / 60_000);
      this.at = t;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute));
      if (this.stopped()) return;
    }
  }
}

/** Percentile of a list of numbers (nearest rank), or 0 when empty. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}
