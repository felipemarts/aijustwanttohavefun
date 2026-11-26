/**
 * Paper-doll sprite composer. Original procedural pixel art (CC0, see ASSETS.md).
 * Output: a horizontal sheet of FRAMES frames, each FRAME_W x FRAME_H pixels:
 *   0 idle, 1 left step, 2 right step, 3 idle blink.
 * The server renders once per appearance hash and caches the PNG; the web never composes layers.
 */
import { PNG } from 'pngjs';
import {
  accessoryById,
  bottomById,
  cloakById,
  dyeById,
  hairById,
  hairColorById,
  hatById,
  speciesById,
  topById,
  SKIN_IDS,
  type Appearance,
  type Rgb,
} from './catalog';

export const FRAME_W = 20;
export const FRAME_H = 28;
export const FRAMES = 4;
const OX = 2; // art is designed on a 16x24 grid, offset inside the frame
const OY = 4;

const OUTLINE: Rgb = [28, 22, 36];
const BOOT: Rgb = [70, 46, 32];
const WHITE: Rgb = [240, 240, 236];
const GOLD: Rgb = [232, 184, 74];
const EYE: Rgb = [30, 26, 40];

const shade = (c: Rgb, f: number): Rgb => [
  Math.max(0, Math.min(255, Math.round(c[0] * f))),
  Math.max(0, Math.min(255, Math.round(c[1] * f))),
  Math.max(0, Math.min(255, Math.round(c[2] * f))),
];

class Frame {
  readonly data = new Uint8Array(FRAME_W * FRAME_H * 4);
  dy = 0;
  /** Optional mask: pixels where draw() is suppressed (used for hood face windows). */
  private window: ((x: number, y: number) => boolean) | null = null;

  px(x: number, y: number, c: Rgb) {
    if (this.window && this.window(x, y)) return;
    const X = x + OX;
    const Y = y + OY + this.dy;
    if (X < 0 || Y < 0 || X >= FRAME_W || Y >= FRAME_H) return;
    const i = (Y * FRAME_W + X) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = 255;
  }

  rect(x0: number, y0: number, x1: number, y1: number, c: Rgb | ((x: number, y: number) => Rgb)) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.px(x, y, typeof c === 'function' ? c(x, y) : c);
  }

  withWindow(w: (x: number, y: number) => boolean, fn: () => void) {
    this.window = w;
    fn();
    this.window = null;
  }

  outline() {
    const src = new Uint8Array(this.data);
    const opaque = (X: number, Y: number) => X >= 0 && Y >= 0 && X < FRAME_W && Y < FRAME_H && src[(Y * FRAME_W + X) * 4 + 3]! > 0;
    for (let Y = 0; Y < FRAME_H; Y++)
      for (let X = 0; X < FRAME_W; X++) {
        if (opaque(X, Y)) continue;
        if (opaque(X - 1, Y) || opaque(X + 1, Y) || opaque(X, Y - 1) || opaque(X, Y + 1)) {
          const i = (Y * FRAME_W + X) * 4;
          this.data[i] = OUTLINE[0];
          this.data[i + 1] = OUTLINE[1];
          this.data[i + 2] = OUTLINE[2];
          this.data[i + 3] = 255;
        }
      }
  }
}

type Ctx = {
  f: Frame;
  H: number; // head top
  T: number; // torso top
  B: number; // torso bottom
  L: number; // leg bottom
  tl: number; // torso left
  tr: number; // torso right
  skin: Rgb;
  hair: Rgb;
  p: Rgb; // dye primary
  s: Rgb; // dye secondary
  step: number; // -1 left step, 1 right step, 0 idle
  blink: boolean;
};

function drawCloakBack(c: Ctx, shape: string, color: Rgb) {
  const { f, T, B, L, tl, tr, H } = c;
  if (shape === 'none' || shape === 'shawl') return;
  const bottom = shape === 'short' ? B - 2 : shape === 'cape' ? B + 2 : L;
  f.rect(tl - 1, T, tr + 1, bottom, (x, y) => (shape === 'leaf' || shape === 'feather') && (x + y) % 3 === 0 ? shade(color, 1.25) : shade(color, 0.85));
  if (shape === 'tattered') for (let x = tl - 1; x <= tr + 1; x += 2) f.px(x, bottom + 1, shade(color, 0.85));
  if (shape === 'hooded') f.rect(4, H - 1, 11, H + 3, shade(color, 0.8));
}

