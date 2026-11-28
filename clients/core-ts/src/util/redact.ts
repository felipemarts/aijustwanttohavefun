/**
 * The last line of defence for secrets: every string the core emits (events, log entries, errors, prompts) passes
 * through `scrub`. The first line is never putting them there; this catches what slips, such as a server error that
 * echoes a header or a runtime error that names its model file.
 */
const PATTERNS: [RegExp, string][] = [
  // Game API keys (`ajwf_sk_...`).
  [/ajwf_sk_[A-Za-z0-9_-]+/g, '[key]'],
  // Claim links: the token after /claim/.
  [/\/claim\/[A-Za-z0-9_.~-]+/g, '/claim/[hidden]'],
  // Any bearer credential.
  [/(bearer\s+)[^\s"',;]+/gi, '$1[hidden]'],
  // Common provider key shapes (OpenAI-style and similar).
  [/\bsk-[A-Za-z0-9_-]{12,}/g, '[key]'],
];

const MIN_SECRET = 6;

export class Redactor {
  private secrets = new Set<string>();

  /** Registers a value that must never leave the core (an agent key, a claim URL, a provider key, a file path). */
  add(secret: string | null | undefined): void {
    if (typeof secret === 'string' && secret.length >= MIN_SECRET) this.secrets.add(secret);
  }

  scrub(text: string): string {
    let out = text;
    // Longest first, so a claim URL is replaced whole before a shorter secret inside it.
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) {
      if (out.includes(s)) out = out.split(s).join('[hidden]');
    }
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    return out;
  }

  /** A deep copy of plain JSON data with every string scrubbed. */
  scrubDeep<T>(value: T): T {
    return this.walk(value) as T;
  }

  /** A copy of a member-ordered JSON value (Maps for objects) with every string and key scrubbed, order kept. */
  scrubOrdered<T>(v: T): T {
    if (typeof v === 'string') return this.scrub(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.scrubOrdered(x)) as T;
    if (v instanceof Map) return new Map([...v.entries()].map(([k, x]) => [typeof k === 'string' ? this.scrub(k) : k, this.scrubOrdered(x)])) as T;
    return v;
  }

  private walk(v: unknown): unknown {
    if (typeof v === 'string') return this.scrub(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = this.walk(x);
      return out;
    }
    return v;
  }
}
