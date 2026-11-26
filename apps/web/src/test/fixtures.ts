/** Test fixtures read straight from the repo's YAML (same transform as the Vite plugin). Node only. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { buildStaticWorld, flattenContent, flattenStrings, type StaticWorld } from '../data/staticWorld';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (f: string): unknown => (existsSync(f) ? parse(readFileSync(f, 'utf8')) : undefined);

export function loadStaticWorld(): StaticWorld {
  const dir = join(ROOT, 'packages', 'content', 'data');
  return buildStaticWorld({
    rooms: read(join(dir, 'rooms.yaml')),
    monsters: read(join(dir, 'monsters.yaml')),
    npcs: read(join(dir, 'npcs.yaml')),
    projects: read(join(dir, 'projects.yaml')),
    zones: read(join(dir, 'zones.yaml')),
  });
}

export function loadCatalog(lang: string): Record<string, string> {
  const out: Record<string, string> = {};
  const locales = join(ROOT, 'packages', 'i18n', 'locales', lang);
  for (const f of existsSync(locales) ? readdirSync(locales) : [])
    if (f.endsWith('.yaml')) flattenStrings(read(join(locales, f)), '', out);
  const content = join(ROOT, 'packages', 'content', 'i18n', lang);
  for (const f of existsSync(content) ? readdirSync(content) : [])
    if (f.endsWith('.yaml')) flattenContent(f.replace(/\.yaml$/, ''), read(join(content, f)), out);
  return out;
}
