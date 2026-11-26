import type { Timer } from './types';

/** Binary min-heap of timers ordered by `at`. No per-tick scan of the world: only due timers are touched. */
export class TimerHeap {
  private items: Timer[] = [];

  constructor(initial?: Timer[]) {
    if (initial) for (const t of initial) this.push(t);
  }

  get size(): number {
    return this.items.length;
  }

  push(t: Timer): void {
    const a = this.items;
    a.push(t);
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
