import { IntlMessageFormat } from 'intl-messageformat';

export const REFERENCE_LANG = 'en';

/** Flat catalog: key -> ICU MessageFormat string. */
export type Catalog = Record<string, string>;
export type Catalogs = Record<string, Catalog>;
export type Params = Record<string, string | number>;

/** Resolves `@kind:id` references inside params to a localized display string. */
export type RefResolver = (lang: string, kind: string, id: string) => string | undefined;

/** Flattens nested objects (`{ a: { b: "x" } }` → `{ "a.b": "x" }`). */
export function flatten(obj: unknown, prefix = '', out: Catalog = {}): Catalog {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (typeof obj === 'string') {
    out[prefix] = obj;
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${prefix}.${i}`, out));
  } else if (typeof obj === 'number' || typeof obj === 'boolean') {
    out[prefix] = String(obj);
  }
  return out;
}

export class I18n {
  readonly langs: string[];
  private cache = new Map<string, IntlMessageFormat | null>();
  private refResolver: RefResolver;

  constructor(
    private catalogs: Catalogs,
    refResolver?: RefResolver,
  ) {
    this.langs = Object.keys(catalogs);
    this.refResolver = refResolver ?? ((lang, kind, id) => this.lookupRef(lang, kind, id));
  }

  /** Picks the best supported language for any BCP-47 tag (exact, then base language, then English). */
  resolveLang(tag: string | undefined | null): string {
    if (!tag) return REFERENCE_LANG;
    if (this.catalogs[tag]) return tag;
    const lower = tag.toLowerCase();
    const exact = this.langs.find((l) => l.toLowerCase() === lower);
    if (exact) return exact;
    const base = lower.split('-')[0];
    const byBase = this.langs.find((l) => l.toLowerCase().split('-')[0] === base);
    return byBase ?? REFERENCE_LANG;
  }

  has(lang: string, key: string): boolean {
    return this.catalogs[lang]?.[key] !== undefined;
  }

  raw(lang: string, key: string): string | undefined {
    return this.catalogs[lang]?.[key] ?? this.catalogs[REFERENCE_LANG]?.[key];
  }

  /** Translates `key` into `lang`, falling back to English and finally to the key itself. */
  t(lang: string, key: string, params?: Params): string {
    const l = this.resolveLang(lang);
    const fmt = this.format(l, key) ?? (l !== REFERENCE_LANG ? this.format(REFERENCE_LANG, key) : null);
    if (!fmt) return key;
    const values = params ? this.resolveParams(l, params) : undefined;
    try {
      return String(fmt.format(values));
    } catch {
      return this.raw(l, key) ?? key;
    }
  }

  /** Like `t` but returns undefined when the key is missing everywhere. */
  maybe(lang: string, key: string, params?: Params): string | undefined {
    const l = this.resolveLang(lang);
    if (!this.has(l, key) && !this.has(REFERENCE_LANG, key)) return undefined;
    return this.t(l, key, params);
  }

  /** Resolves `@kind:id` references in param values. */
  resolveParams(lang: string, params: Params): Params {
    const out: Params = {};
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'string' && v.charCodeAt(0) === 64 /* @ */) {
        const colon = v.indexOf(':');
        if (colon > 1) {
          const kind = v.slice(1, colon);
          const id = v.slice(colon + 1);
          out[k] = this.refResolver(lang, kind, id) ?? id;
          continue;
        }
      }
      out[k] = v;
    }
    return out;
  }

  /** Default reference lookup: `content.<kind>.<id>.name`. Agents are resolved by the caller's resolver. */
  lookupRef(lang: string, kind: string, id: string): string | undefined {
    const key = `content.${kind}.${id}.name`;
    return this.raw(lang, key) ?? (kind === 'dir' ? this.raw(lang, `dir.${id}`) : undefined);
  }

  setRefResolver(r: RefResolver) {
    this.refResolver = r;
  }

  keys(lang: string): string[] {
    return Object.keys(this.catalogs[lang] ?? {});
  }

  catalog(lang: string): Catalog {
    return this.catalogs[lang] ?? {};
  }

  /** Returns a merged catalog for a language: English as base, overridden by the language's own keys. */
  mergedCatalog(lang: string, prefixes?: string[]): Catalog {
    const l = this.resolveLang(lang);
    const base = { ...this.catalogs[REFERENCE_LANG], ...(l !== REFERENCE_LANG ? this.catalogs[l] : {}) };
    if (!prefixes) return base;
    const out: Catalog = {};
    for (const [k, v] of Object.entries(base)) if (prefixes.some((p) => k.startsWith(p))) out[k] = v;
    return out;
  }

  private format(lang: string, key: string): IntlMessageFormat | null {
    const ck = `${lang}\u0000${key}`;
    const hit = this.cache.get(ck);
    if (hit !== undefined) return hit;
    const src = this.catalogs[lang]?.[key];
    let fmt: IntlMessageFormat | null = null;
    if (src !== undefined) {
      try {
        fmt = new IntlMessageFormat(src, lang, undefined, { ignoreTag: true });
      } catch {
        fmt = null;
      }
    }
    this.cache.set(ck, fmt);
    return fmt;
  }
}

/** Validates that every message in a catalog parses as ICU MessageFormat. Returns the broken keys. */
export function findInvalidMessages(catalog: Catalog, lang: string): string[] {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(catalog)) {
    try {
      new IntlMessageFormat(v, lang, undefined, { ignoreTag: true });
    } catch {
      bad.push(k);
    }
  }
  return bad;
}

export type CoverageRow = { lang: string; total: number; present: number; missing: string[]; percent: number };

/** Coverage of each language against the English reference catalog. */
export function coverageReport(catalogs: Catalogs): CoverageRow[] {
  const ref = Object.keys(catalogs[REFERENCE_LANG] ?? {});
  return Object.keys(catalogs).map((lang) => {
    const cat = catalogs[lang] ?? {};
    const missing = ref.filter((k) => cat[k] === undefined);
    const present = ref.length - missing.length;
    return { lang, total: ref.length, present, missing, percent: ref.length ? (present / ref.length) * 100 : 100 };
  });
}
