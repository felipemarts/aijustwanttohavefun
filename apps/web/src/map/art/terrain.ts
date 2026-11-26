/**
 * Classifies every 16 px tile of the global map: room floors by zone, wild land between rooms by the nearest zone,
 * paths through the 2-tile gaps along the exits, the river and its lake. Pure data; painting happens in bake.ts.
 */
import type { RoomInfo } from '@ajwf/shared';

export const T = {
  VOID: 0,
  GRASS: 1,
  COBBLE: 2,
  DIRT: 3,
  FOREST: 4,
  DRY: 5,
  CAVE: 6,
  ROCK: 7,
  MUD: 8,
  MURK: 9,
  PLANK_H: 10,
  PLANK_V: 11,
  FLAG: 12,
  SAND: 13,
  BRICK: 14,
  DWALL: 15,
  WATER: 16,
  STAIRS: 17,
  GLADE: 18,
} as const;

export const ZONES = ['village', 'forest', 'hills', 'mines', 'swamp', 'ruins', 'dungeon'] as const;

export type TerrainGrid = {
  /** Tile coordinates of the grid's top-left corner. */
  x0: number;
  y0: number;
  w: number;
  h: number;
  t: Uint8Array;
  /** Zone index (ZONES) of the room containing the tile, or of the nearest room. */
  zone: Uint8Array;
  /** Index into `rooms` of the room containing the tile, -1 outside rooms. */
  room: Int16Array;
  /** Distance in tiles to the nearest room (0 inside). */
  dist: Uint8Array;
  /** 1 where a path or the river runs. */
  path: Uint8Array;
  rooms: RoomInfo[];
  /** River/lake info for the bridge site, if the world has one. */
  bridge: { x: number; y: number; w: number; h: number } | null;
};

const zoneIndex = (z: string) => Math.max(0, (ZONES as readonly string[]).indexOf(z));

const FLOOR: Record<string, number> = {
  village: T.GRASS,
  forest: T.GLADE,
  hills: T.DRY,
  mines: T.CAVE,
  swamp: T.MUD,
  ruins: T.FLAG,
  dungeon: T.BRICK,
};

const WILD: Record<string, number> = {
  village: T.GRASS,
  forest: T.FOREST,
  hills: T.DRY,
  mines: T.ROCK,
  swamp: T.MURK,
  ruins: T.SAND,
  dungeon: T.DWALL,
};

export type TerrainOptions = {
  /** Exits that are gated by a project (no path is drawn through the gap): `roomId:dir`. */
  gated?: ReadonlySet<string>;
  /** The bridge site room id and the direction the bridge spans. */
  bridgeSite?: { room: string; dir: string } | null;
  padTiles?: number;
};

