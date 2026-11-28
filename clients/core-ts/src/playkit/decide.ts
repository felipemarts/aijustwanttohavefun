/** Reading the model's answer (README 4.3; Go: `internal/playkit/decide.go`). */
import { arr, canon, cpLength, equal, formatNumber, get, has, isObj, members, num, obj, parse, quote, text, wellFormed, type JV } from './jv.ts';
import type { Kit } from './kit.ts';
import { findAction, menuNames, type Menu } from './schema.ts';
import { clip } from './text.ts';
import type { Decision, Resolution } from './types.ts';

export const ERR_NOT_JSON = 'the answer is not one valid JSON object';

/** The decision object in a raw answer, or the one problem. */
export function extract(kit: Kit, raw: string): { value: JV } | { problem: string } {
  const fail = { problem: ERR_NOT_JSON };
  let t = clip(wellFormed(raw), kit.config.decision.rawMax).replace(/^[ \t\r\n]+/, '');
  if (t.startsWith('<think>')) {
    const end = t.indexOf('</think>');
    if (end < 0) return fail;
    t = t.slice(end + '</think>'.length);
  }
  const start = t.indexOf('{');
  if (start < 0) return fail;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < t.length && end < 0; i++) {
    const c = t[i];
    if (inStr && esc) esc = false;
    else if (inStr && c === '\\') esc = true;
    else if (inStr && c === '"') inStr = false;
    else if (inStr) continue;
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) end = i;
    }
  }
  if (end < 0) return fail;
  try {
    const v = parse(t.slice(start, end + 1));
    return isObj(v) ? { value: v } : fail;
  } catch {
    return fail;
  }
}

const SIMPLE_KEY = /^[A-Za-z0-9_]+$/;

function pathJoin(base: string, key: string): string {
  const k = SIMPLE_KEY.test(key) ? key : quote(clip(key, 40));
  return base === '' ? k : `${base}.${k}`;
}

const pathIndex = (base: string, i: number) => `${base}[${formatNumber(i)}]`;

const TYPE_NAMES: Record<string, string> = { string: 'a string', integer: 'an integer', number: 'a number', boolean: 'a boolean', object: 'an object', array: 'an array', null: 'null' };

function typeOk(v: JV, t: string): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number';
    case 'boolean':
      return typeof v === 'boolean';
    case 'object':
      return isObj(v);
    case 'array':
      return Array.isArray(v);
    case 'null':
      return v === null;
  }
  return true;
}

/** The first problem of `v` against the playkit's schema subset, or "" (README 4.3, "Schema validation"). */
export function validateSchema(v: JV, s: JV | undefined, path: string): string {
  if (typeof s === 'boolean') return s ? '' : `${path}: is not allowed`;
  if (!isObj(s)) return '';
  if (s.has('anyOf')) {
    for (const alt of arr(s.get('anyOf'))) if (validateSchema(v, alt, path) === '') return '';
    return `${path}: does not match any allowed form`;
  }
  const t = s.get('type');
  if (typeof t === 'string' && !typeOk(v, t)) return `${path}: must be ${TYPE_NAMES[t]}`;
  if (s.has('const') && !equal(s.get('const'), v)) return `${path}: must be ${canon(s.get('const')!)}`;
  const en = s.get('enum');
  if (Array.isArray(en) && !en.some((x) => equal(x, v))) return `${path}: must be one of: ${en.map((x) => canon(x)).join(', ')}`;
  if (typeof v === 'string') {
    const n = cpLength(v);
    if (s.has('minLength') && n < num(s.get('minLength'))) return `${path}: must be at least ${formatNumber(num(s.get('minLength')))} characters`;
    if (s.has('maxLength') && n > num(s.get('maxLength'))) return `${path}: must be at most ${formatNumber(num(s.get('maxLength')))} characters`;
    if (s.has('pattern')) {
      let re: RegExp | null;
      try {
        re = new RegExp(text(s.get('pattern')), 'u');
      } catch {
        re = null;
      }
      if (re && !re.test(v)) return `${path}: does not match the expected format`;
    }
  } else if (typeof v === 'number') {
    if (s.has('minimum') && v < num(s.get('minimum'))) return `${path}: must be >= ${formatNumber(num(s.get('minimum')))}`;
    if (s.has('maximum') && v > num(s.get('maximum'))) return `${path}: must be <= ${formatNumber(num(s.get('maximum')))}`;
  } else if (Array.isArray(v)) {
    const pre = s.get('prefixItems');
    const hasPre = s.has('prefixItems');
    const hasItems = s.has('items');
    for (let i = 0; i < v.length; i++) {
      const p = pathIndex(path, i);
      let r = '';
      if (hasPre && i < arr(pre).length) r = validateSchema(v[i]!, arr(pre)[i], p);
      else if (hasItems) r = validateSchema(v[i]!, s.get('items'), p);
      if (r) return r;
    }
    if (s.has('minItems') && v.length < num(s.get('minItems'))) return `${path}: must have at least ${formatNumber(num(s.get('minItems')))} items`;
    if (s.has('maxItems') && v.length > num(s.get('maxItems'))) return `${path}: must have at most ${formatNumber(num(s.get('maxItems')))} items`;
  } else if (isObj(v)) {
    const props = s.get('properties');
    if (s.has('required')) for (const r of arr(s.get('required'))) if (!v.has(text(r))) return `${pathJoin(path, text(r))}: is required`;
    const names = s.get('propertyNames');
    const hasNames = s.has('propertyNames');
    const hasAddl = s.has('additionalProperties');
    for (const [k, x] of v) {
      const p = pathJoin(path, k);
      if (hasNames && validateSchema(k, names, p) !== '') return `${p}: is not an allowed name`;
      if (has(props, k)) {
        const r = validateSchema(x, get(props, k), p);
        if (r) return r;
        continue;
      }
      if (hasAddl) {
        const r = validateSchema(x, s.get('additionalProperties'), p);
        if (r) return r;
      }
    }
  }
  return '';
}

