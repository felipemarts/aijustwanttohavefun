import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadLocales } from '@ajwf/i18n/node';

/**
 * The engine never writes sentences, only i18n keys (PLANEJAMENTO §12.2). This test reads the engine source and
 * checks that every key it can emit has English text in packages/i18n/locales/en.
 *
 * Conventions that make keys discoverable here:
 *   tell(run, 'n.<key>') / msg('ev.<key>')      narration (second person) and event text (third person)
 *   fail('<CODE>', '<slug>')                    error message `err.<slug>`, optional hint `hint.<slug>`
 *   { code, slug: '<slug>' }                    same, for errors built as data (gates)
 */
const SRC = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : [],
  );
}

/** Keys built from a runtime value, which the scan cannot see. Keep in sync with the code that builds them. */
const DYNAMIC_KEYS = ['err.name_length', 'err.name_characters', 'err.name_reserved', 'err.name_blocked'];

export function engineKeys(): { required: string[]; slugs: string[] } {
  const keys = new Set<string>(DYNAMIC_KEYS);
  const slugs = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/'((?:n|ev|err)\.[a-z0-9_.]+)'/g)) keys.add(m[1]!);
    for (const m of src.matchAll(/fail\(\s*'[A-Z_]+',\s*'([a-z0-9_]+)'/g)) slugs.add(m[1]!);
    for (const m of src.matchAll(/fail\(\s*'[A-Z_]+',\s*[^,']*\?\s*'([a-z0-9_]+)'\s*:\s*'([a-z0-9_]+)'/g)) slugs.add(m[1]!).add(m[2]!);
    for (const m of src.matchAll(/slug:\s*'([a-z0-9_]+)'/g)) slugs.add(m[1]!);
  }
  for (const s of slugs) keys.add(`err.${s}`);
  return { required: [...keys].sort(), slugs: [...slugs].sort() };
}

describe('engine i18n keys', () => {
  const en = loadLocales().en ?? {};

  it('finds the keys the engine emits', () => {
    const { required } = engineKeys();
    expect(required.length).toBeGreaterThan(100);
    expect(required).toContain('n.move');
    expect(required).toContain('err.no_ap');
    expect(required).toContain('err.nothing_to_gather');
  });

  it('every narration, event and error key exists in English', () => {
    const missing = engineKeys().required.filter((k) => en[k] === undefined);
    expect(missing).toEqual([]);
  });

  it('every hint belongs to an error the engine can raise', () => {
    const { slugs } = engineKeys();
    const known = new Set([...slugs, 'invalid_action', 'invalid_params', 'name']);
    const orphans = Object.keys(en).filter((k) => k.startsWith('hint.') && !known.has(k.slice(5)));
    expect(orphans).toEqual([]);
  });

  it('directions have names', () => {
    for (const d of ['north', 'south', 'east', 'west', 'up', 'down']) expect(en[`dir.${d}`]).toBeTypeOf('string');
  });
});
