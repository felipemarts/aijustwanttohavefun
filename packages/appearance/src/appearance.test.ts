import { describe, expect, it } from 'vitest';
import { createRng } from '@ajwf/shared';
import { I18n } from '@ajwf/i18n';
import { loadLocales } from '@ajwf/i18n/node';
import { PNG } from 'pngjs';
import {
  appearanceHash,
  describeAppearance,
  ensureUnique,
  LAYERS,
  OptionsTokenStore,
  optionIds,
  randomAppearance,
  validateChoice,
  CATALOG,
  type Appearance,
} from './index';
import { renderSpritePng, FRAME_W, FRAMES, FRAME_H } from './sprite';

describe('catalog', () => {
  it('meets the launch minimums', () => {
    expect(CATALOG.species.length).toBeGreaterThanOrEqual(6);
    expect(optionIds('skin').length).toBeGreaterThanOrEqual(6);
    expect(CATALOG.hair_style.length).toBeGreaterThanOrEqual(15);
    expect(CATALOG.hair_color.length).toBeGreaterThanOrEqual(12);
    expect(CATALOG.hat.length).toBeGreaterThanOrEqual(20);
    expect(CATALOG.top.length).toBeGreaterThanOrEqual(20);
    expect(CATALOG.bottom.length).toBeGreaterThanOrEqual(10);
    expect(CATALOG.cloak.length).toBeGreaterThanOrEqual(11);
    expect(CATALOG.accessory.length).toBeGreaterThanOrEqual(16);
    expect(CATALOG.dye.length).toBeGreaterThanOrEqual(16);
  });
});

describe('options draw and token', () => {
  it('draws 5 options per layer and different draws for different tokens', () => {
    const store = new OptionsTokenStore(42);
    const a = store.issue(1000, 'a');
    const b = store.issue(1001, 'b');
    for (const l of LAYERS) expect(a.options[l].length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(a.options)).not.toBe(JSON.stringify(b.options));
  });
  it('rejects choices outside the draw and expired tokens', () => {
    const store = new OptionsTokenStore(1);
    const { token, options } = store.issue(0, 'x');
    const draw = store.get(token, 1000)!;
    const ok = randomAppearance(createRng(3), options);
    expect(validateChoice(ok, draw).ok).toBe(true);
    const outside = optionIds('hat', true).find((h) => !draw.hat.includes(h))!;
    expect(validateChoice({ ...ok, hat: outside }, draw).ok).toBe(false);
    expect(store.get(token, 31 * 60 * 1000)).toBeNull();
  });
});

describe('uniqueness', () => {
  it('1000 surprise_me registrations give 1000 distinct appearances', () => {
    const rng = createRng(7);
    const taken = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      // Force collisions: half of them start from the same base appearance.
      const base = i % 2 === 0 ? randomAppearance(createRng(1)) : randomAppearance(rng);
      const r = ensureUnique(base, (h) => taken.has(h), rng);
      expect(taken.has(r.hash)).toBe(false);
      taken.add(r.hash);
    }
    expect(taken.size).toBe(1000);
  });
  it('reports which layers changed', () => {
    const a = randomAppearance(createRng(2));
    const h = appearanceHash(a);
    const r = ensureUnique(a, (x) => x === h, createRng(5));
    expect(r.changed.length).toBeGreaterThan(0);
    expect(r.hash).not.toBe(h);
  });
});

describe('description', () => {
  const i18n = new I18n(loadLocales());
  const a: Appearance = {
    species: 'dwarf',
    skin: 's2',
    hair_style: 'braids',
    hair_color: 'c4',
    hat: 'feathered_hat',
    top: 'patched_jerkin',
    bottom: 'trousers',
    cloak: 'none',
    accessory: 'pipe',
    dye: 'd0',
  };
  const en = (x: Appearance) => describeAppearance(x, (k, p) => i18n.t('en', k, p), 'en');
  const pt = (x: Appearance) => describeAppearance(x, (k, p) => i18n.t('pt-BR', k, p), 'pt-BR');
  it('describes in English, naming the dye once', () => {
    expect(en(a)).toBe('a stout dwarf with copper braided hair, wearing a feathered hat and a patched jerkin, all in crimson, with a pipe');
  });
  it('picks a or an in English', () => {
    const b: Appearance = { ...a, hat: 'helm', top: 'apron', cloak: 'hooded_cloak', accessory: 'none', dye: 'd4' };
    expect(en(b)).toBe('a stout dwarf with copper braided hair, wearing a helm, an apron, and a hooded cloak, all in amber');
    expect(en(b)).not.toMatch(/\ba [aeiou]/);
    expect(en({ ...b, hat: 'none', cloak: 'none' })).toBe('a stout dwarf with copper braided hair, wearing an apron in amber');
  });
  it('never repeats the dye color', () => {
    for (const x of [a, { ...a, cloak: 'long_cloak' }]) {
      for (const d of [en(x), pt(x)]) expect(d.split(i18n.t(d === en(x) ? 'en' : 'pt-BR', 'appearance.dye.d0')).length - 1).toBe(1);
    }
  });
  it('reads naturally in Brazilian Portuguese', () => {
    expect(pt(a)).toBe('um anão atarracado, com cabelo acobreado trançado, vestindo chapéu com pena e jaqueta remendada, tudo em tom carmesim, e com um cachimbo');
    expect(pt({ ...a, hat: 'none', accessory: 'none', dye: 'd4' })).toBe('um anão atarracado, com cabelo acobreado trançado, vestindo jaqueta remendada em tom âmbar');
  });
  it('describes in every launch language without raw keys', () => {
    for (const lang of ['pt-BR', 'es', 'zh-CN', 'ja', 'fr']) {
      const d = describeAppearance(a, (k, p) => i18n.t(lang, k, p), lang);
      expect(d.length).toBeGreaterThan(10);
      expect(d).not.toContain('appearance.');
    }
  });
});

describe('sprite', () => {
  it('renders a PNG sheet with visible pixels for random appearances', () => {
    const rng = createRng(11);
    for (let i = 0; i < 30; i++) {
      const png = PNG.sync.read(renderSpritePng(randomAppearance(rng)));
      expect(png.width).toBe(FRAME_W * FRAMES);
      expect(png.height).toBe(FRAME_H);
      let opaque = 0;
      for (let p = 3; p < png.data.length; p += 4) if (png.data[p]! > 0) opaque++;
      expect(opaque).toBeGreaterThan(150);
    }
  });
  it('different appearances render differently', () => {
    const a = randomAppearance(createRng(1));
    const b = { ...a, hat: a.hat === 'crown' ? 'helm' : 'crown' };
    expect(renderSpritePng(a).equals(renderSpritePng(b))).toBe(false);
  });
});
