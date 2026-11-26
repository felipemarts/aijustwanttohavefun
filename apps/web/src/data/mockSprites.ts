/**
 * Stand-in character sheets for the mock source (the real ones come from the server, composed by
 * packages/appearance). Same format and proportions: 4 frames of 20x28 (idle, left step, right step, blink),
 * the art on a 16x24 grid offset by (2, 4), with the shared dark outline. Original procedural art (CC0).
 */
import { hash32, rng } from '../util/rng';
import { PixelBuf, shade } from '../util/pixels';

const SKINS = [0xf2d3ab, 0xe0ac7e, 0xc68642, 0x8d5524, 0x9fc79a, 0xb9a6d9];
const HAIRS = [0x2b1d14, 0x6b3e1f, 0xc9a15a, 0xe8d8a0, 0xa83a2c, 0x3d3d46, 0xf0f0f0, 0x5b7bd6, 0x9b59b6];
const CLOTH = [
  0x5b8def, 0xd9534f, 0x5fbf6b, 0xe8c35a, 0x8e6bbf, 0x2f6f73, 0xc8553d, 0x6d7b8a, 0xd08ac0, 0x3f7d5a,
];
const BOOT = 0x46301f;

export function drawMockSheet(seed: string): HTMLCanvasElement {
  const r = rng(hash32(seed));
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const skin = pick(SKINS);
  const hair = pick(HAIRS);
  const top = pick(CLOTH);
  const pants = shade(pick(CLOTH), 0.6);
  const hat = r() < 0.35 ? pick(CLOTH) : -1;
  const hatKind = Math.floor(r() * 3);
  const robe = r() < 0.25;
  const hairKind = Math.floor(r() * 4);
  const cape = r() < 0.3 ? shade(pick(CLOTH), 0.8) : -1;

  const sheet = new PixelBuf(80, 28);
  for (let f = 0; f < 4; f++) {
    const b = new PixelBuf(20, 28);
    b.ox = 2;
    b.oy = 4;
    const step = f === 1 ? -1 : f === 2 ? 1 : 0;
    const blink = f === 3;
    const H = 1;
    const T = 8;
    const B = 14;
    const L = 20;
    if (cape >= 0) b.rect(3, T, 12, B + 3, cape);
    // legs and boots
    const leftEnd = L - (step === -1 ? 1 : 0);
    const rightEnd = L - (step === 1 ? 1 : 0);
    b.rect(5, B + 1, 6, leftEnd, pants);
    b.rect(9, B + 1, 10, rightEnd, pants);
    b.rect(5, leftEnd + 1, 6, leftEnd + 1, BOOT);
    b.rect(9, rightEnd + 1, 10, rightEnd + 1, BOOT);
    if (robe) b.rect(4, B + 1, 11, L - 1, shade(top, 0.85));
    // torso and arms
    b.rect(4, T, 11, B, (x, y) => (y === B - 1 ? 0x5a3c28 : x === 7 && y % 2 ? shade(top, 0.8) : top));
    for (let y = T + 1; y <= B; y++) {
      b.px(3, y, y >= B - 1 ? skin : top);
      b.px(12, y, y >= B - 1 ? skin : top);
    }
    // head
    b.rect(5, H + 1, 10, H + 6, skin);
    b.rect(6, H + 7, 9, H + 7, shade(skin, 0.85));
    if (blink) {
      b.px(6, H + 4, shade(skin, 0.7));
      b.px(9, H + 4, shade(skin, 0.7));
    } else {
      b.px(6, H + 4, 0x1e1a28);
      b.px(9, H + 4, 0x1e1a28);
    }
    // hair
    b.rect(5, H, 10, H + 1, hair);
    b.px(5, H + 2, hair);
    b.px(10, H + 2, hair);
    if (hairKind === 1) {
      b.rect(4, H + 1, 4, H + 6, hair);
      b.rect(11, H + 1, 11, H + 6, hair);
    }
    if (hairKind === 2) b.rect(6, H - 1, 9, H - 1, hair);
    if (hairKind === 3) b.rect(10, H + 2, 11, H + 8, hair);
    if (hat >= 0) {
      if (hatKind === 0) {
        b.rect(4, H, 11, H, hat);
        b.rect(5, H - 2, 10, H - 1, hat);
      } else if (hatKind === 1) {
        b.rect(3, H, 12, H, hat);
        b.rect(6, H - 3, 9, H - 1, hat);
        b.px(7, H - 4, hat);
      } else {
        b.rect(5, H - 1, 10, H, hat);
        b.px(10, H - 2, 0xf2b84b);
      }
    }
    b.ox = 0;
    b.oy = 0;
    b.outline();
    sheet.blit(b, 0, 0, 20, 28, f * 20, 0);
  }
  return sheet.toCanvas();
}
