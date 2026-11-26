import { createRng, hashString, OPTIONS_TOKEN_PREFIX, type Rng } from '@ajwf/shared';
import { LAYERS, optionIds, hasOption, type Appearance, type Layer } from './catalog';

export * from './catalog';

export const OPTIONS_PER_LAYER = 5;
export const OPTIONS_TTL_MS = 30 * 60 * 1000;

export type OptionsDraw = Record<Layer, string[]>;

/** Draws `OPTIONS_PER_LAYER` starter options per layer. Layers with fewer options return all of them. */
export function drawOptions(rng: Rng): OptionsDraw {
  const out = {} as OptionsDraw;
  for (const layer of LAYERS) {
    const ids = rng.shuffle([...optionIds(layer, true)]);
    out[layer] = ids.slice(0, Math.min(OPTIONS_PER_LAYER, ids.length));
  }
  return out;
}

export function randomAppearance(rng: Rng, from?: OptionsDraw): Appearance {
  const out = {} as Appearance;
  for (const layer of LAYERS) out[layer] = rng.pick(from ? from[layer] : optionIds(layer, true));
  return out;
}

export function canonical(a: Appearance): string {
  return LAYERS.map((l) => `${l}=${a[l]}`).join(';');
}

export function appearanceHash(a: Appearance): string {
  return hashString(canonical(a));
}

export type ValidateResult = { ok: true } | { ok: false; layer: Layer; value: string };

/** Checks every layer is a known option and, if a draw is given, that the choice was offered. */
export function validateChoice(a: Record<string, string>, draw?: OptionsDraw): ValidateResult {
  for (const layer of LAYERS) {
    const v = a[layer];
    if (typeof v !== 'string' || !hasOption(layer, v)) return { ok: false, layer, value: String(v) };
    if (draw && !draw[layer].includes(v)) return { ok: false, layer, value: v };
  }
  return { ok: true };
}

/**
 * Guarantees uniqueness: while the hash is taken, swap the accessory or the dye (then other layers)
 * for a random starter option. Returns the final appearance and which layers changed.
 */
export function ensureUnique(
  a: Appearance,
  taken: (hash: string) => boolean,
  rng: Rng,
): { appearance: Appearance; hash: string; changed: Layer[] } {
  const cur = { ...a };
  const changed = new Set<Layer>();
  let hash = appearanceHash(cur);
  const order: Layer[] = ['accessory', 'dye', 'hair_color', 'cloak', 'hat', 'bottom', 'top', 'hair_style'];
  for (let i = 0; taken(hash) && i < 5000; i++) {
    const layer = i < 60 ? rng.pick(order.slice(0, 2)) : rng.pick(order);
    cur[layer] = rng.pick(optionIds(layer, true));
    changed.add(layer);
    hash = appearanceHash(cur);
  }
  for (const l of [...changed]) if (cur[l] === a[l]) changed.delete(l);
  return { appearance: cur, hash, changed: [...changed] };
}

type TokenEntry = { draw: OptionsDraw; expiresAt: number };

/** In-memory store for `options_token`s (valid 30 minutes). */
export class OptionsTokenStore {
  private tokens = new Map<string, TokenEntry>();
  private seq = 0;
  constructor(
    private seed: number,
    private maxSize = 100_000,
  ) {}

  issue(now: number, randomId: string): { token: string; options: OptionsDraw; expiresAt: number } {
    if (this.tokens.size >= this.maxSize) this.sweep(now);
    if (this.tokens.size >= this.maxSize) {
      const first = this.tokens.keys().next().value;
      if (first) this.tokens.delete(first);
    }
    const rng = createRng(this.seed ^ (now & 0x7fffffff) ^ ++this.seq * 2654435761);
    const draw = drawOptions(rng);
    const token = `${OPTIONS_TOKEN_PREFIX}${randomId}`;
    const expiresAt = now + OPTIONS_TTL_MS;
    this.tokens.set(token, { draw, expiresAt });
    return { token, options: draw, expiresAt };
  }

  get(token: string, now: number): OptionsDraw | null {
    const e = this.tokens.get(token);
    if (!e) return null;
    if (e.expiresAt < now) {
      this.tokens.delete(token);
      return null;
    }
    return e.draw;
  }

  consume(token: string): void {
    this.tokens.delete(token);
  }

  sweep(now: number): void {
    for (const [k, v] of this.tokens) if (v.expiresAt < now) this.tokens.delete(k);
  }
}

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * Text description shown to other agents in /look (they cannot see sprites).
 * Built from i18n templates; `lang` is used for list formatting.
 */
export function describeAppearance(a: Appearance, t: Translate, lang: string): string {
  const name = (layer: Layer, id: string) => t(`appearance.${layer}.${id}`);
  const subject = t('appearance.subject', { species: name('species', a.species), build: t(`appearance.build.${a.species}`) });
  const hair =
    a.hair_style === 'bald'
      ? t('appearance.hair_bald')
      : t('appearance.hair', { color: name('hair_color', a.hair_color), style: name('hair_style', a.hair_style) });
  const color = name('dye', a.dye);
  const items: string[] = [];
  if (a.hat !== 'none') items.push(t('appearance.item', { item: name('hat', a.hat), color }));
  items.push(t('appearance.item', { item: name('top', a.top), color }));
  if (a.cloak !== 'none') items.push(t('appearance.item', { item: name('cloak', a.cloak), color }));
  if (a.accessory !== 'none') items.push(t('appearance.plain_item', { item: name('accessory', a.accessory) }));
  let list: string;
  try {
    list = new Intl.ListFormat(lang, { type: 'conjunction' }).format(items);
  } catch {
    list = items.join(', ');
  }
  return t('appearance.desc', { subject, hair, items: list });
}
