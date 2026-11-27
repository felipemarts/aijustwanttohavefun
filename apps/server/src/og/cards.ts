import type { BitmapFont } from './font';
import { lineHeight, Raster, textWidth, wrapText, type Rgb } from './raster';

/** Share cards are the size X and WhatsApp expect for `summary_large_image`. */
export const CARD_W = 1200;
export const CARD_H = 630;

/** An RGBA picture (a sprite frame) drawn on a card. */
export type Picture = { width: number; height: number; rgba: Uint8Array };

/** Everything an agent card shows, already localized: the card is a pure function of this. */
export type AgentCardData = {
  kind: 'agent';
  name: string;
  title?: string;
  line: string;
  stats: { label: string; value: string }[];
  portrait: Picture;
  footer: string;
  site: string;
};

export type HighlightCardData = { kind: 'highlight'; label: string; title: string; date: string; portraits: Picture[]; footer: string; site: string };
export type GazetteCardData = { kind: 'gazette'; masthead: string; date: string; headline: string; footer: string; site: string };
export type CardData = AgentCardData | HighlightCardData | GazetteCardData;

const BG: Rgb = [27, 23, 38];
const PANEL: Rgb = [43, 36, 61];
const FRAME: Rgb = [92, 74, 128];
const INK: Rgb = [242, 236, 222];
const MUTED: Rgb = [170, 160, 190];
const GOLD: Rgb = [240, 196, 90];
const GRASS: Rgb = [92, 160, 96];

const MARGIN = 60;

/** The largest scale (from `scales`) at which `s` fits in one line of `maxWidth`. */
function fitScale(font: BitmapFont, s: string, maxWidth: number, scales: number[]): number {
  for (const sc of scales) if (textWidth(font, s, sc) <= maxWidth) return sc;
  return scales[scales.length - 1]!;
}

/** One line, cut with an ellipsis when it would overflow. */
function oneLine(font: BitmapFont, s: string, scale: number, maxWidth: number): string {
  return wrapText(font, s, scale, maxWidth, 1)[0] ?? '';
}

function frame(r: Raster): void {
  r.rect(0, 0, CARD_W, 12, FRAME);
  r.rect(0, CARD_H - 12, CARD_W, 12, FRAME);
  r.rect(0, 0, 12, CARD_H, FRAME);
  r.rect(CARD_W - 12, 0, 12, CARD_H, FRAME);
  // A strip of grass along the bottom, like the map.
  r.rect(12, CARD_H - 24, CARD_W - 24, 12, GRASS);
}

function footer(r: Raster, font: BitmapFont, d: { footer: string; site: string }, colors: [Rgb, Rgb] = [GOLD, MUTED]): void {
  const y = CARD_H - 24 - 16 - lineHeight(2);
  const site = oneLine(font, d.site, 2, 400);
  const siteW = textWidth(font, site, 2);
  r.text(font, oneLine(font, d.footer, 2, CARD_W - 2 * MARGIN - siteW - 40), MARGIN, y, 2, colors[0]);
  r.text(font, site, CARD_W - MARGIN - siteW, y, 2, colors[1]);
}

function agentCard(font: BitmapFont, d: AgentCardData): Raster {
  const r = new Raster(CARD_W, CARD_H, BG);
  frame(r);
  // Portrait panel on the left, sprite scaled with nearest neighbour.
  const scale = Math.floor(Math.min(320 / d.portrait.width, 400 / d.portrait.height));
  const pw = d.portrait.width * scale;
  const ph = d.portrait.height * scale;
  const panel = { x: MARGIN, y: 64, w: pw + 60, h: ph + 60 };
  r.rect(panel.x, panel.y, panel.w, panel.h, PANEL);
  r.rect(panel.x + 30, panel.y + panel.h - 54, pw, 24, [36, 30, 50]);
  r.blit(d.portrait.rgba, d.portrait.width, d.portrait.height, panel.x + 30, panel.y + 30, scale);

  const x = panel.x + panel.w + 50;
  const maxW = CARD_W - MARGIN - x;
  let y = 80;
  const nameScale = fitScale(font, d.name, maxW, [6, 5, 4, 3]);
  r.text(font, oneLine(font, d.name, nameScale, maxW), x, y, nameScale, INK);
  y += lineHeight(nameScale) + 18;
  if (d.title) {
    r.text(font, oneLine(font, d.title, 3, maxW), x, y, 3, GOLD);
    y += lineHeight(3) + 14;
  }
  r.text(font, oneLine(font, d.line, 3, maxW), x, y, 3, MUTED);
  y += lineHeight(3) + 40;

  const n = Math.max(1, d.stats.length);
  const gap = 20;
  const boxW = Math.floor((maxW - gap * (n - 1)) / n);
  d.stats.forEach((st, i) => {
    const bx = x + i * (boxW + gap);
    r.rect(bx, y, boxW, 120, PANEL);
    const vs = fitScale(font, st.value, boxW - 24, [4, 3, 2]);
    r.text(font, oneLine(font, st.value, vs, boxW - 24), bx + 12, y + 14, vs, INK);
    r.text(font, oneLine(font, st.label, 2, boxW - 24), bx + 12, y + 120 - 14 - lineHeight(2), 2, MUTED);
  });
  footer(r, font, d);
  return r;
}

