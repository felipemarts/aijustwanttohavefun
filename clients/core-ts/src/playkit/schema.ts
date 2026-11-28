/**
 * The menu and the per-turn schema (README 3; Go: `internal/playkit/schema.go`).
 *
 * The menu is built as a pipeline: candidate actions, then each action through `ACTION_STEPS` (a step may change its
 * params or drop it), then the whole menu through `MENU_STEPS` (filters and, in playkit v2, ranking). Adding a v2 rule
 * means adding a step here, driven by playkit.json.
 */
import { arr, canon, clone, get, has, isObj, isTrue, members, num, obj, parse, text, type JObj, type JV } from './jv.ts';
import type { Kit } from './kit.ts';
import { str, strList } from './read.ts';

export type ActionShape = { name: string; ap: number; signature: string; params: JObj };

/** `GET /api/v1/schema`, parsed with member order kept. */
export class SchemaDoc {
  readonly apiVersion: string;
  readonly skillVersion: string;
  readonly actions: ActionShape[];
  private byName = new Map<string, number>();

  constructor(apiVersion: string, skillVersion: string, actions: ActionShape[]) {
    this.apiVersion = apiVersion;
    this.skillVersion = skillVersion;
    this.actions = actions;
    actions.forEach((a, i) => this.byName.set(a.name, i));
  }

  get(name: string): ActionShape | undefined {
    const i = this.byName.get(name);
    return i === undefined ? undefined : this.actions[i];
  }
}

export function parseSchemaDoc(body: string | JV): SchemaDoc {
  const v = typeof body === 'string' ? parse(body) : body;
  const acts = get(v, 'actions');
  if (!Array.isArray(acts)) throw new Error('schema: no actions');
  const out: ActionShape[] = [];
  for (const a of acts) {
    const name = get(a, 'name');
    const params = get(a, 'params');
    if (typeof name !== 'string' || !isObj(params)) throw new Error('schema: bad action entry');
    out.push({ name, ap: Math.trunc(num(get(a, 'ap'))), signature: text(get(a, 'signature')), params });
  }
  return new SchemaDoc(text(get(v, 'api_version')), text(get(v, 'skill_version')), out);
}

export type MenuAction = { name: string; ap: number; params: JV; signatures: string[] };
export type Menu = { actions: MenuAction[]; schema: JObj };

export function menuNames(m: Menu): string[] {
  return m.actions.map((a) => a.name);
}

export function findAction(m: Menu, name: string): MenuAction | undefined {
  return m.actions.find((a) => a.name === name);
}

// ── Sources (README 3.3) ───────────────────────────────────────────────────────────────────────────────────────────

/** The values a narrowing source offers, or null when the source is unknown (it needs `me`, which is null). */
export function source(kit: Kit, from: string, obsv: JV, me: JV): string[] | null {
  const room = get(obsv, 'room');
  const out: string[] = [];
  const add = (s: string) => {
    if (s !== '' && !out.includes(s)) out.push(s);
  };
  const keys = (v: JV | undefined, positive: boolean) => {
    for (const [k, x] of members(v)) {
      if (positive && typeof x === 'number' && x <= 0) continue;
      add(k);
    }
  };
  switch (from) {
    case 'exits':
      keys(get(room, 'exits'), false);
      break;
    case 'monsters':
      for (const m of arr(get(room, 'monsters'))) add(text(get(m, 'id')));
      break;
    case 'fair_monsters': {
      const you = get(obsv, 'you');
      add(str(you, 'in_combat'));
      const lvl = num(get(you, 'lvl'));
      for (const m of arr(get(room, 'monsters'))) if (num(get(m, 'lvl')) <= lvl + kit.lim('monsterLevelGap')) add(str(m, 'id'));
      break;
    }
    case 'agents':
      for (const a of arr(get(room, 'agents'))) {
        if (isTrue(get(a, 'fallen'))) continue;
        add(text(get(a, 'name')));
      }
      break;
    case 'npcs':
    case 'shops':
      for (const n of arr(get(room, 'npcs'))) {
        if (from === 'shops' && !arr(get(n, 'roles')).some((r) => text(r) === 'shop')) continue;
        add(text(get(n, 'id')));
      }
      break;
    case 'resources':
      keys(get(room, 'resources'), true);
      break;
    case 'ground':
      keys(get(room, 'items'), true);
      break;
    case 'bag':
      if (!isObj(me)) return null;
      keys(get(me, 'inventory'), true);
      break;
    case 'equipped':
      if (!isObj(me)) return null;
      for (const [, x] of members(get(me, 'equipment'))) add(text(x));
      break;
    case 'skills':
      if (!isObj(me)) return null;
      for (const s of arr(get(me, 'skills'))) {
        if (isTrue(get(s, 'locked'))) continue;
        add(text(get(s, 'id')));
      }
      break;
    default: {
      if (!from.startsWith('pending.')) return null;
      const list = get(get(obsv, 'pending'), from.slice('pending.'.length));
      for (const x of arr(list)) {
        if (typeof x === 'string') add(x);
        else if (has(x, 'id')) add(text(get(x, 'id')));
      }
    }
  }
  return out;
}

