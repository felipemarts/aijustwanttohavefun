/**
 * Short, pooled, cheap effects: hit flash and damage numbers, kill poof, level-up sparkles, achievement star, fallen
 * wisp, rare-drop glint, heal motes. Each effect is a few sprites driven by one update function; nothing allocates
 * per frame once the pools are warm.
 */
import type { Container } from 'pixi.js';
import { BitmapText, Sprite, type Texture } from 'pixi.js';
import type { SceneTextures } from './textures';

type Fx = {
  t0: number;
  dur: number;
  x: number;
  y: number;
  rise: number;
  sprites: Sprite[];
  text: BitmapText | null;
  step: (fx: Fx, f: number, now: number) => void;
};

const MAX_FX = 80;

export class Effects {
  private active: Fx[] = [];
  private spritePool: Sprite[] = [];
  private textPool: BitmapText[] = [];

  constructor(
    private readonly layer: Container,
    private readonly textLayer: Container,
    private readonly tex: SceneTextures,
    private readonly reduced: boolean,
    private readonly fontFamily: string,
  ) {}

  get count() {
    return this.active.length;
  }

  private sprite(t: Texture): Sprite {
    const s = this.spritePool.pop() ?? new Sprite();
    s.texture = t;
    s.anchor.set(0.5, 0.5);
    s.alpha = 1;
    s.scale.set(1);
    s.rotation = 0;
    s.tint = 0xffffff;
    s.blendMode = 'normal';
    s.visible = true;
    this.layer.addChild(s);
    return s;
  }

  private text(str: string, tint: number): BitmapText {
    const t =
      this.textPool.pop() ??
      new BitmapText({ text: '', style: { fontFamily: this.fontFamily, fontSize: 12 } });
    t.text = str;
    t.tint = tint;
    t.alpha = 1;
    t.anchor.set(0.5, 1);
    t.visible = true;
    this.textLayer.addChild(t);
    return t;
  }

  private add(fx: Omit<Fx, 'rise'>) {
    if (this.active.length >= MAX_FX) this.finish(this.active.shift()!);
    this.active.push({ ...fx, rise: 0 });
  }

  private finish(fx: Fx) {
    for (const s of fx.sprites) {
      s.visible = false;
      s.removeFromParent();
      this.spritePool.push(s);
    }
    if (fx.text) {
      fx.text.visible = false;
      fx.text.removeFromParent();
      this.textPool.push(fx.text);
    }
  }

  update(now: number) {
    let w = 0;
    for (let i = 0; i < this.active.length; i++) {
      const fx = this.active[i]!;
      const f = (now - fx.t0) / fx.dur;
      if (f >= 1) {
        this.finish(fx);
        continue;
      }
      try {
        fx.step(fx, Math.max(0, f), now);
      } catch {
        this.finish(fx);
        continue;
      }
      this.active[w++] = fx;
    }
    this.active.length = w;
  }

  hit(x: number, y: number, dmg: number | null, now: number) {
    const slash = this.sprite(this.tex.fx.slash!);
    slash.position.set(x, y - 12);
    const text = dmg !== null ? this.text(`-${dmg}`, 0xff7a6a) : null;
    this.add({
      t0: now,
      dur: 850,
      x,
      y: y - 24,
      sprites: [slash],
      text,
      step: (fx, f) => {
        slash.alpha = f < 0.25 ? 1 : 0;
        slash.scale.set(1 + f);
        if (fx.text) {
          fx.text.alpha = f < 0.6 ? 1 : 1 - (f - 0.6) / 0.4;
          fx.rise = this.reduced ? 0 : f * 18;
        }
      },
    });
  }

  poof(x: number, y: number, now: number) {
    const s = this.sprite(this.tex.fx.poof0!);
    s.position.set(x, y - 8);
    this.add({
      t0: now,
      dur: 420,
      x,
      y,
      sprites: [s],
      text: null,
      step: (_fx, f) => {
        s.texture = this.tex.fx[`poof${Math.min(3, Math.floor(f * 4))}`]!;
      },
    });
  }

