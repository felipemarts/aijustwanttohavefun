import type { GameEvent, Highlight } from '@ajwf/shared';

/**
 * Highlight detection (PLANEJAMENTO §14.1): one table of small rules over public game events. Pure: no I/O and no
 * clock, so the simulation tool can run it over a recorded event stream. Agent text never reaches a title; it may
 * travel only in `quote`, which clients treat as untrusted.
 */

type Params = Record<string, string | number>;

/** What a rule needs from the world beyond the event itself. */
export type ChronicleLookup = {
  /** Current name of an agent id (undefined for anything that is not an agent). */
  agentName(id: string): string | undefined;
  /** Kind of a monster id: world bosses and dungeon bosses get their own highlights. */
  monsterKind(id: string): 'world_boss' | 'boss' | 'normal' | undefined;
};

/** What a rule returns; the detector adds id, ts, room and drama. */
export type HighlightDraft = Omit<Highlight, 'id' | 'ts' | 'drama' | 'room'> & { drama?: number };

/** Replies that make a rumor "hot". */
export const HOT_RUMOR_REPLIES = 5;
/** A journal entry written this soon after a highlight about its author is itself a highlight. */
export const JOURNAL_WINDOW_MS = 60 * 60_000;
/** The level cap: reaching it is a highlight. */
export const TOP_LEVEL = 20;

/** Detector memory the stateful rules read (rumor threads, the last notable moment of each agent). */
export type RuleState = {
  rumors: Map<string, { author: string; text: string; lang: string; replies: number }>;
  notable: Map<string, { id: string; type: string; ts: number }>;
};

type RuleCtx = { look: ChronicleLookup; st: RuleState };

