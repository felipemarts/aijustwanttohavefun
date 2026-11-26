import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { flatten, type Catalogs } from './index';

export const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'locales');

/** Loads every `<dir>/<lang>/*.yaml` into flat catalogs, optionally prefixing keys. */
export function loadYamlCatalogs(dir: string, prefix = '', into: Catalogs = {}): Catalogs {
  if (!existsSync(dir)) return into;
  for (const lang of readdirSync(dir, { withFileTypes: true })) {
    if (!lang.isDirectory()) continue;
    const cat = (into[lang.name] ??= {});
    for (const f of readdirSync(join(dir, lang.name))) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      const doc = parse(readFileSync(join(dir, lang.name, f), 'utf8')) ?? {};
      flatten(doc, prefix, cat);
    }
  }
  return into;
}

/** Loads the UI/narration catalogs shipped with this package. */
export function loadLocales(into: Catalogs = {}): Catalogs {
  return loadYamlCatalogs(LOCALES_DIR, '', into);
}
