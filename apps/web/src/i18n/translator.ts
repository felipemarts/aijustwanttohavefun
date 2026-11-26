import { IntlMessageFormat } from 'intl-messageformat';
import type { SpectatorEvent } from '@ajwf/shared';

export type Messages = Record<string, string>;
export type Params = Record<string, string | number>;

/** Turns `some_id` into `Some id` when no translation exists (better than showing a raw key). */
export function humanizeId(id: string): string {
  const last = id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id;
  const s = last.replace(/[_-]+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : id;
}

/**
 * A tiny `t()` over a flat ICU catalog: the viewer's language first, then the bundled English fallback, then a
 * humanized key. Every output is a plain string meant for React text nodes or Pixi `text`; nothing is ever parsed
 * as markup (`ignoreTag`), and params coming from the server are values, not templates.
 */
export class Translator {
  private cache = new Map<string, IntlMessageFormat | null>();

  constructor(
    readonly lang: string,
    private readonly messages: Messages,
    private readonly fallback: Messages = {},
  ) {}

  has(key: string): boolean {
    return this.messages[key] !== undefined || this.fallback[key] !== undefined;
  }

  raw(key: string): string | undefined {
    return this.messages[key] ?? this.fallback[key];
  }

  t(key: string, params?: Params): string {
    const fmt = this.format(key);
    if (!fmt) return key.startsWith('content.') ? humanizeId(key.replace(/\.(name|desc)$/, '')) : key;
    try {
      return String(fmt.format(params ? this.resolveParams(params) : undefined));
    } catch {
      return this.raw(key) ?? key;
    }
  }

  /** `t()` that returns undefined instead of the key when the message does not exist. */
  maybe(key: string, params?: Params): string | undefined {
    return this.has(key) ? this.t(key, params) : undefined;
  }

  /** Localized name of a content entity (`content.<kind>.<id>.name`), humanized id when missing. */
  name(kind: string, id: string): string {
    if (kind === 'dir') return this.raw(`dir.${id}`) ?? id;
    if (kind === 'agent') return id;
    return this.raw(`content.${kind}.${id}.name`) ?? humanizeId(id);
  }

  /** Resolves `@kind:id` references in params to localized names; other values pass through untouched. */
  resolveParams(params: Params): Params {
    const out: Params = {};
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'string' && v.charCodeAt(0) === 64 /* @ */) {
        const colon = v.indexOf(':');
        if (colon > 1) {
          out[k] = this.name(v.slice(1, colon), v.slice(colon + 1));
          continue;
        }
      }
      out[k] = typeof v === 'number' || typeof v === 'string' ? v : String(v);
    }
    return out;
  }

  private format(key: string): IntlMessageFormat | null {
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let fmt: IntlMessageFormat | null = null;
    const own = this.messages[key];
    const src = own ?? this.fallback[key];
    if (src !== undefined) {
      try {
        fmt = new IntlMessageFormat(src, own !== undefined ? this.lang : 'en', undefined, {
          ignoreTag: true,
        });
      } catch {
        fmt = null;
      }
    }
    this.cache.set(key, fmt);
    return fmt;
  }
}

/** A room-log line, ready for display. Agent text is kept apart so the UI can show it as quoted, untrusted speech. */
export type LogLine =
  | { kind: 'line'; id: string; ts: number; type: string; text: string }
  | {
      kind: 'speech';
      id: string;
      ts: number;
      type: string;
      actor: string;
      text: string;
      lang: string | null;
    };

/** Localizes one spectator event. Never throws: a broken event becomes a generic line. */
export function formatEvent(tr: Translator, ev: SpectatorEvent): LogLine {
  const id = String(ev.id);
  const ts = typeof ev.ts === 'number' ? ev.ts : 0;
  const type = typeof ev.type === 'string' ? ev.type : 'unknown';
  try {
    if (typeof ev.text === 'string' && !ev.k) {
      return {
        kind: 'speech',
        id,
        ts,
        type,
        actor: typeof ev.actor === 'string' ? ev.actor : '?',
        text: ev.text,
        lang: typeof ev.lang === 'string' ? ev.lang : null,
      };
    }
    if (typeof ev.k === 'string' && tr.has(ev.k)) {
      const p = ev.p && typeof ev.p === 'object' ? ev.p : {};
      return { kind: 'line', id, ts, type, text: tr.t(ev.k, p) };
    }
  } catch {
    // fall through to the generic line
  }
  const actor = typeof ev.actor === 'string' ? ev.actor : '';
  return { kind: 'line', id, ts, type, text: tr.t('ui.log.generic', { actor, type: humanizeId(type) }) };
}