function drawCloakFront(c: Ctx, shape: string, color: Rgb) {
  const { f, T, tl, tr } = c;
  if (shape === 'none') return;
  if (shape === 'shawl') {
    f.rect(tl - 1, T, tr + 1, T + 1, color);
    f.rect(tl, T + 2, tl + 1, T + 3, color);
    f.rect(tr - 1, T + 2, tr, T + 3, color);
    return;
  }
  if (shape === 'fur') f.rect(tl - 1, T, tr + 1, T, (x) => (x % 2 ? [222, 210, 190] : [190, 170, 140]));
  else if (shape === 'royal') f.rect(tl - 1, T, tr + 1, T, (x) => (x % 2 ? WHITE : [40, 40, 44]));
  else {
    f.px(tl - 1, T, color);
    f.px(tr + 1, T, color);
  }
  f.px(7, T, GOLD); // clasp
}

function drawLegs(c: Ctx, shape: string) {
  const { f, B, L, tl, tr, skin, p, s, step } = c;
  const pants = shade(p, 0.7);
  const wide = tr - tl >= 9;
  const lx0 = wide ? 4 : 5;
  const rx1 = wide ? 11 : 10;
  const leftEnd = L - (step === -1 ? 1 : 0);
  const rightEnd = L - (step === 1 ? 1 : 0);
  const leg = (x0: number, x1: number, end: number, color: (y: number) => Rgb) => {
    for (let y = B + 1; y <= end; y++) f.rect(x0, y, x1, y, color(y));
    f.rect(x0, end + 1, x1, end + 1, BOOT);
  };
  const colorAt = (y: number): Rgb => {
    switch (shape) {
      case 'shorts':
        return y <= B + 2 ? pants : skin;
      case 'skirt':
      case 'kilt':
        return y <= B + 3 ? pants : skin;
      case 'leggings':
        return shade(p, 0.45);
      case 'breeches':
        return y >= L ? WHITE : pants;
      default:
        return pants;
    }
  };
  leg(lx0, 6, leftEnd, colorAt);
  leg(9, rx1, rightEnd, colorAt);
  if (shape === 'baggy') {
    f.rect(lx0 - 1, B + 1, lx0 - 1, leftEnd - 1, pants);
    f.rect(rx1 + 1, B + 1, rx1 + 1, rightEnd - 1, pants);
  }
  if (shape === 'skirt' || shape === 'kilt') f.rect(tl, B + 1, tr, B + 3, (x, y) => (shape === 'kilt' && (x + y) % 2 ? shade(s, 0.8) : pants));
  if (shape === 'long_skirt' || shape === 'robe') f.rect(tl, B + 1, tr, L, (x, y) => (x === tl || x === tr) && y < B + 3 ? pants : shape === 'robe' && y === L ? s : pants);
  if (shape === 'sarong') f.rect(tl, B + 1, tr, L - 1, (x, y) => (x - y) % 4 === 0 ? s : pants);
}

