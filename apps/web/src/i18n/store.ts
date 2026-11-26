import { useSyncExternalStore } from 'react';
import uiEn from 'virtual:ajwf-ui-en';
import { detectLang, type Lang, textDirection } from './languages';
import { type Messages, Translator } from './translator';

const STORAGE_KEY = 'ajwf.lang';

/** Offline catalogs built from the repo's YAML (lazy chunks): mock mode and fallback when the server is unreachable. */
const BUNDLED: Record<Lang, () => Promise<{ default: Messages }>> = {
  en: () => import('virtual:ajwf-catalog/en'),
  'pt-BR': () => import('virtual:ajwf-catalog/pt-BR'),
  es: () => import('virtual:ajwf-catalog/es'),
  'zh-CN': () => import('virtual:ajwf-catalog/zh-CN'),
  ja: () => import('virtual:ajwf-catalog/ja'),
  fr: () => import('virtual:ajwf-catalog/fr'),
};

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

async function fetchCatalog(lang: Lang, offline: boolean): Promise<Messages> {
  if (!offline) {
    try {
      const res = await fetch(`/api/public/i18n/${encodeURIComponent(lang)}`, {
        headers: { accept: 'application/json' },
      });
      if (res.ok) {
        const body: unknown = await res.json();
        const messages = body && typeof body === 'object' ? (body as { messages?: unknown }).messages : null;
        if (messages && typeof messages === 'object') {
          const out: Messages = {};
          for (const [k, v] of Object.entries(messages as Record<string, unknown>))
            if (typeof v === 'string') out[k] = v;
          if (Object.keys(out).length > 0) return out;
        }
      }
    } catch {
      // fall back to the bundled catalog
    }
  }
  return (await BUNDLED[lang]()).default;
}

type Listener = () => void;

/** Holds the current language and translator; React reads it through `useT()`, the Pixi scene through `i18n.tr`. */
class I18nStore {
  tr: Translator;
  private listeners = new Set<Listener>();
  private cache = new Map<Lang, Messages>();
  private offline = false;
  private seq = 0;

  constructor() {
    const lang =
      typeof navigator !== 'undefined'
        ? detectLang(readStored(), navigator.languages ?? [navigator.language])
        : 'en';
    this.tr = new Translator(lang, {}, uiEn);
  }

  get lang(): Lang {
    return this.tr.lang as Lang;
  }

  /** Mock mode never asks the server. */
  init(opts: { offline: boolean }) {
    this.offline = opts.offline;
    void this.setLang(this.lang, false);
  }

  async setLang(lang: Lang, persist = true) {
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, lang);
      } catch {
        // private mode: the choice lasts for this page only
      }
    }
    const seq = ++this.seq;
    document.documentElement.lang = lang;
    document.documentElement.dir = textDirection(lang);
    // Switch immediately (English fallback), then again when the catalog arrives.
    const cached = this.cache.get(lang);
    this.tr = new Translator(lang, cached ?? {}, uiEn);
    this.emit();
    if (cached) return;
    let messages: Messages;
    try {
      messages = await fetchCatalog(lang, this.offline);
    } catch {
      return;
    }
    this.cache.set(lang, messages);
    if (seq !== this.seq) return;
    this.tr = new Translator(lang, messages, {
      ...uiEn,
      ...(lang === 'en' ? {} : (this.cache.get('en') ?? {})),
    });
    this.emit();
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    for (const l of this.listeners) l();
  }
}

export const i18n = new I18nStore();

const getTr = () => i18n.tr;

/** The current translator; components re-render when the language or catalog changes. */
export function useT(): Translator {
  return useSyncExternalStore(i18n.subscribe, getTr, getTr);
}
