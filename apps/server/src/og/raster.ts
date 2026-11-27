import { crc32, deflateSync } from 'node:zlib';
import { GLYPH_H, type BitmapFont } from './font';

export type Rgb = readonly [number, number, number];

/**
 * A plain RGB pixel buffer with the few drawing operations share cards need: rectangles, nearest-neighbour image
 * blits and bitmap text at integer scales. Pure JavaScript, so it runs anywhere Node runs (no native libraries).
 */
export class Raster {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    bg: Rgb = [0, 0, 0],
  ) {
    this.data = new Uint8Array(width * height * 3);
    this.rect(0, 0, width, height, bg);
  }

  rect(x0: number, y0: number, w: number, h: number, c: Rgb): void {
    const x1 = Math.min(this.width, x0 + w);
    const y1 = Math.min(this.height, y0 + h);
    for (let y = Math.max(0, y0); y < y1; y++) {
      for (let x = Math.max(0, x0); x < x1; x++) {
        const i = (y * this.width + x) * 3;
        this.data[i] = c[0];
        this.data[i + 1] = c[1];
        this.data[i + 2] = c[2];
      }
    }
  }

  /** Draws an RGBA image scaled by an integer factor (nearest neighbour), alpha-blended over the background. */
  blit(rgba: Uint8Array, w: number, h: number, x0: number, y0: number, scale: number): void {
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const si = (sy * w + sx) * 4;
        const a = rgba[si + 3]! / 255;
        if (a === 0) continue;
        for (let dy = 0; dy < scale; dy++) {
          const y = y0 + sy * scale + dy;
          if (y < 0 || y >= this.height) continue;
          for (let dx = 0; dx < scale; dx++) {
            const x = x0 + sx * scale + dx;
            if (x < 0 || x >= this.width) continue;
            const di = (y * this.width + x) * 3;
            for (let k = 0; k < 3; k++) this.data[di + k] = Math.round(rgba[si + k]! * a + this.data[di + k]! * (1 - a));
          }
        }
      }
    }
  }

  /** Draws one line of text with its top-left corner at (x, y); returns the width drawn. */
  text(font: BitmapFont, s: string, x: number, y: number, scale: number, c: Rgb): number {
    let cx = x;
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      const gx = cx;
      font.draw(cp, (px, py) => this.rect(gx + px * scale, y + py * scale, scale, scale, c));
      cx += font.width(cp) * scale;
    }
    return cx - x;
  }

  png(): Buffer {
    return encodePng(this.width, this.height, this.data);
  }
}

/** Width of a string in output pixels. */
export function textWidth(font: BitmapFont, s: string, scale: number): number {
  let w = 0;
  for (const ch of s) w += font.width(ch.codePointAt(0)!);
  return w * scale;
}

/** CJK ideographs, kana, Hangul, CJK punctuation (U+3000-303F) and full-width forms (U+FF00-FFEF): break anywhere. */
const range = (lo: number, hi: number) => `${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`;
const WIDE = new RegExp(`[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}${range(0x3000, 0x303f)}${range(0xff00, 0xffef)}]`, 'u');

/**
 * Breaks text into at most `maxLines` lines of at most `maxWidth` pixels: at spaces, or anywhere between CJK
 * characters. The last line ends with an ellipsis when the text does not fit.
 */
export function wrapText(font: BitmapFont, s: string, scale: number, maxWidth: number, maxLines: number): string[] {
  // Tokens: runs of non-space, non-CJK characters, single CJK characters, and spaces.
  const tokens = s.normalize('NFC').match(/\s+|[^\s]/gu) ?? [];
  const merged: string[] = [];
  for (const t of tokens) {
    const last = merged[merged.length - 1];
    if (last !== undefined && !/\s/.test(t) && !/\s/.test(last) && !WIDE.test(t) && !WIDE.test(last)) merged[merged.length - 1] = last + t;
    else merged.push(t);
  }
  const lines: string[] = [];
  let cur = '';
  for (const t of merged) {
    const next = cur + t;
    if (textWidth(font, next, scale) <= maxWidth) {
      cur = next;
      continue;
    }
    if (cur.trim()) lines.push(cur.trimEnd());
    cur = /\s/.test(t) ? '' : t;
    // A single word longer than the line is cut by characters.
    while (textWidth(font, cur, scale) > maxWidth) {
      let cut = '';
      for (const ch of cur) {
        if (textWidth(font, cut + ch, scale) > maxWidth) break;
        cut += ch;
      }
      if (!cut) break;
      lines.push(cut);
      cur = cur.slice(cut.length);
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1]!;
  while (last && textWidth(font, `${last}…`, scale) > maxWidth) last = [...last].slice(0, -1).join('');
  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

/** Height in pixels of a line of text at a scale. */
export const lineHeight = (scale: number) => GLYPH_H * scale;

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb) >>> 0);
  return Buffer.concat([len, tb, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal PNG encoder: 8-bit RGB, no filtering, zlib-compressed. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