function drawTop(c: Ctx, id: string) {
  const def = topById.get(id);
  if (!def) return;
  const { f, T, B, tl, tr, p, s, skin } = c;
  const base = def.fixed ?? p;
  const bottom = def.long ? B + 2 : B;
  f.rect(tl, T, tr, bottom, (x, y) => {
    switch (def.pattern) {
      case 'stripes':
        return (y - T) % 2 ? s : base;
      case 'belt':
        return y === B - 1 ? (x === 7 || x === 8 ? GOLD : [60, 40, 30]) : base;
      case 'buttons':
        return x === 7 && (y - T) % 2 === 1 ? s : base;
      case 'trim':
        return y === bottom || x === 7 ? s : base;
      case 'chain':
        return (x + y) % 2 ? shade(base, 0.8) : base;
      case 'scales':
        return (x + (y % 2)) % 2 ? shade(base, 0.75) : base;
      case 'sash':
        return x - tl === y - T || x - tl === y - T + 1 ? s : base;
      case 'collar':
        return y === T && x >= 6 && x <= 9 ? s : base;
      case 'apron':
        return x >= 6 && x <= 9 && y >= T + 2 ? WHITE : base;
      case 'laces':
        return (x === 7 || x === 8) && (x + y) % 2 ? s : base;
      case 'cross':
        return x === 7 || x === 8 || y === T + 2 ? s : base;
      default:
        return base;
    }
  });
  if (def.pattern === 'plain' && id === 'patched_jerkin') {
    f.px(tl + 1, T + 2, s);
    f.px(tr - 2, T + 4, shade(s, 0.8));
  }
  // Arms
  const armColor = (y: number): Rgb => {
    if (def.sleeves === 'long') return y >= B ? skin : base;
    if (def.sleeves === 'short') return y <= T + 2 ? base : skin;
    return skin;
  };
  for (let y = T + 1; y <= B; y++) {
    f.px(tl - 1, y, armColor(y));
    f.px(tr + 1, y, armColor(y));
  }
}

function drawHead(c: Ctx, speciesId: string) {
  const sp = speciesById.get(speciesId);
  const { f, H, skin, blink } = c;
  f.rect(5, H, 10, H + 5, skin);
  f.rect(6, H + 6, 9, H + 6, shade(skin, 0.85)); // neck/chin shadow
  if (sp?.ears === 'pointy') {
    f.rect(4, H + 2, 4, H + 3, skin);
    f.rect(11, H + 2, 11, H + 3, skin);
    f.px(3, H + 1, skin);
    f.px(12, H + 1, skin);
  } else if (sp?.ears === 'big') {
    f.rect(4, H + 2, 4, H + 4, skin);
    f.rect(11, H + 2, 11, H + 4, skin);
  }
  if (blink) {
    f.rect(6, H + 3, 6, H + 3, shade(skin, 0.6));
    f.rect(9, H + 3, 9, H + 3, shade(skin, 0.6));
  } else {
    f.px(6, H + 3, EYE);
    f.px(9, H + 3, EYE);
  }
  f.rect(7, H + 5, 8, H + 5, shade(skin, 0.7));
  if (sp?.tusks) {
    f.px(6, H + 5, WHITE);
    f.px(9, H + 5, WHITE);
  }
}

function drawHairBack(c: Ctx, shape: string) {
  const { f, H, hair } = c;
  const d = shade(hair, 0.8);
  switch (shape) {
    case 'long':
      f.rect(4, H, 4, H + 7, hair);
      f.rect(11, H, 11, H + 7, hair);
      break;
    case 'braids':
      for (let y = H + 2; y <= H + 9; y++) {
        f.px(4, y, y % 2 ? hair : d);
        f.px(11, y, y % 2 ? d : hair);
      }
      break;
    case 'ponytail':
      f.rect(11, H + 1, 12, H + 5, hair);
      break;
    case 'afro':
      f.rect(3, H - 3, 12, H + 3, (x, y) => ((x + y) % 3 ? hair : d));
      break;
    case 'curly':
      f.rect(4, H - 1, 11, H + 3, (x, y) => ((x + y) % 2 ? hair : d));
      break;
    case 'bob':
      f.rect(4, H, 4, H + 4, hair);
      f.rect(11, H, 11, H + 4, hair);
      break;
    case 'pigtails':
      f.rect(2, H + 1, 3, H + 3, hair);
      f.rect(12, H + 1, 13, H + 3, hair);
      break;
  }
}

