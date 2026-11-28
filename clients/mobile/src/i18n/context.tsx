import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { hasKey, resolveLanguage, translate, type Params } from './i18n';

export type T = (key: string, params?: Params) => string;
type I18n = { lang: string; t: T; has: (key: string) => boolean };

const I18nContext = createContext<I18n>({
  lang: 'en',
  t: (k, p) => translate('en', k, p),
  has: (k) => hasKey('en', k),
});

export function I18nProvider({ language, children }: { language: string; children: ReactNode }) {
  const value = useMemo<I18n>(() => {
    const lang = resolveLanguage(language);
    return { lang, t: (k, p) => translate(lang, k, p), has: (k) => hasKey(lang, k) };
  }, [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}

/** A failure's text: the localized message for codes the interface knows, else the core's own message. */
export function errorText(i: I18n, f: { code: string; message: string }): string {
  const key = `error.${f.code}`;
  if (i.has(key)) return i.t(key);
  return f.message || i.t('error.unknown');
}