function isLawless(obsv: JV): boolean {
  return arr(get(get(obsv, 'room'), 'flags')).some((f) => text(f) === 'lawless');
}

function requiredList(params: JV): string[] {
  return arr(get(params, 'required')).map((r) => text(r));
}

// ── Per-action steps ───────────────────────────────────────────────────────────────────────────────────────────────

export type MenuContext = { kit: Kit; doc: SchemaDoc; obs: JV; me: JV; allowPvp: boolean; self: string };
export type Candidate = { name: string; ap: number; params: JV };
export type ActionStep = (ctx: MenuContext, c: Candidate) => Candidate | null;
export type MenuStep = (ctx: MenuContext, actions: MenuAction[]) => MenuAction[];

/** Removes `default`, caps string maxLength at textMax, closes objects listing properties, rewrites `items: false`. */
export function adjust(kit: Kit, v: JV): JV {
  if (Array.isArray(v)) return v.map((x) => adjust(kit, x));
  if (!isObj(v)) return v;
  v.delete('default');
  for (const [k, x] of v) v.set(k, adjust(kit, x));
  if (text(get(v, 'type')) === 'string' && v.has('maxLength') && num(get(v, 'maxLength')) > kit.config.decision.textMax) v.set('maxLength', kit.config.decision.textMax);
  if (v.has('properties') && !v.has('additionalProperties')) v.set('additionalProperties', false);
  // `items: false` after `prefixItems` (a tuple) is refused by llama.cpp's grammar converter: say it with maxItems.
  if (v.get('items') === false && Array.isArray(get(v, 'prefixItems'))) {
    const n = (get(v, 'prefixItems') as JV[]).length;
    v.delete('items');
    if (!v.has('maxItems') || num(get(v, 'maxItems')) > n) v.set('maxItems', n);
  }
  return v;
}

const adjustStep: ActionStep = (ctx, c) => ({ ...c, params: adjust(ctx.kit, clone(c.params)) });

/** `omitParams`: optional params removed (small models invent values for them). */
const omitStep: ActionStep = (ctx, c) => {
  const props = get(c.params, 'properties');
  if (!isObj(props)) return c;
  const req = requiredList(c.params);
  for (const o of ctx.kit.config.omitParams) {
    if (o.action === c.name && props.has(o.param) && !req.includes(o.param)) props.delete(o.param);
  }
  return c;
};

/** `narrow`: params limited to the values of their source; a required param with none drops the action. */
const narrowStep: ActionStep = (ctx, c) => {
  const props = get(c.params, 'properties');
  if (!isObj(props)) return c;
  const req = requiredList(c.params);
  for (const rule of ctx.kit.config.narrow) {
    if (rule.action !== c.name || !props.has(rule.param)) continue;
    let vals = source(ctx.kit, rule.from, ctx.obs, ctx.me);
    if (vals === null) continue;
    if (rule.pvpFrom && ctx.allowPvp && isLawless(ctx.obs)) {
      const extra = source(ctx.kit, rule.pvpFrom, ctx.obs, ctx.me) ?? [];
      vals = [...vals, ...extra.filter((e, i) => !vals!.includes(e) && extra.indexOf(e) === i)];
    }
    if (vals.length === 0) {
      if (req.includes(rule.param)) return null;
      props.delete(rule.param);
      continue;
    }
    props.set(rule.param, obj(['type', 'string'], ['enum', [...vals]]));
  }
  return c;
};

