/**
 * Screen-space overlay: name labels and speech bubbles stay crisp and readable at any zoom. Agent text goes only
 * into a Pixi `Text`'s plain `text` property (canvas fillText): never parsed as markup, never into a style.
 */
import { BitmapText, Container, Graphics, Text } from 'pixi.js';
import { BUBBLE_CAP } from './lod';

export const UI_FONT =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans CJK JP", sans-serif';

const INK = 0x241a2e;
const PARCHMENT = 0xf1e6cf;
const TEAL = 0x5fc9b5;
const BUBBLE_MS = 5200;
const MAX_CHARS = 120;

type Label = { box: Container; name: BitmapText; title: BitmapText; key: string; used: boolean };
type Bubble = {
  box: Container;
  bg: Graphics;
  text: Text;
  chip: BitmapText;
  chipBg: Graphics;
  agent: string;
  until: number;
  w: number;
  h: number;
};

export function clip(text: string, max = MAX_CHARS): string {
  // Collapse whitespace and cut by code points (never in the middle of a surrogate pair).
  const flat = text.replace(/\s+/g, ' ').trim();
  const cps = Array.from(flat);
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : flat;
}

export class Overlay {
  readonly root = new Container();
  private labelLayer = new Container();
  private bubbleLayer = new Container();
  private labels = new Map<string, Label>();
  private labelPool: Label[] = [];
  private bubbles = new Map<string, Bubble>();
  private bubblePool: Bubble[] = [];

  constructor(private readonly labelFont: string) {
    this.root.addChild(this.labelLayer, this.bubbleLayer);
    this.root.eventMode = 'none';
  }

  get labelCount() {
    return this.labels.size;
  }

  beginLabels() {
    for (const l of this.labels.values()) l.used = false;
  }

  /** Shows (or keeps) the label of an agent at a screen position; `big` for the director's star. */
  label(agent: string, nameLine: string, titleLine: string, sx: number, sy: number, highlight: boolean, big = false) {
    let l = this.labels.get(agent);
    if (!l) {
      l = this.labelPool.pop() ?? this.newLabel();
      this.labels.set(agent, l);
      this.labelLayer.addChild(l.box);
      l.key = '';
    }
    const key = `${nameLine}|${titleLine}|${highlight}`;
    if (l.key !== key) {
      l.key = key;
      l.name.text = nameLine;
      l.name.tint = highlight ? 0xf2b84b : PARCHMENT;
      l.title.text = titleLine;
      l.title.visible = !!titleLine;
    }
    l.used = true;
    l.box.visible = true;
    l.box.scale.set(big ? 1.3 : 1);
    l.box.position.set(Math.round(sx), Math.round(sy));
  }

  endLabels() {
    for (const [agent, l] of this.labels) {
      if (l.used) continue;
      l.box.visible = false;
      l.box.removeFromParent();
      this.labels.delete(agent);
      this.labelPool.push(l);
    }
  }

  private newLabel(): Label {
    const box = new Container();
    const name = new BitmapText({ text: '', style: { fontFamily: this.labelFont, fontSize: 12 } });
    name.anchor.set(0.5, 1);
    const title = new BitmapText({ text: '', style: { fontFamily: this.labelFont, fontSize: 10 } });
    title.anchor.set(0.5, 1);
    title.tint = 0xf2b84b;
    title.y = -13;
    box.addChild(name, title);
    return { box, name, title, key: '', used: false };
  }

  /** A speech bubble over an agent; replaces the agent's current bubble. */
  say(agent: string, text: string, lang: string | null, now: number) {
    let b = this.bubbles.get(agent);
    if (!b) {
      if (this.bubbles.size >= BUBBLE_CAP) {
        // drop the oldest bubble
        let oldest: string | null = null;
        let t = Infinity;
        for (const [k, v] of this.bubbles)
          if (v.until < t) {
            t = v.until;
            oldest = k;
          }
        if (oldest) this.release(oldest);
      }
      b = this.bubblePool.pop() ?? this.newBubble();
      this.bubbles.set(agent, b);
      this.bubbleLayer.addChild(b.box);
    }
    b.agent = agent;
    b.until = now + BUBBLE_MS + Math.min(3000, text.length * 25);
    b.text.text = clip(text);
    const chip = (lang ?? '').slice(0, 8);
    b.chip.text = chip;
    this.drawBubble(b, chip.length > 0);
    b.box.visible = false;
  }

