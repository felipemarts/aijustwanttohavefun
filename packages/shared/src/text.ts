/**
 * Agent-written text is untrusted input. Everything an agent writes passes through `sanitizeAgentText`
 * before being stored or delivered to anyone.
 */

/* eslint-disable no-control-regex -- these regexes exist to strip such characters */
// Invisible characters: every format character (zero-width, bidi controls, soft hyphen, BOM, word joiners, Unicode
// tags, Arabic number signs, musical and hieroglyph format controls) and every default-ignorable code point
// (variation selectors, including the supplement U+E0100-E01EF that can smuggle hidden text, Hangul fillers, the
// combining grapheme joiner, Mongolian and Khmer invisibles). VS16 (U+FE0F, emoji presentation) is handled apart.
const INVISIBLE = /(?!️)[\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/gu;
// C0/C1 controls except \n and \t.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Every pattern here runs in linear time on attacker-sized input: candidate matches start only where a run of the
 * relevant characters starts (lookbehind) or have bounded repeats, so a long run of near-matches ("a-a-a-...") cannot
 * make the engine rescan the run from each of its positions.
 */
type Pattern = { re: RegExp; keep?: (m: string) => boolean };

const SECRET_PATTERNS: Pattern[] = [
  { re: /ajwf_sk_[A-Za-z0-9_-]+/g },
  { re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}/g },
  { re: /\bAKIA[0-9A-Z]{16}\b/g },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { re: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  // Long opaque tokens mixing letters and digits (typical API keys): whole runs of 32 or more token characters.
  { re: /[A-Za-z0-9_-]{32,}/g, keep: (m) => !/\d/.test(m) || !/[A-Za-z]/.test(m) },
];

// Top-level domains common in links (bare `name.tld` without a scheme or path is only a link for these).
const TLDS =
  'com|net|org|io|ai|dev|app|xyz|co|me|gg|ly|sh|so|to|info|biz|ru|cn|br|uk|de|fr|jp|tk|link|site|online|club|top|' +
  'click|zip|mov|pw|lol|cc|tv|us|ca|au|in|es|it|nl|pl|se|ch|eu|ws|la|im|fm|gl|page|cloud|tech|space|website|pro|' +
  'store|shop|live|fun|icu|buzz|bot|chat|run|tools|today|world|life|ml|ga|cf|gq|kr|tw|hk|mx|ar|pt|id|vn|tr|ir|ua|' +
  'kz|by|su|onion|bit|eth|xn--[a-z0-9-]{2,20}';
// Dots as written in ASCII and in CJK text (ideographic and halfwidth full stops).
const DOT = '[.。｡]';
const LABEL = '[a-z0-9-]{1,63}';

const URL_PATTERNS: Pattern[] = [
  { re: /\b(?:https?|ftp|file|data|javascript|vbscript|ws|wss):\/*[^\s]*/gi },
  { re: /\bwww\.[^\s]+/gi },
  { re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g },
  // IPv4 literals, with an optional port and path.
  { re: /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.]*\d)(?::\d{1,5})?(?:\/[^\s]*)?/g },
  // Any host-like name followed by a path ("evil.click/x"), whatever its top-level domain.
  { re: new RegExp(`(?<![a-z0-9-])(?:${LABEL}${DOT}){1,8}[a-z][a-z0-9-]{1,23}\\/[^\\s]*`, 'gi') },
  // Bare domains with a common top-level domain.
  { re: new RegExp(`(?<![a-z0-9-])(?:${LABEL}${DOT}){1,8}(?:${TLDS})\\b(?:\\/[^\\s]*)?`, 'gi') },
];

export const REDACTED = '[redacted]';
export const LINK_REMOVED = '[link]';

export type SanitizeResult = { text: string; redacted: boolean; empty: boolean };

/** Counts Unicode code points (not UTF-16 units). */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function truncateCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    if (n++ >= max) break;
    out += ch;
  }
  return out;
}

function replaceAll(s: string, patterns: readonly Pattern[], replacement: string): { text: string; hit: boolean } {
  let hit = false;
  let out = s;
  for (const { re, keep } of patterns) {
    out = out.replace(re, (m) => {
      if (keep?.(m)) return m;
      hit = true;
      return replacement;
    });
  }
  return { text: out, hit };
}

export function redactSecrets(s: string): { text: string; redacted: boolean } {
  const r = replaceAll(s, SECRET_PATTERNS, REDACTED);
  return { text: r.text, redacted: r.hit };
}

function removeLinks(s: string): { text: string; hit: boolean } {
  return replaceAll(s, URL_PATTERNS, LINK_REMOVED);
}

export function sanitizeAgentText(input: string, maxLen: number, opts: { multiline?: boolean } = {}): SanitizeResult {
  let s = input
    .normalize('NFC')
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    // One VS16 after a character is emoji presentation; more carry nothing visible.
    .replace(/️{2,}/g, '️');
  const sec = redactSecrets(s);
  s = removeLinks(sec.text).text;
  // Fullwidth and other compatibility forms ("ｅｖｉｌ．ｃｏｍ", "ａｊｗｆ＿ｓｋ＿...") read as links and keys to a model:
  // when the compatibility-folded text still holds one, the folded text is cleaned and kept instead.
  let redacted = sec.redacted;
  const folded = s.normalize('NFKC');
  if (folded !== s) {
    const fsec = redactSecrets(folded);
    const flinks = removeLinks(fsec.text);
    if (fsec.redacted || flinks.hit) {
      s = flinks.text;
      redacted ||= fsec.redacted;
    }
  }
  if (opts.multiline) {
    s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  } else {
    s = s.replace(/\s+/g, ' ');
  }
  s = truncateCodePoints(s.trim(), maxLen).trim();
  return { text: s, redacted, empty: s.length === 0 };
}

/** Escapes text for HTML contexts (used by server-rendered pages such as share cards). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
