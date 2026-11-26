/**
 * Runtime atlas for character sheets: every agent and NPC sheet (80x28, 4 frames) is drawn into shared 2048x2048
 * canvases so hundreds of distinct appearances still batch into a handful of draw calls.
 */
import { CanvasSource, Rectangle, Texture } from 'pixi.js';

export const FRAME_W = 20;
export const FRAME_H = 28;
const CELL_W = FRAME_W * 4 + 2;
const CELL_H = FRAME_H + 2;
const PAGE = 2048;

type Page = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  source: CanvasSource;
  used: number;
  dirty: boolean;
};

export type SheetTextures = Texture[];

export class SpriteAtlas {
  private pages: Page[] = [];
  private entries = new Map<string, SheetTextures>();
  private pending = new Map<string, Promise<SheetTextures | null>>();
  private readonly cols = Math.floor(PAGE / CELL_W);
  private readonly rows = Math.floor(PAGE / CELL_H);

  get(key: string): SheetTextures | undefined {
    return this.entries.get(key);
  }

  /** Loads (once) and packs a sheet; resolves null when the image cannot be loaded. */
  ensure(key: string, load: () => Promise<CanvasImageSource | null>): Promise<SheetTextures | null> {
    const hit = this.entries.get(key);
    if (hit) return Promise.resolve(hit);
    let p = this.pending.get(key);
    if (!p) {
      p = load()
        .then((img) => (img ? this.add(key, img) : null))
        .catch(() => null);
      this.pending.set(key, p);
    }
    return p;
  }

  add(key: string, img: CanvasImageSource): SheetTextures {
    let page = this.pages[this.pages.length - 1];
    if (!page || page.used >= this.cols * this.rows) page = this.newPage();
    const i = page.used++;
    const x = (i % this.cols) * CELL_W + 1;
    const y = Math.floor(i / this.cols) * CELL_H + 1;
    page.ctx.clearRect(x - 1, y - 1, CELL_W, CELL_H);
    try {
      page.ctx.drawImage(img, 0, 0, FRAME_W * 4, FRAME_H, x, y, FRAME_W * 4, FRAME_H);
    } catch {
      // a broken image leaves an empty cell
    }
    page.dirty = true;
    const textures = [0, 1, 2, 3].map(
      (f) => new Texture({ source: page.source, frame: new Rectangle(x + f * FRAME_W, y, FRAME_W, FRAME_H) }),
    );
    this.entries.set(key, textures);
    return textures;
  }

  /** Re-uploads pages that changed since the last frame (one upload per page, not per sprite). */
  flush() {
    for (const p of this.pages)
      if (p.dirty) {
        p.dirty = false;
        p.source.update();
      }
  }

  get pageCount() {
    return this.pages.length;
  }

  get size() {
    return this.entries.size;
  }

  private newPage(): Page {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE;
    canvas.height = PAGE;
    const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
    ctx.imageSmoothingEnabled = false;
    const source = new CanvasSource({ resource: canvas, scaleMode: 'nearest' });
    const page: Page = { canvas, ctx, source, used: 0, dirty: true };
    this.pages.push(page);
    return page;
  }
}
