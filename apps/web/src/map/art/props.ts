/**
 * Prop and building designs: original procedural pixel art (CC0), drawn into small buffers with the shared outline
 * and stamped onto the baked map. Each design returns its buffer, an anchor (the point that sits on the ground) and
 * the light sources it carries (windows, torches) for the night glow layer.
 */
import { mix, PixelBuf, shade } from '../../util/pixels';
import { rng } from '../../util/rng';
import { OUTLINE, P } from './palette';

export type Light = { x: number; y: number; kind: LightKind; w?: number; h?: number };
export type LightKind =
  'window' | 'torch' | 'forge' | 'lamp' | 'crystal' | 'cauldron' | 'rune' | 'candle' | 'fire';
export type Art = { buf: PixelBuf; ax: number; ay: number; lights: Light[] };

const art = (buf: PixelBuf, ax: number, ay: number, lights: Light[] = [], outline = true): Art => {
  if (outline) {
    buf.ox = 0;
    buf.oy = 0;
    buf.outline(OUTLINE);
  }
  return { buf, ax, ay, lights };
};

// ── Nature ────────────────────────────────────────────────────────────────────

export function tree(seed: number, kind: 'forest' | 'village' | 'dark' = 'forest', big = false): Art {
  const r = rng(seed);
  const W = big ? 46 : 30;
  const H = big ? 54 : 36;
  const b = new PixelBuf(W + 2, H + 2);
  b.ox = 1;
  b.oy = 1;
  const base = kind === 'village' ? 0x5f9a52 : kind === 'dark' ? 0x2a5a44 : P.canopyMid;
  const dark = kind === 'village' ? 0x467a43 : kind === 'dark' ? 0x1f463a : P.canopy;
  const light = kind === 'village' ? 0x86bf6a : kind === 'dark' ? 0x3c7656 : P.canopyLight;
  const cx = W / 2;
  const trunkW = big ? 8 : 4;
  const trunkH = big ? 14 : 9;
  b.rect(Math.floor(cx - trunkW / 2), H - trunkH, Math.floor(cx + trunkW / 2) - 1, H - 1, (x) =>
    x >= cx ? shade(P.trunk, 0.8) : P.trunk,
  );
  if (big) {
    b.rect(Math.floor(cx - trunkW / 2) - 2, H - 3, Math.floor(cx - trunkW / 2) - 1, H - 1, P.trunk);
    b.rect(Math.floor(cx + trunkW / 2), H - 3, Math.floor(cx + trunkW / 2) + 1, H - 1, shade(P.trunk, 0.8));
  }
  const ch = H - trunkH + 3;
  const blobs: [number, number, number, number][] = [
    [2, 2, W - 3, ch - 1],
    [0, Math.floor(ch * 0.35), Math.floor(W * 0.55), ch],
    [Math.floor(W * 0.45), Math.floor(ch * 0.3), W - 1, ch],
  ];
  for (const [x0, y0, x1, y1] of blobs) b.ellipse(x0 + Math.floor(r() * 2), y0, x1, y1, base);
  // shade the lower right, highlight the upper left, a few dithered leaves
  for (let y = 0; y < ch + 1; y++)
    for (let x = 0; x < W; x++) {
      const c = b.get(x, y);
      if (c !== base) continue;
      const nx = (x - cx) / W;
      const ny = y / ch;
      if (nx + ny > 0.85 || ny > 0.86) b.px(x, y, dark);
      else if (nx + ny < 0.25 && (x + y) % 2 === 0) b.px(x, y, light);
      else if (r() < 0.06) b.px(x, y, (x + y) % 3 ? dark : light);
    }
  // leaf clumps
  for (let i = 0; i < (big ? 9 : 5); i++) {
    const x = 3 + Math.floor(r() * (W - 8));
    const y = 3 + Math.floor(r() * (ch * 0.55));
    b.px(x, y, light);
    b.px(x + 1, y, light);
    b.px(x, y + 1, light);
  }
  if (kind === 'forest' && r() < 0.15)
    for (let i = 0; i < 3; i++)
      b.px(4 + Math.floor(r() * (W - 8)), 6 + Math.floor(r() * (ch - 10)), P.flowerRed);
  return art(b, Math.floor(cx) + 1, H + 1);
}

export function bush(seed: number, color: number = P.canopyMid): Art {
  const r = rng(seed);
  const b = new PixelBuf(16, 12);
  b.ellipse(1, 2, 14, 10, color);
  b.ellipse(3, 1, 9, 7, shade(color, 1.15));
  for (let i = 0; i < 6; i++) b.px(2 + Math.floor(r() * 12), 5 + Math.floor(r() * 5), shade(color, 0.8));
  if (r() < 0.4)
    for (let i = 0; i < 3; i++)
      b.px(3 + Math.floor(r() * 10), 3 + Math.floor(r() * 5), r() < 0.5 ? P.flowerRed : P.flowerWhite);
  return art(b, 8, 11);
}

export function boulder(seed: number, size = 1, pal: 'grey' | 'cave' | 'sand' = 'grey'): Art {
  const r = rng(seed);
  const base = pal === 'cave' ? P.rockLight : pal === 'sand' ? 0xb8a88a : P.boulder;
  const w = Math.round(10 + size * 8 + r() * 4);
  const h = Math.round(7 + size * 5 + r() * 2);
  const b = new PixelBuf(w + 2, h + 2);
  b.ox = 1;
  b.oy = 1;
  b.ellipse(0, 0, w - 1, h - 1, base);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (b.get(x, y) < 0) continue;
      if (y > h * 0.62 || x > w * 0.78) b.px(x, y, shade(base, 0.75));
      else if (y < h * 0.3 && x < w * 0.5) b.px(x, y, shade(base, 1.18));
    }
  const cx = Math.floor(w * (0.3 + r() * 0.4));
  b.line(cx, 1, cx + 2, Math.floor(h * 0.5), shade(base, 0.6));
  return art(b, Math.floor(w / 2) + 1, h + 1);
}

export function mushrooms(seed: number): Art {
  const r = rng(seed);
  const b = new PixelBuf(14, 9);
  const n = 2 + Math.floor(r() * 2);
  for (let i = 0; i < n; i++) {
    const x = 1 + i * 4 + Math.floor(r() * 2);
    const h = 2 + Math.floor(r() * 3);
    b.rect(x + 1, 8 - h, x + 1, 7, P.flowerWhite);
    b.rect(x, 7 - h - 1, x + 2, 7 - h, P.mushroom);
    b.px(x + 1, 7 - h - 2, P.mushroom);
    b.px(x, 7 - h - 1, P.flowerWhite);
  }
  return art(b, 7, 8);
}

export function reeds(seed: number): Art {
  const r = rng(seed);
  const b = new PixelBuf(12, 14);
  for (let i = 0; i < 5; i++) {
    const x = 1 + i * 2 + Math.floor(r() * 2);
    const h = 6 + Math.floor(r() * 7);
    b.rect(x, 13 - h, x, 13, i % 2 ? P.reed : shade(P.reed, 0.8));
    if (r() < 0.5) b.rect(x, 13 - h, x, 13 - h + 2, 0x6b4a2a);
  }
  return art(b, 6, 13, [], false);
}

