import type { Content } from '@ajwf/content';
import { BALANCE } from './balance';
import { TimerHeap } from './heap';
import { indexGuild } from './guild';
import { indexOrder } from './market';
import { blankAgent } from './register';
import { indexTrade } from './trade';
import type { AgentState, BoardPost, Guild, Market, Party, RoomState, Timer, Trade, Village, WorldMeta, WorldState } from './types';
import { createWorld, nextPhaseChange, spawnMonster, spawnSlots } from './world';

/**
 * What the server persists: agents one by one, the rest of the world by key (`meta`, `timers`, `room:<id>`,
 * `party:<id>`, `guild:<id>`, `trades`, `market`, `board`, `village`). A world entry whose `data` is null was
 * deleted (a dissolved party or guild): the store should drop the key.
 *
 * Both exports hand out the live objects of the world, not copies, so that saving costs nothing extra. Consumers
 * must serialize them right away, before the game applies another action.
 */
export type Snapshot = { agents: AgentState[]; world: { key: string; data: unknown }[] };

function worldEntry(s: WorldState, key: string): unknown {
  if (key === 'meta') return s.meta;
  if (key === 'timers') return s.timers.toJSON();
  if (key === 'trades') return [...s.trades.values()];
  if (key === 'market') return s.market;
  if (key === 'board') return s.board;
  if (key === 'village') return s.village;
  if (key.startsWith('room:')) return s.rooms.get(key.slice(5));
  if (key.startsWith('party:')) return s.parties.get(key.slice(6)) ?? null;
  if (key.startsWith('guild:')) return s.guilds.get(key.slice(6)) ?? null;
  return undefined;
}

/** Collects the entities changed since the last call and clears the dirty set. Serialize the result at once. */
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

/** Everything, regardless of the dirty set (graceful shutdown, tests). Serialize the result at once. */
export function exportAll(s: WorldState): Snapshot {
  const snap: Snapshot = { agents: [...s.agents.values()], world: [] };
  for (const key of ['meta', 'timers', 'trades', 'market', 'board', 'village']) snap.world.push({ key, data: worldEntry(s, key) });
  for (const r of s.rooms.values()) snap.world.push({ key: `room:${r.id}`, data: r });
  for (const p of s.parties.values()) snap.world.push({ key: `party:${p.id}`, data: p });
  for (const g of s.guilds.values()) snap.world.push({ key: `guild:${g.id}`, data: g });
  return snap;
}

/**
 * Rebuilds a world from snapshots. Tolerates content changes between versions: new rooms start fresh, monsters
 * of removed kinds vanish, empty spawn slots are refilled and agents in removed rooms go back to the square.
 * Snapshots written before a field existed get its default.
 */
export function restoreWorld(content: Content, snap: Snapshot, now: number): WorldState {
  const s = createWorld(content, now);
  // Own copies: the snapshot passed in is never modified.
  const world = new Map(snap.world.filter((e) => e.data !== null && e.data !== undefined).map((e) => [e.key, structuredClone(e.data)]));

  const meta = world.get('meta') as WorldMeta | undefined;
  if (meta) s.meta = { ...s.meta, ...meta };

  const timers = ((world.get('timers') as Timer[] | undefined) ?? []).filter((t) => {
    if (t.kind === 'respawn') return content.rooms.has(t.room) && t.slot < spawnSlots(content, t.room).length;
    return true;
  });
  if (world.has('timers')) s.timers = new TimerHeap(timers);

  for (const room of content.rooms.values()) {
    const saved = world.get(`room:${room.id}`) as Partial<RoomState> | undefined;
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
      said: saved?.said ?? [],
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
    const a: AgentState = { ...blankAgent(now), ...structuredClone(raw) };
    a.equip = { ...blankAgent(now).equip, ...a.equip };
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
  restoreSocial(s, world);
  s.dirty.clear();
  return s;
}

/** Parties, guilds, trades, the market, the board and the village, with the indexes derived from them. */
function restoreSocial(s: WorldState, world: Map<string, unknown>): void {
  const c = s.content;
  const live = (id: string) => s.agents.get(id)?.status === 'active';
  for (const [key, data] of world) {
    if (key.startsWith('party:')) {
      const p = data as Party;
      p.members = p.members.filter((id) => live(id) && s.agents.get(id)!.party === p.id);
      if (p.members.length < 1) continue;
      if (!p.members.includes(p.leader)) p.leader = p.members[0]!;
      s.parties.set(p.id, p);
    } else if (key.startsWith('guild:')) {
      const g = data as Guild;
      g.members = g.members.filter((id) => s.agents.get(id)?.guild === g.id);
      if (!g.members.length) continue;
      g.officers = g.officers.filter((id) => g.members.includes(id));
      if (!g.members.includes(g.leader)) g.leader = g.officers[0] ?? g.members[0]!;
      g.officers = g.officers.filter((id) => id !== g.leader);
      for (const id of Object.keys(g.vault)) if (!c.items.has(id)) delete g.vault[id];
      indexGuild(s, g);
    }
  }
  // An agent pointing at a party or guild that did not survive is on its own again.
  for (const a of s.agents.values()) {
    if (a.party && !s.parties.get(a.party)?.members.includes(a.id)) a.party = null;
    if (a.guild && !s.guilds.get(a.guild)?.members.includes(a.id)) a.guild = null;
  }

  for (const t of (world.get('trades') as Trade[] | undefined) ?? []) {
    if (!s.agents.has(t.from) || !s.agents.has(t.to)) continue;
    s.trades.set(t.id, t);
    indexTrade(s, t);
  }

  const market = world.get('market') as Partial<Market> | undefined;
  s.market = { orders: {}, history: market?.history ?? [] };
  for (const o of Object.values(market?.orders ?? {})) {
    // Escrowed items of a removed kind vanish, like the same items in an inventory would.
    if (!c.items.has(o.item) || !s.agents.has(o.seller)) continue;
    s.market.orders[o.id] = o;
    indexOrder(s, o);
  }

  s.board = (world.get('board') as BoardPost[] | undefined) ?? [];
  s.village = { ...s.village, ...(world.get('village') as Partial<Village> | undefined) };
}
