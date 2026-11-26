/**
 * Monster sprites: one small procedural design per monster kind in monsters.yaml, two idle frames each, with the
 * shared outline. Bosses are larger. Original pixel art (CC0).
 */
import { PixelBuf, shade } from '../../util/pixels';
import { hash32, rng } from '../../util/rng';
import { OUTLINE } from './palette';

export type MonsterSheet = { buf: PixelBuf; fw: number; fh: number; ax: number; ay: number };

type Draw = (b: PixelBuf, f: number) => void;

const EYE_RED = 0xff5a4a;
const EYE_GLOW = 0xbff6ff;

function sheet(fw: number, fh: number, draw: Draw): MonsterSheet {
  const buf = new PixelBuf(fw * 2, fh);
  for (let f = 0; f < 2; f++) {
    const b = new PixelBuf(fw, fh);
    draw(b, f);
    b.ox = 0;
    b.oy = 0;
    b.outline(OUTLINE);
    buf.blit(b, 0, 0, fw, fh, f * fw, 0);
  }
  return { buf, fw, fh, ax: Math.floor(fw / 2), ay: fh - 1 };
}

function quadruped(
  b: PixelBuf,
  f: number,
  o: {
    body: number;
    belly?: number;
    dark?: number;
    eye: number;
    long?: boolean;
    tusk?: boolean;
    bones?: boolean;
  },
) {
  const dark = o.dark ?? shade(o.body, 0.75);
  const lift = f === 1 ? 1 : 0;
  const L = o.long ? 2 : 0;
  // legs
  b.rect(5, 17, 6, 21 - lift, dark);
  b.rect(9, 17, 10, 21, o.body);
  b.rect(14 + L, 17, 15 + L, 21, dark);
  b.rect(17 + L, 17, 18 + L, 21 - lift, o.body);
  // body
  b.ellipse(3, 10, 20 + L, 18, o.body);
  if (o.belly) b.rect(7, 16, 16 + L, 17, o.belly);
  if (o.bones) for (let x = 7; x <= 16 + L; x += 2) b.rect(x, 12, x, 16, shade(o.body, 0.6));
  // tail
  b.line(2, 12, 0, 8 + lift, dark);
  // head
  b.ellipse(15 + L, 6, 22 + L, 13, o.body);
  b.rect(20 + L, 10, 23 + L, 12, o.belly ?? shade(o.body, 1.1));
  b.px(23 + L, 10, OUTLINE);
  b.px(16 + L, 4, dark);
  b.px(17 + L, 5, dark);
  b.px(19 + L, 4, dark);
  b.px(19 + L, 8, o.eye);
  if (o.tusk) {
    b.px(22 + L, 13, 0xf1e6cf);
    b.px(21 + L, 13, 0xf1e6cf);
  }
}

function humanoid(
  b: PixelBuf,
  f: number,
  o: {
    skin: number;
    body: number;
    legs?: number;
    eye?: number;
    head?: number;
    w?: number;
    tall?: number;
    weapon?: number;
    cape?: number;
  },
) {
  const t = o.tall ?? 0;
  const w = o.w ?? 0;
  const bob = f === 1 ? 1 : 0;
  const cx = Math.floor(b.w / 2);
  const top = b.h - 24 - t;
  const legs = o.legs ?? shade(o.body, 0.7);
  if (o.cape) b.rect(cx - 5 - w, top + 8 + bob, cx + 4 + w, top + 19 + t, o.cape);
  b.rect(cx - 3 - w, top + 16 + t, cx - 1 - w, b.h - 1, legs);
  b.rect(cx + 1 + w, top + 16 + t, cx + 3 + w, b.h - 1, legs);
  b.rect(cx - 4 - w, top + 8 + bob, cx + 4 + w, top + 16 + t, o.body);
  b.rect(cx - 6 - w, top + 9 + bob, cx - 5 - w, top + 15 + bob, o.skin);
  b.rect(cx + 5 + w, top + 9 + bob, cx + 6 + w, top + 15 + bob, o.skin);
  b.rect(cx - 3, top + 1 + bob, cx + 3, top + 7 + bob, o.head ?? o.skin);
  if (o.eye !== undefined) {
    b.px(cx - 2, top + 4 + bob, o.eye);
    b.px(cx + 1, top + 4 + bob, o.eye);
  }
  if (o.weapon !== undefined) b.rect(cx + 7 + w, top + 2 + bob, cx + 7 + w, top + 15 + bob, o.weapon);
}

