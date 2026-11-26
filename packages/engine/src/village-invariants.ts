import { BALANCE } from './balance';
import { MAYOR_TITLE } from './election';
import type { WorldState } from './types';
import { STATUE_TITLE, missingFor, projectAt, valueOf } from './village';
import { electionDue, VILLAGE_ID } from './village-state';

const isNatural = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * Rules of the civic systems (projects, elections, mayor, guild halls) that must hold after anything. Developer
 * text, appended to `out`. Linear in the size of the village and the agents: tests and simulations only.
 */
export function checkVillage(s: WorldState, out: string[]): void {
  const c = s.content;
  const v = s.village;
  if (!(v.taxRate >= 0 && v.taxRate <= BALANCE.village.taxMax)) out.push(`village tax rate ${v.taxRate}`);

  for (const [id, st] of Object.entries(v.projects)) {
    const p = c.projects.get(id);
    const what = `project ${id}`;
    if (!p) {
      out.push(`${what}: unknown project`);
      continue;
    }
    if (!isNatural(st.gold) || st.gold > p.cost.gold) out.push(`${what}: ${st.gold} gold of ${p.cost.gold}`);
    for (const [item, qty] of Object.entries(st.items)) {
      const need = p.cost.items.find((x) => x.item === item)?.qty ?? 0;
      if (!Number.isInteger(qty) || qty <= 0 || qty > need) out.push(`${what}: ${qty} x ${item} of ${need}`);
    }
    // Something was delivered, so it was available: its requirements are done.
    for (const r of p.requires) if (v.projects[r]?.doneAt === undefined) out.push(`${what}: has progress before ${r} is done`);
    let ledger = 0;
    for (const [who, value] of Object.entries(st.by)) {
      if (!isNatural(value)) out.push(`${what}: ledger ${who} = ${value}`);
      if (who !== VILLAGE_ID && !s.agents.has(who)) out.push(`${what}: ledger names unknown agent ${who}`);
      ledger += value;
    }
    const delivered = valueOf(c, { gold: st.gold, items: Object.entries(st.items).map(([item, qty]) => ({ item, qty })) });
    if (ledger !== delivered) out.push(`${what}: ledger sums ${ledger} but ${delivered} was delivered`);
    const left = missingFor(s, p);
    const complete = left.gold <= 0 && !left.items.length;
    if (complete !== (st.doneAt !== undefined)) out.push(`${what}: complete ${complete} but doneAt ${st.doneAt}`);
    if (st.doneAt !== undefined && (!st.plaque || st.plaque.length > BALANCE.village.plaqueSize)) out.push(`${what}: plaque ${JSON.stringify(st.plaque)}`);
  }
  if (v.priority !== null) {
    const p = c.projects.get(v.priority);
    if (!p || v.projects[p.id]?.doneAt !== undefined || p.requires.some((r) => v.projects[r]?.doneAt === undefined)) out.push(`priority ${v.priority} is not an available project`);
    if (!v.mayor) out.push(`priority ${v.priority} set without a mayor`);
  }

  // Elections: one vote per agent per election, for a candidate, never for oneself; totals match the ballots.
  const e = v.election;
  if (e.phase !== 'candidacy' && e.phase !== 'voting') out.push(`election ${e.n}: phase ${String(e.phase)}`);
  if (!(e.start < e.voteAt && e.voteAt < e.end)) out.push(`election ${e.n}: schedule ${e.start} ${e.voteAt} ${e.end}`);
  const cands = new Set<string>();
  for (const x of e.candidates) {
    if (cands.has(x.id)) out.push(`election ${e.n}: ${x.id} is a candidate twice`);
    cands.add(x.id);
    if (!s.agents.has(x.id)) out.push(`election ${e.n}: unknown candidate ${x.id}`);
  }
  const recount: Record<string, number> = {};
  for (const [voter, cand] of Object.entries(e.votes)) {
    if (!s.agents.has(voter)) out.push(`election ${e.n}: unknown voter ${voter}`);
    if (!cands.has(cand)) out.push(`election ${e.n}: ${voter} voted for non-candidate ${cand}`);
    if (voter === cand) out.push(`election ${e.n}: ${voter} voted for itself`);
    recount[cand] = (recount[cand] ?? 0) + 1;
  }
  if (Object.keys(e.votes).length && e.phase !== 'voting') out.push(`election ${e.n}: votes outside the voting phase`);
  for (const id of new Set([...Object.keys(recount), ...Object.keys(e.tally)])) {
    if ((recount[id] ?? 0) !== (e.tally[id] ?? 0)) out.push(`election ${e.n}: tally ${id} = ${e.tally[id]} but ${recount[id] ?? 0} ballots`);
  }
  const due = s.timers.toJSON().filter((t) => t.kind === 'election');
  if (due.length !== 1 || due[0]!.at !== electionDue(e)) out.push(`election ${e.n}: timers ${JSON.stringify(due)} (due ${electionDue(e)})`);
  if (v.history.length > BALANCE.election.historyKept) out.push(`election history holds ${v.history.length}`);

  // The mayor title is worn by the mayor only.
  if (v.mayor && !s.agents.get(v.mayor.id)?.titles.includes(MAYOR_TITLE)) out.push(`mayor ${v.mayor.id} lacks the mayor title`);
  for (const a of s.agents.values()) {
    if (a.titles.includes(MAYOR_TITLE) && v.mayor?.id !== a.id) out.push(`agent ${a.id}: mayor title out of office`);
    if (a.title !== null && !a.titles.includes(a.title)) out.push(`agent ${a.id}: active title ${a.title} not owned`);
  }
  if (v.honoree && !s.agents.get(v.honoree.id)?.titles.includes(STATUE_TITLE)) out.push(`honoree ${v.honoree.id} lacks the ${STATUE_TITLE} title`);
  const n = e.n;
  if (!isNatural(v.embezzled.gold) || v.embezzled.election > n) out.push(`embezzled ${JSON.stringify(v.embezzled)}`);

  // Guild halls: on free plots, one per guild, for living guilds.
  const guilds = new Set<string>();
  for (const [plot, h] of Object.entries(v.halls)) {
    if (!c.rooms.get(plot)?.flags.includes('plot')) out.push(`guild hall on ${plot}, which is not a plot`);
    if (projectAt(c, plot)) out.push(`guild hall on project site ${plot}`);
    if (!s.guilds.has(h.guild)) out.push(`guild hall on ${plot} for missing guild ${h.guild}`);
    if (guilds.has(h.guild)) out.push(`guild ${h.guild} has two halls`);
    guilds.add(h.guild);
  }
}
