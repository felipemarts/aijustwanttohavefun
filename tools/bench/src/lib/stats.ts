/** Small statistics helpers shared by the scenarios. */

/** Nearest-rank percentile of an already sorted array (0 when empty). */
export function pct(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (!n) return 0;
  return sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))]!;
}

/** p50, p90, p99, p99.9, max and mean of a list of samples (any order). */
export function summarize(samples: ArrayLike<number>, digits = 3): { n: number; mean: number; p50: number; p90: number; p99: number; p999: number; max: number } {
  const sorted = Float64Array.from(samples).sort();
  let sum = 0;
  for (const v of sorted) sum += v;
  const r = (v: number) => round(v, digits);
  return {
    n: sorted.length,
    mean: r(sorted.length ? sum / sorted.length : 0),
    p50: r(pct(sorted, 50)),
    p90: r(pct(sorted, 90)),
    p99: r(pct(sorted, 99)),
    p999: r(pct(sorted, 99.9)),
    max: r(sorted.length ? sorted[sorted.length - 1]! : 0),
  };
}

export function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Growable Float64Array: samples without boxing millions of numbers in a JS array (the GC is being measured). */
export class Samples {
  private buf: Float64Array;
  length = 0;

  constructor(capacity = 1 << 16) {
    this.buf = new Float64Array(capacity);
  }

  push(v: number): void {
    if (this.length === this.buf.length) {
      const next = new Float64Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = v;
  }

  view(): Float64Array {
    return this.buf.subarray(0, this.length);
  }
}

/** Coefficient of variation (stddev / mean) of repeated measurements. */
export function cv(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return mean ? Math.sqrt(variance) / mean : 0;
}

export const mb = (bytes: number) => round(bytes / 1024 / 1024, 1);
