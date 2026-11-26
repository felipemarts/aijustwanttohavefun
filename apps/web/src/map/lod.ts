/** Level-of-detail decisions. `scale` is CSS pixels per world pixel (the camera zoom). Pure. */

export type Lod = 'dot' | 'sprite' | 'full';

/** Far out agents are coloured dots; mid zoom shows sprites without labels; close up shows everything. */
export function lodFor(scale: number): Lod {
  if (scale < 0.75) return 'dot';
  if (scale < 1.4) return 'sprite';
  return 'full';
}

export const LABEL_CAP = 48;
export const BUBBLE_CAP = 10;

export type LabelCandidate = { name: string; x: number; y: number; priority: number };

/**
 * Which agents get a name label: highest priority first (followed, selected, talking, fighting), then the ones
 * nearest the centre of the screen, capped so labels stay readable and cheap.
 */
export function pickLabels(cands: LabelCandidate[], cx: number, cy: number, cap = LABEL_CAP): Set<string> {
  if (cands.length <= cap) return new Set(cands.map((c) => c.name));
  const scored = cands.map((c) => ({
    name: c.name,
    s: c.priority * 1e9 - ((c.x - cx) ** 2 + (c.y - cy) ** 2),
  }));
  scored.sort((a, b) => b.s - a.s);
  return new Set(scored.slice(0, cap).map((c) => c.name));
}

/** Zoom steps in CSS scale. Integer device-pixel multiples above 1 keep pixels crisp with nearest scaling. */
export function zoomSteps(dpr: number): number[] {
  const device = [0.5, 0.75, 1, 2, 3, 4, 5, 6, 8];
  const d = dpr > 0 ? dpr : 1;
  const out = device.map((s) => s / d).filter((s) => s >= 0.2 && s <= 6.5);
  return [...new Set(out)].sort((a, b) => a - b);
}

export function nearestStep(steps: number[], scale: number): number {
  let best = steps[0] ?? 1;
  for (const s of steps) if (Math.abs(Math.log(s / scale)) < Math.abs(Math.log(best / scale))) best = s;
  return best;
}

export function stepFrom(steps: number[], scale: number, dir: 1 | -1): number {
  const cur = nearestStep(steps, scale);
  const i = steps.indexOf(cur);
  return steps[Math.max(0, Math.min(steps.length - 1, i + dir))] ?? cur;
}
