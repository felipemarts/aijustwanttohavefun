/**
 * Day and night colour grade. The server owns the clock (`day.phase`, `day.t`); between updates the client
 * advances `t` locally. The phase boundaries mirror the engine's (`BALANCE.day`), used here only for rendering.
 */
import type { DayPhase } from '@ajwf/shared';

export const PHASE_START: Record<DayPhase, number> = { dawn: 0, day: 0.06, dusk: 0.64, night: 0.7 };

export function phaseOf(t: number): DayPhase {
  if (t >= PHASE_START.night) return 'night';
  if (t >= PHASE_START.dusk) return 'dusk';
  if (t >= PHASE_START.day) return 'day';
  return 'dawn';
}

/** A representative `t` for a phase (used by the `?phase=` debug override). */
export function phaseMid(p: DayPhase): number {
  return { dawn: 0.03, day: 0.35, dusk: 0.67, night: 0.85 }[p];
}

type Key = { t: number; grade: number; glow: number };

// Multiply colour over the map and the strength of the warm night lights.
const KEYS: Key[] = [
  { t: 0.0, grade: 0x6c6fae, glow: 0.85 },
  { t: 0.03, grade: 0xd9a7b4, glow: 0.45 },
  { t: 0.06, grade: 0xffe9d2, glow: 0.05 },
  { t: 0.16, grade: 0xfff7ea, glow: 0 },
  { t: 0.52, grade: 0xfff4e2, glow: 0 },
  { t: 0.62, grade: 0xffdcae, glow: 0.05 },
  { t: 0.67, grade: 0xdc9c8c, glow: 0.45 },
  { t: 0.7, grade: 0x8379b4, glow: 0.85 },
  { t: 0.85, grade: 0x5c63a6, glow: 1 },
  { t: 1.0, grade: 0x6c6fae, glow: 0.85 },
];

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

function mixRgb(a: number, b: number, f: number): number {
  const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, f));
  const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, f));
  const bl = Math.round(lerp(a & 255, b & 255, f));
  return (r << 16) | (g << 8) | bl;
}

export function gradeAt(t: number): { grade: number; glow: number } {
  const x = ((t % 1) + 1) % 1;
  for (let i = 0; i < KEYS.length - 1; i++) {
    const a = KEYS[i]!;
    const b = KEYS[i + 1]!;
    if (x >= a.t && x <= b.t) {
      const f = (x - a.t) / (b.t - a.t || 1);
      return { grade: mixRgb(a.grade, b.grade, f), glow: lerp(a.glow, b.glow, f) };
    }
  }
  return { grade: 0xffffff, glow: 0 };
}
