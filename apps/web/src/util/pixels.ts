/** A tiny RGBA pixel buffer for procedural pixel art. Colours are 0xRRGGBB numbers; -1 means transparent. */

export const OUTLINE = 0x241a2e;

export function shade(c: number, f: number): number {
  const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((c & 255) * f)));
  return (r << 16) | (g << 8) | b;
}

export function mix(a: number, b: number, f: number): number {
  const r = Math.round(((a >> 16) & 255) * (1 - f) + ((b >> 16) & 255) * f);
  const g = Math.round(((a >> 8) & 255) * (1 - f) + ((b >> 8) & 255) * f);
  const bl = Math.round((a & 255) * (1 - f) + (b & 255) * f);
  return (r << 16) | (g << 8) | bl;
}

export class PixelBuf {
  readonly data: Uint8ClampedArray;
  /** Offset applied to every draw call (lets a design be drawn in local coordinates). */
  ox = 0;
  oy = 0;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8ClampedArray(w * h * 4);
  }

  px(x: number, y: number, c: number, a = 255) {
    const X = Math.floor(x + this.ox);
    const Y = Math.floor(y + this.oy);
    if (X < 0 || Y < 0 || X >= this.w || Y >= this.h || c < 0) return;
    const i = (Y * this.w + X) * 4;
    if (a >= 255) {
      this.data[i] = (c >> 16) & 255;
      this.data[i + 1] = (c >> 8) & 255;
      this.data[i + 2] = c & 255;
      this.data[i + 3] = 255;
    } else {
      // simple "over" blend for translucent pixels
      const sa = a / 255;
      const da = this.data[i + 3]! / 255;
      const oa = sa + da * (1 - sa);
      if (oa <= 0) return;
      this.data[i] = (((c >> 16) & 255) * sa + this.data[i]! * da * (1 - sa)) / oa;
      this.data[i + 1] = (((c >> 8) & 255) * sa + this.data[i + 1]! * da * (1 - sa)) / oa;
      this.data[i + 2] = ((c & 255) * sa + this.data[i + 2]! * da * (1 - sa)) / oa;
      this.data[i + 3] = oa * 255;
    }
  }

  /** Makes an inclusive rectangle transparent again. */
  erase(x0: number, y0: number, x1: number, y1: number) {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const X = Math.floor(x + this.ox);
        const Y = Math.floor(y + this.oy);
        if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) continue;
        this.data[(Y * this.w + X) * 4 + 3] = 0;
      }
  }

  get(x: number, y: number): number {
    const X = Math.floor(x + this.ox);
    const Y = Math.floor(y + this.oy);
    if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) return -1;
    const i = (Y * this.w + X) * 4;
    if (this.data[i + 3] === 0) return -1;
    return (this.data[i]! << 16) | (this.data[i + 1]! << 8) | this.data[i + 2]!;
  }

  opaque(X: number, Y: number): boolean {
    return X >= 0 && Y >= 0 && X < this.w && Y < this.h && this.data[(Y * this.w + X) * 4 + 3]! > 0;
  }

  /** Inclusive rectangle; `c` may be a function of the pixel. */
  rect(x0: number, y0: number, x1: number, y1: number, c: number | ((x: number, y: number) => number)) {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) this.px(x, y, typeof c === 'function' ? c(x, y) : c);
  }

  /** Filled ellipse inside the box [x0..x1] x [y0..y1]. */
  ellipse(x0: number, y0: number, x1: number, y1: number, c: number | ((x: number, y: number) => number)) {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = (x1 - x0 + 1) / 2;
    const ry = (y1 - y0 + 1) / 2;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - (cx + 0.5)) / rx;
        const dy = (y + 0.5 - (cy + 0.5)) / ry;
        if (dx * dx + dy * dy <= 1.0) this.px(x, y, typeof c === 'function' ? c(x, y) : c);
      }
  }

  line(x0: number, y0: number, x1: number, y1: number, c: number) {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (let n = 0; n < 512; n++) {
      this.px(x, y, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** 1 px outline around every opaque region, in absolute buffer coordinates [x0..x1]. */
  outline(color = OUTLINE, x0 = 0, y0 = 0, x1 = this.w - 1, y1 = this.h - 1) {
    const src = new Uint8ClampedArray(this.data);
    const op = (X: number, Y: number) =>
      X >= x0 && Y >= y0 && X <= x1 && Y <= y1 && src[(Y * this.w + X) * 4 + 3]! > 0;
    for (let Y = y0; Y <= y1; Y++)
      for (let X = x0; X <= x1; X++) {
        if (op(X, Y)) continue;
        if (op(X - 1, Y) || op(X + 1, Y) || op(X, Y - 1) || op(X, Y + 1)) {
          const i = (Y * this.w + X) * 4;
          this.data[i] = (color >> 16) & 255;
          this.data[i + 1] = (color >> 8) & 255;
          this.data[i + 2] = color & 255;
          this.data[i + 3] = 255;
        }
      }
  }

  /** Copies a region of another buffer (opaque pixels only). */
  blit(src: PixelBuf, sx: number, sy: number, w: number, h: number, dx: number, dy: number) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const X = sx + x;
        const Y = sy + y;
        if (!src.opaque(X, Y)) continue;
        const i = (Y * src.w + X) * 4;
        this.px(
          dx + x,
          dy + y,
          (src.data[i]! << 16) | (src.data[i + 1]! << 8) | src.data[i + 2]!,
          src.data[i + 3]!,
        );
      }
  }

  toCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    const ctx = c.getContext('2d');
    if (ctx) ctx.putImageData(new ImageData(new Uint8ClampedArray(this.data), this.w, this.h), 0, 0);
    return c;
  }
}
