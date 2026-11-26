/**
 * Test helpers for the civic systems (projects, elections, guild halls). Used by the engine's own tests only; not
 * exported from the package.
 */
import type { ClassId } from '@ajwf/shared';
import { BALANCE } from './balance';
import { HOUR, type Kit } from './testkit';
import type { AgentState } from './types';

export const TOWN_HALL = 'village.town_hall';
export const DAY = 24 * HOUR;

let builders = 0;

/** Gives an agent exactly what a project still needs, at the town hall, and has it contribute everything. */
export function build(k: Kit, project: string, who?: AgentState): AgentState {
  const p = k.c.projects.get(project)!;
  const a = who ?? k.add(`Builder${builders++}`, 'warrior', { room: TOWN_HALL, level: 5 });
  if (a.room !== TOWN_HALL) k.place(a, TOWN_HALL);
  const st = k.s.village.projects[project];
  const gold = p.cost.gold - (st?.gold ?? 0);
  const items: Record<string, number> = {};
  for (const x of p.cost.items) {
    const n = x.qty - (st?.items[x.item] ?? 0);
    if (n > 0) items[x.item] = n;
  }
  a.gold += gold;
  for (const [id, n] of Object.entries(items)) a.inv[id] = (a.inv[id] ?? 0) + n;
  k.ok(a, 'contribute', { project, ...(gold > 0 ? { gold } : {}), items });
  return a;
}

/** Moves the clock to `at` (if later), running every due timer. */
export function advanceTo(k: Kit, at: number): void {
  if (at > k.now) k.advance(at - k.now);
}

/** A claimed agent of the given level, in the town hall by default. */
export function citizen(k: Kit, name: string, level: number, opts: { cls?: ClassId; claimed?: boolean; room?: string } = {}): AgentState {
  return k.add(name, opts.cls ?? 'warrior', { level, room: opts.room ?? TOWN_HALL, claimed: opts.claimed ?? true });
}

let voters = 0;

/** Plays a whole election through the timers so that `a` becomes mayor (one extra voter is created). */
export function elect(k: Kit, a: AgentState): void {
  const e = k.s.village.election;
  if (!e.candidates.some((c) => c.id === a.id)) k.ok(a, 'run_for_mayor', { platform: 'Bridges for all.' });
  advanceTo(k, k.s.village.election.voteAt);
  const v = citizen(k, `Voter${voters++}`, BALANCE.election.voteLevel);
  k.ok(v, 'vote', { candidate: a.name });
  advanceTo(k, k.s.village.election.end);
}
