/** Fixed-capacity buffer keeping the latest items; the oldest is dropped when full. */
export class Ring<T> {
  private buf: T[] = [];
  private head = 0;
  /** True once an item was dropped: older items exist only in the store. */
  overflowed = false;

  constructor(readonly max: number) {}

  push(x: T): void {
    if (this.buf.length < this.max) this.buf.push(x);
    else {
      this.buf[this.head] = x;
      this.head = (this.head + 1) % this.max;
      this.overflowed = true;
    }
  }

  get size(): number {
    return this.buf.length;
  }

  /** Oldest first. */
  values(): T[] {
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }

  /** Newest first, at most `limit` matching items. */
  newest(limit: number, keep: (x: T) => boolean = () => true): T[] {
    const out: T[] = [];
    const n = this.buf.length;
    for (let i = 1; i <= n && out.length < limit; i++) {
      const x = this.buf[(this.head - i + n) % n]!;
      if (keep(x)) out.push(x);
    }
    return out;
  }
}