function drawHairFront(c: Ctx, shape: string) {
  const { f, H, hair } = c;
  const d = shade(hair, 0.8);
  if (shape === 'bald') {
    f.px(7, H, shade(c.skin, 1.12)); // shine
    return;
  }
  if (shape === 'mohawk') {
    f.rect(7, H - 3, 8, H, hair);
    return;
  }
  f.rect(5, H - 1, 10, H, hair);
  f.px(5, H + 1, hair);
  f.px(10, H + 1, hair);
  switch (shape) {
    case 'short':
    case 'curly':
    case 'afro':
      f.rect(5, H + 1, 5, H + 2, hair);
      f.rect(10, H + 1, 10, H + 2, hair);
      break;
    case 'spiky':
      for (const x of [5, 7, 9]) f.px(x, H - 2, hair);
      for (const x of [6, 8, 10]) f.px(x, H - 3, d);
      break;
    case 'bun':
      f.rect(6, H - 3, 9, H - 2, hair);
      break;
    case 'topknot':
      f.rect(7, H - 3, 8, H - 2, hair);
      f.px(7, H - 4, d);
      break;
    case 'side':
      f.rect(5, H + 1, 7, H + 1, hair);
      break;
    case 'shaggy':
      for (const x of [5, 6, 8, 10]) f.px(x, H + 1, hair);
      f.rect(5, H + 2, 5, H + 3, d);
      f.rect(10, H + 2, 10, H + 3, d);
      break;
  }
}

function drawAccessory(c: Ctx, kind: string) {
  const { f, H, T, hair, s, skin } = c;
  switch (kind) {
    case 'round_glasses':
      f.px(5, H + 3, EYE);
      f.px(7, H + 3, EYE);
      f.px(8, H + 3, EYE);
      f.px(10, H + 3, EYE);
      f.px(6, H + 2, [180, 210, 230]);
      f.px(9, H + 2, [180, 210, 230]);
      break;
    case 'pipe':
      f.rect(10, H + 5, 12, H + 5, [110, 70, 40]);
      f.px(12, H + 4, [110, 70, 40]);
      f.px(13, H + 2, [200, 200, 210]);
      break;
    case 'eyepatch':
      f.px(6, H + 3, EYE);
      f.rect(5, H + 2, 10, H + 2, [40, 30, 30]);
      break;
    case 'earring':
      f.px(4, H + 5, GOLD);
      break;
    case 'scar':
      f.rect(9, H + 2, 9, H + 4, [180, 80, 80]);
      break;
    case 'monocle':
      f.px(9, H + 3, GOLD);
      f.px(10, H + 4, GOLD);
      break;
    case 'freckles':
      f.px(6, H + 4, shade(skin, 0.75));
      f.px(9, H + 4, shade(skin, 0.75));
      break;
    case 'beard':
      f.rect(5, H + 4, 10, H + 6, hair);
      f.rect(6, H + 7, 9, H + 7, hair);
      f.rect(7, H + 5, 8, H + 5, shade(hair, 0.7));
      break;
    case 'mustache':
      f.rect(6, H + 4, 9, H + 4, hair);
      break;
    case 'goggles':
      f.rect(5, H + 1, 10, H + 1, [150, 110, 60]);
      f.px(6, H + 1, [140, 200, 220]);
      f.px(9, H + 1, [140, 200, 220]);
      break;
    case 'necklace':
      f.rect(6, T, 9, T, GOLD);
      f.px(7, T + 1, s);
      break;
    case 'flower':
      f.px(10, H, [240, 120, 160]);
      f.px(11, H, [250, 220, 90]);
      break;
    case 'nose_ring':
      f.px(7, H + 4, GOLD);
      break;
    case 'war_paint':
      f.rect(5, H + 3, 5, H + 4, s);
      f.rect(10, H + 3, 10, H + 4, s);
      break;
    case 'bandage':
      f.rect(5, H + 1, 10, H + 1, WHITE);
      f.px(11, H + 2, WHITE);
      break;
  }
}

