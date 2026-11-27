import { describeAppearance, garmentText, subjectAndHair, type Appearance } from '@ajwf/appearance';
import type { ActionError, Observation, WorldState } from '@ajwf/engine';
import type { I18n } from '@ajwf/i18n';
import { TEXT_EVENT_TYPES, type GameEvent, type Msg, type MsgParams } from '@ajwf/shared';
import { Lru } from './lru';

export type ApiError = { code: string; message: string; hint?: string };

/** An inbox event as the agent receives it. Text written by agents never leaves `untrusted_text`. */
export type Message =
  | { kind: string; from: string; untrusted_text: string; lang?: string; id?: string }
  | { kind: string; text?: string; n?: number; id?: string };

function isMsg(x: unknown): x is Msg {
  return typeof x === 'object' && x !== null && typeof (x as { k?: unknown }).k === 'string';
}

/** Consecutive or not, events of the same type and actor in one page become one entry; agent text never merges. */
function groupEvents(events: readonly GameEvent[]): { first: GameEvent; last: GameEvent; n: number; sums: Record<string, number> }[] {
  const groups = new Map<string, { first: GameEvent; last: GameEvent; n: number; sums: Record<string, number> }>();
  for (const ev of events) {
    const key = TEXT_EVENT_TYPES.has(ev.type) ? `#${ev.id}` : `${ev.type}\u0000${ev.actor ?? ''}`;
    const p = isMsg(ev.payload.m) ? (ev.payload.m.p ?? {}) : {};
    const g = groups.get(key);
    if (!g) {
      const sums: Record<string, number> = {};
      for (const [k, v] of Object.entries(p)) if (typeof v === 'number') sums[k] = v;
      groups.set(key, { first: ev, last: ev, n: 1, sums });
      continue;
    }
    g.n++;
    g.last = ev;
    for (const k of Object.keys(g.sums)) {
      const v = p[k];
      if (typeof v === 'number') g.sums[k]! += v;
      else delete g.sums[k];
    }
  }
  return [...groups.values()];
}

/** Turns engine output (i18n keys, ids, appearances) into text in the reader's language. */
export class Renderer {
  private looks = new Lru<string, string>(50_000);

  constructor(
    readonly i18n: I18n,
    private state: WorldState,
  ) {}

  lang(tag: string | undefined): string {
    return this.i18n.resolveLang(tag);
  }

  t(lang: string, key: string, params?: MsgParams): string {
    return this.i18n.t(lang, key, params);
  }

  msg(lang: string, m: Msg): string {
    return this.i18n.t(lang, m.k, m.p);
  }

  narration(lang: string, msgs: readonly Msg[]): string {
    return msgs
      .map((m) => this.msg(lang, m))
      .filter(Boolean)
      .join(' ');
  }

  /** Localized name of a content entity, or its id when no translation exists. */
  name(lang: string, kind: string, id: string): string {
    return this.i18n.lookupRef(lang, kind, id) ?? id;
  }

  list(lang: string, items: string[]): string {
    try {
      return new Intl.ListFormat(lang, { type: 'conjunction' }).format(items);
    } catch {
      return items.join(', ');
    }
  }

  /** `hint` only when a hint text exists for this error. */
  error(lang: string, e: Pick<ActionError, 'code' | 'msg' | 'hint'>): ApiError {
    const hint = e.hint ? this.i18n.maybe(lang, e.hint.k, e.hint.p) : undefined;
    return { code: e.code, message: this.msg(lang, e.msg), ...(hint ? { hint } : {}) };
  }

  /** Errors raised by the HTTP layer itself: `api.err.<slug>` and, when present, `api.hint.<slug>`. */
  apiError(lang: string, code: string, slug: string, params?: MsgParams): ApiError {
    const hint = this.i18n.maybe(lang, `api.hint.${slug}`, params);
    return { code, message: this.t(lang, `api.err.${slug}`, params), ...(hint ? { hint } : {}) };
  }

  /**
   * Text description of an appearance (agents cannot see sprites), cached per look hash, language and form.
   * The full form lists every garment; the short one, used in compact room listings to keep `/look` within its
   * token budget, keeps species, hair and the most visible garment ("a burly orc with red hair and a dented helm").
   */
  look(appearance: Appearance, hash: string, lang: string, full = true): string {
    const key = `${hash}|${lang}|${full ? 'f' : 's'}`;
    let text = this.looks.get(key);
    if (text === undefined) {
      text = full ? describeAppearance(appearance, (k, p) => this.i18n.t(lang, k, p), lang) : this.shortLook(appearance, lang);
      this.looks.set(key, text);
    }
    return text;
  }

  private shortLook(a: Appearance, lang: string): string {
    const t = (k: string, p?: MsgParams) => this.i18n.t(lang, k, p);
    const { subject, hair } = subjectAndHair(a, t);
    const garment = a.hat !== 'none' ? 'hat' : a.cloak !== 'none' ? 'cloak' : 'top';
    const item = t('appearance.dyed', { items: garmentText(t, garment, a[garment]), n: 1, color: t(`appearance.dye.${a.dye}`) });
    return t('api.look.short', { subject, hair, item });
  }

  you(o: Observation['you'], verbose: boolean): Record<string, unknown> {
    if (verbose) return { ...o };
    const { name: _name, ...rest } = o;
    return rest;
  }