const DESIGNS: Record<string, () => MonsterSheet> = {
  slime: () =>
    sheet(20, 16, (b, f) => {
      const c = 0x7ad05a;
      if (f === 0) b.ellipse(2, 4, 17, 15, c);
      else b.ellipse(1, 6, 18, 15, c);
      b.ellipse(5, f === 0 ? 6 : 8, 9, f === 0 ? 9 : 10, shade(c, 1.25));
      b.rect(2, 13, 17, 15, (x, y) => (b.get(x, y) >= 0 ? shade(c, 0.78) : -1));
      b.px(8, f === 0 ? 9 : 10, OUTLINE);
      b.px(12, f === 0 ? 9 : 10, OUTLINE);
    }),
  wolf: () => sheet(26, 22, (b, f) => quadruped(b, f, { body: 0x8a8a96, belly: 0xb8b8c2, eye: OUTLINE })),
  shadow_wolf: () =>
    sheet(26, 22, (b, f) => quadruped(b, f, { body: 0x3a2f4a, belly: 0x54466a, eye: EYE_RED })),
  boar: () =>
    sheet(28, 22, (b, f) =>
      quadruped(b, f, { body: 0x7a5236, belly: 0x9a6a46, eye: OUTLINE, long: true, tusk: true }),
    ),
  bone_hound: () =>
    sheet(28, 22, (b, f) =>
      quadruped(b, f, { body: 0xd8ceb8, dark: 0x9a907a, eye: EYE_RED, long: true, bones: true }),
    ),
  giant_spider: () =>
    sheet(26, 18, (b, f) => {
      const body = 0x3a2f46;
      for (let i = 0; i < 4; i++) {
        const lx = 4 + i * 2;
        const up = (i + f) % 2;
        b.line(11, 9, lx - 4, 14 - up * 2, 0x2a2234);
        b.line(14, 9, 21 + i * 1, 14 - (1 - up) * 2, 0x2a2234);
        b.line(lx - 4, 14 - up * 2, lx - 5, 17, 0x2a2234);
        b.line(21 + i, 14 - (1 - up) * 2, 22 + i, 17, 0x2a2234);
      }
      b.ellipse(8, 3, 19, 13, body);
      b.ellipse(10, 4, 14, 7, shade(body, 1.4));
      b.ellipse(15, 8, 21, 14, shade(body, 1.1));
      b.px(17, 10, EYE_RED);
      b.px(19, 10, EYE_RED);
      b.px(18, 11, EYE_RED);
    }),
  treant_sapling: () =>
    sheet(22, 28, (b, f) => {
      const bark = 0x6b4a2f;
      b.rect(8, 12, 13, 27, bark);
      b.rect(6, 25, 15, 27, shade(bark, 0.8));
      b.line(8, 15, 2, 10 + f, bark);
      b.line(13, 15, 19, 10 - f, bark);
      b.ellipse(2, 0 + f, 19, 13 + f, 0x4f9468);
      b.ellipse(4, 1 + f, 11, 6 + f, 0x6fb47a);
      b.px(9, 18, 0xf2d06b);
      b.px(12, 18, 0xf2d06b);
      b.rect(9, 21, 12, 21, shade(bark, 0.6));
    }),
  cave_bat: () =>
    sheet(22, 16, (b, f) => {
      const c = 0x5a4a6a;
      b.ellipse(8, 5, 13, 12, c);
      b.px(9, 4, c);
      b.px(12, 4, c);
      if (f === 0) {
        b.line(8, 7, 1, 2, c);
        b.line(1, 2, 3, 9, c);
        b.line(13, 7, 20, 2, c);
        b.line(20, 2, 18, 9, c);
        b.rect(2, 4, 7, 7, shade(c, 0.8));
        b.rect(14, 4, 19, 7, shade(c, 0.8));
      } else {
        b.line(8, 8, 1, 13, c);
        b.line(13, 8, 20, 13, c);
        b.rect(3, 9, 7, 11, shade(c, 0.8));
        b.rect(14, 9, 18, 11, shade(c, 0.8));
      }
      b.px(9, 7, EYE_RED);
      b.px(12, 7, EYE_RED);
    }),
  kobold: () =>
    sheet(22, 24, (b, f) => {
      humanoid(b, f, { skin: 0xc86a3a, body: 0x8a6a40, eye: 0xf2d06b, head: 0xc86a3a, weapon: 0xa9a9b3 });
      b.rect(14, 2 + f, 16, 3 + f, 0xc86a3a);
      b.line(3, 20, 0, 23, 0xc86a3a);
    }),
  kobold_foreman: () =>
    sheet(24, 26, (b, f) => {
      humanoid(b, f, { skin: 0xc86a3a, body: 0x5a6a8a, eye: 0xf2d06b, w: 1, weapon: 0x6b4a2f });
      b.rect(7, 1 + f, 16, 3 + f, 0xf2d06b);
      b.rect(9, 0 + f, 14, 0 + f, 0xf2d06b);
      b.px(12, -1 + f + 1, 0xffffff);
    }),
  rock_golem: () =>
    sheet(30, 30, (b, f) => {
      const s = 0x8c8a94;
      b.rect(8, 22, 12, 29, shade(s, 0.8));
      b.rect(17, 22, 21, 29, shade(s, 0.8));
      b.rect(5, 9 + f, 24, 23, s);
      b.rect(1, 10 + f, 5, 21 + f, shade(s, 0.9));
      b.rect(24, 10 + f, 28, 21 + f, shade(s, 0.9));
      b.rect(10, 2 + f, 19, 9 + f, shade(s, 1.1));
      b.px(12, 5 + f, EYE_GLOW);
      b.px(17, 5 + f, EYE_GLOW);
      for (let i = 0; i < 6; i++) b.px(6 + ((i * 7) % 18), 9 + f + ((i * 5) % 4), 0x5f9a52);
      b.line(9, 14, 13, 18, shade(s, 0.65));
      b.rect(13, 13, 15, 15, 0x6fe3e8);
    }),
  crystal_beetle: () =>
    sheet(24, 18, (b, f) => {
      const shell = 0x3f6a8a;
      for (let i = 0; i < 3; i++) {
        b.line(6 + i * 5, 13, 4 + i * 5 - f, 17, OUTLINE);
        b.line(9 + i * 5, 13, 11 + i * 5 + f, 17, OUTLINE);
      }
      b.ellipse(2, 5, 19, 15, shell);
      b.ellipse(18, 8, 23, 13, shade(shell, 0.8));
      b.line(10, 6, 10, 14, shade(shell, 0.6));
      for (const [x, h] of [
        [5, 5],
        [9, 7],
        [13, 6],
        [16, 4],
      ] as const)
        for (let y = 0; y < h; y++)
          b.rect(x, 6 - y, x + (y < h - 2 ? 1 : 0), 6 - y, y > h - 3 ? 0xc8fbff : 0x6fe3e8);
      b.px(21, 9, 0xf2d06b);
    }),
  mire_toad: () =>
    sheet(26, 18, (b, f) => {
      const c = 0x6a8a46;
      b.ellipse(1, 5 + f, 24, 17, c);
      b.ellipse(4, 2 + f, 9, 7 + f, c);
      b.ellipse(15, 2 + f, 20, 7 + f, c);
      b.px(6, 4 + f, 0xf2d06b);
      b.px(17, 4 + f, 0xf2d06b);
      b.rect(5, 11, 20, 11, shade(c, 0.55));
      b.rect(3, 14, 22, 16, 0xb8b06a);
      for (let i = 0; i < 5; i++) b.px(4 + i * 4, 8 + (i % 2) * 2, shade(c, 0.7));
    }),
  bog_lurker: () =>
    sheet(24, 28, (b, f) => {
      const c = 0x3e5a46;
      humanoid(b, f, { skin: c, body: c, legs: shade(c, 0.7), eye: 0xf2d06b, head: shade(c, 1.1), w: 1 });
      b.rect(4, 13 + f, 5, 22 + f, c);
      b.rect(18, 13 + f, 19, 22 + f, c);
      b.rect(8, 2, 9, 5, 0x8a9a46);
      b.rect(13, 1, 14, 4, 0x8a9a46);
    }),
  will_o_wisp: () =>
    sheet(16, 20, (b, f) => {
      b.ellipse(3, 4 + f, 12, 13 + f, 0x9ff6ff);
      b.ellipse(5, 6 + f, 10, 11 + f, 0xe8ffff);
      b.line(7, 14 + f, 5 + f * 2, 19, 0x6fd8e8);
      b.line(8, 14 + f, 10 - f * 2, 19, 0x6fd8e8);
    }),
  swamp_hag: () =>
    sheet(24, 30, (b, f) => {
      humanoid(b, f, {
        skin: 0x8ab06a,
        body: 0x5a4a6a,
        eye: 0xf2d06b,
        cape: 0x3e3448,
        weapon: 0x6b4a2f,
        tall: 2,
      });
      b.rect(7, 2, 16, 3, 0x2e2638);
      b.rect(9, 0, 14, 2, 0x2e2638);
      b.px(15, 9 + f, 0x8ab06a);
      b.px(16, 10 + f, 0x8ab06a);
      b.rect(18, 2 + f, 20, 4 + f, 0x9a6ad0);
    }),
  skeleton: () =>
    sheet(22, 26, (b, f) => {
      const bone = 0xe6dcc6;
      humanoid(b, f, { skin: bone, body: 0x2a2234, legs: bone, head: bone, eye: OUTLINE, weapon: 0xa9a9b3 });
      for (let y = 10; y < 17; y += 2) b.rect(8, y + f, 13, y + f, bone);
    }),
  bandit: () =>
    sheet(22, 26, (b, f) => {
      humanoid(b, f, { skin: 0xe0ac7e, body: 0x6b4a33, legs: 0x3a3346, eye: OUTLINE, weapon: 0xd8d8e0 });
      b.rect(8, 6 + f, 14, 7 + f, 0xd9534f);
      b.rect(8, 2 + f, 14, 3 + f, 0xd9534f);
    }),
  bandit_captain: () =>
    sheet(26, 30, (b, f) => {
      humanoid(b, f, {
        skin: 0xe0ac7e,
        body: 0x8a2e3a,
        legs: 0x2a2234,
        eye: OUTLINE,
        weapon: 0xd8d8e0,
        cape: 0x3a2a2a,
        w: 1,
        tall: 2,
      });
      b.rect(7, 2, 18, 3, 0x2a2234);
      b.rect(9, 0, 16, 2, 0x2a2234);
      b.px(17, 1, 0xf2b84b);
      b.rect(9, 12 + f, 16, 12 + f, 0xf2b84b);
    }),
  wraith: () =>
    sheet(22, 28, (b, f) => {
      const c = 0x4a5a7a;
      b.ellipse(5, 2 + f, 16, 14 + f, c);
      b.rect(4, 9 + f, 17, 23, c);
      for (let x = 4; x <= 17; x += 3) b.rect(x, 24, x + 1, 26 - ((x + f) % 2) * 2, c);
      b.rect(7, 5 + f, 14, 10 + f, 0x1a1626);
      b.px(9, 7 + f, EYE_GLOW);
      b.px(12, 7 + f, EYE_GLOW);
      b.line(4, 12 + f, 1, 18, c);
      b.line(17, 12 + f, 20, 18, c);
    }),
  crypt_guard: () =>
    sheet(24, 28, (b, f) => {
      const bone = 0xe6dcc6;
      humanoid(b, f, {
        skin: bone,
        body: 0x4a4a5a,
        legs: 0x3a3a48,
        head: 0x6a6a7a,
        eye: EYE_RED,
        weapon: 0xa9a9b3,
        w: 1,
        tall: 1,
      });
      b.rect(1, 10 + f, 6, 20 + f, 0x5a3a2a);
      b.rect(2, 11 + f, 5, 19 + f, 0x8a6a40);
      b.px(3, 15 + f, 0xf2b84b);
      b.rect(9, 1 + f, 15, 1 + f, 0x8a8a9a);
    }),
  the_hollow_regent: () =>
    sheet(44, 48, (b, f) => {
      const robe = 0x4a2a5a;
      b.rect(10, 18 + f, 33, 47, robe);
      for (let x = 10; x <= 33; x += 3) b.rect(x, 44, x + 1, 47, shade(robe, 0.7));
      b.rect(16, 18 + f, 27, 40, shade(robe, 1.25));
      b.rect(4, 20 + f, 10, 34 + f, robe);
      b.rect(33, 20 + f, 39, 34 + f, robe);
      b.rect(15, 6 + f, 28, 18 + f, 0xe6dcc6);
      b.rect(17, 10 + f, 19, 12 + f, OUTLINE);
      b.rect(24, 10 + f, 26, 12 + f, OUTLINE);
      b.px(18, 11 + f, 0xc06aff);
      b.px(25, 11 + f, 0xc06aff);
      b.rect(19, 15 + f, 24, 15 + f, OUTLINE);
      for (let x = 14; x <= 29; x += 3) b.rect(x, 1 + f, x + 1, 5 + f, 0xf2b84b);
      b.rect(14, 5 + f, 29, 6 + f, 0xf2b84b);
      b.rect(40, 4, 41, 44, 0x6b4a2f);
      b.ellipse(37, 0 + f, 43, 6 + f, 0xc06aff);
    }),
  ancient_colossus: () =>
    sheet(64, 64, (b, f) => {
      const s = 0x9a968a;
      b.rect(16, 44, 26, 63, shade(s, 0.8));
      b.rect(38, 44, 48, 63, shade(s, 0.8));
      b.rect(10, 16 + f, 54, 46, s);
      b.rect(0, 18 + f, 10, 44 + f, shade(s, 0.9));
      b.rect(54, 18 + f, 63, 44 + f, shade(s, 0.9));
      b.rect(22, 2 + f, 42, 16 + f, shade(s, 1.1));
      b.rect(26, 8 + f, 29, 10 + f, EYE_GLOW);
      b.rect(35, 8 + f, 38, 10 + f, EYE_GLOW);
      b.ellipse(26, 24, 38, 34, 0x2a3a4a);
      b.ellipse(28, 26, 36, 32, 0x6fe3e8);
      for (let i = 0; i < 18; i++) b.px(10 + ((i * 13) % 44), 16 + f + ((i * 7) % 6), 0x5f9a52);
      b.line(14, 36, 22, 44, shade(s, 0.6));
      b.line(46, 20, 50, 30, shade(s, 0.6));
    }),
};

/** A recognisable blob for monster kinds added later without a design. */
function fallback(kind: string): MonsterSheet {
  const r = rng(hash32(kind));
  const c = (Math.floor(r() * 0xffffff) & 0x7f7f7f) + 0x404040;
  return sheet(20, 18, (b, f) => {
    b.ellipse(2, 3 + f, 17, 17, c);
    b.ellipse(5, 5 + f, 9, 9 + f, shade(c, 1.25));
    b.px(8, 9 + f, OUTLINE);
    b.px(12, 9 + f, OUTLINE);
  });
}

export function monsterSheet(kind: string): MonsterSheet {
  const d = DESIGNS[kind];
  return d ? d() : fallback(kind);
}

export const MONSTER_KINDS = Object.keys(DESIGNS);
