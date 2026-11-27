/**
 * Small validators for untrusted JSON from the server (WebSocket and `/api/public`). Everything is checked field by
 * field; a malformed entry is dropped on its own and never takes the rest of a list with it.
 */
import type { ElectionInfo, HallInfo, Highlight, InterestIncrement, KeyMsg } from '@ajwf/shared';

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
export const isStr = (v: unknown): v is string => typeof v === 'string';
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
export const num = (v: unknown, d = 0): number => (isNum(v) ? v : d);
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const strings = (v: unknown): string[] => arr(v).filter(isStr);

/**
 * `batch.interest` of the world topic (director mode): at most 50 entries, each with a plausible agent name, room
 * id, event type and a finite positive score. Anything else is dropped entry by entry.
 */
export function parseIncrements(v: unknown): InterestIncrement[] {
  const out: InterestIncrement[] = [];
  for (const x of arr(v).slice(0, 50)) {
    if (!isObj(x) || !isStr(x.n) || !isStr(x.r) || !isStr(x.e) || !isNum(x.p)) continue;
    if (!x.n || x.n.length > 64 || !/^[a-z0-9_.]{1,80}$/.test(x.r) || !/^[a-z0-9_]{1,40}$/.test(x.e)) continue;
    if (x.p <= 0 || x.p > 1000) continue;
    out.push({ n: x.n, r: x.r, p: x.p, e: x.e });
  }
  return out;
}

/** Params of an i18n message: only strings and numbers survive. */
export function params(v: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (isStr(x) || isNum(x)) out[k] = x;
  return out;
}

export function keyMsg(v: unknown): KeyMsg | null {
  if (!isObj(v) || !isStr(v.k)) return null;
  return { k: v.k, p: params(v.p) };
}

/** `#rrggbb` only: colours from agents never become arbitrary CSS. */
export function safeColor(v: unknown, d = '#8a6a2a'): string {
  return isStr(v) && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : d;
}

export function parseHall(v: unknown): HallInfo | null {
  if (!isObj(v) || !isStr(v.guild)) return null;
  const c = arr(v.colors);
  return { guild: v.guild, colors: [safeColor(c[0], '#d9534f'), safeColor(c[1], '#f2b84b')], at: num(v.at) };
}

export function parseHalls(v: unknown): Record<string, HallInfo> | null {
  if (!isObj(v)) return null;
  const out: Record<string, HallInfo> = {};
  for (const [plot, h] of Object.entries(v)) {
    const p = parseHall(h);
    if (p) out[plot] = p;
  }
  return out;
}

export function parseStringMap(v: unknown): Record<string, string> | null {
  if (!isObj(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (isStr(x)) out[k] = x;
  return out;
}

export function parseElection(v: unknown): ElectionInfo | null {
  if (!isObj(v) || !isNum(v.n)) return null;
  const candidates = arr(v.candidates).flatMap((c) =>
    isStr(c) ? [c] : isObj(c) && isStr(c.name) ? [c.name] : [],
  );
  return {
    n: v.n,
    phase: v.phase === 'voting' ? 'voting' : 'candidacy',
    voteAt: num(v.voteAt),
    end: num(v.end),
    candidates,
  };
}

/** A language tag we are willing to put in a `lang` attribute and a chip. */
export function safeLang(lang: unknown): string | null {
  return isStr(lang) && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(lang) ? lang : null;
}

/** Agent-written text with its language. The text is never interpreted: it only ever becomes a text node. */
export type AgentText = { text: string; lang: string | null };

export function agentText(text: unknown, lang: unknown): AgentText | null {
  const t = isObj(text) ? text.untrusted_text : text;
  return isStr(t) && t.length > 0 ? { text: t, lang: safeLang(lang) } : null;
}

export function parseHighlight(v: unknown): Highlight | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.type) || !isStr(v.titleKey)) return null;
  const h: Highlight = {
    id: v.id,
    type: v.type,
    ts: num(v.ts),
    titleKey: v.titleKey,
    params: params(v.params),
    agents: strings(v.agents).slice(0, 20),
    drama: num(v.drama),
  };
  if (isStr(v.room)) h.room = v.room;
  if (isStr(v.ref)) h.ref = v.ref;
  if (isObj(v.quote) && isStr(v.quote.text)) h.quote = { text: v.quote.text, lang: str(v.quote.lang, 'en') };
  return h;
}

export function parseHighlights(v: unknown): Highlight[] {
  return arr(v).flatMap((x) => {
    const h = parseHighlight(x);
    return h ? [h] : [];
  });
}