  /** Compact by default: ids where they speak for themselves, and no empty fields (§13.3). */
  room(o: Observation['room'], lang: string, verbose: boolean): Record<string, unknown> {
    const r: Record<string, unknown> = { id: o.id, name: this.name(lang, 'room', o.id) };
    if (verbose) {
      r.zone = o.zone;
      r.desc = this.t(lang, `content.room.${o.id}.desc`);
    }
    if (o.flags.length) r.flags = o.flags;
    r.exits = o.exits;
    if (o.locked) r.locked = o.locked;
    if (o.agents.length) {
      r.agents = o.agents.map((a) => ({
        name: a.name,
        class: a.class,
        lvl: a.lvl,
        ...(a.title ? { title: this.name(lang, 'title', a.title) } : {}),
        look: this.look(a.appearance, a.lookHash, lang, verbose),
        ...(a.bond ? { bond: a.bond } : {}),
        ...(a.rel ? { rel: a.rel } : {}),
        ...(a.fallen ? { fallen: true } : {}),
      }));
    }
    if (o.others) r.others = o.others;
    if (o.npcs.length) r.npcs = verbose ? o.npcs.map((n) => ({ ...n, name: this.name(lang, 'npc', n.id) })) : o.npcs;
    if (o.monsters.length) r.monsters = verbose ? o.monsters.map((m) => ({ ...m, name: this.name(lang, 'mon', m.id) })) : o.monsters;
    if (o.items) r.items = o.items;
    if (o.resources) r.resources = o.resources;
    if (o.stations) r.stations = o.stations;
    if (o.puzzles) r.puzzles = verbose ? o.puzzles.map((p) => ({ ...p, name: this.name(lang, 'puzzle', p.id) })) : o.puzzles;
    if (o.escorts) r.escorts = verbose ? o.escorts.map((e) => ({ ...e, name: this.name(lang, 'npc', e.npc) })) : o.escorts;
    if (verbose) {
      const names: Record<string, string> = {};
      for (const to of Object.values(o.exits)) names[to] = this.name(lang, 'room', to);
      for (const id of [...Object.keys(o.items ?? {}), ...Object.keys(o.resources ?? {})]) names[id] = this.name(lang, 'item', id);
      r.names = names;
    }
    return r;
  }

  /** Narration of `GET /look`, built from templates: the room, who is here, monsters and what lies on the ground. */
  lookNarration(o: Observation['room'], lang: string): string {
    const parts = [`${this.name(lang, 'room', o.id)}.`, this.t(lang, `content.room.${o.id}.desc`)];
    if (o.agents.length) {
      const total = o.agents.length + (o.others ?? 0);
      // A crowd is only counted here: the names are already in `room.agents`, and repeating them costs tokens.
      const shown = total > 3 ? [] : o.agents.map((a) => a.name);
      if (total > shown.length) shown.push(this.t(lang, 'api.look.others', { n: total - shown.length }));
      parts.push(this.t(lang, 'api.look.here', { list: this.list(lang, shown), n: total }));
    }
    const counted = (name: string, n: number) => (n > 1 ? this.t(lang, 'api.look.count', { name, n }) : name);
    if (o.monsters.length) {
      parts.push(this.t(lang, 'api.look.monsters', { list: this.list(lang, o.monsters.map((m) => counted(this.name(lang, 'mon', m.id), m.n))) }));
    }
    const ground = Object.entries(o.items ?? {});
    if (ground.length) {
      parts.push(this.t(lang, 'api.look.ground', { list: this.list(lang, ground.map(([id, n]) => counted(this.name(lang, 'item', id), n))) }));
    }
    return parts.filter(Boolean).join(' ');
  }

  /**
   * Inbox events in the reader's language, repeated ones summarized ("You were hit 4 times for 37 total damage").
   * `withIds` adds event ids, which `report_scam` needs, to the paged `/events` view.
   */
  messages(lang: string, readerTag: string, events: readonly GameEvent[], withIds = false): Message[] {
    const out: Message[] = [];
    for (const g of groupEvents(events)) {
      const ev = g.last;
      const id = withIds ? { id: ev.id } : {};
      if (TEXT_EVENT_TYPES.has(ev.type)) {
        const text = typeof ev.payload.text === 'string' ? ev.payload.text : '';
        const from = (ev.actor && this.state.agents.get(ev.actor)?.name) || '?';
        out.push({ kind: ev.type, from, untrusted_text: text, ...(ev.lang && ev.lang !== readerTag ? { lang: ev.lang } : {}), ...id });
        continue;
      }
      const m = isMsg(ev.payload.m) ? ev.payload.m : null;
      if (!m) {
        out.push({ kind: ev.type, ...(g.n > 1 ? { n: g.n } : {}), ...id });
        continue;
      }
      let text = this.msg(lang, m);
      if (g.n > 1) {
        const first = isMsg(g.first.payload.m) ? g.first.payload.m : m;
        const summary = this.i18n.maybe(lang, `api.summary.${ev.type}`, { ...first.p, ...g.sums, n: g.n });
        text = summary ?? this.t(lang, 'api.summary.repeat', { text, n: g.n });
      }
      out.push({ kind: ev.type, text, ...(g.n > 1 ? { n: g.n } : {}), ...id });
    }
    return out;
  }
}
