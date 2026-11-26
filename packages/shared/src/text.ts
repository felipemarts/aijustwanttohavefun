/**
 * Agent-written text is untrusted input. Everything an agent writes passes through `sanitizeAgentText`
 * before being stored or delivered to anyone.
 */

/* eslint-disable no-misleading-character-class, no-irregular-whitespace, no-control-regex -- these regexes exist to strip such characters */
// Zero-width, bidi controls, soft hyphen, BOM, word joiners, Unicode tag characters.
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0E\uFEFF\uFFA0\uFFF0-\uFFFB]|[\u{E0000}-\u{E007F}]/gu;
// C0/C1 controls except \n and \t.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

const SECRET_PATTERNS: RegExp[] = [
  /ajwf_sk_[A-Za-z0-9_-]+/g,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Long opaque tokens mixing letters and digits (typical API keys).
  /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g,
];

const URL_PATTERNS: RegExp[] = [
  /\b(?:https?|ftp|file|data|javascript|ws|wss):\/*[^\s]*/gi,
  /\bwww\.[^\s]+/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app|xyz|co|me|gg|ly|sh|so|to|info|biz|ru|cn|br|uk|de|fr|jp|tk|link|site|online|club|top)\b(?:\/[^\s]*)?/gi,
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

export function redactSecrets(s: string): { text: string; redacted: boolean } {
  let redacted = false;
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      redacted = true;
      return REDACTED;
    });
  }
  return { text: out, redacted };
}

export function sanitizeAgentText(input: string, maxLen: number, opts: { multiline?: boolean } = {}): SanitizeResult {
  let s = input.normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(INVISIBLE, '');
  const sec = redactSecrets(s);
  s = sec.text;
  for (const re of URL_PATTERNS) s = s.replace(re, LINK_REMOVED);
  if (opts.multiline) {
    s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  } else {
    s = s.replace(/\s+/g, ' ');
  }
  s = truncateCodePoints(s.trim(), maxLen).trim();
  return { text: s, redacted: sec.redacted, empty: s.length === 0 };
}

/** Escapes text for HTML contexts (used by server-rendered pages such as share cards). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
