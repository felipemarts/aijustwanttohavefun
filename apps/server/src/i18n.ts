import { loadContentCatalogs } from '@ajwf/content/node';
import { I18n, type Catalogs } from '@ajwf/i18n';
import { loadLocales } from '@ajwf/i18n/node';

/**
 * Narration, server text (`api.*`, in packages/i18n/locales/<lang>/api.yaml) and content names in every language;
 * `extra` overrides (tests inject small catalogs).
 */
export function loadCatalogs(extra: Catalogs = {}): Catalogs {
  const catalogs = loadContentCatalogs(loadLocales());
  for (const [lang, cat] of Object.entries(extra)) Object.assign((catalogs[lang] ??= {}), cat);
  return catalogs;
}

/**
 * `@agent:<id>` references are resolved to the agent's current name; every other kind goes to the content
 * catalogs (`content.<kind>.<id>.name`).
 */
export function createI18n(catalogs: Catalogs, agentName: (id: string) => string | undefined): I18n {
  const i18n = new I18n(catalogs);
  i18n.setRefResolver((lang, kind, id) => (kind === 'agent' ? agentName(id) : i18n.lookupRef(lang, kind, id)));
  return i18n;
}
