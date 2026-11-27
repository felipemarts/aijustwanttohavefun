import type { Content } from '@ajwf/content';
import { hasOwnKey, isPlainKey, own } from '@ajwf/shared';
import { BALANCE } from './balance';
import { postEntry, postKey, restoreBoard } from './board';
import { indexGuild } from './guild';
import { indexOrder, returnOrders } from './market';
import { indexEscort } from './escort';
import { blankAgent } from './register';
import { indexTrade } from './trade';
import type { AgentState, Bounty, Escort, Guild, Market, Order, Party, PuzzleState, RoomState, Timer, Trade, Village, WorldBoss, WorldMeta, WorldState } from './types';
import { restoreVillage } from './village';
import { createWorld, freshPuzzle, nextPhaseChange, spawnMonster, spawnSlots, WORLD_KEYS } from './world';
import { nextWorldBossAt, pushTimers } from './worldboss';

/**
 * What the server persists: agents one by one, the rest of the world by key (`meta`, `timers`, `room:<id>`,
 * `party:<id>`, `guild:<id>`, `post:<id>`, `trades`, `market`, `village`, `puzzles`, `wboss`, `escorts`, `bounties`). A world entry whose `data` is null was
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
  // The legacy whole-board entry: migrated to `post:<id>` entries, so the store drops it.
  if (key === 'board') return null;
  if (key.startsWith('post:')) return postEntry(s, key.slice(5));
  if (key === 'village') return s.village;
  if (key === 'puzzles') return s.puzzles;
  if (key === 'wboss') return s.worldBoss;
  if (key === 'escorts') return [...s.escorts.values()];
  if (key === 'bounties') return s.bounties;
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
  for (const key of WORLD_KEYS) snap.world.push({ key, data: worldEntry(s, key) });
  for (const r of s.rooms.values()) snap.world.push({ key: `room:${r.id}`, data: r });
  for (const p of s.parties.values()) snap.world.push({ key: `party:${p.id}`, data: p });
  for (const g of s.guilds.values()) snap.world.push({ key: `guild:${g.id}`, data: g });
  for (const p of s.board) snap.world.push({ key: postKey(p.id), data: p });
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

  // World boss timers are rebuilt from its schedule below, so a changed schedule never leaves stale ones behind.
  const timers = ((world.get('timers') as Timer[] | undefined) ?? s.timers.toJSON()).filter((t) => {
    if (t.kind === 'respawn') return content.rooms.has(t.room) && t.slot < spawnSlots(content, t.room).length;
    if (t.kind === 'puzzle') return content.puzzles.has(t.id);
    // Trades expire through `sweepTrades`, without timers.
    return t.kind !== 'wboss' && t.kind !== 'trade';
  });
  s.timers.replace(timers);

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
    for (const [id, node] of Object.entries(saved?.resources ?? {})) if (hasOwnKey(st.resources, id)) st.resources[id] = node;
    st.ground = cleanStock(content, saved?.ground);
    s.rooms.set(room.id, st);
    // Refill slots that have neither a living monster nor a pending respawn.
    const pending = new Set(timers.filter((t) => t.kind === 'respawn' && t.room === room.id).map((t) => (t as { slot: number }).slot));
    for (let i = 0; i < slots.length; i++) {
      if (!pending.has(i) && !st.monsters.some((m) => m.slot === i)) spawnMonster(s, room.id, i, now);
    }
  }
  if (!s.timers.toJSON().some((t) => t.kind === 'phase')) s.timers.push({ at: nextPhaseChange(now), kind: 'phase' });
  restoreEvents(s, world, now);

  for (const raw of snap.agents) {
    const a: AgentState = { ...blankAgent(now), ...structuredClone(raw) };
    a.equip = { ...blankAgent(now).equip, ...a.equip };
    if (!content.rooms.has(a.room)) a.room = BALANCE.startRoom;
    a.inv = cleanStock(content, a.inv);
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
  const migrated = restoreSocial(s, world);
  restoreVillage(s);
  s.dirty.clear();
  // Entries rewritten by the restore itself (the board moved to one entry per post) are saved at the next snapshot.
  for (const key of migrated) s.dirty.add(key);
  return s;
}

/** Puzzles, the world boss schedule and the respawn index (timers are already in place). */
function restoreEvents(s: WorldState, world: Map<string, unknown>, now: number): void {
  const saved = (world.get('puzzles') as Record<string, Partial<PuzzleState>> | undefined) ?? {};
  for (const id of s.content.puzzles.keys()) s.puzzles[id] = { ...freshPuzzle(), ...own(saved, id) };

  const wb = world.get('wboss') as Partial<WorldBoss> | undefined;
  if (wb) s.worldBoss = { ...s.worldBoss, ...wb };
  const W = BALANCE.worldBoss;
  // A server that was down through a whole appearance does not bring back a stale boss: it waits for the next one.
  if (!s.worldBoss.next || s.worldBoss.next + W.stayMs <= now) s.worldBoss.next = nextWorldBossAt(now);
  if (s.worldBoss.uid && !s.rooms.get(W.room)?.monsters.some((m) => m.uid === s.worldBoss.uid)) s.worldBoss.uid = null;
  if (s.content.monsters.has(W.monster) && s.content.rooms.has(W.room)) pushTimers(s, now);

  s.respawns.clear();
  for (const t of s.timers.toJSON()) {
    if (t.kind !== 'respawn') continue;
    let pending = s.respawns.get(t.room);
    if (!pending) s.respawns.set(t.room, (pending = new Map()));
    pending.set(t.slot, Math.min(t.at, pending.get(t.slot) ?? Infinity));
  }
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/** A market order as written by this engine: plain id, positive whole quantity and price. */
function validOrder(o: unknown): o is Order {
  const x = o as Partial<Order> | null;
  return !!x && typeof x.id === 'string' && isPlainKey(x.id) && typeof x.item === 'string' && typeof x.seller === 'string' && isCount(x.qty) && isCount(x.price);
}

/** A stock record (item id -> quantity) from a snapshot: known items with positive whole quantities only. */
function cleanStock(c: Content, rec: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, qty] of Object.entries(rec ?? {})) if (c.items.has(id) && isCount(qty)) out[id] = qty;
  return out;
}

