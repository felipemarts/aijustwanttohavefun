/**
 * Explorer: walks to every room it has not seen yet (where it is safe for its level), gathers what grows there and
 * sells the haul in the village. It fights now and then to keep up, alone.
 */
import { BALANCE } from '@ajwf/engine';
import {
  absorbLast,
  cmd,
  hunt,
  inVillage,
  keepSupplied,
  nearest,
  preyFor,
  questKeep,
  quests,
  sellJunk,
  survive,
  travel,
  keepGoing,
} from './common';
import type { AgentView, DecideCtx, Profile } from './types';

function visited(x: DecideCtx): Set<string> {
  let s = x.mem.ext.visited as Set<string> | undefined;
  if (!s) x.mem.ext.visited = s = new Set();
  return s;
}

/** Gathers the most valuable resource in this room, if any is left. */
function gatherHere(v: AgentView, x: DecideCtx): ReturnType<Profile['decide']> | null {
  const res = Object.entries(v.obs.room.resources ?? {}).filter(([, n]) => n > 0);
  if (!res.length) return null;
  if (v.obs.you.ap[0] < 2) return { wait: BALANCE.ap.regenMs };
  res.sort((a, b) => (x.c.items.get(b[0])?.value ?? 0) - (x.c.items.get(a[0])?.value ?? 0));
  return cmd('gather', { resource: res[0]![0] });
}

function explore(v: AgentView, x: DecideCtx): ReturnType<Profile['decide']> | null {
  const seen = visited(x);
  seen.add(v.obs.room.id);
  const lvl = v.obs.you.lvl;
  const fresh = [...x.c.rooms.values()].filter((r) => !seen.has(r.id) && !r.flags.includes('lawless') && !r.flags.includes('dungeon') && (r.level ?? 0) <= lvl + 1).map((r) => r.id);
  const to = nearest(v, x, fresh);
  if (to) return travel(v, x, to);
  // Everything seen: make the rounds of the rooms with resources.
  const rich = [...x.c.rooms.values()].filter((r) => r.resources.length && !r.flags.includes('lawless') && (r.level ?? 0) <= lvl + 1 && r.id !== v.obs.room.id).map((r) => r.id);
  const pick = nearest(v, x, rich);
  return pick ? travel(v, x, pick) : null;
}

export const explorer: Profile = {
  id: 'explorer',
  grouped: false,
  decide(v, x) {
    absorbLast(v, x);
    const s = survive(v, x, false) ?? keepGoing(v, x) ?? keepSupplied(v, x) ?? sellJunk(v, x, questKeep(v));
    if (s) return s;
    const g = gatherHere(v, x);
    if (g) return g;
    // A room just emptied: leave it alone for a while.
    if (v.obs.room.resources) x.mem.avoid.set(v.obs.room.id, v.now + 15 * 60_000);
    if (!inVillage(v) && x.rng.chance(0.35)) {
      const h = hunt(v, x, preyFor(x.c, v.obs.you.lvl, false));
      if (h && 'action' in h && h.action !== 'move') return h;
    }
    return quests(v, x, { social: false, grouped: false }) ?? explore(v, x) ?? hunt(v, x, preyFor(x.c, v.obs.you.lvl, false)) ?? { wait: 20_000 };
  },
};
