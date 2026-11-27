import { hasOwnKey, own } from '@ajwf/shared';
import type { Content } from '@ajwf/content';
import { BALANCE } from './balance';
import { gateBlocker } from './gates';
import type { Run } from './run';
import type { AgentState } from './types';

/** from -> to -> directions. Content is immutable, so a route computed once stays right for the process lifetime. */
const cache = new WeakMap<Content, Map<string, string[] | null>>();

/** Whether a gated exit (`dir` out of `room`) may be walked: all of them, none, or a per-exit check. */
type GatePolicy = boolean | ((room: string, dir: string) => boolean);

function bfs(c: Content, from: string, to: string, throughGates: GatePolicy): string[] | null {
  const prev = new Map<string, { room: string; dir: string } | null>([[from, null]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    if (cur === to) {
      const dirs: string[] = [];
      for (let step = prev.get(cur); step; step = prev.get(step.room)) dirs.push(step.dir);
      return dirs.reverse();
    }
    const room = c.rooms.get(cur);
    if (!room) continue;
    for (const [dir, next] of Object.entries(room.exits)) {
      if (prev.has(next) || !c.rooms.has(next)) continue;
      if (hasOwnKey(room.gates, dir) && !(typeof throughGates === 'function' ? throughGates(cur, dir) : throughGates)) continue;
      prev.set(next, { room: cur, dir });
      queue.push(next);
    }
  }
  return null;
}

/**
 * Shortest walk between two rooms, as the list of directions to pass to `move`. Prefers routes without gated exits
 * and falls back to one through gates. Empty when already there, null when there is no way at all.
 */
export function route(c: Content, from: string, to: string): string[] | null {
  if (from === to) return [];
  let byPair = cache.get(c);
  if (!byPair) cache.set(c, (byPair = new Map()));
  const key = `${from}>${to}`;
  let path = byPair.get(key);
  if (path === undefined) {
    path = bfs(c, from, to, false) ?? bfs(c, from, to, true);
    byPair.set(key, path);
  }
  return path;
}

/** The first directions of a route, capped for hints. Undefined when already there or when there is no way. */
export function routeHint(c: Content, from: string, to: string): string[] | undefined {
  const path = route(c, from, to);
  return path && path.length ? path.slice(0, BALANCE.routes.hintMax) : undefined;
}

/** Whether a gated exit lets this agent through right now, judged as if it stood in the gate's room. */
function gateOpenFor(run: Run, a: AgentState, room: string, dir: string): boolean {
  const gate = own(run.c.rooms.get(room)?.gates, dir);
  if (!gate) return true;
  // A read-only stand-in at the gate: the checks read the room, the party and the class, and change nothing.
  return gateBlocker(run, room === a.room ? a : { ...a, room }, gate) === null;
}

/**
 * The walk an agent can take right now to a room, for hints: the shortest route, provided every gate on it lets
 * this agent through; otherwise the shortest one through open gates only. `closed` when no open way exists (a
 * gate holds every route), `path: []` when already there. Routes without gates come from the cache; only routes
 * that cross a gate are checked against the live state.
 */
export function walkFor(run: Run, a: AgentState, to: string): { path: string[] } | { closed: true } {
  const c = run.c;
  const best = route(c, a.room, to);
  if (best === null) return { closed: true };
  let cur = a.room;
  let open = true;
  for (const dir of best) {
    if (!gateOpenFor(run, a, cur, dir)) {
      open = false;
      break;
    }
    cur = own(c.rooms.get(cur)!.exits, dir)!;
  }
  if (open) return { path: best };
  const around = bfs(c, a.room, to, (room, dir) => gateOpenFor(run, a, room, dir));
  return around ? { path: around } : { closed: true };
}
