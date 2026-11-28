import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from './en.json';
import { formatAgo, PENDING_TRANSLATION, RESOURCES, resolveLanguage, translate, type Dict } from './i18n';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const SRC = join(__dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(f) && !f.endsWith('.test.ts') ? [p] : [];
  });
}

const EN = en as Dict;
const PLURAL = /_(zero|one|two|few|many|other)$/;
const enPlainKeys = Object.keys(EN).filter((k) => !PLURAL.test(k));
const enFamilies = [...new Set(Object.keys(EN).filter((k) => PLURAL.test(k)).map((k) => k.replace(PLURAL, '')))];

/** Plural categories a language really uses for the whole numbers this interface shows (0 to 100 000). */
function neededCategories(lang: string): Set<string> {
  const pr = new Intl.PluralRules(lang);
  const out = new Set<string>();
  for (let n = 0; n <= 100_000; n += n < 1000 ? 1 : 997) out.add(pr.select(n));
  return out;
}

describe.each(Object.keys(RESOURCES).filter((l) => l !== 'en'))('%s is complete against en', (lang) => {
  const dict = RESOURCES[lang]!;
  const pending = new Set(PENDING_TRANSLATION[lang] ?? []);
  const allowed = new Set(new Intl.PluralRules(lang).resolvedOptions().pluralCategories as string[]);

  it('has every plain English key (except those pending translation) and no unknown key', () => {
    const missing = enPlainKeys.filter((k) => !(k in dict));
    expect(missing.filter((k) => !pending.has(k))).toEqual([]);
    const known = new Set(Object.keys(EN));
    const extra = Object.keys(dict).filter((k) => !known.has(k) && !(PLURAL.test(k) && enFamilies.includes(k.replace(PLURAL, ''))));
    expect(extra).toEqual([]);
  });

  it('has every plural form the language needs, and only forms it has', () => {
    const problems: string[] = [];
    for (const fam of enFamilies) {
      for (const cat of new Set([...neededCategories(lang), 'other'])) if (!(`${fam}_${cat}` in dict)) problems.push(`missing ${fam}_${cat}`);
      // A form the language never uses is an error, unless it is one of the English forms kept as is (harmless).
      for (const k of Object.keys(dict)) {
        const m = k.match(PLURAL);
        if (m && k.replace(PLURAL, '') === fam && !allowed.has(m[1]!) && !(k in EN)) problems.push(`unused form ${k}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the placeholders of the English text', () => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(dict)) {
      const source = EN[k] ?? EN[`${k.replace(PLURAL, '')}_other`];
      if (source === undefined) continue;
      const want = placeholders(source);
      const got = placeholders(v);
      // A singular form may leave the number out ("une action"); everything else keeps the same placeholders.
      const ok = PLURAL.test(k) && !k.endsWith('_other') ? got.every((p) => want.includes(p)) : got.join() === want.join();
      if (!ok) bad.push(`${k}: ${got.join(',')} vs ${want.join(',')}`);
    }
    expect(bad).toEqual([]);
  });

  it('has no empty strings', () => {
    expect(Object.entries(dict).filter(([, v]) => !v.trim())).toEqual([]);
  });
});

describe('pending translations and notes', () => {
  it('notes for translators only talk about keys that exist', () => {
    const notes = JSON.parse(readFileSync(join(__dirname, 'notes.en.json'), 'utf8')) as Dict;
    expect(Object.keys(notes).filter((k) => !k.startsWith('_') && !(k in EN))).toEqual([]);
  });

  it('lists only keys that exist in English, each once', () => {
    for (const keys of Object.values(PENDING_TRANSLATION)) {
      expect(keys.filter((k) => !(k in EN))).toEqual([]);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('the code uses only keys that exist', () => {
  it('every literal t("key") is in en.json', () => {
    const missing: string[] = [];
    for (const f of files(SRC)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([\w.]+)'/g)) {
        const k = m[1]!;
        if (!(k in en) && !(`${k}_other` in en)) missing.push(`${f.replace(SRC, '')}: ${k}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('dynamic key families are complete', () => {
    const need = [
      ...['playing', 'thinking', 'resting', 'paused', 'fallen', 'blocked'].map((s) => `status.${s}`),
      ...['not_installed', 'downloading', 'starting', 'ready', 'unreachable', 'error'].map((s) => `engine.status.${s}`),
      ...['warrior', 'mage', 'rogue', 'cleric'].flatMap((c) => [`class.${c}`, `class.${c}.desc`]),
      ...['relaxed', 'normal', 'active'].flatMap((p) => [`pace.${p}`, `pace.${p}.desc`]),
      ...['activity', 'sheet', 'talk', 'guidance'].map((x) => `tab.${x}`),
      ...['connecting', 'reconnecting', 'unauthorized'].map((x) => `conn.${x}`),
      ...['desktop', 'mobile'].map((x) => `settings.platform.${x}`),
    ];
    expect(need.filter((k) => !(k in en))).toEqual([]);
  });

  it('components carry no hard-coded English sentences', () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      if (!f.endsWith('.tsx')) continue;
      const src = readFileSync(f, 'utf8');
      // Text between JSX tags that looks like words (three letters or more).
      for (const m of src.matchAll(/>\s*([A-Za-z][A-Za-z']+(?:\s+[A-Za-z']+)+)\s*</g)) offenders.push(`${f.replace(SRC, '')}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('translate', () => {
  it('interpolates and formats numbers per language', () => {
    expect(translate('en', 'card.level', { level: 7 })).toBe('Level 7');
    expect(translate('pt-BR', 'card.level', { level: 7 })).toBe('Nível 7');
    expect(translate('en', 'away.xp', { count: 12345 })).toBe('+12,345 XP');
    expect(translate('pt-BR', 'away.xp', { count: 12345 })).toBe('+12.345 XP');
  });

  it('chooses plural forms', () => {
    expect(translate('en', 'away.actions', { count: 1 })).toBe('1 action');
    expect(translate('en', 'away.actions', { count: 2 })).toBe('2 actions');
    expect(translate('pt-BR', 'away.actions', { count: 1 })).toBe('1 ação');
    expect(translate('pt-BR', 'away.actions', { count: 5 })).toBe('5 ações');
  });

  it('falls back to English for a language without the text, then to the key', () => {
    expect(translate('xx', 'engine.check')).toBe('Check');
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });

  it('does not resolve prototype names as keys', () => {
    expect(translate('en', '__proto__')).toBe('__proto__');
    expect(translate('en', 'constructor')).toBe('constructor');
  });

  it('never words a past event as the future: at or after the present it is "just now"', () => {
    expect(formatAgo('en', 10_500, 10_000)).toBe('just now'); // stamped by the core a moment after the page's clock
    expect(formatAgo('en', 70_000, 10_000)).toBe('just now'); // a skew of a whole minute
    expect(formatAgo('en', 10_000, 10_000)).toBe('just now');
    expect(formatAgo('pt-BR', 12_000, 10_000)).toBe('agora mesmo');
    expect(formatAgo('en', 10_000 - 120_000, 10_000)).toBe('2 minutes ago');
    expect(formatAgo('en', 10_000 - 30_000, 10_000)).toBe('30 seconds ago');
  });

  it('resolves language tags', () => {
    expect(resolveLanguage('pt')).toBe('pt-BR');
    expect(resolveLanguage('pt-PT')).toBe('pt-BR');
    expect(resolveLanguage('es-MX')).toBe('es');
    expect(resolveLanguage('zh-Hans-CN')).toBe('zh-CN');
    expect(resolveLanguage('de')).toBe('en');
    expect(resolveLanguage(undefined)).toBe('en');
  });
});
