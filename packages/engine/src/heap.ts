import type { Timer } from './types';

/** The snapshot key of the heap: the whole heap is saved as this one entry. */
export const TIMERS_KEY = 'timers';

/**
 * Binary min-heap of timers ordered by `at`. No per-tick scan of the world: only due timers are touched.
 *
 * Persistence: the heap is saved whole, as the single `timers` snapshot entry (the ops benchmark measured about 167 KB
 * for the 4,400 timers of a 10,000-agent world; trade-expiry timers are nearly all of them, see TODO.md). So that it is
 * written only when its content changed, the heap itself marks `timers` in the world's dirty set on every push and
 * pop, and nothing else does: a snapshot taken while no timer was pushed or popped since the previous one leaves the
 * entry out.
 */
export class TimerHeap {
  private items: Timer[] = [];

  /** `dirty`: the world's dirty set, marked on every change of content. */
  constructor(
    initial?: Timer[],
    private readonly dirty?: Set<string>,
  ) {
    if (initial) for (const t of initial) this.push(t);
  }

  /** Replaces the whole content (a restore, or a rescheduled timer), keeping the same heap and dirty set. */
  replace(timers: Timer[]): void {
    this.items = [];
    for (const t of timers) this.push(t);
    this.dirty?.add(TIMERS_KEY);
  }

  get size(): number {
    return this.items.length;
  }

  push(t: Timer): void {
    const a = this.items;
    a.push(t);
    this.dirty?.add(TIMERS_KEY);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.at <= a[i]!.at) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }

  peek(): Timer | undefined {
    return this.items[0];
  }

  pop(): Timer | undefined {
    const a = this.items;
    const top = a[0];
    if (!top) return undefined;
    this.dirty?.add(TIMERS_KEY);
    const last = a.pop();
    if (a.length && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.at < a[m]!.at) m = l;
        if (r < a.length && a[r]!.at < a[m]!.at) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }

  /** Pops the next timer if it is due at `now`. */
  popDue(now: number): Timer | undefined {
    const top = this.items[0];
    return top && top.at <= now ? this.pop() : undefined;
  }

  toJSON(): Timer[] {
    return [...this.items];
  }
}