/**
 * `cast` without PvP (README 3.2.4): offensive skills only on fair monsters, supportive ones on the agents here and
 * the character itself; one closed form per kind, offensive first; no form drops cast.
 */
const castStep: ActionStep = (ctx, c) => {
  if (c.name !== 'cast' || ctx.allowPvp) return c;
  const props = get(c.params, 'properties');
  if (!isObj(props) || !props.has('skill') || !props.has('target')) return c;
  const skill = props.get('skill')!;
  const monsters = source(ctx.kit, 'fair_monsters', ctx.obs, ctx.me) ?? [];
  const form = (skillNode: JV, targets: string[]): JObj => {
    const p = obj(['skill', skillNode]);
    if (targets.length) p.set('target', obj(['type', 'string'], ['enum', [...targets]]));
    return obj(['type', 'object'], ['properties', p], ['required', ['skill']], ['additionalProperties', false]);
  };
  if (!isObj(ctx.me)) return { ...c, params: form(skill, monsters) };
  const offensive: string[] = [];
  const supportive: string[] = [];
  for (const s of arr(get(ctx.me, 'skills'))) {
    if (isTrue(get(s, 'locked'))) continue;
    const id = str(s, 'id');
    if (ctx.kit.config.supportiveSkillTargets.includes(str(s, 'target'))) supportive.push(id);
    else offensive.push(id);
  }
  const forms: JObj[] = [];
  if (offensive.length) forms.push(form(obj(['type', 'string'], ['enum', [...offensive]]), monsters));
  if (supportive.length) {
    const allies: string[] = [];
    for (const a of arr(get(get(ctx.obs, 'room'), 'agents'))) {
      const n = str(a, 'name');
      if (n !== '' && !allies.includes(n)) allies.push(n);
    }
    if (ctx.self !== '' && !allies.includes(ctx.self)) allies.push(ctx.self);
    forms.push(form(obj(['type', 'string'], ['enum', [...supportive]]), allies));
  }
  if (forms.length === 0) return null;
  return { ...c, params: forms.length === 1 ? forms[0]! : obj(['anyOf', forms]) };
};

/** The per-action steps, in order. */
export const ACTION_STEPS: ActionStep[] = [adjustStep, omitStep, narrowStep, castStep];

/** The menu-wide steps, in order (playkit v2 adds its survival filters and ranking here). */
export const MENU_STEPS: MenuStep[] = [];

// ── The menu ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Candidate names: the observation's actions, then (unless fallen) `alwaysOffered`, filtered by the kit's lists. */
function candidates(ctx: MenuContext): Candidate[] {
  const names = strList(get(ctx.obs, 'actions'));
  if (!has(get(ctx.obs, 'you'), 'fallen')) names.push(...ctx.kit.config.alwaysOffered);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const name of names) {
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    const shape = ctx.doc.get(name);
    if (!shape || ctx.kit.config.excludedActions.includes(name) || (!ctx.allowPvp && ctx.kit.config.pvpActions.includes(name))) continue;
    out.push({ name, ap: shape.ap, params: shape.params });
  }
  return out;
}

/**
 * README 3.2: the menu for this turn. `rest` are the loop breakers (`resting`), removed unless that empties the menu.
 */
export function buildMenu(kit: Kit, doc: SchemaDoc, obsv: JV, me: JV, allowPvp: boolean, self: string, rest: string[]): Menu {
  const ctx: MenuContext = { kit, doc, obs: obsv, me, allowPvp, self };
  let actions: MenuAction[] = [];
  for (const cand of candidates(ctx)) {
    let c: Candidate | null = cand;
    for (const step of ACTION_STEPS) {
      c = step(ctx, c);
      if (!c) break;
    }
    if (!c) continue;
    const forms = get(c.params, 'anyOf');
    const signatures = has(c.params, 'anyOf') ? arr(forms).map((f) => signature(c!.name, f)) : [signature(c.name, c.params)];
    actions.push({ name: c.name, ap: c.ap, params: c.params, signatures });
  }
  for (const step of MENU_STEPS) actions = step(ctx, actions);
  if (rest.length) {
    const kept = actions.filter((a) => !rest.includes(a.name));
    if (kept.length) actions = kept;
  }
  return { actions, schema: decisionSchema(kit, actions) };
}

