/**
 * Bakes the whole static map once into a few large canvases: ground tiles with seeded noise, paths, water, wall
 * faces, then props and buildings sorted by depth. Also returns where the night lights, ore glints and ambient
 * creatures go, and the anchors of the construction sites. Deterministic: identical on every load.
 */
import type { RoomInfo } from '@ajwf/shared';
import { mix, PixelBuf, shade } from '../../util/pixels';
import { hash32, noise2, rng, smoothNoise } from '../../util/rng';
import { TILE } from '../geometry';
import type { StaticWorld } from '../../data/staticWorld';
import { OUTLINE, P, VOID } from './palette';
import * as A from './props';
import { buildTerrain, T, type TerrainGrid, ZONES } from './terrain';

export type WorldLight = { x: number; y: number; kind: A.LightKind; w?: number; h?: number };
export type Ambient = { x: number; y: number; kind: 'firefly' | 'wisp' };
export type Site = { x: number; y: number; w: number; h: number; plot: boolean };

export type Baked = {
  x: number;
  y: number;
  w: number;
  h: number;
  chunks: { canvas: HTMLCanvasElement; x: number; y: number }[];
  lights: WorldLight[];
  glints: { x: number; y: number; color: number }[];
  ambient: Ambient[];
  sites: Record<string, Site>;
  bridge: { x: number; y: number; w: number; h: number } | null;
  grid: TerrainGrid;
};

const SOFT = new Set<number>([T.GRASS, T.FOREST, T.DRY, T.MUD, T.SAND, T.GLADE]);
const WATERY = new Set<number>([T.WATER, T.MURK]);
const WALL = new Set<number>([T.ROCK, T.DWALL]);

type Stamp = { art: A.Art; x: number; y: number; shadow?: number };

