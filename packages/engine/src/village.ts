import type { Content, Project } from '@ajwf/content';
import { ref } from '@ajwf/shared';
import { grantTitle } from './agent';
import { BALANCE } from './balance';
import { emit, markAgent, msg, type Run } from './run';
import type { AgentState, Goods, Stack, WorldState } from './types';
import { isProjectDone } from './unlocks';
import { electionDue, VILLAGE_ID, type PlaqueLine, type ProjectState } from './village-state';

/** Title granted to the agent the statue honors. */
export const STATUE_TITLE = 'honored';

export type ProjectStatus = 'done' | 'available' | 'locked';

export function projectStatus(s: WorldState, p: Project): ProjectStatus {
  if (isProjectDone(s, p.id)) return 'done';
  return p.requires.every((r) => isProjectDone(s, r)) ? 'available' : 'locked';
}

const sites = new WeakMap<Content, Map<string, Project>>();

/** The project built at this room, if any (every project has its own site). */
export function projectAt(c: Content, room: string): Project | undefined {
  let m = sites.get(c);
  if (!m) {
    m = new Map([...c.projects.values()].map((p) => [p.site, p]));
    sites.set(c, m);
  }
  return m.get(room);
}

/** What the project still needs, gold and items (only the ones still short). */
export function missingFor(s: WorldState, p: Project): Goods {
  const st = s.village.projects[p.id];
  return {
    gold: p.cost.gold - (st?.gold ?? 0),
    items: p.cost.items.map((c) => ({ item: c.item, qty: c.qty - (st?.items[c.item] ?? 0) })).filter((x) => x.qty > 0),
  };
}

/** Value of goods at item base price (the unit of the contributor ledger). */
export function valueOf(c: Content, g: Goods): number {
  let v = g.gold;
  for (const x of g.items) v += (c.items.get(x.item)?.value ?? 0) * x.qty;
  return v;
}

/** Share of the cost delivered, by value at item base price, 0..1 (3 decimals). */
export function progressOf(s: WorldState, p: Project): number {
  if (isProjectDone(s, p.id)) return 1;
  const st = s.village.projects[p.id];
  const total = valueOf(s.content, { gold: p.cost.gold, items: p.cost.items });
  if (!st || total <= 0) return 0;
  const have = valueOf(s.content, { gold: st.gold, items: p.cost.items.map((c) => ({ item: c.item, qty: Math.min(c.qty, st.items[c.item] ?? 0) })) });
  return Math.min(0.999, Math.floor((have / total) * 1000) / 1000);
}

function stateOf(s: WorldState, id: string): ProjectState {
  let st = s.village.projects[id];
  if (!st) s.village.projects[id] = st = { gold: 0, items: {}, by: {} };
  return st;
}

/**
 * Splits an offer of one resource into what the project takes and the village bonus on top (priority project),
 * never beyond what is missing: with a bonus, the giver only pays what, topped up, covers the need.
 */
export function splitOffer(offer: number, missing: number, bonusPct: number): { take: number; bonus: number } {
  if (offer <= 0 || missing <= 0) return { take: 0, bonus: 0 };
  if (bonusPct <= 0) return { take: Math.min(offer, missing), bonus: 0 };
  const topped = (t: number) => t + Math.floor((t * bonusPct) / 100);
  let t = Math.ceil((missing * 100) / (100 + bonusPct));
  while (t > 1 && topped(t - 1) >= missing) t--;
  while (topped(t) < missing) t++;
  t = Math.min(t, offer);
  return { take: t, bonus: Math.min(Math.floor((t * bonusPct) / 100), missing - t) };
}

/**
 * Delivers goods into a project: `given` comes from `from` (an agent, or null for the village treasury), `bonus`
 * is minted by the village. The caller already trimmed both to what is missing and took `given` from its owner.
 * Completes the project when nothing is missing any more.
 */
export function deliver(run: Run, p: Project, from: AgentState | null, given: Goods, bonus: Goods): void {
  const s = run.s;
  const st = stateOf(s, p.id);
  for (const g of [given, bonus]) {
    st.gold += g.gold;
    for (const x of g.items) st.items[x.item] = (st.items[x.item] ?? 0) + x.qty;
  }
  const id = from?.id ?? VILLAGE_ID;
  st.by[id] = (st.by[id] ?? 0) + valueOf(run.c, given);
  const extra = valueOf(run.c, bonus);
  if (extra > 0) st.by[VILLAGE_ID] = (st.by[VILLAGE_ID] ?? 0) + extra;
  s.dirty.add('village');
  const left = missingFor(s, p);
  if (left.gold <= 0 && !left.items.length) completeProject(run, p, st);
}

/** The top contributors of a project, best first; ties go to whoever gave first. */
export function plaqueOf(s: WorldState, st: ProjectState, size: number = BALANCE.village.plaqueSize): PlaqueLine[] {
  return Object.entries(st.by)
    .filter(([, v]) => v > 0)
    .sort((x, y) => y[1] - x[1])
    .slice(0, size)
    .map(([id, value]) => ({ id, name: id === VILLAGE_ID ? null : (s.agents.get(id)?.name ?? '?'), value }));
}

