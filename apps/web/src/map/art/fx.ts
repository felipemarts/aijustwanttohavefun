/**
 * Small effect sprites (poof, sparkle, star, wisp, glint, slash, light pools, dots) packed in one atlas so they
 * batch with everything else. Light pools are stepped, dithered discs: no gradients or blur in the map.
 */
import { PixelBuf } from '../../util/pixels';
import { OUTLINE } from './palette';

export type FxRegion = { x: number; y: number; w: number; h: number };
export type FxAtlas = { buf: PixelBuf; regions: Record<string, FxRegion> };

export function buildFxAtlas(): FxAtlas {
  const buf = new PixelBuf(256, 128);
  const regions: Record<string, FxRegion> = {};
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  const alloc = (name: string, w: number, h: number, draw: (b: PixelBuf) => void, outline = false) => {
    if (cx + w + 1 > buf.w) {
      cx = 0;
      cy += rowH + 1;
      rowH = 0;
    }
    const b = new PixelBuf(w, h);
    draw(b);
    if (outline) b.outline(OUTLINE);
    buf.blit(b, 0, 0, w, h, cx, cy);
    regions[name] = { x: cx, y: cy, w, h };
    cx += w + 1;
    rowH = Math.max(rowH, h);
  };

  alloc('white', 2, 2, (b) => b.rect(0, 0, 1, 1, 0xffffff));
  alloc('shadow', 14, 5, (b) => {
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 14; x++)
        if (((x - 6.5) / 7) ** 2 + ((y - 2) / 2.5) ** 2 <= 1) b.px(x, y, OUTLINE, 90);
  });
  alloc('dot', 6, 6, (b) => {
    b.rect(0, 0, 5, 5, OUTLINE);
    b.rect(1, 1, 4, 4, 0xffffff);
  });
  for (let i = 0; i < 4; i++)
    alloc(
      `poof${i}`,
      18,
      18,
      (b) => {
        const r = 3 + i * 2;
        const c = i < 2 ? 0xf1e6cf : 0xb8b0c0;
        for (const [ox, oy] of [
          [0, 0],
          [-r * 0.6, r * 0.3],
          [r * 0.6, r * 0.3],
          [0, -r * 0.5],
        ] as const) {
          b.ellipse(
            Math.round(9 + ox - r / 2),
            Math.round(9 + oy - r / 2),
            Math.round(9 + ox + r / 2),
            Math.round(9 + oy + r / 2),
            c,
          );
        }
        if (i === 3)
          for (let y = 0; y < 18; y++) for (let x = 0; x < 18; x++) if ((x + y) % 2) b.erase(x, y, x, y);
      },
      true,
    );
  alloc('sparkle', 7, 7, (b) => {
    b.rect(3, 0, 3, 6, 0xfff2b0);
    b.rect(0, 3, 6, 3, 0xfff2b0);
    b.px(3, 3, 0xffffff);
  });
  alloc(
    'star',
    11,
    11,
    (b) => {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 2.2 : 5;
        pts.push([5 + Math.cos(a) * r, 5 + Math.sin(a) * r]);
      }
      for (let y = 0; y < 11; y++)
        for (let x = 0; x < 11; x++) {
          let inside = false;
          for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const [xi, yi] = pts[i]!;
            const [xj, yj] = pts[j]!;
            if (yi > y + 0.5 !== yj > y + 0.5 && x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi)
              inside = !inside;
          }
          if (inside) b.px(x, y, y < 5 ? 0xffe08a : 0xf2b84b);
        }
    },
    true,
  );
  alloc(
    'wisp',
    10,
    14,
    (b) => {
      b.ellipse(1, 0, 8, 8, 0xe8f4ff);
      b.rect(2, 6, 7, 10, 0xe8f4ff);
      b.px(2, 11, 0xe8f4ff);
      b.px(5, 12, 0xe8f4ff);
      b.px(7, 11, 0xe8f4ff);
      b.px(3, 3, OUTLINE);
      b.px(6, 3, OUTLINE);
    },
    true,
  );
  alloc('glint', 9, 9, (b) => {
    b.rect(4, 0, 4, 8, 0xffffff);
    b.rect(0, 4, 8, 4, 0xffffff);
    b.rect(3, 3, 5, 5, 0xffffff);
  });
  alloc('slash', 14, 14, (b) => {
    for (let i = 0; i < 12; i++) {
      const a = Math.PI * 0.15 + (i / 11) * Math.PI * 0.7;
      b.px(Math.round(7 + Math.cos(a) * 6), Math.round(7 - Math.sin(a) * 6) + 4, 0xffffff);
      b.px(Math.round(7 + Math.cos(a) * 5), Math.round(7 - Math.sin(a) * 5) + 4, 0xfff2b0);
    }
  });
  alloc(
    'arrow',
    9,
    7,
    (b) => {
      for (let y = 0; y < 5; y++) b.rect(y, y, 8 - y, y, 0xf2b84b);
    },
    true,
  );
  alloc('mote', 3, 3, (b) => {
    b.px(1, 1, 0xffffff);
    b.px(0, 1, 0xffffff, 140);
    b.px(2, 1, 0xffffff, 140);
    b.px(1, 0, 0xffffff, 140);
    b.px(1, 2, 0xffffff, 140);
  });
  // Light pools: three stepped, dithered rings.
  for (const [name, R] of [
    ['glowS', 10],
    ['glowM', 18],
    ['glowL', 30],
  ] as const)
    alloc(name, R * 2, R * 2, (b) => {
      for (let y = 0; y < R * 2; y++)
        for (let x = 0; x < R * 2; x++) {
          const d = Math.hypot(x + 0.5 - R, y + 0.5 - R) / R;
          if (d > 1) continue;
          const a = d < 0.35 ? 150 : d < 0.65 ? 85 : (x + y) % 2 ? 40 : 0;
          if (a) b.px(x, y, 0xffffff, a);
        }
    });

  return { buf, regions };
}