function drawHat(c: Ctx, id: string) {
  const def = hatById.get(id);
  if (!def || def.shape === 'none') return;
  const { f, H, p, s } = c;
  const col = def.color ?? p;
  const d = shade(col, 0.75);
  switch (def.shape) {
    case 'hood':
    case 'cowl': {
      const hc = def.shape === 'cowl' ? s : col;
      f.withWindow(
        (x, y) => x >= 6 && x <= 9 && y >= H + 1 && y <= H + 5,
        () => f.rect(4, H - 1, 11, def.shape === 'cowl' ? H + 4 : H + 6, (x) => (x === 4 || x === 11 ? shade(hc, 0.8) : hc)),
      );
      break;
    }
    case 'cone': {
      f.rect(3, H - 1, 12, H - 1, d);
      const rows: [number, number][] = [[5, 10], [6, 9], [6, 9], [7, 8], [7, 8]];
      rows.forEach(([a, b], i) => f.rect(a, H - 2 - i, b, H - 2 - i, col));
      f.px(7, H - 3, id === 'starry_wizard_hat' ? GOLD : s);
      f.px(8, H - 5, GOLD);
      break;
    }
    case 'helm':
    case 'horns':
      f.rect(4, H - 1, 11, H + 1, (x, y) => (y === H + 1 ? d : col));
      f.rect(7, H + 2, 8, H + 2, d);
      if (def.shape === 'horns') {
        f.rect(3, H - 3, 3, H - 1, WHITE);
        f.rect(12, H - 3, 12, H - 1, WHITE);
        f.px(2, H - 4, WHITE);
        f.px(13, H - 4, WHITE);
      }
      break;
    case 'beret':
    case 'feather':
      f.rect(4, H - 1, 10, H, col);
      f.rect(6, H - 2, 8, H - 2, col);
      if (def.shape === 'feather') {
        f.rect(10, H - 4, 10, H - 2, s);
        f.px(11, H - 5, s);
      }
      break;
    case 'flowers':
      for (let x = 5; x <= 10; x++) f.px(x, H - 1, x % 3 === 0 ? [240, 110, 150] : x % 3 === 1 ? [250, 220, 90] : [120, 180, 90]);
      break;
    case 'cap':
      f.rect(5, H - 1, 10, H, col);
      f.rect(9, H, 12, H, d);
      break;
    case 'bandana':
      f.rect(5, H - 1, 10, H, col);
      f.rect(11, H, 12, H + 1, col);
      f.px(7, H - 1, s);
      break;
    case 'tricorn':
      f.rect(3, H - 1, 12, H - 1, col);
      f.rect(4, H - 2, 11, H - 2, col);
      f.px(3, H - 2, d);
      f.px(12, H - 2, d);
      f.rect(6, H - 3, 9, H - 3, col);
      f.px(7, H - 2, GOLD);
      break;
    case 'crown':
      f.rect(5, H - 1, 10, H - 1, col);
      for (const x of [5, 7, 8, 10]) f.px(x, H - 2, col);
      f.px(7, H - 1, [200, 40, 60]);
      break;
    case 'straw':
      f.rect(2, H, 13, H, col);
      f.rect(5, H - 2, 10, H - 1, col);
      f.rect(5, H - 1, 10, H - 1, (x) => (x % 2 ? [160, 60, 50] : col));
      break;
    case 'tophat':
      f.rect(4, H - 1, 11, H - 1, col);
      f.rect(5, H - 6, 10, H - 2, col);
      f.rect(5, H - 2, 10, H - 2, s);
      break;
    case 'band':
      f.rect(5, H + 1, 10, H + 1, s);
      break;
    case 'witch':
      f.rect(2, H - 1, 13, H - 1, col);
      f.rect(5, H - 2, 10, H - 2, col);
      f.rect(6, H - 3, 9, H - 3, col);
      f.rect(7, H - 4, 9, H - 4, col);
      f.rect(8, H - 5, 9, H - 5, col);
      f.px(10, H - 6, col);
      f.rect(5, H - 2, 10, H - 2, (x) => (x === 7 ? GOLD : s));
      break;
    case 'turban':
      f.rect(4, H - 2, 11, H, (x, y) => ((x + y) % 3 === 0 ? s : col));
      f.px(7, H - 1, [60, 160, 200]);
      break;
    case 'circlet':
      f.rect(5, H + 1, 10, H + 1, col);
      f.px(7, H + 1, [80, 180, 220]);
      break;
    case 'chef':
      f.rect(5, H - 4, 10, H - 1, (x, y) => ((x + y) % 4 === 0 ? [220, 220, 216] : col));
      f.rect(5, H, 10, H, [200, 200, 196]);
      break;
  }
}

