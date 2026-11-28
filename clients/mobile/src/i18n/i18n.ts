/**
 * A small i18n layer: one flat JSON file per language (`en.json` is the source), `{name}` placeholders, and plural
 * forms as `key_one` / `key_other` (and `_zero`, `_two`, `_few`, `_many` where a language needs them) chosen with
 * `Intl.PluralRules` from the `count` parameter.
 *
 * To add a language: translate `en.json` into `<tag>.json` and add one line to RESOURCES. Missing keys fall back to
 * English. Narration, names and other strings that come from the core are already localized and never pass here.
 */
import en from './en.json';
import es from './es.json';
import fr from './fr.json';
import ja from './ja.json';
import ptBR from './pt-BR.json';
import zhCN from './zh-CN.json';

export type Dict = Record<string, string>;
export type Params = Record<string, string | number>;

export const RESOURCES: Record<string, Dict> = {
  en,
  'pt-BR': ptBR,
  es,
  fr,
  ja,
  'zh-CN': zhCN,
};

/**
 * Keys waiting for the next translation round in these languages: added in English (missing there, so they show the
 * English text) or changed in English (the old translation is still there and is outdated). Empty it when the
 * translations arrive. The completeness test fails if a language misses a key that is not listed here.
 */
const PENDING_KEYS = [
  // added
  'error.core_unreachable',
  'error.not_on_device',
  'card.syncing',
  'card.latestA11y',
  'stuck.label',
  'stuck.refusals',
  'stuck.no_progress',
  'stuck.lost',
  'stuck.nudge',
  'stuck.nudgeHint',
  'nudge.quest',
  'nudge.turnIn',
  'nudge.noProgress',
  'nudge.lost',
  'nudge.generic',
  'talk.modeLabel',
  'talk.modeChat',
  'talk.modeCommand',
  'talk.commandPlaceholder',
  'talk.commandHint',
  'status.thinkingFor',
  'slow.title',
  'slow.action',
  'new.languageHint',
  'time.justNow',
  'settings.keepAwakeHint',
  'engine.verifying',
  // changed in English
  'error.network',
  'error.not_available',
  'home.noSession.body',
  'settings.keepAwake',
  'new.personaHint',
  'guide.personaHint',
];
export const PENDING_TRANSLATION: Record<string, string[]> = Object.fromEntries(['es', 'fr', 'ja', 'zh-CN'].map((l) => [l, PENDING_KEYS]));

/** The game's six languages, by endonym. */
export const LANGUAGES: { tag: string; name: string }[] = [
  { tag: 'en', name: 'English' },
  { tag: 'pt-BR', name: 'Português (Brasil)' },
  { tag: 'es', name: 'Español' },
  { tag: 'fr', name: 'Français' },
  { tag: 'ja', name: '日本語' },
  { tag: 'zh-CN', name: '简体中文' },
];

/** Maps any BCP-47 tag to one of LANGUAGES (pt-PT and pt go to pt-BR, es-MX to es, zh-Hans to zh-CN). */
export function resolveLanguage(tag: string | undefined | null): string {
  if (!tag) return 'en';
  const lower = tag.toLowerCase();
  const exact = LANGUAGES.find((l) => l.tag.toLowerCase() === lower);
  if (exact) return exact.tag;
  const primary = lower.split(/[-_]/)[0];
  const byPrimary = LANGUAGES.find((l) => l.tag.toLowerCase().split('-')[0] === primary);
  return byPrimary ? byPrimary.tag : 'en';
}

const pluralCache = new Map<string, Intl.PluralRules>();
function pluralCategory(lang: string, n: number): string {
  try {
    let pr = pluralCache.get(lang);
    if (!pr) {
      pr = new Intl.PluralRules(lang);
      pluralCache.set(lang, pr);
    }
    return pr.select(n);
  } catch {
    return n === 1 ? 'one' : 'other';
  }
}

function lookup(lang: string, key: string): string | undefined {
  const own = RESOURCES[lang];
  if (own && Object.prototype.hasOwnProperty.call(own, key)) return own[key];
  if (Object.prototype.hasOwnProperty.call(en, key)) return (en as Dict)[key];
  return undefined;
}

export function hasKey(lang: string, key: string): boolean {
  return lookup(lang, key) !== undefined;
}

export function translate(lang: string, key: string, params?: Params): string {
  let raw: string | undefined;
  const count = params?.count;
  if (typeof count === 'number') {
    raw = lookup(lang, `${key}_${pluralCategory(lang, count)}`) ?? lookup(lang, `${key}_other`);
  }
  raw ??= lookup(lang, key) ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, k)) return m;
    const v = params[k];
    return typeof v === 'number' ? formatNumber(lang, v) : String(v);
  });
}

export function formatNumber(lang: string, n: number, digits = 0): string {
  try {
    return new Intl.NumberFormat(lang, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
  } catch {
    return n.toFixed(digits);
  }
}

export function formatTime(lang: string, ts: number): string {
  try {
    return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(ts);
  } catch {
    return new Date(ts).toTimeString().slice(0, 5);
  }
}

export function formatDateTime(lang: string, ts: number): string {
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(ts);
  } catch {
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** "3 hours ago" in the interface language, through Intl; falls back to a clock time. */
export function formatAgo(lang: string, ts: number, now = Date.now()): string {
  // A past event is never worded as the future: anything from 10 s ago up to "after now" (clock skew between the
  // core and the page) is "just now".
  const s = Math.min(0, Math.round((ts - now) / 1000));
  const abs = Math.abs(s);
  if (abs < 10) return translate(lang, 'time.justNow');
  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    if (abs < 60) return rtf.format(s, 'second');
    if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86400), 'day');
  } catch {
    return formatTime(lang, ts);
  }
}

/** `m:ss` or `h:mm:ss`, digits only. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatBytes(lang: string, bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${formatNumber(lang, v, i >= 2 ? 1 : 0)} ${units[i]}`;
}
