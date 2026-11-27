/**
 * The broadcast delay of director mode: every spectator message waits here before the store sees it, so the screen
 * shows the world as it was a while ago while the scout (fed undelayed) looks ahead. Pure: the caller passes the
 * clock, and decides when to start, release and flush.
 *
 * The lag builds up gradually from the start instead of freezing the picture: a message that arrives `a` ms after
 * the start is held `min(maxMs, a × ramp)`. Hold times never decrease with arrival time, so release order is arrival
 * order. With a steady stream the newest message on screen is `min(maxMs, elapsed × ramp / (1 + ramp))` old: with
 * the defaults, the lag reaches 30 s a minute and a half after the start (the message that arrived at one minute).
 */
export const BROADCAST_DELAY = {
  maxMs: 30_000,
  ramp: 0.5,
};

type Held<T> = { item: T; at: number };

export class DelayLine<T> {
  private queue: Held<T>[] = [];
  private head = 0;
  private startedAt: number | null = null;

  constructor(
    readonly maxMs = BROADCAST_DELAY.maxMs,
    readonly ramp = BROADCAST_DELAY.ramp,
  ) {}

  get active(): boolean {
    return this.startedAt !== null;
  }

  /** Messages waiting. */
  get size(): number {
    return this.queue.length - this.head;
  }

  /** Starts delaying from `now` with no lag yet (does nothing when already active). */
  start(now: number): void {
    if (this.startedAt === null) this.startedAt = now;
  }

  /** Stops delaying and returns everything held, oldest first, to apply at once. */
  stop(): T[] {
    this.startedAt = null;
    return this.drain();
  }

  /** Returns everything held and starts building the lag again from `now` (reconnects, a tab coming back). */
  restart(now: number): T[] {
    const out = this.drain();
    this.startedAt = now;
    return out;
  }

  /** A message arrives: held when active; returned at once (to apply now) when not. */
  push(item: T, now: number): T[] {
    if (this.startedAt === null) return [item];
    const hold = Math.min(this.maxMs, Math.max(0, now - this.startedAt) * this.ramp);
    if (hold <= 0 && this.size === 0) return [item];
    this.queue.push({ item, at: now + hold });
    return [];
  }

  /** Messages due by `now`, oldest first. */
  release(now: number): T[] {
    const out: T[] = [];
    while (this.head < this.queue.length && this.queue[this.head]!.at <= now) out.push(this.queue[this.head++]!.item);
    this.compact();
    return out;
  }

  /** How far behind real time the screen is (ms), for the display clock. */
  lag(now: number): number {
    if (this.startedAt === null) return 0;
    return Math.min(this.maxMs, (Math.max(0, now - this.startedAt) * this.ramp) / (1 + this.ramp));
  }

  private drain(): T[] {
    const out = this.queue.slice(this.head).map((h) => h.item);
    this.queue = [];
    this.head = 0;
    return out;
  }

  private compact(): void {
    if (this.head > 256 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
  }
}