export function bakeMap(rooms: RoomInfo[], world: StaticWorld | null, chunkSize = 1024): Baked {
  const gated = new Set<string>();
  for (const r of world?.rooms ?? []) for (const d of r.gates ?? []) gated.add(`${r.id}:${d}`);
  const bridgeProject = world?.projects.find((p) => p.building === 'bridge' || p.id === 'bridge');
  const bridgeRoom = bridgeProject ? rooms.find((r) => r.id === bridgeProject.site) : undefined;
  const bridgeDir = bridgeRoom
    ? (Object.keys(bridgeRoom.exits).find((d) => gated.has(`${bridgeRoom.id}:${d}`)) ?? null)
    : null;
  const grid = buildTerrain(rooms, {
    gated,
    bridgeSite: bridgeRoom && bridgeDir ? { room: bridgeRoom.id, dir: bridgeDir } : null,
  });

  const W = grid.w * TILE;
  const H = grid.h * TILE;
  const ox = grid.x0 * TILE;
  const oy = grid.y0 * TILE;
  const map = new PixelBuf(W, H);
  map.ox = -ox;
  map.oy = -oy;

  const tAt = (tx: number, ty: number) =>
    tx < grid.x0 || ty < grid.y0 || tx >= grid.x0 + grid.w || ty >= grid.y0 + grid.h
      ? T.VOID
      : grid.t[(ty - grid.y0) * grid.w + (tx - grid.x0)]!;
  const kAt = (tx: number, ty: number) => (ty - grid.y0) * grid.w + (tx - grid.x0);

  // ── 1. Ground tiles ──────────────────────────────────────────────────────────
  for (let ty = grid.y0; ty < grid.y0 + grid.h; ty++) {
    for (let tx = grid.x0; tx < grid.x0 + grid.w; tx++) {
      const t = tAt(tx, ty);
      paintTile(map, tx, ty, t);
    }
  }

  // ── 2. Edges: water banks, wall faces, soft path borders ──────────────────────
  for (let ty = grid.y0; ty < grid.y0 + grid.h; ty++) {
    for (let tx = grid.x0; tx < grid.x0 + grid.w; tx++) {
      const t = tAt(tx, ty);
      const up = tAt(tx, ty - 1);
      const down = tAt(tx, ty + 1);
      const left = tAt(tx - 1, ty);
      const right = tAt(tx + 1, ty);
      const px = tx * TILE;
      const py = ty * TILE;
      if (WATERY.has(t)) {
        const water = t === T.WATER;
        const foam = water ? P.foam : P.murkLight;
        const bank = water ? P.bank : P.mudDark;
        if (!WATERY.has(up) && up !== T.VOID && up !== T.PLANK_V) {
          map.rect(px, py, px + 15, py, bank);
          map.rect(px, py + 1, px + 15, py + 1, (x) => (noise2(x, py, 4) < 0.6 ? foam : -1));
        }
        if (!WATERY.has(left) && left !== T.VOID && left !== T.PLANK_H)
          map.rect(px, py, px, py + 15, (_x, y) => (noise2(px, y, 5) < 0.5 ? foam : -1));
        if (!WATERY.has(right) && right !== T.VOID && right !== T.PLANK_H)
          map.rect(px + 15, py, px + 15, py + 15, (_x, y) => (noise2(px + 15, y, 5) < 0.5 ? foam : -1));
        if (!WATERY.has(down) && down !== T.VOID && down !== T.PLANK_V)
          map.rect(px, py + 15, px + 15, py + 15, shade(water ? P.waterDark : P.murkDark, 0.9));
      } else if (WALL.has(t) && !WALL.has(down) && down !== T.VOID) {
        // wall face toward the walkable tile below
        const face = t === T.ROCK ? P.rockMid : P.dwallLight;
        map.rect(px, py + 9, px + 15, py + 15, (x, y) =>
          y === py + 9 ? shade(face, 1.25) : (x + Math.floor(y / 3)) % 5 === 0 ? shade(face, 0.8) : face,
        );
      } else if (!WALL.has(t) && WALL.has(up)) {
        map.rect(px, py, px + 15, py + 2, (x, y) => shade(colorUnder(map, x, y), y === py ? 0.6 : 0.78));
      }
      if (!SOFT.has(t) && t !== T.VOID && !WALL.has(t) && !WATERY.has(t)) {
        // roughen hard tiles (paths, flagstones) where they meet soft ground
        for (const [n, dx, dy] of [
          [up, 0, -1],
          [down, 0, 1],
          [left, -1, 0],
          [right, 1, 0],
        ] as const) {
          if (!SOFT.has(n)) continue;
          const soft = tileBase(n);
          for (let i = 0; i < 16; i++) {
            for (let depth = 0; depth < 2; depth++) {
              const x = dx === 0 ? px + i : dx < 0 ? px + depth : px + 15 - depth;
              const y = dy === 0 ? py + i : dy < 0 ? py + depth : py + 15 - depth;
              if (noise2(x, y, 11) < (depth === 0 ? 0.55 : 0.2))
                map.px(x, y, noise2(x, y, 12) < 0.2 ? shade(soft, 0.85) : soft);
            }
          }
        }
      }
    }
  }

  // ── 3. Props ─────────────────────────────────────────────────────────────────
  const stamps: Stamp[] = [];
  const lights: WorldLight[] = [];
  const glints: Baked['glints'] = [];
  const ambient: Ambient[] = [];
  const sites: Record<string, Site> = {};
  const put = (art: A.Art, x: number, y: number, shadow = 0) =>
    stamps.push({ art, x: Math.round(x), y: Math.round(y), shadow });
  const isPath = (px: number, py: number) => {
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    if (tx < grid.x0 || ty < grid.y0 || tx >= grid.x0 + grid.w || ty >= grid.y0 + grid.h) return true;
    return grid.path[kAt(tx, ty)]! > 0;
  };
  const near = (px: number, py: number, r: number, pred: (t: number, k: number) => boolean) => {
    for (let dy = -r; dy <= r; dy += 8)
      for (let dx = -r; dx <= r; dx += 8) {
        const tx = Math.floor((px + dx) / TILE);
        const ty = Math.floor((py + dy) / TILE);
        if (tx < grid.x0 || ty < grid.y0 || tx >= grid.x0 + grid.w || ty >= grid.y0 + grid.h) continue;
        const k = kAt(tx, ty);
        if (pred(grid.t[k]!, k)) return true;
      }
    return false;
  };

  // Wild scatter on a jittered grid.
  const STEP = 18;
  for (let wy = oy; wy < oy + H; wy += STEP) {
    for (let wx = ox; wx < ox + W; wx += STEP) {
      const h = hash32(`${wx},${wy}`, 3);
      const r = rng(h);
      const x = wx + Math.floor(r() * STEP);
      const y = wy + Math.floor(r() * STEP);
      const tx = Math.floor(x / TILE);
      const ty = Math.floor(y / TILE);
      if (tx < grid.x0 || ty < grid.y0 || tx >= grid.x0 + grid.w || ty >= grid.y0 + grid.h) continue;
      const k = kAt(tx, ty);
      const t = grid.t[k]!;
      const zone = ZONES[grid.zone[k]!];
      const dist = grid.dist[k]!;
      if (grid.room[k]! >= 0 || grid.path[k]! > 0) continue;
      if (near(x, y, 8, (_t, kk) => grid.path[kk]! > 0)) continue;
      const roll = r();
      // tall props must not spill their canopy over a room's floor
      const roomAbove = near(x, y - 20, 8, (_t, kk) => grid.room[kk]! >= 0);
      if (zone === 'forest' && t === T.FOREST) {
        if (roll < 0.62 && !roomAbove) put(A.tree(h, r() < 0.2 ? 'dark' : 'forest', false), x, y, 18);
        else if (roll < 0.75) put(A.bush(h), x, y);
        else if (roll < 0.8) put(A.mushrooms(h), x, y);
      } else if (zone === 'village' && t === T.GRASS) {
        if (dist >= 2 && roll < 0.16 && !roomAbove) put(A.tree(h, 'village', false), x, y, 16);
        else if (dist >= 1 && roll < 0.05) put(A.bush(h, 0x5f9a52), x, y);
        else if (roll < 0.1) A.flowers(map, x, y, h);
      } else if (zone === 'hills' && t === T.DRY) {
        if (roll < 0.14) put(A.boulder(h, r() * 1.5), x, y, 8);
        else if (roll < 0.22) put(A.bush(h, 0x8a9a46), x, y);
        else if (roll < 0.25 && dist >= 2) put(A.tree(h, 'village', false), x, y, 16);
      } else if (zone === 'swamp' && t === T.MURK) {
        if (roll < 0.05) put(A.deadTree(h), x, y, 10);
        else if (roll < 0.3 && near(x, y, 16, (tt) => !WATERY.has(tt))) put(A.reeds(h), x, y);
        else if (roll < 0.42) lily(map, x, y, h);
      } else if (zone === 'ruins' && (t === T.SAND || t === T.DRY)) {
        if (t === T.SAND && roll < 0.025) put(A.column(h), x, y, 6);
        else if (t === T.SAND && roll < 0.1) put(A.rubble(h), x, y);
        else if (roll < 0.17) put(A.bush(h, 0x7a8a46), x, y);
        else if (t === T.DRY && roll < 0.2) put(A.boulder(h, r(), 'sand'), x, y, 8);
      } else if (zone === 'mines' && t === T.ROCK && dist <= 2) {
        if (roll < 0.22) ore(map, x, y, h, glints);
      }
    }
  }

  // Room dressing.
  for (const room of rooms) dressRoom(room);

  // Swamp mist: pale dithered veils over water and mud.
  for (let wy = oy; wy < oy + H; wy += 32)
    for (let wx = ox; wx < ox + W; wx += 32) {
      const tx = Math.floor(wx / TILE);
      const ty = Math.floor(wy / TILE);
      if (tx < grid.x0 || ty < grid.y0 || tx >= grid.x0 + grid.w || ty >= grid.y0 + grid.h) continue;
      if (ZONES[grid.zone[kAt(tx, ty)]!] !== 'swamp') continue;
      if (smoothNoise(wx, wy, 96, 21) < 0.5) continue;
      for (let y = wy; y < wy + 32; y++)
        for (let x = wx; x < wx + 32; x++)
          if ((x + y * 2) % 4 === 0 && smoothNoise(x, y, 40, 22) > 0.55) map.px(x, y, P.mist, 70);
    }

  // Depth sort and stamp.
  stamps.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const s of stamps) {
    if (s.shadow) shadowEllipse(map, s.x, s.y, s.shadow);
    map.blit(s.art.buf, 0, 0, s.art.buf.w, s.art.buf.h, s.x - s.art.ax, s.y - s.art.ay);
    for (const l of s.art.lights) lights.push({ ...l, x: s.x - s.art.ax + l.x, y: s.y - s.art.ay + l.y });
  }

  // ── 4. Cut into chunk canvases ───────────────────────────────────────────────
  const chunks: Baked['chunks'] = [];
  for (let cy = 0; cy < H; cy += chunkSize)
    for (let cx = 0; cx < W; cx += chunkSize) {
      const cw = Math.min(chunkSize, W - cx);
      const ch = Math.min(chunkSize, H - cy);
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      const ctx = c.getContext('2d');
      if (ctx) {
        const img = new ImageData(cw, ch);
        for (let y = 0; y < ch; y++)
          img.data.set(map.data.subarray(((cy + y) * W + cx) * 4, ((cy + y) * W + cx + cw) * 4), y * cw * 4);
        // opaque everywhere: fill holes with the void colour
        for (let i = 3; i < img.data.length; i += 4)
          if (img.data[i] === 0) {
            img.data[i - 3] = (VOID >> 16) & 255;
            img.data[i - 2] = (VOID >> 8) & 255;
            img.data[i - 1] = VOID & 255;
            img.data[i] = 255;
          }
        ctx.putImageData(img, 0, 0);
      }
      chunks.push({ canvas: c, x: ox + cx, y: oy + cy });
    }

  const bridge = grid.bridge
    ? { x: grid.bridge.x * TILE, y: grid.bridge.y * TILE, w: grid.bridge.w * TILE, h: grid.bridge.h * TILE }
    : null;
  return { x: ox, y: oy, w: W, h: H, chunks, lights, glints, ambient, sites, bridge, grid };

  // ── Room dressing ──────────────────────────────────────────────────────────
  function dressRoom(room: RoomInfo) {
    const [rtx, rty, rtw, rth] = room.rect;
    const rx = rtx * TILE;
    const ry = rty * TILE;
    const rw = rtw * TILE;
    const rh = rth * TILE;
    const cx = rx + rw / 2;
    const band = ry + Math.round(rh * 0.45); // props stand on this line, characters below it
    const north = 'north' in room.exits;
    const seed = hash32(room.id);
    const r = rng(seed);
    const L = rx + 34; // centre of the left block (left of the north path)
    const R = rx + rw - 34;
    const id = room.id;
    const plot = room.flags.includes('plot');
    const projectSite = world?.projects.find((p) => p.site === id);

    if (plot) sites[id] = { x: cx, y: band + 2, w: rw - 28, h: 58, plot: true };
    else if (projectSite) sites[id] = siteFor(projectSite.building, room, rx, ry, rw, rh, band);
    if (plot) {
      put(A.bush(seed, 0x5f9a52), rx + 8, ry + rh - 6);
      return;
    }

    switch (room.zone) {
      case 'village':
        return dressVillage();
      case 'forest':
        return dressForest();
      case 'hills':
        return dressHills();
      case 'mines':
        return dressMines();
      case 'swamp':
        return dressSwamp();
      case 'ruins':
        return dressRuins();
      case 'dungeon':
        return dressDungeon();
      default:
        return;
    }

    function dressVillage() {
      const left = (a: A.Art) => put(a, L, band, Math.min(60, a.buf.w));
      switch (id) {
        case 'village.square':
          put(A.fountain(), rx + 40, band + 2, 0);
          put(A.flowerBox(seed), R + 6, ry + 36);
          put(A.bench(), R + 12, band);
          put(A.lamp(), cx - 22, band);
          put(A.lamp(), cx + 22, band);
          A.flowers(map, rx + 4, ry + rh - 14, seed + 1);
          A.flowers(map, rx + rw - 16, ry + rh - 14, seed + 2);
          break;
        case 'village.tavern':
          left(
            A.compose(
              A.house({ w: 54, wallH: 26, roofH: 20, door: 'right', chimney: true }),
              A.hangingSign(P.amber),
              22,
              -14,
            ),
          );
          put(A.noticeBoard(), R - 6, band);
          put(A.barrel(), R + 18, band - 2);
          put(A.barrel(), R + 26, band + 2);
          break;
        case 'village.guild_hall':
          put(
            A.compose(
              A.compose(
                A.house({ w: 108, wallH: 28, roofH: 22, roof: 0x8e3b46, windows: 4, chimney: true }),
                A.banner(0xd9534f),
                -22,
                -8,
              ),
              A.banner(0x5b8def),
              22,
              -8,
            ),
            cx,
            band,
            100,
          );
          break;
        case 'village.temple':
          left(
            A.compose(
              A.house({
                w: 54,
                wallH: 26,
                roofH: 20,
                roof: 0x5b6b8a,
                wall: 0xd8d4dc,
                stone: true,
                windows: 2,
              }),
              A.bellTower(),
              0,
              -40,
            ),
          );
          put(A.lamp(), R - 16, band);
          A.flowers(map, R - 4, band - 14, seed, [P.flowerWhite, P.flowerBlue]);
          A.flowers(map, R + 8, band - 6, seed + 3, [P.flowerWhite, P.flowerYellow]);
          break;
        case 'village.town_hall':
          left(A.house({ w: 56, wallH: 28, roofH: 20, roof: P.roofDark, windows: 2, chimney: false }));
          put(A.banner(P.amber), R - 10, band - 10);
          put(A.banner(0x5b8def), R + 6, band - 10);
          put(A.bench(), R, band + 2);
          break;
        case 'village.smithy':
          left(
            A.house({
              w: 54,
              wallH: 24,
              roofH: 18,
              roof: 0x4d4a5a,
              wall: 0x7a6a5a,
              frame: 0x4a3a2a,
              windows: 1,
              door: 'left',
              chimney: true,
            }),
          );
          put(A.forge(), R - 6, band);
          put(A.anvil(), R + 20, band + 4);
          put(A.barrel(), rx + rw - 8, band - 6);
          break;
        case 'village.alchemist':
          left(
            A.compose(
              A.house({
                w: 52,
                wallH: 26,
                roofH: 20,
                roof: 0x7a4f8a,
                windows: 2,
                windowColor: 0x3e6b5a,
                chimney: true,
              }),
              A.hangingSign(0x7ad05a),
              -18,
              -14,
            ),
          );
          put(A.cauldron(), R - 4, band + 2);
          put(A.crate(), R + 22, band - 2);
          break;
        case 'village.tailor':
          left(
            A.compose(
              A.house({ w: 52, wallH: 26, roofH: 20, roof: 0x3f7f86, windows: 2 }),
              A.hangingSign(0xd08ac0),
              18,
              -14,
            ),
          );
          put(A.loom(), R, band + 2);
          break;
        case 'village.market':
          put(A.stall(seed, 0xd9534f), rx + 30, band + 2, 30);
          put(A.stall(seed + 1, 0x5b8def), cx, band + 2, 30);
          put(A.stall(seed + 2, 0xe8c35a), rx + rw - 30, band + 2, 30);
          put(A.crate(), rx + 56, band - 6);
          put(A.barrel(), rx + rw - 56, band - 4);
          break;
        case 'village.training_yard':
          put(A.weaponRack(), L - 6, band - 4);
          put(A.fence(40), L, band + 4);
          put(A.dummy(), R - 16, band);
          put(A.dummy(), R + 4, band + 2);
          put(A.dummy(), R + 22, band - 2);
          break;
        case 'village.north_road':
          put(A.cart(), rx + 36, band, 24);
          put(A.signpost(), cx + 26, band);
          put(A.fence(36), rx + rw - 26, band - 2);
          put(A.tree(seed, 'village'), rx + rw - 18, ry + 30, 16);
          break;
        case 'village.river_bank':
          put(A.woodpile(), L, band);
          put(A.reeds(seed), rx + 10, ry + 8);
          put(A.reeds(seed + 1), rx + rw - 12, ry + 6);
          put(A.crate(), R + 6, band - 2);
          put(A.rowboat(), rx + 30, ry - 6);
          break;
        case 'village.west_gate':
        case 'village.east_gate':
        case 'village.south_gate':
          dressGate();
          break;
        default:
          if (north) left(A.house({ w: 50, wallH: 24, roofH: 18, windows: 2, chimney: r() < 0.5 }));
          else put(A.house({ w: 70, wallH: 24, roofH: 18, windows: 3, chimney: true }), cx, band, 60);
      }
      // lamp posts at the room corners along the paths
      if (id !== 'village.square' && r() < 0.6) put(A.lamp(), rx + 6, ry + rh - 2);
    }

    function dressGate() {
      const pathTop = ry + rh / 2 - TILE - 2;
      const pathBottom = ry + rh / 2 + TILE + 2;
      if (id === 'village.west_gate' || id === 'village.east_gate') {
        const x = id === 'village.west_gate' ? rx + 4 : rx + rw - 4;
        put(A.palisade(pathTop - ry - 10, true), x, pathTop);
        put(A.palisade(ry + rh - pathBottom - 10, true), x, ry + rh);
        put(A.torch(), x + (id === 'village.west_gate' ? 8 : -8), pathTop + 2);
        put(A.torch(), x + (id === 'village.west_gate' ? 8 : -8), pathBottom + 12);
        const hutX = id === 'village.west_gate' ? L + 8 : R - 8;
        put(
          A.house({ w: 36, wallH: 20, roofH: 14, roof: P.roofDark, windows: 1, door: 'center' }),
          hutX,
          band,
          36,
        );
        put(A.haybale(), id === 'village.west_gate' ? R : L, band);
      } else {
        const y = ry + rh - 2;
        put(A.palisade(cx - TILE - rx - 6), rx + (cx - TILE - rx - 6) / 2, y);
        put(A.palisade(rx + rw - (cx + TILE) - 6), cx + TILE + 6 + (rx + rw - (cx + TILE) - 6) / 2, y);
        put(A.torch(), cx - TILE - 6, y - 4);
        put(A.torch(), cx + TILE + 6, y - 4);
        put(A.house({ w: 40, wallH: 20, roofH: 14, roof: P.roofDark, windows: 1 }), L, band, 40);
        put(A.weaponRack(), R, band);
      }
    }

    function topTrees(kind: 'forest' | 'dark' | 'village') {
      const xs = [rx + 12, rx + 36, rx + rw - 36, rx + rw - 12];
      if (!north) xs.push(cx - 10, cx + 12);
      for (const x of xs)
        put(
          A.tree(hash32(`${id}${x}`), kind),
          x + Math.floor(r() * 6) - 3,
          ry + 34 + Math.floor(r() * 18),
          18,
        );
    }

    function dressForest() {
      switch (id) {
        case 'forest.old_oak':
          put(A.tree(seed, 'forest', true), north ? L : cx, band, 30);
          put(A.tree(seed + 5, 'forest'), R + 10, ry + 40, 18);
          put(A.mushrooms(seed), R - 8, band + 6);
          break;
        case 'forest.hollow':
          put(A.tree(seed, 'dark', true), cx, band, 30);
          put(A.tree(seed + 1, 'dark'), rx + 14, ry + 44, 18);
          put(A.tree(seed + 2, 'dark'), rx + rw - 14, ry + 44, 18);
          break;
        case 'forest.mushroom_ring':
          topTrees('forest');
          for (let i = 0; i < 9; i++) {
            const a = (i / 9) * Math.PI * 2;
            put(A.mushrooms(seed + i), cx + Math.cos(a) * 34, band + 30 + Math.sin(a) * 16);
          }
          break;
        case 'forest.creek':
          topTrees('forest');
          for (let x = rx; x < rx + rw; x++) {
            const y0 = ry + 62 + Math.round(Math.sin(x / 14) * 3);
            for (let y = y0; y < y0 + 6; y++)
              if (!isPath(x, y)) map.px(x, y, y === y0 ? P.foam : (x + y) % 7 === 0 ? P.waterLight : P.water);
          }
          put(A.boulder(seed, 0.2), cx - 20, ry + 70);
          break;
        case 'forest.thicket':
          topTrees('dark');
          for (let i = 0; i < 6; i++)
            put(A.bush(seed + i, i % 2 ? P.canopy : P.canopyMid), rx + 8 + i * 6, band + 10 + i * 9);
          break;
        default:
          topTrees('forest');
          if (r() < 0.7) put(A.mushrooms(seed), rx + 14, ry + rh - 8);
          A.flowers(map, rx + rw - 20, ry + rh - 18, seed);
      }
      for (let i = 0; i < 4; i++)
        ambient.push({ x: rx + 10 + r() * (rw - 20), y: ry + 20 + r() * (rh - 30), kind: 'firefly' });
    }

    function dressHills() {
      put(A.boulder(seed, 1.4), north ? L - 10 : cx - 30, band - 4, 12);
      put(A.boulder(seed + 1, 0.6), north ? L + 18 : cx + 10, band, 8);
      put(A.boulder(seed + 2, 1), R + 4, band - 8, 10);
      put(A.bush(seed, 0x8a9a46), R - 18, band + 2);
      if (id === 'hills.pass') put(A.signpost(), rx + rw - 14, band + 6);
    }

    function dressMines() {
      // a wall face along the top, supports and lanterns
      for (let x = rx; x < rx + rw; x++) {
        if (north && x >= cx - TILE - 2 && x < cx + TILE + 2) continue;
        for (let y = ry; y < ry + 22; y++)
          map.px(
            x,
            y,
            y === ry + 21
              ? shade(P.rockMid, 0.7)
              : (x + Math.floor(y / 3)) % 6 === 0
                ? shade(P.rockMid, 0.8)
                : y < ry + 6
                  ? P.rock
                  : P.rockMid,
          );
      }
      for (let i = 0; i < 6; i++) ore(map, rx + 8 + r() * (rw - 16), ry + 4 + r() * 12, seed + i, glints);
      put(A.supportBeam(30), north ? L : cx - 34, ry + 30);
      put(A.supportBeam(30), R, ry + 30);
      switch (id) {
        case 'mines.crystal_cavern':
          put(A.crystals(seed), rx + 22, band);
          put(A.crystals(seed + 1), R + 10, band - 6);
          put(A.crystals(seed + 2), cx + 4, ry + rh - 8);
          break;
        case 'mines.flooded_gallery':
          map.ellipse(rx + 20, band - 6, rx + 90, band + 14, P.waterDark);
          map.ellipse(rx + 24, band - 4, rx + 86, band + 11, P.water);
          for (let i = 0; i < 5; i++) map.px(rx + 30 + i * 11, band + (i % 2) * 4, P.waterLight);
          break;
        case 'mines.forge_ruin':
          put(A.forge(), L, band);
          put(A.anvil(), cx + 26, band + 6);
          put(A.barrel(), R + 16, band);
          break;
        case 'mines.entrance':
        case 'mines.tunnel':
        case 'mines.deep_shaft':
          for (let x = rx; x < rx + rw; x += 1) {
            const y = ry + rh / 2 + 18;
            if (x % 6 < 2) map.rect(x, y - 3, x, y + 3, P.woodDark);
            map.px(x, y - 2, P.iron);
            map.px(x, y + 2, P.iron);
          }
          if (id === 'mines.deep_shaft') {
            map.ellipse(R - 14, band - 6, R + 14, band + 8, 0x15101c);
            map.rect(R - 2, band - 6, R - 1, band + 6, P.wood);
            map.rect(R + 2, band - 6, R + 3, band + 6, P.wood);
          }
          break;
        default:
          put(A.crate(), R + 14, band + 4);
      }
    }

    function dressSwamp() {
      for (let i = 0; i < 3; i++) {
        const x = rx + 20 + r() * (rw - 40);
        const y = ry + rh * 0.55 + r() * rh * 0.35;
        map.ellipse(x - 10, y - 3, x + 10, y + 3, P.murk);
        map.px(x - 4, y - 1, P.murkLight);
      }
      put(A.reeds(seed), rx + 8, ry + 14);
      put(A.reeds(seed + 1), rx + rw - 10, ry + 20);
      put(A.reeds(seed + 2), rx + 14, ry + rh - 6);
      switch (id) {
        case 'swamp.witch_hut':
          put(
            A.compose(
              A.house({
                w: 48,
                wallH: 22,
                roofH: 22,
                roof: 0x5a3a6a,
                wall: 0x6b5e52,
                frame: 0x4a3a32,
                windows: 1,
                windowColor: 0x3e6b5a,
                chimney: true,
              }),
              A.cauldron(0x9a6ad0),
              34,
              6,
            ),
            north ? L : cx - 20,
            band,
            44,
          );
          break;
        case 'swamp.drowned_shrine':
          put(A.shrine(), north ? L : cx, band, 40);
          break;
        case 'swamp.marsh_edge':
          put(A.signpost(), R, band);
          put(A.deadTree(seed), L - 10, band - 6, 10);
          break;
        default:
          put(A.deadTree(seed), north ? L : cx - 30, band - 4, 10);
          lily(map, R, band + 10, seed);
      }
      for (let i = 0; i < 3; i++)
        ambient.push({ x: rx + 10 + r() * (rw - 20), y: ry + 20 + r() * (rh - 30), kind: 'wisp' });
    }

    function dressRuins() {
      const cols = [rx + 14, rx + 40, rx + rw - 40, rx + rw - 14];
      switch (id) {
        case 'ruins.collapsed_tower':
          put(A.brokenTower(), cx, band + 2, 50);
          put(A.rubble(seed), rx + 20, band + 10);
          break;
        case 'ruins.plaza':
          put(A.statueBroken(), L, band, 20);
          put(A.column(seed), R - 10, band);
          put(A.column(seed + 1), R + 16, band - 4);
          break;
        case 'ruins.bandit_hideout':
          put(A.tent(0xd9534f), rx + 34, band, 28);
          put(A.tent(0x8a6440), rx + rw - 34, band - 4, 28);
          put(A.campfire(), cx, band + 14);
          put(A.crate(), cx + 22, band + 2);
          break;
        case 'ruins.catacomb_stairs':
          for (const x of cols) put(A.column(hash32(`${id}${x}`)), x, band - 4, 6);
          put(A.torch(), cx - 26, ry + rh - 4);
          put(A.torch(), cx + 26, ry + rh - 4);
          break;
        case 'ruins.drowned_gate':
          put(A.portcullis(60), north ? L : cx, band, 0);
          map.ellipse(rx + 90, band + 6, rx + 150, band + 26, P.murk);
          break;
        case 'ruins.overgrown_street':
          for (const x of cols) put(A.column(hash32(`${id}${x}`)), x, band - 2, 6);
          for (let i = 0; i < 4; i++) put(A.bush(seed + i, P.ivy), rx + 20 + i * 38, ry + rh - 4);
          break;
        default:
          for (const x of cols)
            if (r() < 0.75) put(A.column(hash32(`${id}${x}`)), x, band - Math.floor(r() * 10), 6);
          put(A.rubble(seed), cx + 30, band + 8);
      }
    }

    function dressDungeon() {
      for (let x = rx; x < rx + rw; x++) {
        if (north && x >= cx - TILE - 2 && x < cx + TILE + 2) continue;
        for (let y = ry; y < ry + 24; y++)
          map.px(
            x,
            y,
            y === ry + 23
              ? P.dwall
              : (x + (Math.floor(y / 4) % 2) * 4) % 8 === 0 || y % 4 === 0
                ? P.dwall
                : y < ry + 8
                  ? P.dwall
                  : P.dwallLight,
          );
      }
      put(A.torch(), rx + 24, ry + 20);
      put(A.torch(), rx + rw - 24, ry + 20);
      switch (id) {
        case 'dungeon.antechamber':
          put(A.column(seed, false), rx + 50, band, 6);
          put(A.column(seed + 1, false), rx + rw - 50, band, 6);
          break;
        case 'dungeon.lever_hall':
          put(A.lever(true), rx + 40, band);
          put(A.lever(false), cx, band);
          put(A.lever(true), rx + rw - 40, band);
          break;
        case 'dungeon.trapped_corridor':
          for (let i = 0; i < 6; i++) put(A.bones(seed + i), rx + 20 + i * 24, band + (i % 2) * 6);
          break;
        case 'dungeon.rune_door':
          put(A.runeCircle(), cx, band + 4);
          break;
        case 'dungeon.gate_hall':
          put(A.portcullis(56), cx, band, 0);
          break;
        case 'dungeon.boss_lair':
          put(A.throne(), cx, band + 4, 30);
          put(A.bones(seed), rx + 30, band + 20);
          put(A.bones(seed + 1), rx + rw - 30, band + 16);
          break;
        case 'dungeon.vault':
          put(A.goldPile(), cx, band + 2);
          put(A.chest(true), rx + 40, band);
          put(A.chest(false), rx + rw - 40, band);
          break;
        default:
          put(A.bones(seed), cx + 30, band + 10);
      }
    }
  }

  function siteFor(
    building: string,
    room: RoomInfo,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    band: number,
  ): Site {
    const cx = rx + rw / 2;
    if (building === 'bridge' && grid.bridge)
      return {
        x: (grid.bridge.x + grid.bridge.w / 2) * TILE,
        y: (grid.bridge.y + grid.bridge.h) * TILE + 6,
        w: 52,
        h: 40,
        plot: false,
      };
    if (building === 'wall') return { x: cx, y: ry + rh + 6, w: rw, h: 26, plot: false };
    if (building === 'statue') return { x: rx + rw - 34, y: band + 2, w: 40, h: 46, plot: false };
    void room;
    return { x: rx + rw - 34, y: band + 2, w: 58, h: 48, plot: false };
  }
}