export function deadTree(seed: number): Art {
  const r = rng(seed);
  const b = new PixelBuf(24, 32);
  b.rect(10, 8, 12, 31, P.deadwood);
  b.rect(12, 8, 12, 31, shade(P.deadwood, 0.8));
  b.line(11, 16, 3 + Math.floor(r() * 3), 8, P.deadwood);
  b.line(11, 18, 4, 14, P.deadwood);
  b.line(12, 12, 20, 4 + Math.floor(r() * 3), P.deadwood);
  b.line(12, 20, 21, 15, P.deadwood);
  b.line(11, 8, 9, 1, P.deadwood);
  b.rect(8, 30, 14, 31, shade(P.deadwood, 0.8));
  return art(b, 11, 31);
}

export function flowers(
  b: PixelBuf,
  x: number,
  y: number,
  seed: number,
  palette = [P.flowerRed, P.flowerYellow, P.flowerWhite, P.flowerBlue],
) {
  const r = rng(seed);
  for (let i = 0; i < 5; i++) {
    const fx = x + Math.floor(r() * 10);
    const fy = y + Math.floor(r() * 6);
    const c = palette[Math.floor(r() * palette.length)]!;
    b.px(fx, fy, c);
    b.px(fx + 1, fy, shade(c, 0.8));
    b.px(fx, fy + 1, P.grassDark);
  }
}

export function column(seed: number, ivy = true): Art {
  const r = rng(seed);
  const h = 14 + Math.floor(r() * 14);
  const b = new PixelBuf(14, h + 6);
  b.rect(1, h + 1, 12, h + 4, shade(P.column, 0.85));
  b.rect(3, 2, 10, h, (x) =>
    x === 3
      ? shade(P.column, 1.08)
      : x >= 9
        ? shade(P.column, 0.8)
        : x % 3 === 0
          ? shade(P.column, 0.9)
          : P.column,
  );
  // broken top
  for (let x = 3; x <= 10; x++) {
    const cut = Math.floor(r() * 4);
    if (cut > 0) b.erase(x, 2, x, 1 + cut);
  }
  if (ivy)
    for (let i = 0; i < 10; i++) {
      const y = h - Math.floor(r() * (h * 0.7));
      b.px(3 + Math.floor(r() * 8), y, r() < 0.5 ? P.ivy : shade(P.ivy, 1.2));
    }
  return art(b, 7, h + 4);
}

export function rubble(seed: number, base: number = P.flagDark): Art {
  const r = rng(seed);
  const b = new PixelBuf(16, 8);
  for (let i = 0; i < 4; i++) {
    const x = Math.floor(r() * 12);
    const y = 2 + Math.floor(r() * 4);
    b.rect(x, y, x + 1 + Math.floor(r() * 2), y + 1, i % 2 ? base : shade(base, 1.15));
  }
  return art(b, 8, 7);
}

export function crystals(seed: number): Art {
  const r = rng(seed);
  const b = new PixelBuf(16, 16);
  for (let i = 0; i < 3; i++) {
    const x = 2 + i * 4 + Math.floor(r() * 2);
    const h = 6 + Math.floor(r() * 7);
    for (let y = 0; y < h; y++) {
      const w = y < 2 ? 0 : 1;
      b.rect(
        x - w,
        15 - y,
        x + w,
        15 - y,
        y > h - 3 ? 0xc8fbff : i === 1 ? P.crystal : shade(P.crystal, 0.8),
      );
    }
  }
  return art(b, 8, 15, [{ x: 8, y: 9, kind: 'crystal' }]);
}

// ── Village furniture ─────────────────────────────────────────────────────────

export function barrel(): Art {
  const b = new PixelBuf(10, 12);
  b.rect(1, 1, 8, 10, (x, y) => (y === 3 || y === 8 ? P.stoneDark : x >= 6 ? P.woodDark : P.wood));
  b.rect(2, 0, 7, 0, P.woodLight);
  return art(b, 5, 11);
}

export function crate(): Art {
  const b = new PixelBuf(11, 10);
  b.rect(0, 0, 10, 9, P.wood);
  b.rect(0, 0, 10, 0, P.woodLight);
  b.line(1, 1, 9, 8, P.woodDark);
  b.rect(0, 9, 10, 9, P.woodDark);
  return art(b, 5, 9);
}

export function lamp(): Art {
  const b = new PixelBuf(8, 22);
  b.rect(3, 6, 4, 21, 0x3a3346);
  b.rect(2, 20, 5, 21, 0x3a3346);
  b.rect(1, 1, 6, 6, 0x3a3346);
  b.rect(2, 2, 5, 5, P.windowLit);
  return art(b, 4, 21, [{ x: 4, y: 4, kind: 'lamp' }]);
}

export function torch(): Art {
  const b = new PixelBuf(6, 14);
  b.rect(2, 5, 3, 13, P.woodDark);
  b.rect(1, 3, 4, 5, 0x5a4a3a);
  b.rect(1, 0, 4, 2, 0xf08a3c);
  b.px(2, 0, P.amber);
  b.px(3, 1, 0xffe08a);
  return art(b, 3, 13, [{ x: 3, y: 1, kind: 'torch' }]);
}

export function fence(len: number, color: number = P.wood): Art {
  const b = new PixelBuf(len, 9);
  for (let x = 0; x < len; x += 5) b.rect(x, 0, x + 1, 8, x % 2 ? shade(color, 0.85) : color);
  b.rect(0, 2, len - 1, 2, shade(color, 1.1));
  b.rect(0, 5, len - 1, 5, shade(color, 0.9));
  return art(b, Math.floor(len / 2), 8);
}

export function signpost(): Art {
  const b = new PixelBuf(16, 18);
  b.rect(7, 4, 8, 17, P.woodDark);
  b.rect(1, 2, 14, 6, P.wood);
  b.rect(2, 4, 12, 4, P.woodDark);
  b.rect(13, 3, 15, 5, P.wood);
  return art(b, 8, 17);
}

export function dummy(): Art {
  const b = new PixelBuf(12, 22);
  b.rect(5, 8, 6, 21, P.woodDark);
  b.rect(1, 9, 10, 10, P.woodDark);
  b.ellipse(2, 7, 9, 16, 0xd8b85a);
  b.ellipse(3, 0, 8, 6, 0xd8b85a);
  b.px(4, 3, OUTLINE);
  b.px(7, 3, OUTLINE);
  b.rect(3, 11, 8, 11, 0xa88a3a);
  return art(b, 6, 21);
}

