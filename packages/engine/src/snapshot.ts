import type { Content } from '@ajwf/content';
import { BALANCE } from './balance';
import { TimerHeap } from './heap';
import { blankAgent } from './register';
import type { AgentState, RoomState, Timer, WorldMeta, WorldState } from './types';
import { createWorld, nextPhaseChange, spawnMonster, spawnSlots } from './world';

/** What the server persists: agents one by one, the rest of the world by key (`meta`, `timers`, `room:<id>`). */
export type Snapshot = { agents: AgentState[]; world: { key: string; data: unknown }[] };

function worldEntry(s: WorldState, key: string): unknown {
  if (key === 'meta') return s.meta;
  if (key === 'timers') return s.timers.toJSON();
  if (key.startsWith('room:')) return s.rooms.get(key.slice(5));
  return undefined;
}

/** Collects the entities changed since the last call and clears the dirty set. */
export function exportDirty(s: WorldState): Snapshot {
  const snap: Snapshot = { agents: [], world: [] };
  for (const key of s.dirty) {
    if (key.startsWith('agent:')) {
      const a = s.agents.get(key.slice(6));
      if (a) snap.agents.push(a);
    } else {
      const data = worldEntry(s, key);
      if (data !== undefined) snap.world.push({ key, data });
    }
  }
  s.dirty.clear();
  return snap;
}

/** Everything, regardless of the dirty set (graceful shutdown, tests). */
export function exportAll(s: WorldState): Snapshot {
  const snap: Snapshot = { agents: [...s.agents.values()], world: [] };
  snap.world.push({ key: 'meta', data: s.meta }, { key: 'timers', data: s.timers.toJSON() });
  for (const r of s.rooms.values()) snap.world.push({ key: `room:${r.id}`, data: r });
  return snap;
}

/**
 * Rebuilds a world from snapshots. Tolerates content changes between versions: new rooms start fresh, monsters
 * of removed kinds vanish, empty spawn slots are refilled and agents in removed rooms go back to the square.
 */
export function restoreWorld(content: Content, snap: Snapshot, now: number): WorldState {
  const s = createWorld(content, now);
  const world = new Map(snap.world.map((e) => [e.key, e.data]));

  const meta = world.get('meta') as WorldMeta | undefined;
  if (meta) s.meta = { ...s.meta, ...meta };

  const timers = ((world.get('timers') as Timer[] | undefined) ?? []).filter((t) => {
    if (t.kind === 'respawn') return content.rooms.has(t.room) && t.slot < spawnSlots(content, t.room).length;
    return true;
  });
  if (world.has('timers')) s.timers = new TimerHeap(timers);

  for (const room of content.rooms.values()) {
    const saved = world.get(`room:${room.id}`) as RoomState | undefined;
    const fresh = s.rooms.get(room.id)!;
    const slots = spawnSlots(content, room.id);
    const st: RoomState = {
      id: room.id,
      // Rooms missing from the snapshot are refilled below, with uids that cannot clash with the saved ones.
      monsters: (saved?.monsters ?? []).filter(
        (m, i, all) => content.monsters.has(m.kind) && (m.slot < 0 || (slots[m.slot]?.kind === m.kind && all.findIndex((x) => x.slot === m.slot) === i)),
      ),
      resources: fresh.resources,
      ground: {},
    };
    for (const [id, node] of Object.entries(saved?.resources ?? {})) if (st.resources[id]) st.resources[id] = node;
    for (const [id, qty] of Object.entries(saved?.ground ?? {})) if (content.items.has(id) && qty > 0) st.ground[id] = qty;
    s.rooms.set(room.id, st);
    // Refill slots that have neither a living monster nor a pending respawn.
    const pending = new Set(timers.filter((t) => t.kind === 'respawn' && t.room === room.id).map((t) => (t as { slot: number }).slot));
    for (let i = 0; i < slots.length; i++) {
      if (!pending.has(i) && !st.monsters.some((m) => m.slot === i)) spawnMonster(s, room.id, i, now);
    }
  }
  if (!s.timers.toJSON().some((t) => t.kind === 'phase')) s.timers.push({ at: nextPhaseChange(now), kind: 'phase' });

  for (const raw of snap.agents) {
    const a: AgentState = { ...blankAgent(now), ...raw };
    a.equip = { ...blankAgent(now).equip, ...raw.equip };
    // Own copies: the snapshot passed in is never modified.
    a.inv = { ...raw.inv };
    a.quests = { ...raw.quests };
    if (!content.rooms.has(a.room)) a.room = BALANCE.startRoom;
    for (const id of Object.keys(a.inv)) if (!content.items.has(id)) delete a.inv[id];
    for (const slot of Object.keys(a.equip) as (keyof AgentState['equip'])[]) {
      if (a.equip[slot] && !content.items.has(a.equip[slot]!)) a.equip[slot] = null;
    }
    for (const id of Object.keys(a.quests)) if (!content.quests.has(id)) delete a.quests[id];
    a.combat = null;
    s.agents.set(a.id, a);
    // Names of retired and banned agents stay reserved, so nobody can impersonate them later.
    s.byName.set(a.norm, a.id);
    s.bySkeleton.set(a.skeleton, a.id);
    if (a.status !== 'active') continue;
    s.lookHashes.set(a.lookHash, (s.lookHashes.get(a.lookHash) ?? 0) + 1);
    s.roomAgents.get(a.room)!.add(a.id);
  }
  // Monsters remember attackers by id; forget the ones that no longer exist.
  for (const r of s.rooms.values()) {
    for (const m of r.monsters) for (const id of Object.keys(m.threat)) if (!s.agents.has(id)) delete m.threat[id];
  }
  s.dirty.clear();
  return s;
}
