import type { AgentState, WorldState } from '@ajwf/engine';
import type { Highlight, MsgParams } from '@ajwf/shared';
import type { Renderer } from '../render';
import type { EventRow } from '../store/types';

/** Event types the summary reads (actor or target is the agent). */
export const SUMMARY_EVENT_TYPES = ['level_up', 'achievement', 'rare_drop', 'friend', 'betrayal', 'fallen', 'pvp_kill', 'project_contribution', 'election_result'] as const;
/** Events read at most for one summary. */
export const SUMMARY_MAX_EVENTS = 5000;
const LIST_MAX = 5;

/** One line of the summary: an i18n key and its params (for clients that render), plus the text in `lang`. */
export type SummaryItem = { type: string; k: string; p: MsgParams; text: string };

export type Summary = {
  since: number;
  until: number;
  items: SummaryItem[];
  highlights: { id: string; k: string; p: Highlight['params']; text: string; ts: number }[];
  /** Every item's text, joined: ready to show as one paragraph. */
  text: string;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** `@mon:slime` -> the monster's name in `lang`; anything else (an agent name) as is. */
function refName(render: Renderer, lang: string, v: string): string {
  const m = /^@([a-z]+):(.+)$/.exec(v);
  return m ? render.name(lang, m[1]!, m[2]!) : v;
}

function payload(r: EventRow): Record<string, unknown> {
  try {
    return JSON.parse(r.payloadJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * "While you were away" (§14.2): what happened to one agent between `since` and `until`, from its stored events
 * and the highlights it appears in. Built only from templates (`owner.summary.*`) with names and content
 * references; agent-written text never appears.
 */
export function buildSummary(o: {
  s: WorldState;
  render: Renderer;
  lang: string;
  agent: AgentState;
  events: EventRow[];
  highlights: Highlight[];
  since: number;
  until: number;
}): Summary {
  const { s, render, lang, agent: a } = o;
  const nameOf = (id: string | null, fallback = '') => (id ? s.agents.get(id)?.name : undefined) ?? fallback;
  const list = (xs: string[]) => {
    const uniq = [...new Set(xs.filter(Boolean))];
    const shown = uniq.slice(0, LIST_MAX);
    if (uniq.length > LIST_MAX) shown.push(render.t(lang, 'owner.summary.and_more', { n: uniq.length - LIST_MAX }));
    return render.list(lang, shown);
  };

  let levelFrom = 0;
  let levelTo = 0;
  const achievements: string[] = [];
  const items: string[] = [];
  const friends: string[] = [];
  const betrayed: string[] = [];
  const betrayedBy: string[] = [];
  let deaths = 0;
  const killers: string[] = [];
  const victims: string[] = [];
  const projects = new Map<string, number>();
  let elected = false;

  for (const r of o.events) {
    // The window is (since, until]: the next summary starts where this one ended, without repeating anything.
    if (r.ts <= o.since || r.ts > o.until) continue;
    const p = payload(r);
    const mine = r.actor === a.id;
    switch (r.type) {
      case 'level_up':
        if (!mine) break;
        if (!levelFrom) levelFrom = num(p.level) - 1;
        levelTo = Math.max(levelTo, num(p.level));
        break;
      case 'achievement':
        if (mine) achievements.push(render.name(lang, 'ach', str(p.ach)));
        break;
      case 'rare_drop':
        if (mine) items.push(render.name(lang, 'item', str(p.item)));
        break;
      case 'friend':
        friends.push(nameOf(mine ? r.target : r.actor));
        break;
      case 'betrayal':
        if (mine) betrayed.push(nameOf(r.target, str(p.victim)));
        else betrayedBy.push(nameOf(r.actor, str(p.traitor)));
        break;
      case 'fallen':
        if (!mine) break;
        deaths++;
        killers.push(refName(render, lang, str(p.by)));
        break;
      case 'pvp_kill':
        if (mine) victims.push(nameOf(r.target, str(p.victim)));
        break;
      case 'project_contribution':
        if (mine) projects.set(str(p.project), (projects.get(str(p.project)) ?? 0) + num(p.value));
        break;
      case 'election_result':
        if (mine) elected = true;
        break;
    }
  }

  const out: SummaryItem[] = [];
  const add = (type: string, p: MsgParams) => {
    const params = { name: a.name, ...p };
    out.push({ type, k: `owner.summary.${type}`, p: params, text: render.t(lang, `owner.summary.${type}`, params) });
  };
  if (levelTo > levelFrom) add('levels', { n: levelTo - levelFrom, level: levelTo });
  if (elected) add('elected', {});
  if (achievements.length) add('achievements', { n: achievements.length, list: list(achievements) });
  if (items.length) add('items', { n: items.length, list: list(items) });
  if (friends.length) add('friends', { n: new Set(friends).size, list: list(friends) });
  if (betrayed.length) add('betrayed', { n: betrayed.length, list: list(betrayed) });
  if (betrayedBy.length) add('betrayed_by', { n: betrayedBy.length, list: list(betrayedBy) });
  if (victims.length) add('pvp_kills', { n: victims.length, list: list(victims) });
  if (deaths) add('deaths', { n: deaths, list: list(killers) });
  if (projects.size) {
    const total = [...projects.values()].reduce((x, y) => x + y, 0);
    add('projects', { n: projects.size, list: list([...projects.keys()].map((id) => render.name(lang, 'proj', id))), value: total });
  }
  const hs = o.highlights.filter((h) => h.ts > o.since && h.ts <= o.until);
  if (hs.length) add('highlights', { n: hs.length });
  if (!out.length) add('quiet', {});

  return {
    since: o.since,
    until: o.until,
    items: out,
    highlights: hs.map((h) => ({ id: h.id, k: h.titleKey, p: h.params, ts: h.ts, text: render.t(lang, h.titleKey, h.params) })),
    text: out.map((i) => i.text).join(' '),
  };
}