export function weaponRack(): Art {
  const b = new PixelBuf(20, 16);
  b.rect(0, 4, 1, 15, P.woodDark);
  b.rect(18, 4, 19, 15, P.woodDark);
  b.rect(0, 6, 19, 7, P.wood);
  for (let i = 0; i < 4; i++) {
    const x = 4 + i * 4;
    b.rect(x, 0, x, 13, i % 2 ? P.stoneLight : P.iron);
    b.rect(x - 1, 9, x + 1, 9, P.woodDark);
  }
  return art(b, 10, 15);
}

export function anvil(): Art {
  const b = new PixelBuf(16, 12);
  b.rect(4, 7, 11, 11, P.woodDark);
  b.rect(1, 2, 14, 4, 0x4a4a56);
  b.rect(1, 2, 14, 2, 0x6e6e7c);
  b.rect(5, 5, 10, 6, 0x3a3a44);
  b.rect(0, 3, 1, 3, 0x4a4a56);
  return art(b, 8, 11);
}

export function forge(): Art {
  const b = new PixelBuf(22, 20);
  b.rect(1, 6, 20, 19, (x, y) => ((x + (y >> 2)) % 5 === 0 || y % 4 === 0 ? P.stoneDark : P.stone));
  b.rect(6, 11, 15, 17, 0x2a1a1a);
  b.rect(7, 14, 14, 17, 0xf08a3c);
  b.rect(8, 15, 13, 17, P.amber);
  b.rect(9, 0, 12, 6, P.stoneDark);
  return art(b, 11, 19, [{ x: 11, y: 15, kind: 'forge' }]);
}

export function cauldron(color = 0x7ad05a): Art {
  const b = new PixelBuf(16, 14);
  b.ellipse(1, 3, 14, 13, 0x2e2a36);
  b.rect(2, 3, 13, 4, color);
  b.px(5, 2, shade(color, 1.2));
  b.px(9, 1, shade(color, 1.2));
  b.px(10, 2, color);
  b.rect(0, 12, 2, 13, P.woodDark);
  b.rect(13, 12, 15, 13, P.woodDark);
  return art(b, 8, 13, [{ x: 8, y: 4, kind: 'cauldron' }]);
}

export function loom(): Art {
  const b = new PixelBuf(22, 18);
  b.rect(0, 0, 1, 17, P.woodDark);
  b.rect(20, 0, 21, 17, P.woodDark);
  b.rect(0, 1, 21, 2, P.wood);
  b.rect(0, 13, 21, 14, P.wood);
  for (let x = 3; x < 19; x++)
    b.rect(x, 3, x, 12, x % 3 === 0 ? 0x5b8def : x % 3 === 1 ? 0xe0605a : 0xf1e6cf);
  return art(b, 11, 17);
}

export function fountain(): Art {
  const b = new PixelBuf(46, 30);
  b.ellipse(0, 8, 45, 29, P.stone);
  b.ellipse(3, 10, 42, 26, P.fountainWater);
  b.ellipse(6, 13, 38, 23, shade(P.fountainWater, 0.88));
  for (let i = 0; i < 6; i++) b.px(10 + i * 5, 15 + (i % 2) * 4, P.foam);
  b.rect(20, 2, 25, 18, P.stoneLight);
  b.rect(23, 2, 25, 18, P.stone);
  b.rect(18, 0, 27, 2, P.stoneLight);
  b.px(22, 0, P.foam);
  b.px(21, 3, P.foam);
  b.px(26, 4, P.foam);
  b.rect(0, 22, 45, 29, (x, y) => (b.get(x, y) === P.stone ? shade(P.stone, 0.8) : -1));
  return art(b, 23, 28);
}

export function bench(): Art {
  const b = new PixelBuf(18, 9);
  b.rect(0, 2, 17, 4, P.wood);
  b.rect(0, 2, 17, 2, P.woodLight);
  b.rect(1, 5, 2, 8, P.woodDark);
  b.rect(15, 5, 16, 8, P.woodDark);
  return art(b, 9, 8);
}

export function flowerBox(seed: number): Art {
  const b = new PixelBuf(18, 9);
  b.rect(0, 4, 17, 8, P.woodDark);
  b.rect(0, 4, 17, 4, P.wood);
  flowers(b, 1, 0, seed);
  flowers(b, 8, 0, seed + 1);
  b.rect(1, 3, 16, 3, P.grassDark);
  return art(b, 9, 8);
}

export function stall(seed: number, awning: number): Art {
  const r = rng(seed);
  const b = new PixelBuf(34, 30);
  b.rect(2, 8, 3, 29, P.woodDark);
  b.rect(30, 8, 31, 29, P.woodDark);
  b.rect(1, 18, 32, 25, P.wood);
  b.rect(1, 18, 32, 18, P.woodLight);
  b.rect(1, 25, 32, 25, P.woodDark);
  for (let i = 0; i < 9; i++) {
    const x = 3 + i * 3;
    const c = [P.flowerRed, P.flowerYellow, 0x7fb069, 0xd9823b, P.flowerWhite][Math.floor(r() * 5)]!;
    b.rect(x, 15, x + 1, 17, c);
  }
  b.rect(0, 2, 33, 9, (x) => (Math.floor(x / 4) % 2 ? awning : P.flowerWhite));
  for (let x = 0; x < 34; x += 4) b.rect(x, 10, x + 1, 10, Math.floor(x / 4) % 2 ? awning : P.flowerWhite);
  b.rect(0, 2, 33, 2, shade(awning, 1.15));
  return art(b, 17, 29);
}

export function noticeBoard(): Art {
  const b = new PixelBuf(22, 20);
  b.rect(2, 6, 3, 19, P.woodDark);
  b.rect(18, 6, 19, 19, P.woodDark);
  b.rect(0, 0, 21, 13, P.wood);
  b.rect(1, 1, 20, 12, 0x8a6a3a);
  b.rect(3, 2, 7, 7, P.flowerWhite);
  b.rect(9, 3, 13, 9, 0xf1d9a8);
  b.rect(15, 2, 19, 6, P.flowerWhite);
  b.rect(4, 8, 8, 11, 0xf1d9a8);
  b.px(5, 2, P.flowerRed);
  b.px(11, 3, P.flowerRed);
  return art(b, 11, 19);
}

export function palisade(len: number, vertical = false): Art {
  const w = vertical ? 8 : len;
  const h = vertical ? len + 10 : 20;
  const b = new PixelBuf(w, h);
  if (!vertical) {
    for (let x = 0; x < len; x += 4) {
      b.rect(x, 3, x + 3, 19, x % 8 ? P.wood : P.woodDark);
      b.px(x + 1, 2, P.woodLight);
      b.px(x + 2, 2, P.woodLight);
      b.px(x + 1, 1, P.woodLight);
    }
    b.rect(0, 9, len - 1, 10, P.woodDark);
  } else {
    b.rect(1, 0, 6, h - 1, (x, y) => (y % 4 === 0 ? P.woodDark : x > 4 ? P.woodDark : P.wood));
    b.rect(1, 0, 6, 1, P.woodLight);
  }
  return art(b, Math.floor(w / 2), h - 1);
}

