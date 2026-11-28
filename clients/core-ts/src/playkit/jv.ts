/**
 * A small JSON value model for the playkit (README 2 and 2.1; Go: `internal/jv`). Objects are `Map`s, so member order
 * is kept exactly as received (a plain object would move integer-like keys first); duplicate keys and nesting deeper
 * than 64 are parse errors; strings are written by the playkit's `quote` rule and numbers by its `number` rule.
 */
export type JObj = Map<string, JV>;
export type JV = null | boolean | number | string | JV[] | JObj;

export class JsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonError';
  }
}

export const isObj = (v: JV | undefined): v is JObj => v instanceof Map;
export const isArr = (v: JV | undefined): v is JV[] => Array.isArray(v);

/** Builds an object from key, value pairs, in order. */
export function obj(...kv: [string, JV][]): JObj {
  return new Map(kv);
}

/** A member of an object, or undefined (also for non-objects). */
export function get(v: JV | undefined, key: string): JV | undefined {
  return isObj(v) ? v.get(key) : undefined;
}

/** Walks members: `at(v, 'you', 'ap')`. */
export function at(v: JV | undefined, ...keys: string[]): JV | undefined {
  let cur = v;
  for (const k of keys) cur = get(cur, k);
  return cur;
}

export function has(v: JV | undefined, key: string): boolean {
  return isObj(v) && v.has(key);
}

/** The string, or "" for any other kind (Go: `Value.Text`). */
export function text(v: JV | undefined): string {
  return typeof v === 'string' ? v : '';
}

/** The number, or 0 for any other kind (Go: `Value.N`). */
export function num(v: JV | undefined): number {
  return typeof v === 'number' ? v : 0;
}

/** The items, or [] for any other kind. */
export function arr(v: JV | undefined): JV[] {
  return Array.isArray(v) ? v : [];
}

/** The members in order, or [] for any other kind. */
export function members(v: JV | undefined): [string, JV][] {
  return isObj(v) ? [...v.entries()] : [];
}

export const isTrue = (v: JV | undefined): boolean => v === true;

export function strArr(items: readonly string[]): JV[] {
  return [...items];
}

export function clone<T extends JV>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => clone(x)) as T;
  if (isObj(v)) return new Map([...v.entries()].map(([k, x]) => [k, clone(x)])) as T;
  return v;
}

/** Deep equality; object member order is significant (Go: `jv.Equal`). */
export function equal(a: JV | undefined, b: JV | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (isObj(a)) {
    if (!isObj(b) || a.size !== b.size) return false;
    const ea = [...a.entries()];
    const eb = [...b.entries()];
    return ea.every(([k, x], i) => eb[i]![0] === k && equal(x, eb[i]![1]));
  }
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  return a === b;
}