/** Parties, guilds, trades, the market, the board and the village, with the indexes derived from them. */
function restoreSocial(s: WorldState, world: Map<string, unknown>): string[] {
  const migrated: string[] = [];
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
      // Snapshots from before coups existed have no votes.
      g.coup = (g.coup ?? []).filter((id) => id !== g.leader && g.members.includes(id));
      g.vault = cleanStock(c, g.vault);
      indexGuild(s, g);
    }
  }
  // An agent pointing at a party or guild that did not survive is on its own again.
  for (const a of s.agents.values()) {
    if (a.party && !s.parties.get(a.party)?.members.includes(a.id)) a.party = null;
    if (a.guild && !s.guilds.get(a.guild)?.members.includes(a.id)) a.guild = null;
  }

  // In order of expiry, which `sweepTrades` relies on (a changed TTL could otherwise mix the order up).
  const trades = [...((world.get('trades') as Trade[] | undefined) ?? [])].sort((x, y) => x.expires - y.expires);
  for (const t of trades) {
    if (!s.agents.has(t.from) || !s.agents.has(t.to) || s.trades.has(t.id)) continue;
    s.trades.set(t.id, t);
    indexTrade(s, t);
  }

  const market = world.get('market') as Partial<Market> | undefined;
  s.market = { orders: {}, history: market?.history ?? [] };
  for (const o of Object.values(market?.orders ?? {})) {
    // Escrowed items of a removed kind vanish, like the same items in an inventory would; so do malformed orders.
    if (!validOrder(o) || !c.items.has(o.item) || !s.agents.has(o.seller) || hasOwnKey(s.market.orders, o.id)) continue;
    s.market.orders[o.id] = o;
    indexOrder(s, o);
  }
  // Orders of sellers retired or banned before their orders were cancelled with them (older versions).
  for (const id of new Set([...s.ordersOf.keys()])) {
    const seller = s.agents.get(id)!;
    if (seller.status !== 'active') {
      returnOrders(s, seller);
      migrated.push(`agent:${id}`, 'market');
    }
  }

  migrated.push(...restoreBoard(s, world));
  s.village = { ...s.village, ...(world.get('village') as Partial<Village> | undefined) };

  for (const e of (world.get('escorts') as Escort[] | undefined) ?? []) {
    const q = c.quests.get(e.quest);
    if (!q || q.kind !== 'escort' || !c.rooms.has(e.room) || !c.rooms.has(e.to) || s.escortOfParty.has(e.party)) continue;
    e.guards = e.guards.filter((id) => s.agents.has(id));
    s.escorts.set(e.id, e);
    indexEscort(s, e);
    // The stall timer may predate the snapshot's timers: one more check is harmless.
    s.timers.push({ at: e.at + BALANCE.escort.stallMs, kind: 'escort', id: e.id });
  }

  // A bounty is kept while its target exists; a missing refund timer is put back (only the timer at `due` acts).
  const saved = (world.get('bounties') as Record<string, Bounty> | undefined) ?? {};
  const timed = new Set(s.timers.toJSON().flatMap((t) => (t.kind === 'bounty' ? [`${t.target}|${t.at}`] : [])));
  for (const [target, b] of Object.entries(saved)) {
    if (!s.agents.has(target) || !(b.total > 0)) continue;
    s.bounties[target] = b;
    if (!timed.has(`${target}|${b.due}`)) s.timers.push({ at: b.due, kind: 'bounty', target });
  }
  return migrated;
}