export function haybale(): Art {
  const b = new PixelBuf(14, 10);
  b.ellipse(0, 0, 13, 9, 0xd8b85a);
  b.rect(0, 4, 13, 4, 0xb8963a);
  b.rect(4, 0, 4, 9, 0xb8963a);
  return art(b, 7, 9);
}

export function cart(): Art {
  const b = new PixelBuf(28, 18);
  b.rect(2, 4, 25, 11, P.wood);
  b.rect(2, 4, 25, 4, P.woodLight);
  b.rect(4, 2, 9, 4, 0xd8b85a);
  b.rect(12, 1, 18, 4, 0x7fb069);
  b.ellipse(4, 10, 11, 17, P.woodDark);
  b.ellipse(16, 10, 23, 17, P.woodDark);
  b.px(7, 13, P.woodLight);
  b.px(19, 13, P.woodLight);
  b.rect(25, 8, 27, 9, P.woodDark);
  return art(b, 14, 17);
}

export function rowboat(): Art {
  const b = new PixelBuf(26, 12);
  b.ellipse(0, 1, 25, 11, P.wood);
  b.ellipse(3, 3, 22, 8, P.woodDark);
  b.rect(11, 3, 13, 9, P.wood);
  return art(b, 13, 11);
}

export function woodpile(): Art {
  const b = new PixelBuf(18, 12);
  for (let row = 0; row < 3; row++)
    for (let i = 0; i < 4 - row; i++) {
      const x = 1 + i * 4 + row * 2;
      const y = 8 - row * 3;
      b.ellipse(x, y, x + 3, y + 3, P.wood);
      b.px(x + 1, y + 1, P.woodLight);
    }
  return art(b, 9, 11);
}

export function supportBeam(width = 30): Art {
  const b = new PixelBuf(width, 26);
  b.rect(0, 2, 3, 25, P.wood);
  b.rect(width - 4, 2, width - 1, 25, P.woodDark);
  b.rect(0, 0, width - 1, 4, P.wood);
  b.rect(0, 0, width - 1, 0, P.woodLight);
  b.rect(width / 2 - 2, 5, width / 2 + 1, 9, 0x3a3346);
  b.rect(width / 2 - 1, 6, width / 2, 8, P.windowLit);
  return art(b, Math.floor(width / 2), 25, [{ x: Math.floor(width / 2), y: 7, kind: 'lamp' }]);
}

export function bones(seed: number): Art {
  const r = rng(seed);
  const b = new PixelBuf(14, 8);
  b.rect(1, 5, 8, 5, P.bone);
  b.px(0, 4, P.bone);
  b.px(0, 6, P.bone);
  b.px(9, 4, P.bone);
  b.px(9, 6, P.bone);
  if (r() < 0.7) {
    b.ellipse(8, 0, 13, 5, P.bone);
    b.px(10, 2, OUTLINE);
    b.px(12, 2, OUTLINE);
  }
  return art(b, 7, 7);
}

export function tent(stripe: number): Art {
  const b = new PixelBuf(32, 24);
  for (let y = 0; y < 22; y++) {
    const half = Math.floor((y / 22) * 15) + 1;
    b.rect(16 - half, y + 1, 15 + half, y + 1, (x) => (Math.floor((x + 2) / 4) % 2 ? stripe : 0xe8dcc0));
  }
  b.rect(13, 12, 18, 22, 0x2a2030);
  b.rect(15, 0, 16, 1, P.woodDark);
  return art(b, 16, 23);
}

export function campfire(): Art {
  const b = new PixelBuf(14, 10);
  b.rect(1, 7, 12, 8, P.woodDark);
  b.line(2, 9, 11, 6, P.wood);
  b.rect(4, 3, 9, 6, 0xf08a3c);
  b.rect(5, 1, 8, 4, P.amber);
  b.px(6, 0, 0xffe08a);
  return art(b, 7, 9, [{ x: 7, y: 4, kind: 'fire' }]);
}

export function throne(): Art {
  const b = new PixelBuf(26, 34);
  b.rect(3, 0, 22, 22, 0x5a1e2e);
  b.rect(5, 2, 20, 20, 0x7a2e3a);
  b.rect(3, 0, 22, 1, P.gold);
  b.px(7, 0, P.gold);
  b.px(12, 0, P.gold);
  b.px(18, 0, P.gold);
  b.rect(0, 18, 25, 26, 0x4a3a2a);
  b.rect(2, 20, 23, 24, 0x7a2e3a);
  b.rect(0, 18, 3, 33, 0x4a3a2a);
  b.rect(22, 18, 25, 33, 0x4a3a2a);
  b.rect(0, 18, 25, 18, P.gold);
  b.ellipse(10, 6, 15, 11, 0xe6dcc6);
  b.px(11, 8, OUTLINE);
  b.px(14, 8, OUTLINE);
  return art(b, 13, 33);
}

export function chest(open = false): Art {
  const b = new PixelBuf(16, 13);
  b.rect(0, 4, 15, 12, P.wood);
  b.rect(0, 4, 15, 5, P.woodDark);
  b.rect(0, 0, 15, 4, open ? 0x2a1a1a : P.woodLight);
  b.rect(7, 4, 8, 7, P.gold);
  b.rect(0, 8, 15, 8, P.gold);
  if (open) b.rect(2, 1, 13, 3, P.gold);
  return art(b, 8, 12, open ? [{ x: 8, y: 2, kind: 'candle' }] : []);
}

export function goldPile(): Art {
  const b = new PixelBuf(26, 12);
  b.ellipse(0, 3, 25, 11, 0xd99a2b);
  b.ellipse(4, 1, 21, 9, P.gold);
  for (let i = 0; i < 8; i++) b.px(5 + i * 2, 3 + (i % 3), 0xfff2b0);
  return art(b, 13, 11, [{ x: 13, y: 5, kind: 'candle' }]);
}

export function lever(up: boolean): Art {
  const b = new PixelBuf(10, 14);
  b.rect(1, 9, 8, 13, P.stoneDark);
  b.line(4, 10, up ? 2 : 7, 2, P.iron);
  b.rect(up ? 1 : 6, 1, up ? 3 : 8, 3, P.flowerRed);
  return art(b, 5, 13);
}

export function portcullis(width: number): Art {
  const b = new PixelBuf(width, 30);
  b.rect(0, 0, 5, 29, P.stoneDark);
  b.rect(width - 6, 0, width - 1, 29, P.stoneDark);
  b.rect(0, 0, width - 1, 5, P.stone);
  for (let x = 8; x < width - 7; x += 4) b.rect(x, 6, x + 1, 26, 0x4a4a56);
  for (let y = 9; y < 26; y += 5) b.rect(6, y, width - 7, y, 0x4a4a56);
  return art(b, Math.floor(width / 2), 29);
}