  levelUp(x: number, y: number, level: number | string, label: string, now: number) {
    const n = this.reduced ? 0 : 6;
    const sprites: Sprite[] = [];
    for (let i = 0; i < n; i++) {
      const s = this.sprite(this.tex.fx.sparkle!);
      s.blendMode = 'add';
      sprites.push(s);
    }
    const text = this.text(label || `LV ${level}`, 0xf2b84b);
    this.add({
      t0: now,
      dur: 1400,
      x,
      y: y - 30,
      sprites,
      text,
      step: (fx, f) => {
        sprites.forEach((s, i) => {
          const a = (i / n) * Math.PI * 2 + f * 3;
          s.position.set(x + Math.cos(a) * 10, y - 6 - f * 34 - (i % 2) * 4);
          s.alpha = 1 - f;
        });
        if (fx.text) {
          fx.text.alpha = f < 0.7 ? 1 : 1 - (f - 0.7) / 0.3;
          fx.rise = this.reduced ? 0 : f * 14;
        }
      },
    });
  }

  star(x: number, y: number, now: number) {
    const s = this.sprite(this.tex.fx.star!);
    this.add({
      t0: now,
      dur: 1500,
      x,
      y,
      sprites: [s],
      text: null,
      step: (_fx, f) => {
        const pop = f < 0.15 ? f / 0.15 : 1;
        s.scale.set(this.reduced ? 1 : pop * (1 + 0.15 * Math.sin(f * 20)));
        s.position.set(x, y - 40 - (this.reduced ? 0 : f * 6));
        s.alpha = f > 0.8 ? (1 - f) / 0.2 : 1;
      },
    });
  }

  wisp(x: number, y: number, now: number) {
    const s = this.sprite(this.tex.fx.wisp!);
    s.alpha = 0.9;
    this.add({
      t0: now,
      dur: 1800,
      x,
      y,
      sprites: [s],
      text: null,
      step: (_fx, f) => {
        s.position.set(x + (this.reduced ? 0 : Math.sin(f * 9) * 3), y - 14 - (this.reduced ? 0 : f * 30));
        s.alpha = 0.9 * (1 - f);
      },
    });
  }

  glint(x: number, y: number, now: number, color = 0xfff2b0) {
    const s = this.sprite(this.tex.fx.glint!);
    s.tint = color;
    s.blendMode = 'add';
    this.add({
      t0: now,
      dur: 1300,
      x,
      y,
      sprites: [s],
      text: null,
      step: (_fx, f) => {
        const k = Math.sin(f * Math.PI * 3);
        s.scale.set(Math.max(0.1, Math.abs(k)));
        s.alpha = 1 - f * 0.5;
        s.position.set(x + 6, y - 20);
      },
    });
  }

  heal(x: number, y: number, now: number) {
    const n = this.reduced ? 1 : 4;
    const sprites: Sprite[] = [];
    for (let i = 0; i < n; i++) {
      const s = this.sprite(this.tex.fx.sparkle!);
      s.tint = 0x8af08a;
      s.blendMode = 'add';
      sprites.push(s);
    }
    this.add({
      t0: now,
      dur: 1000,
      x,
      y,
      sprites,
      text: null,
      step: (_fx, f) => {
        sprites.forEach((s, i) => {
          s.position.set(x - 8 + i * 5, y - 8 - f * 24 - (i % 2) * 6);
          s.alpha = 1 - f;
        });
      },
    });
  }

  /** A small ore or crystal glint on the cave walls (ambient). */
  twinkle(x: number, y: number, color: number, now: number) {
    const s = this.sprite(this.tex.fx.glint!);
    s.tint = color;
    s.blendMode = 'add';
    this.add({
      t0: now,
      dur: 700,
      x,
      y,
      sprites: [s],
      text: null,
      step: (_fx, f) => {
        s.position.set(x, y);
        s.scale.set(0.2 + Math.sin(f * Math.PI) * 0.6);
      },
    });
  }

  /** Positions of the screen-space texts (damage numbers, LV labels). */
  forEachText(fn: (t: BitmapText, x: number, y: number, rise: number) => void) {
    for (const fx of this.active) if (fx.text) fn(fx.text, fx.x, fx.y, fx.rise);
  }
}
