/** Readers shared by the playkit modules, with Go's semantics for absent or mistyped values. */
import { arr, formatNumber, get, num, text, type JV } from './jv.ts';

/** A member as text: a number formatted, a string as is, anything else "" (Go: `str`). */
export function str(v: JV | undefined, key: string): string {
  const x = get(v, key);
  return typeof x === 'number' ? formatNumber(x) : text(x);
}

/** A member as a number, formatted; 0 when absent or not a number (Go: `num`). */
export function numText(v: JV | undefined, key: string): string {
  return formatNumber(num(get(v, key)));
}

/** `cur/max` of a two-item array, else `?`. */
export function gauge(v: JV | undefined, key: string): string {
  const x = get(v, key);
  if (!Array.isArray(x) || x.length !== 2) return '?';
  return `${formatNumber(num(x[0]))}/${formatNumber(num(x[1]))}`;
}

/** Items as text ("" for non-strings). */
export function strList(v: JV | undefined): string[] {
  return arr(v).map((x) => text(x));
}
