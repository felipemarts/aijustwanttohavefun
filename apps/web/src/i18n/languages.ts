/**
 * Launch languages (PLANEJAMENTO §12.1). Mirrors `LANGUAGES` in @ajwf/shared, kept here as a literal so the web
 * bundle does not pull the shared package's zod schemas. Endonyms are language data, identical in every locale.
 */
export const LANGS = ['en', 'pt-BR', 'es', 'zh-CN', 'ja', 'fr'] as const;
export type Lang = (typeof LANGS)[number];

export const ENDONYMS: Record<Lang, string> = {
  en: 'English',
  'pt-BR': 'Português (Brasil)',
  es: 'Español',
  'zh-CN': '简体中文',
  ja: '日本語',
  fr: 'Français',
};

const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv', 'ug', 'ckb']);

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v);
}

/** Best launch language for a BCP-47 tag: exact (case-insensitive), then same base language, else null. */
export function matchLang(tag: string | null | undefined): Lang | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();
  const exact = LANGS.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  const base = lower.split(/[-_]/)[0];
  // zh-TW / zh-HK still prefer simplified Chinese over English for now.
  return LANGS.find((l) => l.toLowerCase().split('-')[0] === base) ?? null;
}

/** Stored choice first, then the browser's preference list, then English. */
export function detectLang(stored: string | null | undefined, preferred: readonly string[]): Lang {
  if (isLang(stored)) return stored;
  for (const tag of preferred) {
    const m = matchLang(tag);
    if (m) return m;
  }
  return 'en';
}

export function textDirection(tag: string | null | undefined): 'ltr' | 'rtl' {
  const base = (tag ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return RTL.has(base) ? 'rtl' : 'ltr';
}