export function runeCircle(): Art {
  const b = new PixelBuf(40, 22);
  b.ellipse(0, 0, 39, 21, 0x2f2a44);
  b.ellipse(3, 2, 36, 19, P.brick);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    b.px(Math.round(19.5 + Math.cos(a) * 15), Math.round(10.5 + Math.sin(a) * 8), 0x6fe3e8);
  }
  b.rect(17, 8, 22, 13, 0x5fc9b5);
  b.rect(18, 9, 21, 12, 0x2f2a44);
  return art(b, 20, 21, [{ x: 20, y: 10, kind: 'rune' }], false);
}

export function stairsDown(): Art {
  const b = new PixelBuf(36, 26);
  b.rect(0, 0, 35, 25, P.flagDark);
  b.rect(4, 4, 31, 25, 0x1a1420);
  for (let i = 0; i < 5; i++) b.rect(5 + i, 6 + i * 4, 30 - i, 7 + i * 4, shade(P.flag, 0.7 - i * 0.1));
  b.rect(0, 0, 35, 3, P.column);
  return art(b, 18, 25);
}

export function brokenTower(): Art {
  const b = new PixelBuf(56, 56);
  b.rect(6, 12, 49, 55, (x, y) =>
    (x + (y >> 2) * 3) % 8 === 0 || y % 6 === 0 ? P.flagDark : x > 38 ? shade(P.column, 0.82) : P.column,
  );
  for (let x = 6; x <= 49; x++) {
    const cut = 12 + Math.floor(Math.abs(Math.sin(x * 0.7)) * 10 + (x > 30 ? 8 : 0));
    b.erase(x, 12, x, cut - 1);
  }
  b.rect(22, 38, 31, 55, 0x1a1420);
  b.rect(10, 26, 14, 31, 0x1a1420);
  for (let i = 0; i < 20; i++) b.px(6 + ((i * 7) % 43), 30 + ((i * 11) % 24), P.ivy);
  return art(b, 28, 55);
}

export function statueBroken(): Art {
  const b = new PixelBuf(24, 34);
  b.rect(2, 24, 21, 33, P.flagDark);
  b.rect(2, 24, 21, 25, P.column);
  b.rect(8, 8, 15, 23, P.column);
  b.rect(6, 12, 17, 16, P.column);
  b.rect(9, 3, 14, 8, P.column);
  b.erase(13, 3, 14, 6);
  b.rect(15, 8, 15, 23, shade(P.column, 0.8));
  return art(b, 12, 33);
}

export function shrine(): Art {
  const b = new PixelBuf(40, 30);
  b.rect(0, 22, 39, 29, P.flagDark);
  b.rect(4, 6, 9, 22, P.column);
  b.rect(30, 6, 35, 22, P.column);
  b.rect(2, 2, 37, 7, P.flag);
  b.rect(2, 2, 37, 2, P.column);
  b.rect(16, 14, 23, 22, P.stoneDark);
  b.rect(18, 11, 21, 13, P.windowLit);
  b.rect(10, 24, 30, 29, (x, y) => ((x + y) % 3 ? P.murk : P.murkLight));
  return art(b, 20, 29, [{ x: 19, y: 12, kind: 'candle' }]);
}

// ── Buildings ─────────────────────────────────────────────────────────────────

export type HouseOpts = {
  w: number;
  wallH: number;
  roofH: number;
  roof?: number;
  wall?: number;
  frame?: number | null;
  stone?: boolean;
  door?: 'center' | 'left' | 'right';
  windows?: number;
  chimney?: boolean;
  windowColor?: number;
};

/** A front-facing house: shingled roof over a timber-framed (or stone) wall, door and windows. */
export function house(o: HouseOpts): Art {
  const roof = o.roof ?? P.roof;
  const wall = o.wall ?? P.plaster;
  const frame = o.frame === undefined ? P.timber : o.frame;
  const W = o.w + 4;
  const H = o.roofH + o.wallH + (o.chimney ? 4 : 0);
  const b = new PixelBuf(W, H + 1);
  const top = o.chimney ? 4 : 0;
  const lights: Light[] = [];
  // wall
  const wy0 = top + o.roofH - 1;
  const wy1 = top + o.roofH + o.wallH - 1;
  b.rect(2, wy0, o.w + 1, wy1, (x, y) => {
    if (o.stone) return (x + (Math.floor(y / 3) % 2) * 3) % 6 === 0 || y % 3 === 0 ? shade(wall, 0.82) : wall;
    if (frame !== null && (x === 2 || x === o.w + 1 || y === wy0 + Math.floor(o.wallH / 2) - 1)) return frame;
    return x > o.w - 2 ? shade(wall, 0.9) : wall;
  });
  b.rect(2, wy1 - 1, o.w + 1, wy1, shade(wall, 0.75));
  // door
  const dw = 7;
  const dx = o.door === 'left' ? 6 : o.door === 'right' ? o.w - 9 : Math.floor(W / 2 - dw / 2);
  b.rect(dx, wy1 - 10, dx + dw - 1, wy1, P.door);
  b.rect(dx, wy1 - 10, dx + dw - 1, wy1 - 10, shade(P.door, 0.7));
  b.px(dx + dw - 2, wy1 - 5, P.gold);
  b.rect(dx - 1, wy1 + 1 - 1, dx + dw, wy1, shade(P.stone, 0.9));
  // windows
  const nWin = o.windows ?? 2;
  const slots: number[] = [];
  for (let i = 0; i < nWin; i++) {
    const x = Math.round(((i + 1) * W) / (nWin + 1)) - 3;
    if (x + 5 >= dx - 1 && x <= dx + dw) continue;
    slots.push(x);
  }
  for (const x of slots) {
    const y = wy0 + 4;
    b.rect(x - 1, y - 1, x + 5, y + 5, frame ?? shade(wall, 0.7));
    b.rect(x, y, x + 4, y + 4, o.windowColor ?? P.window);
    b.rect(x + 2, y, x + 2, y + 4, frame ?? shade(wall, 0.7));
    b.rect(x, y + 2, x + 4, y + 2, frame ?? shade(wall, 0.7));
    b.px(x, y, shade(o.windowColor ?? P.window, 1.4));
    lights.push({ x: x + 2, y: y + 2, kind: 'window', w: 5, h: 5 });
  }
  // roof: overhanging shingle band with a ridge
  for (let y = 0; y < o.roofH; y++) {
    const inset = Math.max(0, Math.floor((o.roofH - y) / 3) - 1);
    const x0 = Math.min(inset, 4);
    const x1 = W - 1 - Math.min(inset, 4);
    b.rect(x0, top + y, x1, top + y, (x) => {
      if (y === 0) return shade(roof, 0.75);
      if (y % 4 === 3) return shade(roof, 0.78);
      if ((x + (Math.floor(y / 4) % 2) * 3) % 6 === 0) return shade(roof, 0.86);
      if (y < 3) return shade(roof, 1.12);
      return x > W * 0.72 ? shade(roof, 0.92) : roof;
    });
  }
  b.rect(0, top + o.roofH - 1, W - 1, top + o.roofH - 1, shade(roof, 0.6));
  if (o.chimney) {
    b.rect(W - 12, 0, W - 8, top + 3, P.stoneDark);
    b.rect(W - 12, 0, W - 8, 0, P.stone);
  }
  return art(b, Math.floor(W / 2), H, lights);
}

