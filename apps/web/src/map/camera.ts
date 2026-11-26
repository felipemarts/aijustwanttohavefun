/** Camera: centre and zoom in world pixels, eased moves, inertia, clamping to the world. */
import type { Rect } from './geometry';
import { nearestStep, stepFrom, zoomSteps } from './lod';

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

type Tween = {
  from: { x: number; y: number; s: number };
  to: { x: number; y: number; s: number };
  t0: number;
  dur: number;
};

export class Camera {
  x = 0;
  y = 0;
  scale = 2;
  viewW = 800;
  viewH = 600;
  bounds: Rect = { x: 0, y: 0, w: 1000, h: 1000 };
  steps: number[];
  private tween: Tween | null = null;
  private vx = 0;
  private vy = 0;

  constructor(dpr: number) {
    this.steps = zoomSteps(dpr);
  }

  get minScale(): number {
    const fit = Math.min(this.viewW / this.bounds.w, this.viewH / this.bounds.h);
    return Math.max(this.steps[0] ?? 0.25, Math.min(fit, 1));
  }

  get moving(): boolean {
    return !!this.tween;
  }

  setView(w: number, h: number) {
    this.viewW = w;
    this.viewH = h;
    this.clamp();
  }

  /** Smooth move (director, follow, buttons). `dur` in ms; 0 jumps. */
  moveTo(x: number, y: number, s = this.scale, dur = 1200, now = performance.now()) {
    this.vx = this.vy = 0;
    if (dur <= 0) {
      this.tween = null;
      this.x = x;
      this.y = y;
      this.scale = s;
      this.clamp();
      return;
    }
    this.tween = { from: { x: this.x, y: this.y, s: this.scale }, to: { x, y, s }, t0: now, dur };
  }

  stop() {
    this.tween = null;
    this.vx = this.vy = 0;
  }

  panBy(dxScreen: number, dyScreen: number) {
    this.tween = null;
    this.x -= dxScreen / this.scale;
    this.y -= dyScreen / this.scale;
    this.clamp();
  }

  fling(vxScreen: number, vyScreen: number) {
    this.vx = -vxScreen / this.scale;
    this.vy = -vyScreen / this.scale;
  }

  /** Zoom keeping the world point under the screen point (sx, sy) fixed. */
  zoomAt(newScale: number, sx: number, sy: number) {
    this.tween = null;
    const s = Math.max(this.minScale, Math.min(this.steps[this.steps.length - 1] ?? 6, newScale));
    const wx = this.x + (sx - this.viewW / 2) / this.scale;
    const wy = this.y + (sy - this.viewH / 2) / this.scale;
    this.scale = s;
    this.x = wx - (sx - this.viewW / 2) / s;
    this.y = wy - (sy - this.viewH / 2) / s;
    this.clamp();
  }

  /** Animated zoom by one step toward a screen point. */
  stepZoom(dir: 1 | -1, sx = this.viewW / 2, sy = this.viewH / 2, dur = 180) {
    const target = Math.max(this.minScale, stepFrom(this.steps, this.scale, dir));
    const wx = this.x + (sx - this.viewW / 2) / this.scale;
    const wy = this.y + (sy - this.viewH / 2) / this.scale;
    const nx = wx - (sx - this.viewW / 2) / target;
    const ny = wy - (sy - this.viewH / 2) / target;
    this.moveTo(nx, ny, target, dur);
  }

  snapZoom(sx = this.viewW / 2, sy = this.viewH / 2) {
    const target = Math.max(this.minScale, nearestStep(this.steps, this.scale));
    if (Math.abs(target - this.scale) < 1e-3) return;
    const wx = this.x + (sx - this.viewW / 2) / this.scale;
    const wy = this.y + (sy - this.viewH / 2) / this.scale;
    this.moveTo(wx - (sx - this.viewW / 2) / target, wy - (sy - this.viewH / 2) / target, target, 160);
  }

  update(now: number, dtMs: number) {
    const tw = this.tween;
    if (tw) {
      const f = Math.min(1, (now - tw.t0) / tw.dur);
      const e = easeInOutCubic(f);
      // zoom eases in log space so it feels even
      const s = Math.exp(Math.log(tw.from.s) + (Math.log(tw.to.s) - Math.log(tw.from.s)) * e);
      this.x = tw.from.x + (tw.to.x - tw.from.x) * e;
      this.y = tw.from.y + (tw.to.y - tw.from.y) * e;
      this.scale = s;
      if (f >= 1) this.tween = null;
      this.clamp();
    } else if (this.vx || this.vy) {
      const k = Math.pow(0.004, dtMs / 1000);
      this.x += (this.vx * dtMs) / 1000;
      this.y += (this.vy * dtMs) / 1000;
      this.vx *= k;
      this.vy *= k;
      if (Math.hypot(this.vx, this.vy) * this.scale < 8) this.vx = this.vy = 0;
      this.clamp();
    }
  }

  clamp() {
    const halfW = this.viewW / 2 / this.scale;
    const halfH = this.viewH / 2 / this.scale;
    const b = this.bounds;
    this.x = b.w <= halfW * 2 ? b.x + b.w / 2 : Math.max(b.x + halfW, Math.min(b.x + b.w - halfW, this.x));
    this.y = b.h <= halfH * 2 ? b.y + b.h / 2 : Math.max(b.y + halfH, Math.min(b.y + b.h - halfH, this.y));
  }

  /** Visible world rectangle, with a margin in world pixels. */
  viewRect(margin = 0): Rect {
    const w = this.viewW / this.scale;
    const h = this.viewH / this.scale;
    return { x: this.x - w / 2 - margin, y: this.y - h / 2 - margin, w: w + margin * 2, h: h + margin * 2 };
  }

  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.scale + this.viewW / 2, y: (wy - this.y) * this.scale + this.viewH / 2 };
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: this.x + (sx - this.viewW / 2) / this.scale, y: this.y + (sy - this.viewH / 2) / this.scale };
  }
}