// ── Code points ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The string with every lone surrogate replaced by U+FFFD (as Go reads invalid text). */
export function wellFormed(s: string): string {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      out += s.slice(start, i) + '�';
      start = i + 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += s.slice(start, i) + '�';
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

/** Code points of a (well-formed) string. */
export function codePoints(s: string): string[] {
  return Array.from(wellFormed(s));
}

export function cpLength(s: string): number {
  let n = 0;
  for (const _ of wellFormed(s)) n++;
  return n;
}

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────────────────────────

const MAX_DEPTH = 64;

/** Parses exactly one JSON value: strict RFC 8259, ordered objects, duplicate keys refused, depth at most 64. */
export function parse(input: string): JV {
  const p = new Parser(input);
  p.ws();
  const v = p.value(0);
  p.ws();
  if (p.i !== p.s.length) throw p.err('trailing data');
  return v;
}

class Parser {
  s: string;
  i = 0;
  constructor(s: string) {
    this.s = s;
  }

  err(m: string): JsonError {
    return new JsonError(`json at ${this.i}: ${m}`);
  }

  ws(): void {
    for (;;) {
      const c = this.s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else return;
    }
  }

  value(depth: number): JV {
    if (depth > MAX_DEPTH) throw this.err('too deep');
    if (this.i >= this.s.length) throw this.err('unexpected end');
    const c = this.s[this.i]!;
    if (c === '{') return this.object(depth);
    if (c === '[') return this.array(depth);
    if (c === '"') return this.str();
    if (c === 't') return this.lit('true', true);
    if (c === 'f') return this.lit('false', false);
    if (c === 'n') return this.lit('null', null);
    if (c === '-' || (c >= '0' && c <= '9')) return this.number();
    throw this.err(`unexpected ${JSON.stringify(c)}`);
  }

  lit<T extends JV>(word: string, v: T): T {
    if (this.s.startsWith(word, this.i)) {
      this.i += word.length;
      return v;
    }
    throw this.err('bad literal');
  }

  digits(): number {
    const start = this.i;
    while (this.i < this.s.length && this.s[this.i]! >= '0' && this.s[this.i]! <= '9') this.i++;
    return this.i - start;
  }

  number(): number {
    const start = this.i;
    if (this.s[this.i] === '-') this.i++;
    if (this.s[this.i] === '0') this.i++;
    else if (this.digits() === 0) throw this.err('bad number');
    if (this.s[this.i] === '.') {
      this.i++;
      if (this.digits() === 0) throw this.err('bad number');
    }
    if (this.s[this.i] === 'e' || this.s[this.i] === 'E') {
      this.i++;
      if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i++;
      if (this.digits() === 0) throw this.err('bad number');
    }
    const n = Number(this.s.slice(start, this.i));
    if (!Number.isFinite(n)) throw this.err('bad number');
    return n;
  }

  hex4(): number {
    const h = this.s.slice(this.i, this.i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) throw this.err('bad escape');
    this.i += 4;
    return parseInt(h, 16);
  }

  /** Lone surrogates (escaped or raw) become U+FFFD. */
  str(): string {
    this.i++;
    let out = '';
    for (;;) {
      if (this.i >= this.s.length) throw this.err('unterminated string');
      const c = this.s.charCodeAt(this.i);
      if (c === 0x22) {
        this.i++;
        return wellFormed(out);
      }
      if (c === 0x5c) {
        this.i++;
        if (this.i >= this.s.length) throw this.err('bad escape');
        const e = this.s[this.i++]!;
        switch (e) {
          case '"':
          case '\\':
          case '/':
            out += e;
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const r = this.hex4();
            if (r >= 0xd800 && r <= 0xdfff) {
              if (r < 0xdc00 && this.s.startsWith('\\u', this.i)) {
                const save = this.i;
                this.i += 2;
                let r2: number;
                try {
                  r2 = this.hex4();
                } catch {
                  r2 = -1;
                }
                if (r2 >= 0xdc00 && r2 <= 0xdfff) {
                  out += String.fromCharCode(r, r2);
                  break;
                }
                this.i = save;
              }
              out += '�';
            } else out += String.fromCharCode(r);
            break;
          }
          default:
            throw this.err('bad escape');
        }
        continue;
      }
      if (c < 0x20) throw this.err('control character in string');
      out += this.s[this.i++];
    }
  }

  array(depth: number): JV[] {
    this.i++;
    const out: JV[] = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value(depth + 1));
      this.ws();
      if (this.i >= this.s.length) throw this.err('unexpected end');
      const c = this.s[this.i++];
      if (c === ',') continue;
      if (c === ']') return out;
      this.i--;
      throw this.err('expected , or ]');
    }
  }

  object(depth: number): JObj {
    this.i++;
    const out: JObj = new Map();
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') throw this.err('expected key');
      const k = this.str();
      if (out.has(k)) throw new JsonError(`duplicate key ${JSON.stringify(k)}`);
      this.ws();
      if (this.s[this.i] !== ':') throw this.err('expected :');
      this.i++;
      this.ws();
      out.set(k, this.value(depth + 1));
      this.ws();
      if (this.i >= this.s.length) throw this.err('unexpected end');
      const c = this.s[this.i++];
      if (c === ',') continue;
      if (c === '}') return out;
      this.i--;
      throw this.err('expected , or }');
    }
  }
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A JSON string literal by the playkit rule: `"` `\` escaped; \n \r \t; other code points below U+0020, U+007F, `<`,
 * `>`, U+2028, U+2029 as \u with four lower-case hex digits; everything else as is.
 */
export function quote(s: string): string {
  let out = '"';
  for (const ch of wellFormed(s)) {
    const r = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (r < 0x20 || r === 0x7f || ch === '<' || ch === '>' || r === 0x2028 || r === 0x2029) out += `\\u${r.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** The playkit's `number`: JavaScript's `String(x)` is exactly that rule (and gives "0" for -0). */
export function formatNumber(n: number): string {
  return String(n);
}

/** Compact JSON keeping member order (README `write`). */
export function write(v: JV): string {
  return ser(v, false);
}

/** Compact JSON with object keys sorted by UTF-16 code units (README `canon`). */
export function canon(v: JV): string {
  return ser(v, true);
}

function ser(v: JV, sorted: boolean): string {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'string') return quote(v);
  if (Array.isArray(v)) return `[${v.map((x) => ser(x, sorted)).join(',')}]`;
  let entries = [...v.entries()];
  if (sorted) entries = entries.slice().sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${quote(k)}:${ser(x, sorted)}`).join(',')}}`;
}

// ── Plain JavaScript values ────────────────────────────────────────────────────────────────────────────────────────

/** To plain JavaScript (objects lose integer-like key order; use only where order does not matter). */
export function toPlain(v: JV): unknown {
  if (Array.isArray(v)) return v.map(toPlain);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of v) Object.defineProperty(out, k, { value: toPlain(x), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}

/** From plain JavaScript data (key order as the object enumerates it). Non-JSON values become null. */
export function fromPlain(x: unknown): JV {
  if (x === null || typeof x === 'boolean' || typeof x === 'string') return x;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (Array.isArray(x)) return x.map(fromPlain);
  if (x instanceof Map) return new Map([...x.entries()].map(([k, v]) => [String(k), fromPlain(v)]));
  if (typeof x === 'object') return new Map(Object.entries(x as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => [k, fromPlain(v)]));
  return null;
}