function forbiddenKeys(kit: Kit, v: JV, path: string): string {
  if (isObj(v)) {
    for (const [k, x] of v) {
      const p = pathJoin(path, k);
      if (kit.config.decision.forbiddenKeys.includes(k)) return `${p}: is not allowed`;
      const r = forbiddenKeys(kit, x, p);
      if (r) return r;
    }
  } else if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const r = forbiddenKeys(kit, v[i]!, pathIndex(path, i));
      if (r) return r;
    }
  }
  return '';
}

function forbiddenText(kit: Kit, v: JV, path: string): string {
  if (typeof v === 'string') {
    const low = v.toLowerCase();
    if (kit.config.decision.forbiddenText.some((f) => low.includes(f.toLowerCase()))) return `${path}: contains forbidden text`;
  } else if (isObj(v)) {
    for (const [k, x] of v) {
      const r = forbiddenText(kit, x, pathJoin(path, k));
      if (r) return r;
    }
  } else if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const r = forbiddenText(kit, v[i]!, pathIndex(path, i));
      if (r) return r;
    }
  }
  return '';
}

/** An extracted object as a decision on this menu, or the first problem (README 4.3, `validate`). */
export function validateDecision(kit: Kit, v: JV, menu: Menu): { decision: Decision } | { problem: string } {
  const p0 = forbiddenKeys(kit, v, '');
  if (p0) return { problem: p0 };
  for (const [k] of members(v)) if (!['thought', 'action', 'params', 'note'].includes(k)) return { problem: `${pathJoin('', k)}: is not allowed` };
  if (!has(v, 'action')) return { problem: 'action: is required' };
  const names = menuNames(menu);
  const av = get(v, 'action');
  if (typeof av !== 'string' || !names.includes(av)) return { problem: `action: must be one of: ${names.map((n) => quote(n)).join(', ')}` };
  const d: Decision = { thought: '', action: av, params: obj(), note: '' };
  for (const [key, max] of [
    ['thought', kit.config.decision.thoughtMax],
    ['note', kit.config.decision.noteMax],
  ] as const) {
    const x = get(v, key);
    if (x === undefined || x === null) continue;
    if (typeof x !== 'string') return { problem: `${key}: must be a string` };
    d[key] = clip(x, max);
  }
  const pv = get(v, 'params');
  if (pv !== undefined && pv !== null) d.params = pv;
  const entry = findAction(menu, d.action);
  const p1 = validateSchema(d.params, entry?.params, 'params');
  if (p1) return { problem: p1 };
  const p2 = forbiddenText(kit, d.params, 'params');
  if (p2) return { problem: p2 };
  return { decision: d };
}

/** Extract then validate. */
export function decide(kit: Kit, raw: string, menu: Menu): { decision: Decision } | { problem: string } {
  const e = extract(kit, raw);
  return 'problem' in e ? e : validateDecision(kit, e.value, menu);
}

/** The first of `fallbackActions` on the menu, with no params, or null. */
export function fallback(kit: Kit, menu: Menu): Decision | null {
  for (const name of kit.config.fallbackActions) if (findAction(menu, name)) return { thought: '', action: name, params: obj(), note: '' };
  return null;
}

/**
 * README 4.3 `resolve`: the first answer if valid; else one retry carrying the problem (an engine error counts as
 * invalid); else the fallback action; else no action.
 */
export async function resolve(kit: Kit, menu: Menu, first: string, retry: ((problem: string) => Promise<string>) | null): Promise<Resolution> {
  const d = decide(kit, first, menu);
  if ('decision' in d) return { decision: d.decision, source: 'first' };
  const res: Resolution = { decision: null, source: 'none', firstProblem: d.problem };
  if (retry) {
    try {
      const raw = await retry(d.problem);
      const d2 = decide(kit, raw, menu);
      if ('decision' in d2) return { ...res, decision: d2.decision, source: 'retry' };
      res.retryProblem = d2.problem;
    } catch (e) {
      res.retryProblem = e instanceof Error ? e.message : 'engine error';
    }
  }
  const fb = fallback(kit, menu);
  if (fb) return { ...res, decision: fb, source: 'fallback' };
  return res;
}
