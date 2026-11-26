import type { Content, Room } from '@ajwf/content';
import { isNight, nextDayFraction, BALANCE } from './balance';
import { TimerHeap } from './heap';
import { emit, markRoom, type Run } from './run';
import type { AgentState, MonsterInst, PuzzleState, RoomState, WorldState } from './types';
import { scheduleWorldBoss } from './worldboss';

export type SpawnSlot = { kind: string; night: boolean };

/** World entries that are not per room, party or guild (see snapshot.ts). */
export const WORLD_KEYS = ['meta', 'timers', 'trades', 'market', 'board', 'village', 'puzzles', 'wboss', 'escorts'] as const;

const spawnCache = new WeakMap<Content, Map<string, SpawnSlot[]>>();

/** The fixed list of monster slots of a room (one entry per monster, expanded from `count`). */
export function spawnSlots(c: Content, roomId: string): SpawnSlot[] {
  let byRoom = spawnCache.get(c);
  if (!byRoom) {
    byRoom = new Map();
    spawnCache.set(c, byRoom);
  }
  let slots = byRoom.get(roomId);
  if (!slots) {
    slots = [];
    for (const m of c.rooms.get(roomId)?.monsters ?? []) {
      for (let i = 0; i < m.count; i++) slots.push({ kind: m.id, night: m.night === true });
    }
    byRoom.set(roomId, slots);
  }
  return slots;
}

function emptyRoom(room: Room, now: number): RoomState {
  const resources: RoomState['resources'] = {};
  for (const r of room.resources) resources[r.id] = { qty: r.max, at: now };
  return { id: room.id, monsters: [], resources, ground: {}, said: [] };
}

export function freshPuzzle(): PuzzleState {
  return { open: 0, pulls: {}, hold: null, winch: 0, ready: 0 };
}

/** Schedules a monster slot to come back, and remembers when (for "it returns in N seconds" answers). */
export function scheduleRespawn(s: WorldState, roomId: string, slot: number, at: number): void {
  s.timers.push({ at, kind: 'respawn', room: roomId, slot });
  let pending = s.respawns.get(roomId);
  if (!pending) s.respawns.set(roomId, (pending = new Map()));
  pending.set(slot, at);
  s.dirty.add('timers');
}

/** A brand new world: every room populated, nobody in it. */
export function createWorld(content: Content, now: number): WorldState {
  const s: WorldState = {
    content,
    meta: { eventSeq: 0, agentSeq: 0, monsterSeq: 0, worldFirsts: {}, partySeq: 0, guildSeq: 0, tradeSeq: 0, orderSeq: 0, postSeq: 0, escortSeq: 0, createdAt: now },
    agents: new Map(),
    byName: new Map(),
    bySkeleton: new Map(),
    lookHashes: new Map(),
    rooms: new Map(),
    roomAgents: new Map(),
    timers: new TimerHeap(),
    inboxes: new Map(),
    parties: new Map(),
    guilds: new Map(),
    guildNames: new Map(),
    guildSkeletons: new Map(),
    trades: new Map(),
    tradesOf: new Map(),
    market: { orders: {}, history: [] },
    ordersOf: new Map(),
    ordersByItem: new Map(),
    board: [],
    village: { taxRate: 0, treasury: 0 },
    puzzles: Object.fromEntries([...content.puzzles.keys()].map((id) => [id, freshPuzzle()])),
    worldBoss: { next: 0, announced: 0, uid: null, leaves: 0 },
    escorts: new Map(),
    escortOfParty: new Map(),
    escortsIn: new Map(),
    respawns: new Map(),
    dirty: new Set(),
  };
  for (const room of content.rooms.values()) {
    s.rooms.set(room.id, emptyRoom(room, now));
    s.roomAgents.set(room.id, new Set());
    const slots = spawnSlots(content, room.id);
    for (let i = 0; i < slots.length; i++) spawnMonster(s, room.id, i, now);
    s.dirty.add(`room:${room.id}`);
  }
  s.timers.push({ at: nextPhaseChange(now), kind: 'phase' });
  scheduleWorldBoss(s, now);
  for (const key of WORLD_KEYS) s.dirty.add(key);
  return s;
}

/** Next nightfall or dawn after `now`. */
export function nextPhaseChange(now: number): number {
  return Math.min(nextDayFraction(now, BALANCE.day.night), nextDayFraction(now, BALANCE.day.dawn));
}