export type HighlightRule = {
  type: string;
  /** Event types the rule looks at. */
  on: readonly string[];
  /** Every title key the rule may produce (checked against the English catalog by the tests). */
  keys: readonly string[];
  detect(ev: GameEvent, ctx: RuleCtx): HighlightDraft | null;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const p = (ev: GameEvent, k: string) => ev.payload[k];
/** The agent behind an id, falling back to a name carried in the payload. */
const who = (ctx: RuleCtx, id: string | undefined, fallback?: unknown): string => (id ? ctx.look.agentName(id) : undefined) ?? str(fallback);
const names = (...xs: string[]) => [...new Set(xs.filter(Boolean))];
const draft = (type: string, titleKey: string, params: Params, agents: string[], extra: Partial<HighlightDraft> = {}): HighlightDraft => ({
  type,
  titleKey,
  params,
  agents,
  ...extra,
});

/** The rule table. Each rule is a few lines; `highlights.test.ts` has one test per rule. */
export const RULES: readonly HighlightRule[] = [
  {
    type: 'world_first',
    on: ['achievement'],
    keys: ['highlight.world_first'],
    detect: (ev, c) => (p(ev, 'world_first') === true ? draft('world_first', 'highlight.world_first', { name: who(c, ev.actor), ach: `@ach:${str(p(ev, 'ach'))}` }, names(who(c, ev.actor))) : null),
  },
  {
    type: 'epic_drop',
    on: ['rare_drop'],
    keys: ['highlight.epic_drop', 'highlight.legendary_drop'],
    detect: (ev, c) => {
      const rarity = str(p(ev, 'rarity'));
      if (rarity !== 'epic' && rarity !== 'legendary') return null;
      const name = who(c, ev.actor);
      return draft(`${rarity}_drop`, `highlight.${rarity}_drop`, { name, item: `@item:${str(p(ev, 'item'))}`, mon: `@mon:${str(p(ev, 'mon'))}` }, names(name));
    },
  },
  {
    type: 'guild_founded',
    on: ['guild_founded'],
    keys: ['highlight.guild_founded'],
    detect: (ev, c) => draft('guild_founded', 'highlight.guild_founded', { name: who(c, ev.actor), guild: str(p(ev, 'name')) }, names(who(c, ev.actor))),
  },
  {
    type: 'betrayal',
    on: ['betrayal'],
    keys: ['highlight.betrayal'],
    detect: (ev, c) => {
      const traitor = who(c, ev.actor, p(ev, 'traitor'));
      const victim = who(c, ev.target, p(ev, 'victim'));
      return draft('betrayal', 'highlight.betrayal', { name: traitor, victim }, names(traitor, victim));
    },
  },
  {
    type: 'scam_reported',
    on: ['scam_reported'],
    keys: ['highlight.scam_reported'],
    detect: (ev, c) => {
      const victim = who(c, ev.actor, p(ev, 'victim'));
      const accused = who(c, ev.target, p(ev, 'accused'));
      return draft('scam_reported', 'highlight.scam_reported', { name: victim, accused, value: num(p(ev, 'value')) }, names(accused, victim));
    },
  },
  {
    type: 'treasury_looted',
    on: ['treasury_looted'],
    keys: ['highlight.treasury_looted'],
    detect: (ev, c) => {
      const by = who(c, ev.actor, p(ev, 'by'));
      return draft('treasury_looted', 'highlight.treasury_looted', { name: by, guild: str(p(ev, 'guild')), value: num(p(ev, 'value')), pct: Math.round(num(p(ev, 'share')) * 100) }, names(by));
    },
  },
  {
    type: 'coup',
    on: ['guild_coup'],
    keys: ['highlight.coup'],
    detect: (ev, c) => {
      const usurper = who(c, ev.actor, p(ev, 'new'));
      const old = str(p(ev, 'old'));
      return draft('coup', 'highlight.coup', { name: usurper, old, guild: str(p(ev, 'guild')), reason: str(p(ev, 'reason')) || 'other' }, names(usurper, old));
    },
  },
  {
    type: 'mayor_elected',
    on: ['election_result'],
    keys: ['highlight.mayor_elected', 'highlight.mayor_reelected'],
    detect: (ev, c) => {
      const winner = who(c, ev.actor, p(ev, 'winner'));
      if (!winner) return null;
      const m = p(ev, 'm') as { k?: unknown } | undefined;
      const again = m?.k === 'ev.election_reelected';
      const votes = (p(ev, 'votes') as { name?: unknown; votes?: unknown }[] | undefined)?.find((x) => x.name === winner)?.votes;
      return draft(again ? 'mayor_reelected' : 'mayor_elected', again ? 'highlight.mayor_reelected' : 'highlight.mayor_elected', { name: winner, votes: num(votes), n: num(p(ev, 'n')), old: str(p(ev, 'previous')) }, names(winner, str(p(ev, 'previous'))));
    },
  },
  {
    type: 'embezzlement',
    on: ['mayor_embezzle'],
    keys: ['highlight.embezzlement'],
    detect: (ev, c) => draft('embezzlement', 'highlight.embezzlement', { name: who(c, ev.actor), gold: num(p(ev, 'gold')) }, names(who(c, ev.actor))),
  },
  {
    type: 'project_completed',
    on: ['project_completed'],
    keys: ['highlight.project_completed'],
    detect: (ev) => {
      const plaque = ((p(ev, 'plaque') as { name?: unknown }[] | undefined) ?? []).map((l) => str(l.name)).filter(Boolean);
      // `by` tells the texts whether an agent or only the village treasury paid for it.
      return draft('project_completed', 'highlight.project_completed', { proj: `@proj:${str(p(ev, 'project'))}`, name: plaque[0] ?? '', by: plaque.length ? 'agent' : 'village' }, names(...plaque));
    },
  },
  {
    type: 'bounty_claimed',
    on: ['bounty_claimed'],
    keys: ['highlight.bounty_claimed'],
    detect: (ev, c) => {
      const hunter = who(c, ev.actor, p(ev, 'hunter'));
      const target = who(c, ev.target, p(ev, 'target'));
      return draft('bounty_claimed', 'highlight.bounty_claimed', { name: hunter, target, gold: num(p(ev, 'gold')) }, names(hunter, target));
    },
  },
  {
    type: 'duel_upset',
    on: ['duel'],
    keys: ['highlight.duel_upset'],
    detect: (ev, c) => {
      if (p(ev, 'upset') !== true) return null;
      const winner = who(c, ev.actor, p(ev, 'winner'));
      const loser = who(c, ev.target, p(ev, 'loser'));
      return draft('duel_upset', 'highlight.duel_upset', { name: winner, loser, rounds: num(p(ev, 'rounds')) }, names(winner, loser));
    },
  },
  {
    type: 'best_friends',
    on: ['bond'],
    keys: ['highlight.best_friends'],
    detect: (ev, c) => {
      if (p(ev, 'level') !== 'best_friend') return null;
      const a = who(c, ev.actor);
      const b = who(c, ev.target);
      return a && b ? draft('best_friends', 'highlight.best_friends', { name: a, other: b }, names(a, b)) : null;
    },
  },
  {
    type: 'hot_rumor',
    on: ['board_reply'],
    keys: ['highlight.hot_rumor'],
    detect: (ev, c) => {
      const r = c.st.rumors.get(str(p(ev, 'post')));
      if (!r || r.replies !== HOT_RUMOR_REPLIES) return null;
      return draft('hot_rumor', 'highlight.hot_rumor', { name: r.author, n: r.replies }, names(r.author), { quote: { text: r.text, lang: r.lang }, drama: 4 });
    },
  },
  {
    type: 'journal_after',
    on: ['journal'],
    keys: ['highlight.journal_after'],
    detect: (ev, c) => {
      const name = who(c, ev.actor);
      const n = c.st.notable.get(name);
      if (!n || ev.ts - n.ts > JOURNAL_WINDOW_MS) return null;
      c.st.notable.delete(name);
      return draft('journal_after', 'highlight.journal_after', { name, about: n.type }, [name], { ref: n.id, quote: { text: str(p(ev, 'text')), lang: ev.lang ?? '' } });
    },
  },
  {
    type: 'boss_kill',
    on: ['kill'],
    keys: ['highlight.boss_kill', 'highlight.world_boss_kill'],
    detect: (ev, c) => {
      const mon = str(p(ev, 'mon'));
      const kind = c.look.monsterKind(mon);
      if (kind !== 'boss' && kind !== 'world_boss') return null;
      const by = ((p(ev, 'by') as unknown[] | undefined) ?? []).map(str).filter(Boolean);
      const name = who(c, ev.actor, by[0]);
      return draft(kind === 'boss' ? 'boss_kill' : 'world_boss_kill', `highlight.${kind}_kill`, { name, mon: `@mon:${mon}`, n: Math.max(1, by.length) }, names(name, ...by));
    },
  },
  {
    type: 'level_20',
    on: ['level_up'],
    keys: ['highlight.level_20'],
    detect: (ev, c) => (num(p(ev, 'level')) === TOP_LEVEL ? draft('level_20', 'highlight.level_20', { name: who(c, ev.actor), level: TOP_LEVEL }, names(who(c, ev.actor))) : null),
  },
  {
    type: 'statue_honor',
    on: ['statue_honor'],
    keys: ['highlight.statue_honor'],
    detect: (ev, c) => {
      const name = who(c, ev.actor, p(ev, 'name'));
      return draft('statue_honor', 'highlight.statue_honor', { name, value: num(p(ev, 'value')) }, names(name));
    },
  },
  {
    type: 'guild_hall_built',
    on: ['guild_hall_built'],
    keys: ['highlight.guild_hall_built'],
    detect: (ev, c) => {
      const name = who(c, ev.actor);
      return draft('guild_hall_built', 'highlight.guild_hall_built', { name, guild: str(p(ev, 'name')), room: `@room:${str(p(ev, 'plot'))}` }, names(name));
    },
  },
];

/** Every highlight title key the rules can produce. */
export const HIGHLIGHT_KEYS: readonly string[] = [...new Set(RULES.flatMap((r) => r.keys))];

const RUMOR_MEMORY = 500;
const NOTABLE_MEMORY = 5000;

/** Highlight ids: `h` + the id of the event that caused it (a second highlight of one event gets a suffix). */
export function highlightId(eventId: string, n: number): string {
  return n ? `h${eventId}-${n}` : `h${eventId}`;
}

/** Sequence number of a highlight id (the event id), for paging. */
export function highlightSeq(id: string): number {
  const m = /^h(\d+)/.exec(id);
  return m ? Number(m[1]) : 0;
}

/**
 * Runs the rules over events, in order. Keeps a little memory (rumor threads and the latest notable moment of each
 * agent, both bounded) so that rules spanning several events work. Feed it only events spectators may see: it
 * never looks at visibility itself.
 */
export class HighlightDetector {
  readonly st: RuleState = { rumors: new Map(), notable: new Map() };
  private byType = new Map<string, HighlightRule[]>();

  constructor(
    private look: ChronicleLookup,
    rules: readonly HighlightRule[] = RULES,
  ) {
    for (const r of rules) for (const t of r.on) (this.byType.get(t) ?? this.byType.set(t, []).get(t)!).push(r);
  }

  detect(ev: GameEvent): Highlight[] {
    this.remember(ev);
    const rules = this.byType.get(ev.type);
    if (!rules) return [];
    const out: Highlight[] = [];
    for (const rule of rules) {
      const d = rule.detect(ev, { look: this.look, st: this.st });
      if (!d) continue;
      const { drama, ...rest } = d;
      const h: Highlight = { id: highlightId(ev.id, out.length), ts: ev.ts, ...rest, drama: drama ?? ev.drama ?? 1 };
      if (ev.roomId) h.room = ev.roomId;
      out.push(h);
    }
    for (const h of out) if (h.type !== 'journal_after') for (const name of h.agents) this.note(name, h);
    return out;
  }

  /** Bookkeeping before the rules run: rumor threads and their replies. */
  private remember(ev: GameEvent): void {
    const rumors = this.st.rumors;
    if (ev.type === 'board_post' && ev.payload.tag === 'rumor') {
      const author = (ev.actor && this.look.agentName(ev.actor)) || '?';
      rumors.set(str(ev.payload.post), { author, text: str(ev.payload.text), lang: ev.lang ?? '', replies: 0 });
      if (rumors.size > RUMOR_MEMORY) rumors.delete(rumors.keys().next().value!);
    } else if (ev.type === 'board_reply') {
      const r = rumors.get(str(ev.payload.post));
      if (r) r.replies++;
    }
  }

  private note(name: string, h: Highlight): void {
    const notable = this.st.notable;
    notable.delete(name);
    notable.set(name, { id: h.id, type: h.type, ts: h.ts });
    if (notable.size > NOTABLE_MEMORY) notable.delete(notable.keys().next().value!);
  }
}
