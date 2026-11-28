import { describe, expect, it } from 'vitest';
import { BLINK_EVERY, FRAME, crispScale, fitScale, frameAt, frameBox, isDrawableSprite, moodFor, tickMs } from './sprite-math';
import { safeHttpUrl } from './url';

describe('sprite frames', () => {
  it('walks through step, idle, step, idle while playing', () => {
    expect([0, 1, 2, 3, 4].map((t) => frameAt('walk', t, false))).toEqual([FRAME.stepA, FRAME.idle, FRAME.stepB, FRAME.idle, FRAME.stepA]);
  });

  it('stands idle and blinks once per cycle', () => {
    const frames = Array.from({ length: BLINK_EVERY * 2 }, (_, t) => frameAt('idle', t, false));
    expect(frames.filter((f) => f === FRAME.blink)).toHaveLength(2);
    expect(frames.filter((f) => f !== FRAME.blink && f !== FRAME.idle)).toEqual([]);
  });

  it('never animates with reduced motion, nor when fallen', () => {
    for (let t = 0; t < 40; t++) {
      expect(frameAt('walk', t, true)).toBe(FRAME.idle);
      expect(frameAt('still', t, false)).toBe(FRAME.idle);
    }
    expect(tickMs('walk', true)).toBe(0);
    expect(tickMs('still', false)).toBe(0);
    expect(tickMs('idle', false)).toBeGreaterThan(0);
  });

  it('maps statuses to moods', () => {
    expect(moodFor('playing')).toBe('walk');
    expect(moodFor('thinking')).toBe('idle');
    expect(moodFor('resting')).toBe('idle');
    expect(moodFor('fallen')).toBe('still');
  });

  it('shifts the 80x28 sheet by whole frames', () => {
    expect(frameBox(0, 3)).toEqual({ width: 60, height: 84, sheetWidth: 240, offsetX: -0 });
    expect(frameBox(3, 3).offsetX).toBe(-180);
    expect(frameBox(9, 2).offsetX).toBe(-120); // clamped to the last frame
    expect(frameBox(-1, 2).offsetX).toBe(-0);
  });
});

describe('crisp scaling', () => {
  it('scales by a whole number of device pixels', () => {
    expect(crispScale(3, 1)).toEqual({ device: 3, css: 3 });
    expect(crispScale(3, 2)).toEqual({ device: 6, css: 3 });
    // 3 CSS px on a 1.5x screen would be 4.5 device px: round to 5 device px.
    const c = crispScale(3, 1.5);
    expect(Number.isInteger(c.device)).toBe(true);
    expect(c.device).toBe(5);
    expect(c.css * 1.5).toBeCloseTo(5);
    expect(crispScale(0, 0)).toEqual({ device: 1, css: 1 });
  });

  it('fits a frame in a box with an integer scale', () => {
    expect(fitScale(60, 84)).toBe(3);
    expect(fitScale(79, 200)).toBe(3);
    expect(fitScale(10, 10)).toBe(1);
  });
});

describe('what may be drawn or opened', () => {
  it('draws http(s) sprites and inline PNGs only', () => {
    expect(isDrawableSprite('https://game.example/s/abc.png')).toBe(true);
    expect(isDrawableSprite('data:image/png;base64,AAAA')).toBe(true);
    expect(isDrawableSprite('data:image/svg+xml;base64,AAAA')).toBe(false);
    expect(isDrawableSprite('javascript:alert(1)')).toBe(false);
    expect(isDrawableSprite(null)).toBe(false);
  });

  it('opens absolute http(s) URLs only', () => {
    expect(safeHttpUrl('https://game.example/claim/abc')).toBe('https://game.example/claim/abc');
    expect(safeHttpUrl('http://127.0.0.1:8710/agents/Pip')).toBe('http://127.0.0.1:8710/agents/Pip');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,hi')).toBeNull();
    expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
    expect(safeHttpUrl('//evil.example')).toBeNull();
    expect(safeHttpUrl('https://user:pass@evil.example')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
  });
});