export function buildTerrain(rooms: RoomInfo[], opts: TerrainOptions = {}): TerrainGrid {
  const pad = opts.padTiles ?? 6;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rooms) {
    minX = Math.min(minX, r.rect[0]);
    minY = Math.min(minY, r.rect[1]);
    maxX = Math.max(maxX, r.rect[0] + r.rect[2]);
    maxY = Math.max(maxY, r.rect[1] + r.rect[3]);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 40;
    maxY = 30;
  }
  const x0 = minX - pad;
  const y0 = minY - pad;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const n = w * h;
  const grid: TerrainGrid = {
    x0,
    y0,
    w,
    h,
    t: new Uint8Array(n),
    zone: new Uint8Array(n),
    room: new Int16Array(n).fill(-1),
    dist: new Uint8Array(n).fill(255),
    path: new Uint8Array(n),
    rooms,
    bridge: null,
  };
  const idx = (tx: number, ty: number) => (ty - y0) * w + (tx - x0);
  const inGrid = (tx: number, ty: number) => tx >= x0 && ty >= y0 && tx < x0 + w && ty < y0 + h;

  // 1. Nearest room for every tile (Chebyshev distance to its rectangle).
  for (let ty = y0; ty < y0 + h; ty++) {
    for (let tx = x0; tx < x0 + w; tx++) {
      let best = 255;
      let bestRoom = -1;
      for (let i = 0; i < rooms.length; i++) {
        const [rx, ry, rw, rh] = rooms[i]!.rect;
        const dx = tx < rx ? rx - tx : tx >= rx + rw ? tx - (rx + rw - 1) : 0;
        const dy = ty < ry ? ry - ty : ty >= ry + rh ? ty - (ry + rh - 1) : 0;
        const d = Math.max(dx, dy);
        if (d < best) {
          best = d;
          bestRoom = i;
        }
      }
      const k = idx(tx, ty);
      grid.dist[k] = Math.min(255, best);
      const room = rooms[bestRoom];
      grid.zone[k] = zoneIndex(room?.zone ?? 'village');
      if (best === 0) {
        grid.room[k] = bestRoom;
        grid.t[k] =
          room!.id === 'village.square' || room!.flags.includes('market')
            ? T.COBBLE
            : (FLOOR[room!.zone] ?? T.GRASS);
      } else {
        const zone = room?.zone ?? 'village';
        // far from the ruins the sand gives way to dry grass
        grid.t[k] = zone === 'ruins' && best > 2 ? T.DRY : (WILD[zone] ?? T.GRASS);
      }
    }
  }

  const set = (tx: number, ty: number, t: number, onlyOutside = false) => {
    if (!inGrid(tx, ty)) return;
    const k = idx(tx, ty);
    if (onlyOutside && grid.room[k]! >= 0) return;
    grid.t[k] = t;
    grid.path[k] = 1;
  };

  // 2. River and lake around the bridge site (drawn before the paths so the paths stay on land).
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const site = opts.bridgeSite ? byId.get(opts.bridgeSite.room) : undefined;
  if (site && opts.bridgeSite?.dir === 'north') {
    const [sx, sy, sw] = site.rect;
    const ry0 = sy - 2;
    const lakeCx = sx - 6.5;
    const lakeCy = sy - 6;
    for (let ty = y0; ty < y0 + h; ty++) {
      for (let tx = x0; tx < x0 + w; tx++) {
        const k = idx(tx, ty);
        if (grid.room[k]! >= 0) continue;
        const inRiver = ty >= ry0 && ty <= ry0 + 1 && tx >= lakeCx && tx < x0 + w;
        const ex = (tx + 0.5 - lakeCx) / 6.6;
        const ey = (ty + 0.5 - lakeCy) / 5.4;
        const inLake = ex * ex + ey * ey <= 1;
        if (inRiver || inLake) {
          grid.t[k] = T.WATER;
          grid.path[k] = 2;
        }
      }
    }
    grid.bridge = { x: sx + Math.floor(sw / 2) - 2, y: ry0, w: 4, h: 2 };
  }

  // 3. Paths along the exits, through the gaps and into each room's centre.
  const done = new Set<string>();
  for (const a of rooms) {
    for (const [dir, toId] of Object.entries(a.exits)) {
      const b = byId.get(toId);
      if (!b) continue;
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      const gated = opts.gated?.has(`${a.id}:${dir}`) ?? false;
      const [ax, ay, aw, ah] = a.rect;
      const [bx, by, bw, bh] = b.rect;
      const acx = ax + Math.floor(aw / 2);
      const acy = ay + Math.floor(ah / 2);
      // in-room spur from the centre to the edge of the exit
      paintSpur(a, dir, set);
      if (gated || done.has(key)) continue;
      done.add(key);
      const material = pathMaterial(a.zone, b.zone, dir);
      if (ay === by && ah === bh) {
        const left = ax < bx ? ax + aw : bx + bw;
        const right = ax < bx ? bx : ax;
        for (let tx = left; tx < right; tx++)
          for (const ty of [acy - 1, acy]) set(tx, ty, material === T.PLANK_V ? T.PLANK_H : material, true);
      } else if (ax === bx && aw === bw) {
        const top = ay < by ? ay + ah : by + bh;
        const bottom = ay < by ? by : ay;
        for (let ty = top; ty < bottom; ty++)
          for (const tx of [acx - 1, acx]) set(tx, ty, material === T.PLANK_H ? T.PLANK_V : material, true);
      } else {
        // Rooms that are not grid neighbours: an L-shaped path between centres.
        const bcx = bx + Math.floor(bw / 2);
        const bcy = by + Math.floor(bh / 2);
        for (let tx = Math.min(acx, bcx); tx <= Math.max(acx, bcx); tx++)
          set(tx, acy, material === T.PLANK_V ? T.PLANK_H : material, true);
        for (let ty = Math.min(acy, bcy); ty <= Math.max(acy, bcy); ty++)
          set(bcx, ty, material === T.PLANK_H ? T.PLANK_V : material, true);
      }
    }
  }
  return grid;

  function paintSpur(room: RoomInfo, dir: string, put: (tx: number, ty: number, t: number) => void) {
    const spur =
      room.zone === 'village' && room.id !== 'village.square' && !room.flags.includes('market')
        ? T.COBBLE
        : room.zone === 'forest' || room.zone === 'hills'
          ? T.DIRT
          : -1;
    if (spur < 0) return;
    const [rx, ry, rw, rh] = room.rect;
    const cx = rx + Math.floor(rw / 2);
    const cy = ry + Math.floor(rh / 2);
    if (dir === 'east')
      for (let tx = cx - 1; tx < rx + rw; tx++) for (const ty of [cy - 1, cy]) put(tx, ty, spur);
    if (dir === 'west') for (let tx = rx; tx <= cx; tx++) for (const ty of [cy - 1, cy]) put(tx, ty, spur);
    if (dir === 'north') for (let ty = ry; ty <= cy; ty++) for (const tx of [cx - 1, cx]) put(tx, ty, spur);
    if (dir === 'south')
      for (let ty = cy - 1; ty < ry + rh; ty++) for (const tx of [cx - 1, cx]) put(tx, ty, spur);
  }
}

function pathMaterial(za: string, zb: string, dir: string): number {
  if (dir === 'up' || dir === 'down') return T.STAIRS;
  if (za === 'village' && zb === 'village') return T.COBBLE;
  if (za === 'swamp' || zb === 'swamp') return T.PLANK_H;
  if (za === 'mines' && zb === 'mines') return T.CAVE;
  if (za === 'dungeon' && zb === 'dungeon') return T.BRICK;
  if (za === 'ruins' && zb === 'ruins') return T.FLAG;
  return T.DIRT;
}

export function tileAt(g: TerrainGrid, tx: number, ty: number): number {
  if (tx < g.x0 || ty < g.y0 || tx >= g.x0 + g.w || ty >= g.y0 + g.h) return T.VOID;
  return g.t[(ty - g.y0) * g.w + (tx - g.x0)]!;
}