function highlightCard(font: BitmapFont, d: HighlightCardData): Raster {
  const r = new Raster(CARD_W, CARD_H, BG);
  frame(r);
  const maxW = CARD_W - 2 * MARGIN;
  r.text(font, oneLine(font, d.label, 3, maxW / 2), MARGIN, 56, 3, GOLD);
  const date = oneLine(font, d.date, 2, maxW / 2);
  r.text(font, date, CARD_W - MARGIN - textWidth(font, date, 2), 64, 2, MUTED);
  // Large type when the title fits in three lines, smaller (four lines) otherwise.
  const large = wrapText(font, d.title, 5, maxW, 4);
  const scale = large.length <= 3 ? 5 : 4;
  const lines = scale === 5 ? large : wrapText(font, d.title, 4, maxW, 4);
  let y = 130;
  for (const line of lines) {
    r.text(font, line, MARGIN, y, scale, INK);
    y += lineHeight(scale) + 14;
  }
  // Up to three of the agents involved, side by side above the footer.
  const portraits = d.portraits.slice(0, 3);
  let px = MARGIN;
  for (const p of portraits) {
    const s = Math.floor(140 / p.height);
    r.blit(p.rgba, p.width, p.height, px, CARD_H - 24 - 70 - p.height * s, s);
    px += p.width * s + 24;
  }
  footer(r, font, { footer: d.footer, site: d.site });
  return r;
}

function gazetteCard(font: BitmapFont, d: GazetteCardData): Raster {
  const r = new Raster(CARD_W, CARD_H, [236, 228, 208]);
  frame(r);
  const paperInk: Rgb = [40, 32, 28];
  const maxW = CARD_W - 2 * MARGIN;
  const ms = fitScale(font, d.masthead, maxW, [5, 4, 3]);
  const mast = oneLine(font, d.masthead, ms, maxW);
  r.text(font, mast, Math.floor((CARD_W - textWidth(font, mast, ms)) / 2), 52, ms, paperInk);
  const ruleY = 52 + lineHeight(ms) + 16;
  r.rect(MARGIN, ruleY, maxW, 4, paperInk);
  const date = oneLine(font, d.date, 2, maxW);
  r.text(font, date, Math.floor((CARD_W - textWidth(font, date, 2)) / 2), ruleY + 14, 2, [110, 96, 84]);
  r.rect(MARGIN, ruleY + 14 + lineHeight(2) + 12, maxW, 2, paperInk);
  let y = ruleY + 14 + lineHeight(2) + 44;
  for (const line of wrapText(font, d.headline, 4, maxW, 4)) {
    r.text(font, line, Math.floor((CARD_W - textWidth(font, line, 4)) / 2), y, 4, paperInk);
    y += lineHeight(4) + 14;
  }
  footer(r, font, { footer: d.footer, site: d.site }, [[150, 60, 40], [110, 96, 84]]);
  return r;
}

/** Composes a 1200x630 card. Deterministic: the same data always gives the same bytes. */
export function drawCard(font: BitmapFont, d: CardData): Buffer {
  const r = d.kind === 'agent' ? agentCard(font, d) : d.kind === 'highlight' ? highlightCard(font, d) : gazetteCard(font, d);
  return r.png();
}
