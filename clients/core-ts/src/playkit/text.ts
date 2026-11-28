/** The playkit's text rules (README 2; Go: `internal/playkit/text.go`). Lengths are code points. */
import { codePoints, quote, wellFormed } from './jv.ts';

/** The playkit's whitespace: U+0009..U+000D, U+0020, U+0085, U+00A0, U+2028, U+2029. Nothing else. */
export function isSpace(ch: string): boolean {
  const r = ch.codePointAt(0)!;
  return (r >= 0x09 && r <= 0x0d) || r === 0x20 || r === 0x85 || r === 0xa0 || r === 0x2028 || r === 0x2029;
}

/** Every run of whitespace becomes one space; both ends trimmed. */
export function oneLine(s: string): string {
  let out = '';
  let space = false;
  for (const ch of wellFormed(s)) {
    if (isSpace(ch)) {
      space = true;
      continue;
    }
    if (space && out.length > 0) out += ' ';
    space = false;
    out += ch;
  }
  return out;
}

/** At most n code points: a longer string becomes its first n-1 code points and "…". */
export function clip(s: string, n: number): string {
  if (n <= 0) return '';
  const cps = codePoints(s);
  if (cps.length <= n) return wellFormed(s);
  return `${cps.slice(0, n - 1).join('')}…`;
}

/** Game text, names and the owner's text: one line, no `<` or `>`, clipped. */
export function plain(s: string, n: number): string {
  let t = oneLine(s);
  if (t.includes('<') || t.includes('>')) t = oneLine(t.replace(/[<>]/g, ''));
  return clip(t, n);
}

/** Text written by another player's agent: one line, clipped, then quoted. */
export function quoted(s: string, n: number): string {
  return quote(clip(oneLine(s), n));
}

/** Removes the playkit's whitespace from both ends. */
export function trimSpace(s: string): string {
  const cps = codePoints(s);
  let a = 0;
  let b = cps.length;
  while (a < b && isSpace(cps[a]!)) a++;
  while (b > a && isSpace(cps[b - 1]!)) b--;
  return cps.slice(a, b).join('');
}

/**
 * Go's `strings.TrimSpace` (Unicode White_Space), which the Go code uses for step hints (README 5.5 says only
 * "trimmed"). Kept separate so the difference is visible.
 */
export function unicodeTrim(s: string): string {
  const cps = codePoints(s);
  let a = 0;
  let b = cps.length;
  while (a < b && isUnicodeSpace(cps[a]!)) a++;
  while (b > a && isUnicodeSpace(cps[b - 1]!)) b--;
  return cps.slice(a, b).join('');
}

/** Go's `unicode.IsSpace`. */
function isUnicodeSpace(ch: string): boolean {
  const r = ch.codePointAt(0)!;
  return isSpace(ch) || r === 0x1680 || (r >= 0x2000 && r <= 0x200a) || r === 0x202f || r === 0x205f || r === 0x3000;
}

const NAME = /^[a-z_]+$/;

/**
 * Fills a template (README 2.2): one left-to-right pass replacing `{{name}}` present in `values` (values are not
 * scanned again), then empty lines tidied. Templates are stored with CRLF already turned into LF.
 */
export function render(template: string, values: Record<string, string>): string {
  const tpl = template.endsWith('\n') ? template.slice(0, -1) : template;
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    if (tpl.startsWith('{{', i)) {
      const end = tpl.indexOf('}}', i + 2);
      if (end >= 0) {
        const name = tpl.slice(i + 2, end);
        if (NAME.test(name) && Object.prototype.hasOwnProperty.call(values, name)) {
          out += values[name];
          i = end + 2;
          continue;
        }
      }
    }
    out += tpl[i];
    i++;
  }
  return tidy(out);
}

function tidy(s: string): string {
  const out: string[] = [];
  for (const l of s.split('\n')) {
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

export const joinList = (items: readonly string[]): string => items.join(', ');