export type RecentLike = { action: string; params: JV; ok: boolean };

/** Params for a prompt: canonical JSON, `{}` when not an object. */
export function paramsText(p: JV | undefined): string {
  return isObj(p) ? canon(p) : '{}';
}

/**
 * The loop breakers (README 3.2.5): the action refused on the previous turn (not `look`), then, in order of first
 * appearance, every 0-AP action that appears at least twice in `recent` with the same params.
 */
export function resting(doc: SchemaDoc, last: { action: string; ok: boolean } | null, recent: RecentLike[]): string[] {
  const out: string[] = [];
  if (last && !last.ok && last.action !== 'look') out.push(last.action);
  const count = new Map<string, number>();
  for (const r of recent) {
    const k = `${r.action} ${paramsText(r.params)}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  for (const r of recent) {
    if ((count.get(`${r.action} ${paramsText(r.params)}`) ?? 0) < 2 || out.includes(r.action)) continue;
    const shape = doc.get(r.action);
    if (shape && shape.ap === 0) out.push(r.action);
  }
  return out;
}

/** README 3.4. Member order matters. */
export function decisionSchema(kit: Kit, actions: MenuAction[]): JObj {
  const d = kit.config.decision;
  const branches: JV[] = actions.map((a) =>
    obj(
      ['type', 'object'],
      [
        'properties',
        obj(
          ['thought', obj(['type', 'string'], ['maxLength', d.thoughtMax])],
          ['action', obj(['const', a.name])],
          ['params', a.params],
          ['note', obj(['type', 'string'], ['maxLength', d.noteMax])],
        ),
      ],
      ['required', ['thought', 'action', 'params', 'note']],
      ['additionalProperties', false],
    ),
  );
  return obj(['type', 'object'], ['anyOf', branches]);
}

// ── Signatures (README 3.5) ────────────────────────────────────────────────────────────────────────────────────────

const AGENT_FIELDS = new Set(['agent', 'to', 'candidate']);

export function signature(action: string, params: JV): string {
  return `${action} ${shape(params, 'params')}`;
}

function shape(node: JV | undefined, field: string): string {
  if (!isObj(node)) return `<${field}>`;
  const any = get(node, 'anyOf');
  if (Array.isArray(any)) {
    const variants = any.filter(isObj);
    const nonNull = variants.filter((v) => text(get(v, 'type')) !== 'null');
    const first = nonNull.length ? shape(nonNull[0], field) : `<${field}>`;
    return nonNull.length < variants.length ? `${first}|null` : first;
  }
  const en = get(node, 'enum');
  if (Array.isArray(en)) return `"${en.map((e) => (typeof e === 'string' ? e : canon(e))).join('|')}"`;
  switch (text(get(node, 'type'))) {
    case 'string':
      if (text(get(node, 'pattern')).includes('[0-9a-fA-F]{6}')) return '"#rrggbb"';
      return AGENT_FIELDS.has(field) ? '"<name>"' : `"<${field}>"`;
    case 'integer':
    case 'number':
      return `<${field}>`;
    case 'array': {
      const pre = get(node, 'prefixItems');
      if (Array.isArray(pre)) return `[${pre.map((x) => shape(x, field)).join(', ')}]`;
      return `[${shape(get(node, 'items'), field)}]`;
    }
    case 'object': {
      const props = get(node, 'properties');
      const addl = get(node, 'additionalProperties');
      if ((!has(node, 'properties') || !isObj(props)) && isObj(addl)) return `{"<item>": ${shape(addl, 'qty')}}`;
      const req = new Set(requiredList(node));
      return `{${members(props)
        .map(([k, v]) => `"${k}"${req.has(k) ? '' : '?'}: ${shape(v, k)}`)
        .join(', ')}}`;
    }
  }
  return `<${field}>`;
}