/**
 * Puts a monster in a room slot. Night creatures only appear at night: during the day the spawn is postponed to
 * the next nightfall. Returns the new instance, or null when postponed.
 */
export function spawnMonster(s: WorldState, roomId: string, slot: number, now: number): MonsterInst | null {
  const def = spawnSlots(s.content, roomId)[slot];
  const room = s.rooms.get(roomId);
  if (!def || !room) return null;
  if (room.monsters.some((m) => m.slot === slot)) return null;
  if (def.night && !isNight(now)) {
    scheduleRespawn(s, roomId, slot, nextDayFraction(now, BALANCE.day.night));
    return null;
  }
  const kind = s.content.monsters.get(def.kind)!;
  const inst: MonsterInst = {
    uid: `m${(++s.meta.monsterSeq).toString(36)}`,
    kind: def.kind,
    hp: kind.hp,
    slot,
    threat: {},
    taunt: null,
    lastHit: 0,
  };
  room.monsters.push(inst);
  s.respawns.get(roomId)?.delete(slot);
  markRoom(s, roomId);
  return inst;
}

export function roomState(s: WorldState, roomId: string): RoomState {
  const r = s.rooms.get(roomId);
  if (!r) throw new Error(`unknown room ${roomId}`);
  return r;
}

export function agentsIn(s: WorldState, roomId: string): Set<string> {
  let set = s.roomAgents.get(roomId);
  if (!set) {
    set = new Set();
    s.roomAgents.set(roomId, set);
  }
  return set;
}

/** Moves an agent between the room indexes. Does not emit events. */
export function relocate(s: WorldState, a: AgentState, to: string, now: number): void {
  s.roomAgents.get(a.room)?.delete(a.id);
  a.room = to;
  a.roomAt = now;
  agentsIn(s, to).add(a.id);
}

/** Current stock of a resource node, regenerated lazily from the last update. */
export function refreshResource(s: WorldState, roomId: string, itemId: string, now: number): { qty: number; max: number } | null {
  const def = s.content.rooms.get(roomId)?.resources.find((r) => r.id === itemId);
  const node = s.rooms.get(roomId)?.resources[itemId];
  if (!def || !node) return null;
  if (node.qty < def.max) {
    const grown = Math.floor(((now - node.at) * def.regen_per_hour) / 3_600_000);
    if (grown > 0) {
      node.qty = Math.min(def.max, node.qty + grown);
      // Keep the fraction of time that did not yet yield a unit.
      node.at = node.qty >= def.max ? now : node.at + Math.floor((grown * 3_600_000) / def.regen_per_hour);
    }
  } else node.at = now;
  return { qty: node.qty, max: def.max };
}

/** A monster nobody hit for a while forgets its attackers and heals back. */
export function refreshMonster(s: WorldState, m: MonsterInst, now: number): void {
  if (m.lastHit && now - m.lastHit > BALANCE.combat.monsterResetMs) {
    m.hp = s.content.monsters.get(m.kind)!.hp;
    m.threat = {};
    m.taunt = null;
    m.lastHit = 0;
  }
}

/** Nightfall brings the night creatures (through their respawn timers); dawn sends the idle ones away. */
export function phaseChange(run: Run): void {
  const { s, now } = run;
  if (!isNight(now)) {
    for (const room of s.content.rooms.values()) {
      const slots = spawnSlots(s.content, room.id);
      if (!slots.some((x) => x.night)) continue;
      const st = roomState(s, room.id);
      const before = st.monsters.length;
      // Fights abandoned long ago do not count as holding the creature here.
      for (const m of st.monsters) refreshMonster(s, m, now);
      const leaving = st.monsters.filter((m) => slots[m.slot]?.night && Object.keys(m.threat).length === 0);
      if (!leaving.length) continue;
      st.monsters = st.monsters.filter((m) => !leaving.includes(m));
      for (const m of leaving) scheduleRespawn(s, room.id, m.slot, nextDayFraction(now, BALANCE.day.night));
      if (st.monsters.length !== before) markRoom(s, room.id);
    }
  }
  emit(run, 'day_phase', { vis: 'public', data: { night: isNight(now) } });
  s.timers.push({ at: nextPhaseChange(now), kind: 'phase' });
  s.dirty.add('timers');
}
