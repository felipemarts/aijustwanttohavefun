/** Scale and tick helpers for the small SVG charts (no chart library). Pure. */

export type Scale = ((v: number) => number) & { domain: [number, number]; range: [number, number] };

/** Linear map from `domain` to `range`; a flat domain maps everything to the middle of the range. */
export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const f = ((v: number) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0))) as Scale;
  f.domain = [d0, d1];
  f.range = [r0, r1];
  return f;
}

/** A "nice" step (1, 2, 2.5 or 5 times a power of ten) close to span / count. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !(count > 0)) return 1;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * pow;
}

/**
 * Ticks covering [min, max] with nice round values; the returned domain is extended to the outer ticks so the line
 * never touches the frame. Integers stay integers when the data are integers (people, buildings).
 */
export function niceTicks(min: number, max: number, count = 4, integer = false): { ticks: number[]; domain: [number, number] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [0, 1], domain: [0, 1] };
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.5;
    min = min >= 0 ? Math.max(0, min - pad) : min - pad;
    max = max + pad;
  }
  let step = niceStep(max - min, count);
  if (integer) step = Math.max(1, Math.ceil(step));
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo, i = 0; v <= hi + step * 1e-9 && i < 50; v += step, i++) ticks.push(Math.round(v * 1e9) / 1e9);
  return { ticks, domain: [lo, hi] };
}

/** Min and max of a list (0..0 when empty). */
export function extent(values: readonly number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo === Infinity ? [0, 0] : [lo, hi];
}

/** At most `max` evenly spaced indices of a series of length n, always including the first and the last. */
export function indexTicks(n: number, max: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const m = Math.max(2, Math.min(max, n));
  const out: number[] = [];
  for (let i = 0; i < m; i++) out.push(Math.round((i * (n - 1)) / (m - 1)));
  return [...new Set(out)];
}

/** SVG path for a polyline, rounded to half pixels. */
export function linePath(points: readonly { x: number; y: number }[]): string {
  return points
    .map((p, i) => `${i ? 'L' : 'M'}${Math.round(p.x * 2) / 2} ${Math.round(p.y * 2) / 2}`)
    .join(' ');
}

/** Stepped (pixel-style) path: horizontal then vertical between points. */
export function stepPath(points: readonly { x: number; y: number }[]): string {
  if (!points.length) return '';
  let d = `M${Math.round(points[0]!.x)} ${Math.round(points[0]!.y)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const mid = Math.round((points[i - 1]!.x + p.x) / 2);
    d += ` H${mid} V${Math.round(p.y)} H${Math.round(p.x)}`;
  }
  return d;
}