/** Stamps `top` over `base` at an offset (both share base's anchor). */
export function compose(base: Art, top: Art, x: number, y: number): Art {
  base.buf.blit(top.buf, 0, 0, top.buf.w, top.buf.h, x - top.ax + base.ax, y - top.ay + base.ay);
  for (const l of top.lights)
    base.lights.push({ ...l, x: l.x + x - top.ax + base.ax, y: l.y + y - top.ay + base.ay });
  return base;
}

/** Wraps an art in a larger canvas so extras can be composed around it. */
export function pad(a: Art, left: number, top: number, right: number, bottom: number): Art {
  const b = new PixelBuf(a.buf.w + left + right, a.buf.h + top + bottom);
  b.blit(a.buf, 0, 0, a.buf.w, a.buf.h, left, top);
  return {
    buf: b,
    ax: a.ax + left,
    ay: a.ay + top,
    lights: a.lights.map((l) => ({ ...l, x: l.x + left, y: l.y + top })),
  };
}

export function banner(color: number): Art {
  const b = new PixelBuf(8, 16);
  b.rect(0, 0, 7, 0, P.woodDark);
  b.rect(1, 1, 6, 12, color);
  b.px(1, 13, color);
  b.px(6, 13, color);
  b.px(3, 13, color);
  b.px(4, 13, color);
  b.rect(3, 4, 4, 7, P.gold);
  return art(b, 4, 15);
}

export function bellTower(): Art {
  const b = new PixelBuf(18, 24);
  b.rect(2, 8, 15, 23, P.stoneLight);
  b.rect(5, 10, 12, 18, 0x2a2638);
  b.ellipse(6, 11, 11, 17, P.gold);
  b.px(8, 18, P.gold);
  for (let y = 0; y < 8; y++) b.rect(8 - y, y, 9 + y, y, y % 3 === 2 ? 0x4a5874 : 0x5b6b8a);
  return art(b, 9, 23);
}

export function hangingSign(color: number): Art {
  const b = new PixelBuf(14, 14);
  b.rect(0, 0, 13, 1, P.woodDark);
  b.rect(3, 2, 3, 4, P.woodDark);
  b.rect(10, 2, 10, 4, P.woodDark);
  b.rect(1, 5, 12, 13, P.wood);
  b.rect(4, 7, 8, 11, color);
  b.rect(9, 8, 9, 10, color);
  return art(b, 7, 13);
}

export function watchtower(): Art {
  const b = new PixelBuf(40, 76);
  b.rect(8, 24, 31, 75, (x, y) =>
    (x + (Math.floor(y / 4) % 2) * 3) % 6 === 0 || y % 4 === 0
      ? P.stoneDark
      : x > 25
        ? shade(P.stone, 0.85)
        : P.stone,
  );
  b.rect(16, 62, 23, 75, P.door);
  b.rect(17, 36, 22, 42, P.window);
  b.rect(2, 14, 37, 26, P.wood);
  b.rect(2, 14, 37, 15, P.woodLight);
  for (let x = 2; x < 38; x += 6) b.rect(x, 8, x + 3, 14, P.woodDark);
  b.rect(19, 0, 19, 9, P.woodDark);
  b.rect(20, 0, 27, 4, 0x5b8def);
  return art(b, 20, 75, [
    { x: 20, y: 39, kind: 'window', w: 6, h: 7 },
    { x: 10, y: 18, kind: 'torch' },
    { x: 30, y: 18, kind: 'torch' },
  ]);
}

export function arena(): Art {
  const b = new PixelBuf(110, 60);
  b.ellipse(0, 0, 109, 59, P.stone);
  b.ellipse(8, 6, 101, 53, P.stoneDark);
  b.ellipse(12, 9, 97, 50, 0xc9b48a);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    b.rect(
      Math.round(54 + Math.cos(a) * 51),
      Math.round(29 + Math.sin(a) * 27),
      Math.round(55 + Math.cos(a) * 51),
      Math.round(31 + Math.sin(a) * 27),
      P.stoneLight,
    );
  }
  b.rect(48, 52, 61, 59, 0x2a2030);
  return art(b, 55, 59);
}

export function library(): Art {
  const base = house({
    w: 70,
    wallH: 30,
    roofH: 22,
    roof: 0x4f6fa8,
    wall: 0xe8dcc0,
    frame: 0x5a4a3a,
    windows: 3,
    door: 'center',
    chimney: true,
    windowColor: 0x3b4660,
  });
  return compose(base, hangingSign(0x8a3a3a), 18, -18);
}

export function statue(): Art {
  const b = new PixelBuf(28, 46);
  b.rect(2, 32, 25, 45, P.stone);
  b.rect(2, 32, 25, 33, P.stoneLight);
  b.rect(10, 12, 17, 31, 0xd8d0c0);
  b.rect(7, 15, 20, 19, 0xd8d0c0);
  b.rect(11, 5, 16, 11, 0xd8d0c0);
  b.rect(20, 2, 21, 18, 0xd8d0c0);
  b.rect(16, 12, 17, 31, 0xb8b0a0);
  b.rect(10, 4, 17, 4, P.gold);
  return art(b, 14, 45);
}

export function stoneWall(len: number): Art {
  const b = new PixelBuf(len, 26);
  b.rect(0, 6, len - 1, 25, (x, y) =>
    (x + (Math.floor(y / 4) % 2) * 4) % 8 === 0 || y % 4 === 0 ? P.stoneDark : P.stone,
  );
  for (let x = 0; x < len; x += 8) b.rect(x, 0, x + 4, 6, P.stone);
  b.rect(0, 6, len - 1, 6, P.stoneLight);
  return art(b, Math.floor(len / 2), 25);
}

export function bridge(w: number, h: number): Art {
  const b = new PixelBuf(w, h + 8);
  b.rect(0, 4, w - 1, h + 3, (x, y) => (y % 4 === 0 ? P.woodDark : x % 2 ? P.wood : P.woodLight));
  b.rect(0, 0, 2, h + 7, P.woodDark);
  b.rect(w - 3, 0, w - 1, h + 7, P.woodDark);
  for (let y = 2; y < h + 6; y += 6) {
    b.rect(0, y, 2, y, P.woodLight);
    b.rect(w - 3, y, w - 1, y, P.woodLight);
  }
  return art(b, Math.floor(w / 2), h + 7);
}

