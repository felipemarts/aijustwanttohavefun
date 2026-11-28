/**
 * Sprite sheet maths. A sheet is 80x28: four 20x28 frames, in order idle, step, step, blink. Pure, so it is tested.
 */
import type { CharacterStatus } from '../core/types';

export const FRAME_W = 20;
export const FRAME_H = 28;
export const FRAMES = 4;
export const FRAME = { idle: 0, stepA: 1, stepB: 2, blink: 3 } as const;

export type Mood = 'walk' | 'idle' | 'still';

export function moodFor(status: CharacterStatus): Mood {
  if (status === 'playing') return 'walk';
  if (status === 'fallen') return 'still';
  return 'idle';
}

/** Milliseconds per animation tick for a mood (0: no animation). */
export function tickMs(mood: Mood, reducedMotion: boolean): number {
  if (reducedMotion || mood === 'still') return 0;
  return mood === 'walk' ? 220 : 200;
}

const WALK = [FRAME.stepA, FRAME.idle, FRAME.stepB, FRAME.idle] as const;
export const BLINK_EVERY = 18;

/** The frame to show at animation tick `tick`. Walking cycles the two steps; idle blinks now and then. */
export function frameAt(mood: Mood, tick: number, reducedMotion: boolean): number {
  if (reducedMotion || mood === 'still') return FRAME.idle;
  const t = Math.max(0, Math.floor(tick));
  if (mood === 'walk') return WALK[t % WALK.length]!;
  return t % BLINK_EVERY === BLINK_EVERY - 1 ? FRAME.blink : FRAME.idle;
}

/**
 * Whole-number scaling in device pixels. `target` is the wished size of one sprite pixel in CSS/density-independent
 * pixels; the result scales by an integer number of DEVICE pixels, so every sprite pixel has the same size on screen
 * (on a 1.5x display, 3 CSS px would be 4.5 device px and the pixels would come out uneven).
 */
export function crispScale(target: number, pixelRatio: number): { device: number; css: number } {
  const ratio = pixelRatio > 0 && Number.isFinite(pixelRatio) ? pixelRatio : 1;
  const device = Math.max(1, Math.round(Math.max(1, target) * ratio));
  return { device, css: device / ratio };
}

/** Largest whole-number scale (in CSS px per sprite px) for which one frame fits in a box. */
export function fitScale(maxWidth: number, maxHeight: number): number {
  return Math.max(1, Math.floor(Math.min(maxWidth / FRAME_W, maxHeight / FRAME_H)));
}

/** Geometry to show one frame: the sheet drawn at `scale`, shifted left by whole frames. */
export function frameBox(frame: number, scale: number): { width: number; height: number; sheetWidth: number; offsetX: number } {
  const f = Math.min(FRAMES - 1, Math.max(0, Math.floor(frame)));
  return { width: FRAME_W * scale, height: FRAME_H * scale, sheetWidth: FRAME_W * FRAMES * scale, offsetX: -f * FRAME_W * scale };
}

/** Sprites come from the game server (http/https) or, in the mock, as inline PNGs. Anything else is not drawn. */
export function isDrawableSprite(uri: string | null | undefined): uri is string {
  if (!uri) return false;
  if (uri.startsWith('data:image/png;base64,')) return true;
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
