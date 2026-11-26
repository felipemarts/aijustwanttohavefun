import type { Content } from '@ajwf/content';
import { BALANCE } from './balance';

/** from -> to -> directions. Content is immutable, so a route computed once stays right for the process lifetime. */
const cache = new WeakMap<Content, Map<string, string[] | null>>();

function bfs(c: Content, from: string, to: string, throughGates: boolean): string[] | null {
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
      if (!throughGates && room.gates[dir]) continue;
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
