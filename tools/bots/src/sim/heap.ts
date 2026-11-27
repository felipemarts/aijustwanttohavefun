/** Min-heap of wake-ups ordered by time, then by insertion order (so equal times stay deterministic). */
export class WakeHeap {
  private t: number[] = [];
  private i: number[] = [];
  private q: number[] = [];
  private seq = 0;

  get size(): number {
    return this.t.length;
  }

  push(time: number, bot: number): void {
    this.t.push(time);
    this.i.push(bot);
    this.q.push(this.seq++);
    let k = this.t.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!this.less(k, p)) break;
      this.swap(k, p);
      k = p;
    }
  }

  peekTime(): number {
    return this.t[0] ?? Infinity;
  }

  pop(): { time: number; bot: number } | null {
    if (!this.t.length) return null;
    const out = { time: this.t[0]!, bot: this.i[0]! };
    const last = this.t.length - 1;
    this.swap(0, last);
    this.t.pop();
    this.i.pop();
    this.q.pop();
    let k = 0;
    for (;;) {
      const l = 2 * k + 1;
      const r = l + 1;
      let m = k;
      if (l < this.t.length && this.less(l, m)) m = l;
      if (r < this.t.length && this.less(r, m)) m = r;
      if (m === k) break;
      this.swap(k, m);
      k = m;
    }
    return out;
  }

  private less(a: number, b: number): boolean {
    return this.t[a]! < this.t[b]! || (this.t[a] === this.t[b] && this.q[a]! < this.q[b]!);
  }

  private swap(a: number, b: number): void {
    [this.t[a], this.t[b]] = [this.t[b]!, this.t[a]!];
    [this.i[a], this.i[b]] = [this.i[b]!, this.i[a]!];
    [this.q[a], this.q[b]] = [this.q[b]!, this.q[a]!];
  }
}