export function emptyLot(w: number, h: number): Art {
  const b = new PixelBuf(w, h);
  b.rect(2, 2, w - 3, h - 3, (x, y) =>
    (x * 7 + y * 13) % 11 === 0 ? P.dirtDark : (x * 3 + y * 5) % 17 === 0 ? 0xbfa57c : P.dirt,
  );
  for (let x = 0; x < w; x += 8) {
    b.rect(x, 0, x + 1, 3, P.woodDark);
    b.rect(x, h - 4, x + 1, h - 1, P.woodDark);
  }
  b.rect(0, 1, w - 1, 1, 0xd8c8a0);
  b.rect(0, h - 3, w - 1, h - 3, 0xd8c8a0);
  for (let y = 0; y < h; y += 8) {
    b.rect(0, y, 1, y + 1, P.woodDark);
    b.rect(w - 2, y, w - 1, y + 1, P.woodDark);
  }
  // the sign: a board on a post with a little house glyph
  const sx = w - 22;
  b.rect(sx + 8, 10, sx + 9, 26, P.woodDark);
  b.rect(sx, 4, sx + 17, 14, P.wood);
  b.rect(sx + 1, 5, sx + 16, 13, P.woodLight);
  b.rect(sx + 6, 9, sx + 11, 12, P.roof);
  b.rect(sx + 7, 7, sx + 10, 8, P.roof);
  b.rect(sx + 8, 11, sx + 9, 12, P.door);
  return art(b, Math.floor(w / 2), h - 1);
}

export function scaffold(w: number, h: number, seed: number): Art {
  const r = rng(seed);
  const b = new PixelBuf(w, h);
  b.rect(2, h - 8, w - 3, h - 1, P.dirt);
  // partial stone base
  b.rect(6, h - 22, w - 7, h - 6, (x, y) =>
    (x + (Math.floor(y / 4) % 2) * 4) % 8 === 0 || y % 4 === 0 ? P.stoneDark : P.stone,
  );
  for (let x = 6; x < w - 7; x++) {
    const cut = Math.floor(r() * 6);
    if (cut > 0) b.erase(x, h - 22, x, h - 23 + cut);
  }
  // poles and planks
  for (let x = 2; x < w; x += 18) b.rect(x, 4, x + 1, h - 4, P.wood);
  for (let y = 10; y < h - 6; y += 12) b.rect(0, y, w - 1, y + 1, P.woodLight);
  b.line(4, h - 6, w - 8, 12, P.woodDark);
  // crane hook
  b.rect(w - 10, 0, w - 9, 10, P.woodDark);
  b.rect(w - 22, 0, w - 9, 1, P.woodDark);
  b.rect(w - 21, 2, w - 21, 8, 0x3a3346);
  b.rect(w - 23, 9, w - 19, 12, P.stone);
  // materials
  b.rect(w - 26, h - 10, w - 16, h - 5, P.wood);
  b.rect(w - 26, h - 10, w - 16, h - 10, P.woodLight);
  return art(b, Math.floor(w / 2), h - 1);
}

/** Finished project building by building id; unknown ids get a generic hall. */
export function projectBuilding(building: string): Art {
  switch (building) {
    case 'watchtower':
      return watchtower();
    case 'library':
      return library();
    case 'arena':
      return arena();
    case 'statue':
      return statue();
    case 'wall':
      return stoneWall(150);
    case 'inn':
      return house({
        w: 56,
        wallH: 28,
        roofH: 20,
        roof: P.roofDark,
        windows: 2,
        door: 'left',
        chimney: true,
      });
    case 'covered_market':
      return house({
        w: 120,
        wallH: 18,
        roofH: 18,
        roof: 0x8a5a3a,
        frame: P.woodDark,
        wall: 0x6b4a33,
        windows: 0,
        door: 'center',
      });
    default:
      return house({
        w: 64,
        wallH: 28,
        roofH: 20,
        roof: mix(P.roof, 0x5b6b8a, 0.5),
        windows: 2,
        chimney: true,
      });
  }
}

// ── Village growth: upgraded sites, guild halls, the statue ──────────────────────

/** `#rrggbb` (already validated) to a colour number; falls back on bad input. */
export function hexColor(hex: string, fallback = 0xd9534f): number {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? Number.parseInt(hex.slice(1), 16) : fallback;
}

/** A guild banner on a pole in two colours: the field and a cross of the second colour. */
export function guildBanner(c1: number, c2: number, tall = 16): Art {
  const b = new PixelBuf(10, tall + 4);
  b.rect(0, 0, 9, 0, P.woodDark);
  b.rect(1, 1, 8, tall - 2, c1);
  b.rect(1, Math.floor(tall / 2) - 2, 8, Math.floor(tall / 2), c2);
  b.rect(4, 2, 5, tall - 3, c2);
  b.rect(1, 1, 8, 1, shade(c1, 1.2));
  b.rect(1, tall - 1, 2, tall, c1);
  b.rect(4, tall - 1, 5, tall + 1, c1);
  b.rect(7, tall - 1, 8, tall, c1);
  return art(b, 5, tall + 3);
}

/** A guild hall: a stone-footed hall with a pennant, the crest over the door and banners in the guild colours. */
export function guildHall(c1: number, c2: number): Art {
  const roof = mix(c1, 0x4a3d66, 0.45);
  const base = house({ w: 76, wallH: 30, roofH: 24, roof, wall: 0xe6dcc6, frame: 0x5a4a3a, windows: 4, door: 'center', chimney: true });
  const W = base.buf.w;
  const b = pad(base, 10, 14, 10, 0);
  // pennant on the ridge
  b.buf.rect(10 + Math.floor(W / 2), 0, 10 + Math.floor(W / 2), 15, P.woodDark);
  b.buf.rect(11 + Math.floor(W / 2), 1, 18 + Math.floor(W / 2), 4, c1);
  b.buf.rect(11 + Math.floor(W / 2), 3, 15 + Math.floor(W / 2), 4, c2);
  // crest over the door
  const cx = 10 + Math.floor(W / 2);
  const crestY = 14 + 24 + 4 + 1;
  b.buf.rect(cx - 4, crestY - 1, cx + 3, crestY + 6, OUTLINE);
  b.buf.rect(cx - 3, crestY, cx + 2, crestY + 5, c1);
  b.buf.rect(cx - 3, crestY + 2, cx + 2, crestY + 3, c2);
  // stone footing
  const foot = b.buf.h - 2;
  b.buf.rect(12, foot, W + 7, foot + 1, (x) => ((x >> 2) % 2 ? P.stoneDark : P.stone));
  compose(b, guildBanner(c1, c2, 20), -Math.floor(W / 2) - 4, -2);
  compose(b, guildBanner(c1, c2, 20), Math.floor(W / 2) + 4, -2);
  return b;
}

/** The tavern's new wing (inn expansion): a two-storey guest house with a balcony and a bed sign. */
export function innWing(): Art {
  const base = house({ w: 50, wallH: 36, roofH: 20, roof: P.roofDark, windows: 2, door: 'right', chimney: true });
  const W = base.buf.w;
  const b = base.buf;
  // upper floor windows and a balcony rail
  const wy = 4 + 20 + 3;
  for (const x of [8, W - 15]) {
    b.rect(x - 1, wy - 1, x + 5, wy + 5, P.timber);
    b.rect(x, wy, x + 4, wy + 4, P.window);
    b.px(x, wy, shade(P.window, 1.4));
    base.lights.push({ x: x + 2, y: wy + 2, kind: 'window', w: 5, h: 5 });
  }
  b.rect(3, wy + 7, W - 4, wy + 7, P.woodDark);
  for (let x = 4; x < W - 4; x += 3) b.rect(x, wy + 8, x, wy + 10, P.wood);
  b.rect(3, wy + 11, W - 4, wy + 11, P.woodDark);
  return compose(base, hangingSign(0x7fa6e8), -Math.floor(W / 2) + 10, -18);
}