function drawFrame(a: Appearance, frameIndex: number): Frame {
  const sp = speciesById.get(a.species) ?? speciesById.get('human')!;
  const dye = dyeById.get(a.dye) ?? dyeById.get('d0')!;
  const skinIdx = Math.max(0, SKIN_IDS.indexOf(a.skin));
  const f = new Frame();
  const step = frameIndex === 1 ? -1 : frameIndex === 2 ? 1 : 0;
  f.dy = step === 0 ? 0 : -1;
  const b = sp.body;
  const c: Ctx = {
    f,
    H: b.headTop,
    T: b.torsoTop,
    B: b.torsoBottom,
    L: b.legBottom,
    tl: b.wide ? 3 : 4,
    tr: b.wide ? 12 : 11,
    skin: sp.skins[skinIdx] ?? sp.skins[0]!,
    hair: hairColorById.get(a.hair_color)?.rgb ?? [60, 40, 30],
    p: dye.primary,
    s: dye.secondary,
    step,
    blink: frameIndex === 3,
  };
  const cloak = cloakById.get(a.cloak);
  const cloakColor = cloak?.fixed ?? shade(dye.primary, 0.9);
  const hairShape = hairById.get(a.hair_style)?.shape ?? 'short';
  drawCloakBack(c, cloak?.shape ?? 'none', cloakColor);
  drawHairBack(c, hairShape);
  drawLegs(c, bottomById.get(a.bottom)?.shape ?? 'pants');
  drawTop(c, a.top);
  drawHead(c, sp.id);
  drawHairFront(c, hairShape);
  drawAccessory(c, accessoryById.get(a.accessory)?.kind ?? 'none');
  drawHat(c, a.hat);
  drawCloakFront(c, cloak?.shape ?? 'none', cloakColor);
  f.outline();
  return f;
}

/** Returns the raw RGBA sheet (FRAMES * FRAME_W) x FRAME_H. */
export function renderSheetRgba(a: Appearance): { width: number; height: number; data: Uint8Array } {
  const width = FRAME_W * FRAMES;
  const data = new Uint8Array(width * FRAME_H * 4);
  for (let i = 0; i < FRAMES; i++) {
    const fr = drawFrame(a, i);
    for (let y = 0; y < FRAME_H; y++) {
      const src = y * FRAME_W * 4;
      data.set(fr.data.subarray(src, src + FRAME_W * 4), (y * width + i * FRAME_W) * 4);
    }
  }
  return { width, height: FRAME_H, data };
}

/** Renders the sprite sheet as PNG, optionally scaled up (nearest neighbour) for share cards. */
export function renderSpritePng(a: Appearance, scale = 1): Buffer {
  const sheet = renderSheetRgba(a);
  const png = new PNG({ width: sheet.width * scale, height: sheet.height * scale });
  if (scale === 1) png.data = Buffer.from(sheet.data);
  else
    for (let y = 0; y < png.height; y++)
      for (let x = 0; x < png.width; x++) {
        const si = (Math.floor(y / scale) * sheet.width + Math.floor(x / scale)) * 4;
        const di = (y * png.width + x) * 4;
        for (let k = 0; k < 4; k++) png.data[di + k] = sheet.data[si + k]!;
      }
  return PNG.sync.write(png);
}

/** Renders only frame 0 (portrait) at a given scale. */
export function renderPortraitPng(a: Appearance, scale = 8): Buffer {
  const fr = drawFrame(a, 0);
  const png = new PNG({ width: FRAME_W * scale, height: FRAME_H * scale });
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const si = (Math.floor(y / scale) * FRAME_W + Math.floor(x / scale)) * 4;
      const di = (y * png.width + x) * 4;
      for (let k = 0; k < 4; k++) png.data[di + k] = fr.data[si + k]!;
    }
  return PNG.sync.write(png);
}

export function portraitRgba(a: Appearance) {
  return drawFrame(a, 0).data;
}
