/** World geometry in pixels: rooms, floors, stable spots, walking routes. Pure functions. */
import type { RoomInfo } from '@ajwf/shared';
import { hash32 } from '../util/rng';

export const TILE = 16;

export type Rect = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };

export function roomPx(room: Pick<RoomInfo, 'rect'>): Rect {
  const [x, y, w, h] = room.rect;
  return { x: x * TILE, y: y * TILE, w: w * TILE, h: h * TILE };
}

export function center(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * Where characters stand: the lower part of the room, in front of the buildings and props that line its top edge.
 * Coordinates are the feet of the character.
 */
export function floorOf(r: Rect): Rect {
  const top = r.y + Math.round(r.h * 0.46);
  return { x: r.x + 14, y: top, w: r.w - 28, h: r.y + r.h - 6 - top };
}

/** A stable spot for an agent in a room, seeded by name: the same agent always stands in the same place. */
export function agentSpot(room: Pick<RoomInfo, 'rect' | 'id'>, name: string): Pt {
  const f = floorOf(roomPx(room));
  const h = hash32(name, 17);
  const u = (h & 0xffff) / 0x10000;
  const v = (h >>> 16) / 0x10000;
  return { x: Math.round(f.x + u * f.w), y: Math.round(f.y + v * f.h) };
}

/** Spot of the i-th monster of a kind; monsters keep to the far side of the floor from the path cross. */
export function monsterSpot(room: Pick<RoomInfo, 'rect' | 'id'>, kind: string, i: number): Pt {
  const f = floorOf(roomPx(room));
  const h = hash32(`${room.id}/${kind}/${i}`, 5);
  const u = (h & 0xffff) / 0x10000;
  const v = (h >>> 16) / 0x10000;
  // keep them off the vertical centre line where paths run
  const side = u < 0.5 ? u * 0.8 : 0.6 + (u - 0.5) * 0.8;
  return { x: Math.round(f.x + side * f.w), y: Math.round(f.y + 6 + v * (f.h - 6)) };
}

/** NPCs stand by the door of their building, a little off the path. */
export function npcSpot(room: Pick<RoomInfo, 'rect' | 'id'>, i: number): Pt {
  const r = roomPx(room);
  return { x: Math.round(r.x + r.w / 2 + 26 + i * 18), y: Math.round(r.y + r.h * 0.5 + 4) };
}

const DIRS: Record<string, Pt> = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
};

/** Middle of the room edge an exit leaves through (where the path meets the room). */
export function exitPoint(r: Rect, dir: string): Pt {
  const c = center(r);
  const d = DIRS[dir];
  if (!d) return c;
  return { x: c.x + (d.x * r.w) / 2, y: c.y + (d.y * r.h) / 2 + (d.x !== 0 ? 0 : 0) };
}

/** Direction of `b` seen from `a` when they are grid neighbours (adjacent cells), else null. */
export function neighbourDir(a: Rect, b: Rect): string | null {
  const ca = center(a);
  const cb = center(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  if (Math.abs(dy) < 1 && Math.abs(dx) <= a.w + 4 * TILE) return dx > 0 ? 'east' : 'west';
  if (Math.abs(dx) < 1 && Math.abs(dy) <= a.h + 4 * TILE) return dy > 0 ? 'south' : 'north';
  return null;
}

/**
 * Waypoints of a walk from `from` (in room a) to `to` (in room b): out through a's exit, along the path, in through
 * b's entrance. Non-neighbour rooms return null (the agent teleports: respawn, admin moves).
 */
export function walkRoute(a: Rect, b: Rect, from: Pt, to: Pt): Pt[] | null {
  const dir = neighbourDir(a, b);
  if (!dir) return null;
  const out = exitPoint(a, dir);
  const back = { north: 'south', south: 'north', east: 'west', west: 'east' }[dir]!;
  const inn = exitPoint(b, back);
  // Feet walk on the path's centre line; nudge the edge points into the path band.
  return [from, out, inn, to];
}

export function routeLength(points: Pt[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++)
    len += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return len;
}

/** Point at distance `d` along a polyline. */
export function pointAlong(points: Pt[], d: number, out: Pt = { x: 0, y: 0 }): Pt {
  let left = Math.max(0, d);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= seg || i === points.length - 1) {
      const f = seg > 0 ? Math.min(1, left / seg) : 1;
      out.x = a.x + (b.x - a.x) * f;
      out.y = a.y + (b.y - a.y) * f;
      return out;
    }
    left -= seg;
  }
  const last = points[points.length - 1] ?? { x: 0, y: 0 };
  out.x = last.x;
  out.y = last.y;
  return out;
}

/** Bounds of all rooms in pixels, padded. */
export function worldBounds(rooms: Iterable<Pick<RoomInfo, 'rect'>>, padTiles = 6): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rooms) {
    const [x, y, w, h] = r.rect;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 64 * TILE, h: 48 * TILE };
  return {
    x: (x0 - padTiles) * TILE,
    y: (y0 - padTiles) * TILE,
    w: (x1 - x0 + padTiles * 2) * TILE,
    h: (y1 - y0 + padTiles * 2) * TILE,
  };
}

/** The room under a world point, if any (rooms plus half their gap, so clicks on paths still select something). */
export function roomAt(rooms: Iterable<RoomInfo>, p: Pt): RoomInfo | null {
  for (const room of rooms) {
    const r = roomPx(room);
    if (p.x >= r.x - TILE && p.x < r.x + r.w + TILE && p.y >= r.y - TILE && p.y < r.y + r.h + TILE)
      return room;
  }
  return null;
}
