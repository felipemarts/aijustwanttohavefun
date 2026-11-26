import type { ActionName } from '@ajwf/shared';
import { BALANCE } from './balance';
import { isMayor } from './election';
import { guildOf } from './guild';
import type { AgentState, WorldState } from './types';
import { hallOf, missingFor, progressOf, projectAt, projectStatus, type ProjectStatus } from './village';
import type { ElectionPhase, ElectionRecord, PlaqueLine } from './village-state';

/**
 * Read models of the village: what the server needs for `/village`, the map and the gazette, and the compact
 * civic part of an agent's observation. Pure reads; the cost is O(projects + plots + candidates), never a scan of
 * agents or rooms.
 */

export type ProjectView = {
  id: string;
  site: string;
  building: string;
  status: ProjectStatus;
  /** Share of the cost delivered, by value at item base price (1 when done). */
  progress: number;
  requires: string[];
  /** What is still needed (available and locked projects). */
  missing?: { gold: number; items: Record<string, number> };
  doneAt?: number;
  /** Top contributors, best first (done projects). `name` null = the village. */
  plaque?: PlaqueLine[];
};

export type BuildingView =
  | { kind: 'project'; project: string; building: string; at: number }
  | { kind: 'guild_hall'; guild: string; name: string; colors: [string, string]; at: number };

export type CandidateView = {
  name: string;
  at: number;
  /** Live total (the ballot is secret, the totals are not). */
  votes: number;
  /** Agent-written text: escape before display. */
  platform: string;
  lang: string;
  /** False once banned or retired: cannot be voted for or win. */
  active: boolean;
};

export type VillageView = {
  now: number;
  treasury: number;
  taxRate: number;
  priority: string | null;
  mayor: { name: string; since: number; election: number } | null;
  election: { n: number; phase: ElectionPhase; start: number; voteAt: number; end: number; voters: number; candidates: CandidateView[] };
  /** The latest closed election, for the gazette (the full record was emitted in `election_result`). */
  lastElection: ElectionRecord | null;
  /** Every project in content order. */
  projects: ProjectView[];
  /** room id -> what stands there: finished projects and guild halls. */
  buildings: Record<string, BuildingView>;
  /** Statue honoree (name and sprite hash), once the statue is built. */
  honoree: { name: string; sprite: string; value: number; at: number } | null;
};

export function projectViews(s: WorldState): ProjectView[] {
  const out: ProjectView[] = [];
  for (const p of s.content.projects.values()) {
    const status = projectStatus(s, p);
    const st = s.village.projects[p.id];
    const view: ProjectView = { id: p.id, site: p.site, building: p.building, status, progress: progressOf(s, p), requires: p.requires };
    if (status === 'done') {
      view.doneAt = st!.doneAt!;
      view.plaque = st!.plaque ?? [];
    } else {
      const m = missingFor(s, p);
      view.missing = { gold: m.gold, items: Object.fromEntries(m.items.map((x) => [x.item, x.qty])) };
    }
    out.push(view);
  }
  return out;
}

/** Everything `/village` and the map need, in one cheap call. */
export function villageView(s: WorldState, now: number): VillageView {
  const v = s.village;
  const e = v.election;
  const projects = projectViews(s);
  const buildings: Record<string, BuildingView> = {};
  for (const p of projects) if (p.status === 'done') buildings[p.site] = { kind: 'project', project: p.id, building: p.building, at: p.doneAt! };
  for (const [plot, h] of Object.entries(v.halls)) {
    const g = s.guilds.get(h.guild);
    if (g) buildings[plot] = { kind: 'guild_hall', guild: g.id, name: g.name, colors: g.colors, at: h.at };
  }
  return {
    now,
    treasury: v.treasury,
    taxRate: v.taxRate,
    priority: v.priority,
    mayor: v.mayor ? { name: v.mayor.name, since: v.mayor.since, election: v.mayor.election } : null,
    election: {
      n: e.n,
      phase: e.phase,
      start: e.start,
      voteAt: e.voteAt,
      end: e.end,
      voters: Object.keys(e.votes).length,
      candidates: e.candidates.map((c) => ({
        name: c.name,
        at: c.at,
        votes: e.tally[c.id] ?? 0,
        platform: c.platform,
        lang: c.lang,
        active: s.agents.get(c.id)?.status === 'active',
      })),
    },
    lastElection: v.history[v.history.length - 1] ?? null,
    projects,
    buildings,
    honoree: v.honoree ? { name: v.honoree.name, sprite: v.honoree.sprite, value: v.honoree.value, at: v.honoree.at } : null,
  };
}

// ── Observation ──────────────────────────────────────────────────────────────

export type CivicSeen = {
  /** The project of this site: progress 0..1, or done. */
  project?: { id: string; progress: number; done?: true };
  /** At the town hall: the projects open to contributions. */
  projects?: { id: string; progress: number }[];
  actions: ActionName[];
};

const round2 = (x: number) => Math.floor(x * 100) / 100;

/** The civic part of what an agent sees where it stands, and the civic actions that make sense there. */
export function civicSeen(s: WorldState, a: AgentState): CivicSeen {
  const c = s.content;
  const out: CivicSeen = { actions: [] };
  const flags = c.rooms.get(a.room)!.flags;
  const site = projectAt(c, a.room);
  const townHall = flags.includes('town_hall');
  let canGive = false;
  if (site) {
    const status = projectStatus(s, site);
    out.project = status === 'done' ? { id: site.id, progress: 1, done: true } : { id: site.id, progress: round2(progressOf(s, site)) };
    canGive = status === 'available';
  }
  if (townHall) {
    out.projects = [];
    for (const p of c.projects.values()) if (projectStatus(s, p) === 'available') out.projects.push({ id: p.id, progress: round2(progressOf(s, p)) });
    canGive ||= out.projects.length > 0;
  }
  if (canGive) out.actions.push('contribute');
  const e = s.village.election;
  if (townHall && a.claimed && a.level >= BALANCE.election.runLevel && !e.candidates.some((x) => x.id === a.id)) out.actions.push('run_for_mayor');
  if (e.phase === 'voting' && a.claimed && a.level >= BALANCE.election.voteLevel && !e.votes[a.id] && e.candidates.some((x) => x.id !== a.id)) out.actions.push('vote');
  if (townHall && isMayor(s, a)) out.actions.push('mayor_priority', 'mayor_tax', 'mayor_fund', 'mayor_embezzle');
  if (flags.includes('plot') && !site && !s.village.halls[a.room]) {
    const g = guildOf(s, a);
    if (g && g.leader === a.id && hallOf(s, g.id) === undefined) out.actions.push('guild_build_hall');
  }
  return out;
}
