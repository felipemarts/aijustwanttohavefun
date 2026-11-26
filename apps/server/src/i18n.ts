import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadContentCatalogs } from '@ajwf/content/node';
import { flatten, I18n, type Catalogs } from '@ajwf/i18n';
import { loadLocales } from '@ajwf/i18n/node';

export const SERVER_LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'locales');

/** Server-owned catalogs: `locales/<lang>.yaml`. */
function loadServerCatalogs(into: Catalogs): Catalogs {
  if (!existsSync(SERVER_LOCALES_DIR)) return into;
  for (const f of readdirSync(SERVER_LOCALES_DIR)) {
    if (!f.endsWith('.yaml')) continue;
    const lang = f.slice(0, -5);
    flatten(parse(readFileSync(join(SERVER_LOCALES_DIR, f), 'utf8')) ?? {}, '', (into[lang] ??= {}));
  }
  return into;
}

/** Narration, content names and server text in every language; `extra` overrides (tests inject small catalogs). */
export function loadCatalogs(extra: Catalogs = {}): Catalogs {
  const catalogs = loadServerCatalogs(loadContentCatalogs(loadLocales()));
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
