import { BALANCE, bondScore, reputation, type AgentState, type Guild, type WorldState } from '@ajwf/engine';
import type { Highlight } from '@ajwf/shared';
import type { Chronicle } from './chronicle';

const LIST = 10;

/** Public reputation of an agent (§7.5), without the name it repeats. */
export function reputationOf(s: WorldState, a: AgentState, now: number) {
  const r = reputation(s, a.id, now);
  if (!r) return null;
  const { name: _name, ...rest } = r;
  return rest;
}

const names = (s: WorldState, ids: readonly string[]) => ids.flatMap((id) => s.agents.get(id)?.name ?? []).slice(0, LIST);

function rank(g: Guild, id: string): 'leader' | 'officer' | 'member' {
  return g.leader === id ? 'leader' : g.officers.includes(id) ? 'officer' : 'member';
}

/**
 * What the profile page (`/a/:name`) adds to the public card: reputation, guild, friends, best friends and rivals,
 * the projects the agent built, its latest journal entries (agent text) and the highlights it appears in.
 */
export async function profileExtras(s: WorldState, chronicle: Chronicle, a: AgentState, now: number) {
  const g = a.guild ? s.guilds.get(a.guild) : undefined;
  const best = Object.keys(a.bonds)
    .map((id) => s.agents.get(id))
    .filter((b): b is AgentState => !!b && bondScore(a, b) >= BALANCE.bond.bestFriend)
    .map((b) => b.name)
    .slice(0, LIST);
  const projects = Object.entries(s.village.projects)
    .flatMap(([id, st]) => ((st.by[a.id] ?? 0) > 0 ? [{ id, value: st.by[a.id]!, done: st.doneAt !== undefined }] : []))
    .sort((x, y) => y.value - x.value);
  const journal = (await chronicle.journalOf(a.id)).map((j) => ({ ts: j.ts, text: j.text, lang: j.lang }));
  const highlights: Highlight[] = chronicle.recentHighlights(LIST, (h) => h.agents.includes(a.name));
  return {
    reputation: reputationOf(s, a, now),
    ...(g ? { guild: { name: g.name, rank: rank(g, a.id), colors: g.colors } } : {}),
    friends: { n: a.friends.length, names: names(s, a.friends) },
    best_friends: best,
    rivals: names(s, a.rivals),
    projects,
    /** Agent-written: escape before display. */
    journal,
    highlights,
  };
}
