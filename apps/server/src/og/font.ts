import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** Header of the subset file written by `scripts/build-font.ts`. */
export const FONT_MAGIC = Buffer.from('UFS1', 'ascii');

/**
 * Unicode blocks kept from GNU Unifont: Latin (with extensions and IPA), Greek, Cyrillic, Vietnamese Latin, common
 * punctuation and symbols, CJK punctuation, kana, CJK Unified Ideographs, Hangul syllables, full/half-width forms
 * and U+FFFD (drawn for anything missing).
 */
export const FONT_RANGES: readonly [number, number][] = [
  [0x0020, 0x02ff],
  [0x0370, 0x052f],
  [0x1e00, 0x1eff],
  [0x2000, 0x206f],
  [0x20a0, 0x20cf],
  [0x2100, 0x214f],
  [0x2190, 0x21ff],
  [0x2460, 0x24ff],
  [0x25a0, 0x27bf],
  [0x3000, 0x30ff],
  [0x31f0, 0x31ff],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7a3],
  [0xff00, 0xffef],
  [0xfffd, 0xfffd],
];

export const GLYPH_H = 16;
export const FONT_FILE = join(import.meta.dirname, '..', '..', 'assets', 'fonts', 'unifont-subset.bin.gz');

/** A 16 px bitmap font: every glyph is 8 or 16 pixels wide, one bit per pixel, rows top to bottom. */
export class BitmapFont {
  private index = new Map<number, number>();
  private widths: Uint8Array;
  private offsets: Uint32Array;
  private bits: Buffer;

  constructor(file: Buffer) {
    const raw = gunzipSync(file);
    if (!raw.subarray(0, 4).equals(FONT_MAGIC)) throw new Error('not a UFS1 font file');
    const n = raw.readUInt32LE(4);
    const cpStart = 8;
    const wStart = cpStart + n * 4;
    const bStart = wStart + n;
    this.widths = new Uint8Array(raw.buffer, raw.byteOffset + wStart, n);
    this.offsets = new Uint32Array(n);
    let off = 0;
    for (let i = 0; i < n; i++) {
      this.index.set(raw.readUInt32LE(cpStart + i * 4), i);
      this.offsets[i] = off;
      off += this.widths[i] === 8 ? 16 : 32;
    }
    this.bits = raw.subarray(bStart);
  }

  static load(path = FONT_FILE): BitmapFont {
    return new BitmapFont(readFileSync(path));
  }

  has(cp: number): boolean {
    return this.index.has(cp);
  }

  /** Width in font pixels of one code point: zero for combining marks and controls, U+FFFD's for missing glyphs. */
  width(cp: number): number {
    if (isZeroWidth(cp)) return 0;
    const i = this.index.get(cp) ?? this.index.get(0xfffd);
    return i === undefined ? 8 : this.widths[i]!;
  }

  /** Calls `dot(x, y)` for every lit pixel of the glyph, in font pixels. */
  draw(cp: number, dot: (x: number, y: number) => void): void {
    if (isZeroWidth(cp)) return;
    const i = this.index.get(cp) ?? this.index.get(0xfffd);
    if (i === undefined) return;
    const w = this.widths[i]!;
    const bytesPerRow = w / 8;
    const base = this.offsets[i]!;
    for (let y = 0; y < GLYPH_H; y++) {
      for (let bx = 0; bx < bytesPerRow; bx++) {
        const byte = this.bits[base + y * bytesPerRow + bx]!;
        if (!byte) continue;
        for (let k = 0; k < 8; k++) if (byte & (0x80 >> k)) dot(bx * 8 + k, y);
      }
    }
  }
}

const ZERO_WIDTH = /[\p{M}\p{Cc}\p{Cf}]/u;
function isZeroWidth(cp: number): boolean {
  return ZERO_WIDTH.test(String.fromCodePoint(cp));
}

let shared: BitmapFont | null = null;
/** The bundled font, loaded on first use (about 1 MB in memory). */
export function cardFont(): BitmapFont {
  shared ??= BitmapFont.load();
  return shared;
}
