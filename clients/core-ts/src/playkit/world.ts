/** The world map (README 5.3; Go: `world.go`). */
import { arr, get, members, text, type JV } from './jv.ts';
import type { Kit } from './kit.ts';
import { str } from './read.ts';
import type { World } from './types.ts';

/** README 5.3: an observation's room joins the world map. */
export function observe(kit: Kit, w: World, obsv: JV): void {
  const room = get(obsv, 'room');
  const id = str(room, 'id');
  if (id === '') return;
  if (w.rooms.has(id) || w.rooms.size < kit.lim('worldRooms')) {
    w.rooms.set(
      id,
      members(get(room, 'exits')).map(([k, v]) => [k, text(v)]),
    );
  }
  for (const n of arr(get(room, 'npcs'))) {
    const x = str(n, 'id');
    if (x !== '') w.npcs.set(x, id);
  }
  for (const m of arr(get(room, 'monsters'))) {
    const x = str(m, 'id');
    if (x !== '') w.monsters.set(x, id);
  }
}

/** The shortest route through the rooms seen, as directions; [] when unknown or when from = to. */
export function worldPath(w: World, from: string, to: string): string[] {
  if (from === to) return [];
  const seen = new Set([from]);
  const queue: { room: string; dirs: string[] }[] = [{ room: from, dirs: [] }];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const [dir, room] of w.rooms.get(cur.room) ?? []) {
      if (seen.has(room)) continue;
      const dirs = [...cur.dirs, dir];
      if (room === to) return dirs;
      seen.add(room);
      queue.push({ room, dirs });
    }
  }
  return [];
}