function completeProject(run: Run, p: Project, st: ProjectState): void {
  const s = run.s;
  const v = s.village;
  st.doneAt = run.now;
  st.plaque = plaqueOf(s, st);
  if (v.priority === p.id) v.priority = null;
  const plaque = st.plaque;
  const contributors = plaque.filter((l) => l.id !== VILLAGE_ID).map((l) => l.id);
  emit(run, 'project_completed', {
    room: p.site,
    vis: 'public',
    to: contributors,
    drama: 9,
    m: msg('ev.project_completed', { proj: ref.proj(p.id), room: ref.room(p.site), name: plaque.find((l) => l.name !== null)?.name ?? '' }),
    data: { project: p.id, site: p.site, building: p.building, unlocks: p.unlocks, plaque },
  });
  if (p.unlocks.includes('statue_honor') && v.top) honor(run, v.top.id, v.top.value);
  for (const q of run.c.projects.values()) {
    if (q.requires.includes(p.id) && projectStatus(s, q) === 'available') {
      emit(run, 'project_available', { room: 'village.town_hall', vis: 'public', drama: 3, m: msg('ev.project_available', { proj: ref.proj(q.id) }), data: { project: q.id, site: q.site } });
    }
  }
}

/** `statue_honor`: the top overall contributor gets the statue (name and sprite) and a title. */
function honor(run: Run, agentId: string, value: number): void {
  const a = run.s.agents.get(agentId);
  if (!a) return;
  run.s.village.honoree = { id: a.id, name: a.name, sprite: a.lookHash, value, at: run.now };
  grantTitle(a, STATUE_TITLE);
  markAgent(run.s, a);
  emit(run, 'statue_honor', {
    room: 'village.square',
    actor: a.id,
    vis: 'public',
    to: [a.id],
    drama: 7,
    m: msg('ev.statue_honor', { actor: a.name, title: ref.title(STATUE_TITLE) }),
    data: { name: a.name, sprite: a.lookHash, value, title: STATUE_TITLE },
  });
}

/** Keeps the top overall contributor up to date after `a` gave (O(1): compared with the current holder only). */
export function noteContributor(s: WorldState, a: AgentState): void {
  const total = a.stats.contributions ?? 0;
  if (!s.village.top || total > s.village.top.value) s.village.top = { id: a.id, value: total };
  else if (s.village.top.id === a.id) s.village.top.value = total;
}

// ── Guild halls ──────────────────────────────────────────────────────────────

/** The plot where this guild's hall stands. O(number of plots). */
export function hallOf(s: WorldState, guildId: string): string | undefined {
  for (const [plot, h] of Object.entries(s.village.halls)) if (h.guild === guildId) return plot;
  return undefined;
}

/** A dissolved guild frees its plot. */
export function freeHall(s: WorldState, guildId: string): void {
  const plot = hallOf(s, guildId);
  if (plot === undefined) return;
  delete s.village.halls[plot];
  s.dirty.add('village');
}

// ── Restore ──────────────────────────────────────────────────────────────────

/**
 * Makes a restored village consistent with the content and the rest of the world: fields missing from older
 * snapshots get their defaults (already merged by the caller), entries pointing at removed projects, items, rooms,
 * guilds or agents are dropped, and exactly one election timer is on the heap.
 */
export function restoreVillage(s: WorldState): void {
  const c = s.content;
  const v = s.village;
  for (const [id, st] of Object.entries(v.projects)) {
    if (!c.projects.has(id)) delete v.projects[id];
    else for (const item of Object.keys(st.items)) if (!c.items.has(item)) delete st.items[item];
  }
  const pri = v.priority ? c.projects.get(v.priority) : undefined;
  if (v.priority && (!pri || projectStatus(s, pri) !== 'available')) v.priority = null;
  for (const [plot, h] of Object.entries(v.halls)) if (!s.guilds.has(h.guild) || !c.rooms.get(plot)?.flags.includes('plot')) delete v.halls[plot];
  if (v.mayor && !s.agents.has(v.mayor.id)) v.mayor = null;
  if (v.top && !s.agents.has(v.top.id)) v.top = null;
  const e = v.election;
  e.candidates = e.candidates.filter((x) => s.agents.has(x.id));
  const ids = new Set(e.candidates.map((x) => x.id));
  e.tally = {};
  for (const [voter, cand] of Object.entries(e.votes)) {
    if (!s.agents.has(voter) || !ids.has(cand)) delete e.votes[voter];
    else e.tally[cand] = (e.tally[cand] ?? 0) + 1;
  }
  const due = electionDue(e);
  const timers = s.timers.toJSON();
  const mine = timers.filter((t) => t.kind === 'election');
  if (mine.length !== 1 || mine[0]!.at !== due) {
    s.timers.replace([...timers.filter((t) => t.kind !== 'election'), { at: due, kind: 'election' }]);
  }
}

/** Cost of a guild hall as goods. */
export function hallCost(): Goods {
  const H = BALANCE.village.hall;
  return { gold: H.gold, items: H.items.map((x): Stack => ({ item: x.item, qty: x.qty })) };
}