function shadowEllipse(map: PixelBuf, x: number, y: number, w: number) {
  const h = Math.max(3, Math.round(w / 5));
  for (let dy = -h; dy <= h; dy++)
    for (let dx = -w / 2; dx <= w / 2; dx++) {
      const nx = dx / (w / 2);
      const ny = dy / h;
      if (nx * nx + ny * ny <= 1) map.px(x + dx, y + dy - 1, OUTLINE, 70);
    }
}

function colorUnder(map: PixelBuf, x: number, y: number): number {
  const c = map.get(x, y);
  return c < 0 ? VOID : c;
}

function lily(map: PixelBuf, x: number, y: number, seed: number) {
  const r = rng(seed);
  for (let i = 0; i < 2; i++) {
    const lx = x + Math.floor(r() * 10);
    const ly = y + Math.floor(r() * 6);
    map.ellipse(lx, ly, lx + 4, ly + 2, 0x5f8a46);
    map.px(lx + 2, ly, P.murk);
    if (r() < 0.3) map.px(lx + 1, ly + 1, 0xe8a8c8);
  }
}

function ore(map: PixelBuf, x: number, y: number, seed: number, glints: Baked['glints']) {
  const r = rng(seed);
  const colors = [P.copper, P.copper, P.iron, P.silver, P.crystal];
  const c = colors[Math.floor(r() * colors.length)]!;
  for (let i = 0; i < 5; i++) {
    const ex = Math.round(x + r() * 6 - 3);
    const ey = Math.round(y + r() * 4 - 2);
    map.px(ex, ey, c);
    map.px(ex + 1, ey, shade(c, 0.75));
  }
  glints.push({ x: Math.round(x), y: Math.round(y), color: c });
}

