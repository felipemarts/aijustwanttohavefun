/** Turns procedural pixel buffers into Pixi textures (nearest scaling), packing small ones into shared sources. */
import { CanvasSource, Rectangle, Texture, TextureSource } from 'pixi.js';
import { drawMockSheet } from '../data/mockSprites';
import type { PixelBuf } from '../util/pixels';
import { buildFxAtlas } from './art/fx';
import { MONSTER_KINDS, monsterSheet } from './art/monsters';

// Pixel art everywhere: no smoothing.
TextureSource.defaultOptions.scaleMode = 'nearest';

export function canvasTexture(canvas: HTMLCanvasElement): Texture {
  return new Texture({ source: new CanvasSource({ resource: canvas, scaleMode: 'nearest' }) });
}

export type MonsterTex = { frames: Texture[]; ax: number; ay: number; w: number; h: number };

/** Shelf-packs buffers into one canvas; returns the source and each buffer's rectangle. */
function pack(bufs: { key: string; buf: PixelBuf }[], width = 1024) {
  let x = 0;
  let y = 0;
  let rowH = 0;
  const rects = new Map<string, { x: number; y: number }>();
  for (const { key, buf } of bufs) {
    if (x + buf.w + 2 > width) {
      x = 0;
      y += rowH + 2;
      rowH = 0;
    }
    rects.set(key, { x: x + 1, y: y + 1 });
    x += buf.w + 2;
    rowH = Math.max(rowH, buf.h);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.max(4, y + rowH + 2);
  const ctx = canvas.getContext('2d')!;
  for (const { key, buf } of bufs) {
    const r = rects.get(key)!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.w, buf.h), r.x, r.y);
  }
  return { source: new CanvasSource({ resource: canvas, scaleMode: 'nearest' }), rects };
}

export type SceneTextures = {
  fx: Record<string, Texture>;
  monster(kind: string): MonsterTex;
  /** Shown while an agent's real sheet loads. */
  placeholder: Texture[];
};

export function buildSceneTextures(): SceneTextures {
  const fxAtlas = buildFxAtlas();
  const fxSource = new CanvasSource({ resource: fxAtlas.buf.toCanvas(), scaleMode: 'nearest' });
  const fx: Record<string, Texture> = {};
  for (const [name, r] of Object.entries(fxAtlas.regions))
    fx[name] = new Texture({ source: fxSource, frame: new Rectangle(r.x, r.y, r.w, r.h) });

  const sheets = MONSTER_KINDS.map((k) => ({ key: k, sheet: monsterSheet(k) }));
  const packed = pack(sheets.map((s) => ({ key: s.key, buf: s.sheet.buf })));
  const monsters = new Map<string, MonsterTex>();
  for (const { key, sheet } of sheets) {
    const r = packed.rects.get(key)!;
    monsters.set(key, {
      frames: [0, 1].map(
        (f) =>
          new Texture({
            source: packed.source,
            frame: new Rectangle(r.x + f * sheet.fw, r.y, sheet.fw, sheet.fh),
          }),
      ),
      ax: sheet.ax,
      ay: sheet.ay,
      w: sheet.fw,
      h: sheet.fh,
    });
  }

  const ph = canvasTexture(drawMockSheet('placeholder-silhouette'));
  const placeholder = [0, 1, 2, 3].map(
    (f) => new Texture({ source: ph.source, frame: new Rectangle(f * 20, 0, 20, 28) }),
  );

  return {
    fx,
    placeholder,
    monster(kind: string) {
      let m = monsters.get(kind);
      if (!m) {
        const s = monsterSheet(kind);
        const t = canvasTexture(s.buf.toCanvas());
        m = {
          frames: [0, 1].map(
            (f) => new Texture({ source: t.source, frame: new Rectangle(f * s.fw, 0, s.fw, s.fh) }),
          ),
          ax: s.ax,
          ay: s.ay,
          w: s.fw,
          h: s.fh,
        };
        monsters.set(kind, m);
      }
      return m;
    },
  };
}
