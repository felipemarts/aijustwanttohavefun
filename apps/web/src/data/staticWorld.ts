/**
 * Static world content the map needs besides what `WorldFull.rooms` carries: which monsters and NPCs stand in each
 * room, monster kinds, project sites. Built at build time from `packages/content/data/*.yaml` (see the
 * `ajwf-content` plugin in vite.config.ts) so nothing is duplicated by hand. Pure: no I/O here.
 */
import type { RoomInfo } from '@ajwf/shared';

export type StaticRoomMonster = { id: string; n: number; night?: boolean };

export type StaticRoom = RoomInfo & {
  level?: number;
  monsters: StaticRoomMonster[];
  npcs: string[];
  stations?: string[];
  /** Exits that need a project, puzzle or dead boss (party gates are left out: they are walkable). */
  gates?: string[];
};

export type StaticMonster = {
  id: string;
  level: number;
  boss?: boolean;
  elite?: boolean;
  worldBoss?: boolean;
  respawnSec: number;
};

export type StaticProject = { id: string; site: string; building: string };

export type StaticWorld = {
  rooms: StaticRoom[];
  monsters: Record<string, StaticMonster>;
  projects: StaticProject[];
  zones: Record<string, { law: string }>;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function buildStaticWorld(files: {
  rooms?: unknown;
  monsters?: unknown;
  npcs?: unknown;
  projects?: unknown;
  zones?: unknown;
}): StaticWorld {
  const npcsByRoom = new Map<string, string[]>();
  for (const n of arr(files.npcs)) {
    if (!isObj(n)) continue;
    const room = str(n.room);
    const list = npcsByRoom.get(room) ?? [];
    list.push(str(n.id));
    npcsByRoom.set(room, list);
  }
  const projects: StaticProject[] = arr(files.projects)
    .filter(isObj)
    .map((p) => ({ id: str(p.id), site: str(p.site), building: str(p.building) }));

  const rooms: StaticRoom[] = [];
  for (const r of arr(files.rooms)) {
    if (!isObj(r)) continue;
    const rect = arr(r.rect).map((x) => num(x));
    if (rect.length !== 4) continue;
    const flags = arr(r.flags).map((f) => str(f));
    const exits: Record<string, string> = {};
    if (isObj(r.exits)) for (const [d, to] of Object.entries(r.exits)) exits[d] = str(to);
    const id = str(r.id);
    rooms.push({
      id,
      zone: str(r.zone),
      rect: [rect[0]!, rect[1]!, rect[2]!, rect[3]!],
      flags,
      exits,
      plot: flags.includes('plot'),
      building: null,
      ...(typeof r.level === 'number' ? { level: r.level } : {}),
      monsters: arr(r.monsters)
        .filter(isObj)
        .map((m) => ({ id: str(m.id), n: num(m.count, 1), ...(m.night === true ? { night: true } : {}) })),
      npcs: npcsByRoom.get(id) ?? [],
      ...(Array.isArray(r.stations) ? { stations: r.stations.map((s) => str(s)) } : {}),
      ...(isObj(r.gates)
        ? {
            gates: Object.entries(r.gates)
              .filter(([, g]) => !isObj(g) || g.requires !== 'party')
              .map(([d]) => d),
          }
        : {}),
    });
  }

  const monsters: Record<string, StaticMonster> = {};
  for (const m of arr(files.monsters)) {
    if (!isObj(m)) continue;
    const id = str(m.id);
    monsters[id] = {
      id,
      level: num(m.level, 1),
      respawnSec: num(m.respawn_sec, 120),
      ...(m.boss === true ? { boss: true } : {}),
      ...(m.elite === true ? { elite: true } : {}),
      ...(m.world_boss === true ? { worldBoss: true } : {}),
    };
  }

  const zones: Record<string, { law: string }> = {};
  for (const z of arr(files.zones)) if (isObj(z)) zones[str(z.id)] = { law: str(z.law, 'safe') };

  return { rooms, monsters, projects, zones };
}

/** Flattens `{ a: { b: 'x' } }` into `{ 'a.b': 'x' }` (strings only). */
export function flattenStrings(
  obj: unknown,
  prefix: string,
  out: Record<string, string>,
): Record<string, string> {
  if (isObj(obj))
    for (const [k, v] of Object.entries(obj)) flattenStrings(v, prefix ? `${prefix}.${k}` : k, out);
  else if (typeof obj === 'string') out[prefix] = obj;
  return out;
}

/** Content translations are `{ <id>: { name, desc } }` per kind; ids contain dots and stay one key segment. */
export function flattenContent(
  kind: string,
  doc: unknown,
  out: Record<string, string>,
): Record<string, string> {
  if (!isObj(doc)) return out;
  for (const [id, fields] of Object.entries(doc)) flattenStrings(fields, `content.${kind}.${id}`, out);
  return out;
}
