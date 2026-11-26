import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { buildContent, type Content, type ContentFiles } from './index';
import { contentSchemas } from './schema';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
export const CONTENT_I18N_DIR = join(ROOT, 'i18n');

export function readContentFiles(dir = DATA_DIR): Partial<ContentFiles> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(contentSchemas)) {
    const file = join(dir, `${key}.yaml`);
    if (existsSync(file)) out[key] = parse(readFileSync(file, 'utf8'));
  }
  return out as Partial<ContentFiles>;
}

let cached: Content | null = null;

/** Loads and validates the static world content. Cached per process. */
export function loadContent(dir = DATA_DIR): Content {
  if (dir === DATA_DIR && cached) return cached;
  const c = buildContent(readContentFiles(dir));
  if (dir === DATA_DIR) cached = c;
  return c;
}

function flattenInto(obj: unknown, prefix: string, out: Record<string, string>) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flattenInto(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (typeof obj === 'string') out[prefix] = obj;
}

/**
 * Content translations live in `i18n/<lang>/<kind>.yaml` as `{ <id>: { name, desc } }`.
 * They are exposed as `content.<kind>.<id>.name` keys, merged into `into`.
 */
export function loadContentCatalogs(
  into: Record<string, Record<string, string>> = {},
  dir = CONTENT_I18N_DIR,
): Record<string, Record<string, string>> {
  if (!existsSync(dir)) return into;
  for (const lang of readdirSync(dir, { withFileTypes: true })) {
    if (!lang.isDirectory()) continue;
    const cat = (into[lang.name] ??= {});
    for (const f of readdirSync(join(dir, lang.name))) {
      if (!f.endsWith('.yaml')) continue;
      const kind = f.replace(/\.yaml$/, '');
      const doc = parse(readFileSync(join(dir, lang.name, f), 'utf8')) ?? {};
      // Ids contain dots (village.square); keep them intact as a single key segment.
      for (const [entityId, fields] of Object.entries(doc as Record<string, unknown>)) {
        flattenInto(fields, `content.${kind}.${entityId}`, cat);
      }
    }
  }
  return into;
}