  private newBubble(): Bubble {
    const box = new Container();
    const bg = new Graphics();
    const text = new Text({
      text: '',
      style: {
        fontFamily: UI_FONT,
        fontSize: 12,
        fill: INK,
        wordWrap: true,
        wordWrapWidth: 150,
        breakWords: true,
        lineHeight: 15,
      },
    });
    const chipBg = new Graphics();
    const chip = new BitmapText({ text: '', style: { fontFamily: this.labelFont, fontSize: 9 } });
    box.addChild(bg, text, chipBg, chip);
    return { box, bg, text, chip, chipBg, agent: '', until: 0, w: 0, h: 0 };
  }

  private drawBubble(b: Bubble, withChip: boolean) {
    const pad = 6;
    const tw = Math.ceil(b.text.width);
    const th = Math.ceil(b.text.height);
    const w = Math.max(28, tw + pad * 2);
    const h = th + pad * 2 - 2;
    b.w = w;
    b.h = h;
    const g = b.bg;
    g.clear();
    // stepped corners, 1 px ink outline, a tail pointing down to the speaker
    g.rect(-w / 2 + 2, -h - 8, w - 4, h + 2).fill(INK);
    g.rect(-w / 2, -h - 6, w, h - 2).fill(INK);
    g.rect(-w / 2 + 1, -h - 6, w - 2, h - 2).fill(PARCHMENT);
    g.rect(-w / 2 + 2, -h - 7, w - 4, h).fill(PARCHMENT);
    g.rect(-3, -8, 6, 2).fill(PARCHMENT);
    g.rect(-2, -6, 4, 2).fill(PARCHMENT);
    g.rect(-1, -4, 2, 2).fill(PARCHMENT);
    g.rect(-4, -8, 1, 2).fill(INK);
    g.rect(3, -8, 1, 2).fill(INK);
    g.rect(-3, -6, 1, 2).fill(INK);
    g.rect(2, -6, 1, 2).fill(INK);
    g.rect(-2, -4, 1, 2).fill(INK);
    g.rect(1, -4, 1, 2).fill(INK);
    g.rect(-1, -2, 2, 1).fill(INK);
    b.text.position.set(Math.round(-w / 2 + pad), Math.round(-h - 7 + pad - 2));
    b.chipBg.clear();
    if (withChip) {
      const cw = Math.ceil(b.chip.width) + 6;
      b.chipBg.rect(w / 2 - cw - 2, -h - 14, cw, 11).fill(TEAL);
      b.chipBg.rect(w / 2 - cw - 2, -h - 14, cw, 1).fill(INK);
      b.chip.position.set(Math.round(w / 2 - cw + 1), -h - 13);
      b.chip.visible = true;
    } else b.chip.visible = false;
  }

  /** Places live bubbles; `head` maps an agent to its screen head position or null when off-screen. */
  layoutBubbles(now: number, head: (agent: string) => { x: number; y: number } | null, show: boolean) {
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    // newest first: a bubble that would cover a newer one waits hidden until there is room
    const order = [...this.bubbles.entries()].sort((a, b) => b[1].until - a[1].until);
    for (const [agent, b] of order) {
      if (now > b.until) {
        this.release(agent);
        continue;
      }
      const p = show ? head(agent) : null;
      if (!p) {
        b.box.visible = false;
        continue;
      }
      const r = { x0: p.x - b.w / 2, y0: p.y - b.h - 14, x1: p.x + b.w / 2, y1: p.y };
      if (placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)) {
        b.box.visible = false;
        continue;
      }
      placed.push(r);
      b.box.visible = true;
      b.box.position.set(Math.round(p.x), Math.round(p.y));
      const left = b.until - now;
      b.box.alpha = left < 400 ? left / 400 : 1;
    }
  }

  hasBubble(agent: string) {
    return this.bubbles.has(agent);
  }

  private release(agent: string) {
    const b = this.bubbles.get(agent);
    if (!b) return;
    b.box.visible = false;
    b.box.removeFromParent();
    this.bubbles.delete(agent);
    this.bubblePool.push(b);
  }
}
