/**
 * Builds `assets/fonts/unifont-subset.bin.gz` (the share-card font) from a GNU Unifont `.hex` file:
 *
 *   pnpm --filter @ajwf/server exec tsx src/scripts/build-font.ts path/to/unifont_all-17.0.05.hex
 *
 * Unifont (https://unifoundry.com/unifont/) is dual-licensed SIL OFL 1.1 / GPLv2+ with the font embedding
 * exception; see ASSETS.md and assets/fonts/LICENSE-unifont.txt. Only the blocks below are kept, so the file stays
 * small while covering the six launch languages (Latin, CJK ideographs, kana) plus Greek, Cyrillic and Hangul.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { FONT_MAGIC, FONT_RANGES } from '../og/font';

const src = process.argv[2];
if (!src) {
  console.error('usage: build-font.ts <unifont.hex>');
  process.exit(1);
}

const glyphs: { cp: number; bits: Buffer }[] = [];
for (const line of readFileSync(src, 'utf8').split('\n')) {
  const [c, b] = line.trim().split(':');
  if (!c || !b) continue;
  const cp = parseInt(c, 16);
  if (!FONT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) continue;
  // 32 hex digits: 8 px wide; 64: 16 px wide. 16 rows either way.
  if (b.length !== 32 && b.length !== 64) continue;
  glyphs.push({ cp, bits: Buffer.from(b, 'hex') });
}
glyphs.sort((x, y) => x.cp - y.cp);

const head = Buffer.alloc(8);
FONT_MAGIC.copy(head, 0);
head.writeUInt32LE(glyphs.length, 4);
const cps = Buffer.alloc(glyphs.length * 4);
const widths = Buffer.alloc(glyphs.length);
glyphs.forEach((g, i) => {
  cps.writeUInt32LE(g.cp, i * 4);
  widths[i] = g.bits.length === 16 ? 8 : 16;
});
const out = gzipSync(Buffer.concat([head, cps, widths, ...glyphs.map((g) => g.bits)]), { level: 9 });
const dest = join(import.meta.dirname, '..', '..', 'assets', 'fonts', 'unifont-subset.bin.gz');
writeFileSync(dest, out);
console.log(`${glyphs.length} glyphs, ${out.length} bytes -> ${dest}`);