function tileBase(t: number): number {
  switch (t) {
    case T.GRASS:
      return P.grass;
    case T.FOREST:
      return P.forest;
    case T.GLADE:
      return 0x5f9a5c;
    case T.DRY:
      return P.dry;
    case T.MUD:
      return P.mud;
    case T.SAND:
      return P.sand;
    default:
      return P.grass;
  }
}

/** Paints one 16x16 tile at tile coordinates (tx, ty). */
function paintTile(map: PixelBuf, tx: number, ty: number, t: number) {
  const x0 = tx * TILE;
  const y0 = ty * TILE;
  const h = hash32(`${tx},${ty}`, 1);
  for (let ly = 0; ly < TILE; ly++) {
    for (let lx = 0; lx < TILE; lx++) {
      const x = x0 + lx;
      const y = y0 + ly;
      const n = noise2(x, y, 1);
      let c: number;
      switch (t) {
        case T.GRASS: {
          c = smoothNoise(x, y, 40, 3) > 0.66 ? mix(P.grass, P.grassLight, 0.4) : P.grass;
          if (n < 0.06) c = P.grassDark;
          else if (n > 0.965) c = P.grassLight;
          break;
        }
        case T.COBBLE: {
          const row = Math.floor(y / 4);
          const off = (row % 2) * 3;
          const col = Math.floor((x + off) / 6);
          const edge = y % 4 === 3 || (x + off) % 6 === 5;
          const tone = noise2(col, row, 7);
          c = edge
            ? P.cobbleDark
            : tone < 0.25
              ? shade(P.cobble, 0.93)
              : tone > 0.85
                ? P.cobbleLight
                : P.cobble;
          if (!edge && y % 4 === 0 && (x + off) % 6 === 0) c = P.cobbleLight;
          break;
        }
        case T.DIRT:
          c =
            n < 0.1
              ? P.dirtDark
              : n > 0.975
                ? 0xc2a57c
                : smoothNoise(x, y, 20, 8) > 0.7
                  ? shade(P.dirt, 0.95)
                  : P.dirt;
          break;
        case T.FOREST:
          c = smoothNoise(x, y, 30, 4) > 0.62 ? P.forestLight : P.forest;
          if (n < 0.13) c = P.forestDark;
          else if (n > 0.975) c = 0x6b5a3a;
          break;
        case T.GLADE:
          c = smoothNoise(x, y, 30, 4) > 0.6 ? 0x6aa864 : 0x5f9a5c;
          if (n < 0.08) c = P.forestLight;
          else if (n > 0.97) c = P.flowerYellow;
          break;
        case T.DRY:
          c = smoothNoise(x, y, 36, 5) > 0.64 ? P.dryLight : P.dry;
          if (n < 0.08) c = P.dryDark;
          else if (n > 0.95 && noise2(x, y + 1, 1) > 0.5) c = P.dryLight;
          break;
        case T.CAVE:
          c = n < 0.1 ? P.caveDark : n > 0.97 ? P.caveLight : P.cave;
          if (Math.abs(smoothNoise(x, y, 18, 6) - 0.5) < 0.012) c = P.caveDark;
          break;
        case T.ROCK: {
          const f = smoothNoise(x, y, 7, 7);
          c = f > 0.72 ? P.rockLight : f > 0.45 ? P.rockMid : P.rock;
          if (n < 0.04) c = P.rock;
          break;
        }
        case T.MUD:
          c = smoothNoise(x, y, 22, 9) > 0.6 ? P.moss : P.mud;
          if (n < 0.1) c = P.mudDark;
          break;
        case T.MURK:
          c = smoothNoise(x, y, 28, 10) > 0.62 ? P.murkDark : P.murk;
          if (noise2(Math.floor(x / 5), y, 13) > 0.985) c = P.murkLight;
          break;
        case T.PLANK_H:
          c = lx % 4 === 3 ? P.plankDark : n < 0.08 ? shade(P.plank, 0.9) : P.plank;
          if (lx % 4 === 1 && (ly === 2 || ly === 13)) c = OUTLINE;
          break;
        case T.PLANK_V:
          c = ly % 4 === 3 ? P.plankDark : n < 0.08 ? shade(P.plank, 0.9) : P.plank;
          if (ly % 4 === 1 && (lx === 2 || lx === 13)) c = OUTLINE;
          break;
        case T.FLAG: {
          const row = Math.floor(y / 8);
          const off = (row % 2) * 4;
          const col = Math.floor((x + off) / 8);
          const edge = y % 8 === 7 || (x + off) % 8 === 7;
          const tone = noise2(col, row, 15);
          c = edge ? P.flagDark : tone < 0.3 ? shade(P.flag, 0.94) : tone > 0.85 ? P.flagLight : P.flag;
          if (!edge && tone > 0.6 && tone < 0.68 && (x + off) % 8 === y % 8) c = 0x7e705c;
          if (edge && noise2(x, y, 16) > 0.93) c = P.ivy;
          break;
        }
        case T.SAND:
          c =
            n < 0.08
              ? P.sandDark
              : n > 0.985
                ? P.flagDark
                : smoothNoise(x, y, 30, 17) > 0.65
                  ? shade(P.sand, 0.96)
                  : P.sand;
          break;
        case T.BRICK: {
          const row = Math.floor(y / 5);
          const off = (row % 2) * 5;
          const edge = y % 5 === 4 || (x + off) % 10 === 9;
          c = edge ? P.brickDark : y % 5 === 0 ? P.brickLight : n < 0.06 ? shade(P.brick, 0.9) : P.brick;
          break;
        }
        case T.DWALL: {
          const row = Math.floor(y / 5);
          const off = (row % 2) * 5;
          c = y % 5 === 4 || (x + off) % 10 === 9 ? 0x18121f : P.dwall;
          break;
        }
        case T.WATER:
          c = smoothNoise(x, y, 26, 18) > 0.6 ? P.waterDark : P.water;
          if (noise2(Math.floor(x / 4), y, 19) > 0.98) c = P.waterLight;
          break;
        case T.STAIRS:
          c = ly % 4 === 0 ? P.flagLight : ly % 4 === 3 ? shade(P.flagDark, 0.7) : P.flag;
          if (lx === 0 || lx === 15) c = P.flagDark;
          break;
        default:
          c = VOID;
      }
      map.px(x, y, c);
    }
  }
  // grass tufts and pebbles, one per some tiles
  if ((t === T.GRASS || t === T.FOREST || t === T.DRY || t === T.GLADE) && (h & 7) < 3) {
    const tx0 = x0 + 2 + ((h >>> 4) % 11);
    const ty0 = y0 + 2 + ((h >>> 9) % 11);
    const dark = t === T.GRASS ? P.grassDark : t === T.FOREST ? P.forestDark : P.dryDark;
    map.px(tx0, ty0, dark);
    map.px(tx0 + 2, ty0, dark);
    map.px(tx0 + 1, ty0 + 1, dark);
  }
}