/** The covered market: a long timber roof on posts over the stalls, open at the front. */
export function coveredMarket(len: number, seed: number): Art {
  const r = rng(seed);
  const H = 50;
  const b = new PixelBuf(len, H);
  const roofH = 16;
  // back wall in shade
  b.rect(3, roofH, len - 4, H - 14, (x, y) => ((x + (y >> 2)) % 7 === 0 ? 0x5a4030 : 0x6b4a33));
  // stalls' counters under the roof
  for (let x = 6; x < len - 10; x += 26) {
    b.rect(x, H - 22, x + 20, H - 15, P.wood);
    b.rect(x, H - 22, x + 20, H - 22, P.woodLight);
    for (let i = 0; i < 6; i++)
      b.rect(x + 2 + i * 3, H - 25, x + 3 + i * 3, H - 23, [P.flowerRed, P.flowerYellow, 0x7fb069, 0xd9823b, P.flowerWhite][Math.floor(r() * 5)]!);
  }
  // posts
  for (let x = 2; x < len - 2; x += 24) b.rect(x, roofH - 2, x + 2, H - 2, P.woodDark);
  b.rect(len - 5, roofH - 2, len - 3, H - 2, P.woodDark);
  // roof: shingles with a striped valance
  for (let y = 0; y < roofH; y++) {
    const inset = Math.max(0, 3 - Math.floor(y / 2));
    b.rect(inset, y, len - 1 - inset, y, (x) =>
      y === 0 ? shade(0x8a5a3a, 0.75) : y % 4 === 3 ? shade(0x8a5a3a, 0.8) : (x + (y >> 2) * 3) % 7 === 0 ? shade(0x8a5a3a, 0.88) : 0x8a5a3a,
    );
  }
  b.rect(0, roofH, len - 1, roofH + 3, (x) => (Math.floor(x / 5) % 2 ? 0xd9534f : P.flowerWhite));
  for (let x = 0; x < len; x += 5) if (Math.floor(x / 5) % 2) b.rect(x + 1, roofH + 4, x + 3, roofH + 4, 0xd9534f);
  b.rect(0, roofH - 1, len - 1, roofH - 1, shade(0x8a5a3a, 0.6));
  return art(b, Math.floor(len / 2), H - 1, [
    { x: Math.floor(len * 0.25), y: roofH + 6, kind: 'lamp' },
    { x: Math.floor(len * 0.75), y: roofH + 6, kind: 'lamp' },
  ]);
}

/** A stretch of stone wall with crenellations (front face), `h` tall. */
export function wallRun(len: number, h = 24): Art {
  const b = new PixelBuf(len, h);
  b.rect(0, 5, len - 1, h - 1, (x, y) =>
    (x + (Math.floor(y / 4) % 2) * 4) % 8 === 0 || y % 4 === 0 ? P.stoneDark : y > h - 5 ? shade(P.stone, 0.85) : P.stone,
  );
  for (let x = 0; x < len; x += 7) b.rect(x, 0, Math.min(len - 1, x + 3), 5, (xx, y) => (y === 0 ? P.stoneLight : P.stone));
  b.rect(0, 5, len - 1, 5, P.stoneLight);
  // a few mossy stones
  for (let x = 3; x < len; x += 11) b.px(x, h - 3, P.ivy);
  return art(b, Math.floor(len / 2), h - 1);
}

/** A square gate tower with a crenellated top, an arrow slit and a torch. */
export function gateTower(flag = 0x5b8def): Art {
  const W = 22;
  const H = 46;
  const b = new PixelBuf(W, H);
  b.rect(1, 8, W - 2, H - 1, (x, y) =>
    (x + (Math.floor(y / 4) % 2) * 4) % 8 === 0 || y % 4 === 0 ? P.stoneDark : x > W - 7 ? shade(P.stone, 0.85) : P.stone,
  );
  for (let x = 0; x < W; x += 6) b.rect(x, 3, Math.min(W - 1, x + 3), 8, P.stone);
  b.rect(0, 8, W - 1, 9, P.stoneLight);
  b.rect(10, 16, 11, 24, 0x1a1420);
  b.rect(10, 0, 10, 4, P.woodDark);
  b.rect(11, 0, 15, 2, flag);
  return art(b, Math.floor(W / 2), H - 1, [{ x: 10, y: 20, kind: 'torch' }]);
}

/** A stepped stone plinth with a gold plaque; the figure on top is drawn separately. */
export function plinth(): Art {
  const b = new PixelBuf(30, 20);
  b.rect(0, 14, 29, 19, P.stoneDark);
  b.rect(0, 14, 29, 14, P.stone);
  b.rect(3, 4, 26, 14, (x, y) => (y % 5 === 4 ? P.stoneDark : x > 21 ? shade(P.stoneLight, 0.88) : P.stoneLight));
  b.rect(2, 2, 27, 4, P.stone);
  b.rect(2, 2, 27, 2, P.stoneLight);
  b.rect(9, 7, 20, 11, 0xb9842a);
  b.rect(10, 8, 19, 10, P.gold);
  b.rect(11, 9, 18, 9, 0xb9842a);
  return art(b, 15, 19);
}

/** Round flower bed edged with stones (statue garden). */
export function flowerBed(seed: number): Art {
  const b = new PixelBuf(22, 10);
  b.ellipse(0, 0, 21, 9, P.stone);
  b.ellipse(2, 1, 19, 8, 0x5f8a46);
  flowers(b, 3, 1, seed, [P.flowerRed, P.flowerYellow, P.flowerWhite]);
  flowers(b, 10, 2, seed + 1, [P.flowerBlue, P.flowerWhite]);
  return art(b, 11, 9);
}

/**
 * Recolours an agent sheet's first frame as cast bronze: every opaque pixel is mapped by its luminance onto a
 * four-step ramp, the outline stays dark. Works on raw RGBA (20x28).
 */
export function bronzeFrame(rgba: Uint8ClampedArray, w = 20, h = 28): PixelBuf {
  const ramp = [0x3a2a1c, 0x6a4a2a, 0x9a6a3a, 0xc8944e, 0xe8c07a];
  const b = new PixelBuf(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (rgba[i + 3]! < 128) continue;
      const l = (0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!) / 255;
      const k = l < 0.18 ? 0 : Math.min(ramp.length - 1, 1 + Math.floor(l * (ramp.length - 1)));
      b.px(x, y, ramp[k]!);
    }
  return b;
}
