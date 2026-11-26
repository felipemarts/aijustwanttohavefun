import { capacity, derive, levelCap, slotsUsed } from './agent';
import { BALANCE, xpToNext } from './balance';
import type { Goods, Timer, WorldState } from './types';
import { spawnSlots } from './world';

const isNatural = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * Checks the rules that must hold after any sequence of actions and ticks (PLANEJAMENTO §16.4).
 * Returns human-readable violations (developer text, not game text); an empty list means the world is sound.
 * Cost is linear in the size of the world: meant for tests and simulations, not for the live loop.
 */
export function checkInvariants(s: WorldState, now: number): string[] {
  const out: string[] = [];
  const c = s.content;

  for (const a of s.agents.values()) {
    const who = `agent ${a.id} (${a.name})`;
    if (!isNatural(a.gold)) out.push(`${who}: gold ${a.gold} is not a non-negative integer`);
    if (!Number.isInteger(a.ap) || a.ap < 0 || a.ap > BALANCE.ap.max) out.push(`${who}: AP ${a.ap} outside [0, ${BALANCE.ap.max}]`);
    if (!Number.isInteger(a.level) || a.level < 1 || a.level > BALANCE.maxLevel) out.push(`${who}: level ${a.level} outside [1, ${BALANCE.maxLevel}]`);
    if (!a.claimed && a.level > BALANCE.unclaimedMaxLevel) out.push(`${who}: unclaimed agent at level ${a.level}`);
    const cap = levelCap(a);
    if (!(a.xp >= 0) || (a.level < cap && a.xp >= xpToNext(a.level))) out.push(`${who}: xp ${a.xp} out of range for level ${a.level}`);
    if (!c.classes.has(a.cls)) out.push(`${who}: unknown class ${a.cls}`);

    if (c.classes.has(a.cls)) {
      const d = derive(c, a, now);
      if (!(a.hp <= d.maxHp + 1e-9)) out.push(`${who}: HP ${a.hp} above max ${d.maxHp}`);
      if (!(a.mp >= 0) || !(a.mp <= d.maxMp + 1e-9)) out.push(`${who}: MP ${a.mp} outside [0, ${d.maxMp}]`);
    }
    if (a.hp <= 0 && !a.fallen) out.push(`${who}: HP ${a.hp} while standing`);
    if (a.fallen && a.hp !== 0) out.push(`${who}: fallen with HP ${a.hp}`);
    if (Number.isNaN(a.hp)) out.push(`${who}: HP is NaN`);

    for (const [id, qty] of Object.entries(a.inv)) {
      if (!Number.isInteger(qty) || qty <= 0) out.push(`${who}: ${qty} x ${id} in inventory`);
      if (!c.items.has(id)) out.push(`${who}: unknown item ${id} in inventory`);
    }
    for (const [slot, id] of Object.entries(a.equip)) {
      if (id === null) continue;
      const item = c.items.get(id);
      if (!item) out.push(`${who}: unknown item ${id} equipped`);
      else if (item.type !== slot) out.push(`${who}: ${id} (${item.type}) equipped as ${slot}`);
    }
    const used = slotsUsed(c, a.inv);
    if (used > capacity(c, a)) out.push(`${who}: ${used} inventory slots used of ${capacity(c, a)}`);

    for (const [qid, prog] of Object.entries(a.quests)) {
      const q = c.quests.get(qid);
      if (!q) {
        out.push(`${who}: unknown active quest ${qid}`);
        continue;
      }
      prog.steps.forEach((n, i) => {
        const need = q.steps[i]?.qty ?? 0;
        if (!isNatural(n) || n > need) out.push(`${who}: quest ${qid} step ${i} progress ${n} of ${need}`);
      });
    }
    if (Object.keys(a.quests).length > BALANCE.inventory.maxActiveQuests) out.push(`${who}: too many active quests`);

    if (!c.rooms.has(a.room)) out.push(`${who}: in unknown room ${a.room}`);
    const here = s.roomAgents.get(a.room);
    if (a.status === 'active' && !here?.has(a.id)) out.push(`${who}: missing from the index of room ${a.room}`);
    if (s.byName.get(a.norm) !== a.id) out.push(`${who}: name index points to ${s.byName.get(a.norm)}`);
    if (s.bySkeleton.get(a.skeleton) !== a.id) out.push(`${who}: skeleton index points to ${s.bySkeleton.get(a.skeleton)}`);
  }

  for (const [roomId, ids] of s.roomAgents) {
    for (const id of ids) {
      const a = s.agents.get(id);
      if (!a) out.push(`room ${roomId}: indexes unknown agent ${id}`);
      else if (a.room !== roomId) out.push(`room ${roomId}: indexes ${id}, who is in ${a.room}`);
      else if (a.status !== 'active') out.push(`room ${roomId}: indexes inactive agent ${id}`);
    }
  }
  for (const [norm, id] of s.byName) if (s.agents.get(id)?.norm !== norm) out.push(`name index: ${norm} -> ${id} does not match`);
  for (const [sk, id] of s.bySkeleton) if (s.agents.get(id)?.skeleton !== sk) out.push(`skeleton index: ${sk} -> ${id} does not match`);

  const uids = new Set<string>();
  for (const [roomId, st] of s.rooms) {
    const def = c.rooms.get(roomId);
    if (!def) {
      out.push(`room state for unknown room ${roomId}`);
      continue;
    }
    const slots = spawnSlots(c, roomId);
    const taken = new Set<number>();
    for (const m of st.monsters) {
      const kind = c.monsters.get(m.kind);
      const what = `room ${roomId}: monster ${m.uid} (${m.kind})`;
      if (!kind) out.push(`${what}: unknown kind`);
      if (!(m.hp > 0)) out.push(`${what}: HP ${m.hp}`);
      if (kind && m.hp > kind.hp) out.push(`${what}: HP ${m.hp} above max ${kind.hp}`);
      if (uids.has(m.uid)) out.push(`${what}: duplicate uid`);
      uids.add(m.uid);
      if (m.slot >= 0) {
        if (slots[m.slot]?.kind !== m.kind) out.push(`${what}: does not belong to slot ${m.slot}`);
        if (taken.has(m.slot)) out.push(`${what}: second living monster in slot ${m.slot}`);
        taken.add(m.slot);
      }
    }
    for (const r of def.resources) {
      const node = st.resources[r.id];
      if (!node) out.push(`room ${roomId}: resource ${r.id} has no state`);
      else if (!isNatural(node.qty) || node.qty > r.max) out.push(`room ${roomId}: resource ${r.id} stock ${node.qty} outside [0, ${r.max}]`);
    }
    for (const [id, qty] of Object.entries(st.ground)) {
      if (!Number.isInteger(qty) || qty <= 0) out.push(`room ${roomId}: ${qty} x ${id} on the ground`);
      if (!c.items.has(id)) out.push(`room ${roomId}: unknown item ${id} on the ground`);
    }
  }
  checkSocial(s, out);
  checkEconomy(s, out);
  checkEvents(s, now, out);
  return out;
}

/** Puzzles, the world boss, escorts and the respawn index, against the timers that drive them. */
function checkEvents(s: WorldState, now: number, out: string[]): void {
  const c = s.content;
  const timers = s.timers.toJSON();
  const due = new Map<string, number>();
  const key = (t: Timer) => (t.kind === 'puzzle' ? `puzzle:${t.id}` : t.kind === 'escort' ? `escort:${t.id}` : t.kind === 'wboss' ? `wboss:${t.step}` : '');
  for (const t of timers) {
    if (!Number.isFinite(t.at)) out.push(`timer ${t.kind} at ${t.at}`);
    const k = key(t);
    if (k) due.set(k, Math.max(due.get(k) ?? -Infinity, t.at));
  }

  for (const id of c.puzzles.keys()) if (!s.puzzles[id]) out.push(`puzzle ${id}: no state`);
  for (const [id, st] of Object.entries(s.puzzles)) {
    const pz = c.puzzles.get(id);
    const what = `puzzle ${id}`;
    if (!pz) {
      out.push(`${what}: state for unknown puzzle`);
      continue;
    }
    for (const n of [st.open, st.winch, st.ready]) if (!isNatural(n)) out.push(`${what}: bad timestamp ${n}`);
    // Something open must have a timer that closes it.
    const closesAt = Math.max(st.open, st.winch, st.ready);
    if (closesAt > now && (due.get(`puzzle:${id}`) ?? -Infinity) < closesAt) out.push(`${what}: open until ${closesAt} without a timer to close it`);
    for (const [t, pull] of Object.entries(st.pulls)) {
      if (pz.type !== 'levers' || !pz.targets.includes(t)) out.push(`${what}: pull on unknown lever ${t}`);
      if (!s.agents.has(pull.by)) out.push(`${what}: pulled by unknown agent ${pull.by}`);
    }
    if (st.hold && (pz.type !== 'gate' || !s.agents.has(st.hold.by))) out.push(`${what}: bad hold ${JSON.stringify(st.hold)}`);
    if (pz.type !== 'lock' && st.ready) out.push(`${what}: ready time on a ${pz.type}`);
    if (pz.type !== 'gate' && st.winch) out.push(`${what}: winch on a ${pz.type}`);
  }

  const W = BALANCE.worldBoss;
  const wb = s.worldBoss;
  if (c.monsters.has(W.monster) && c.rooms.has(W.room)) {
    if (!(wb.next > 0) || (due.get('wboss:spawn') ?? -Infinity) < wb.next) out.push(`world boss: next appearance ${wb.next} has no spawn timer`);
    if (wb.uid) {
      if (!s.rooms.get(W.room)?.monsters.some((m) => m.uid === wb.uid && m.kind === W.monster && m.slot < 0)) out.push(`world boss: ${wb.uid} is not in ${W.room}`);
      if ((due.get('wboss:leave') ?? -Infinity) < wb.leaves) out.push(`world boss: no timer to leave at ${wb.leaves}`);
    }
  }
  for (const [roomId, st] of s.rooms) {
    for (const m of st.monsters) if (m.slot < 0 && m.uid !== wb.uid) out.push(`room ${roomId}: event monster ${m.uid} that no schedule owns`);
  }

  const respawnAt = new Set(timers.filter((t) => t.kind === 'respawn').map((t) => `${t.room}|${t.slot}|${t.at}`));
  for (const [roomId, pending] of s.respawns) {
    for (const [slot, at] of pending) {
      if (!respawnAt.has(`${roomId}|${slot}|${at}`)) out.push(`respawn index: ${roomId} slot ${slot} at ${at} has no timer`);
      if (s.rooms.get(roomId)?.monsters.some((m) => m.slot === slot)) out.push(`respawn index: ${roomId} slot ${slot} pending but alive`);
    }
  }

  let inRooms = 0;
  for (const [roomId, ids] of s.escortsIn) {
    inRooms += ids.size;
    for (const id of ids) if (s.escorts.get(id)?.room !== roomId) out.push(`escort index: ${id} listed in ${roomId}`);
  }
  if (inRooms !== s.escorts.size) out.push(`escort index holds ${inRooms} entries for ${s.escorts.size} escorts`);
  if (s.escortOfParty.size !== s.escorts.size) out.push(`escort party index holds ${s.escortOfParty.size} entries for ${s.escorts.size} escorts`);
  for (const e of s.escorts.values()) {
    const what = `escort ${e.id}`;
    const q = c.quests.get(e.quest);
    if (q?.kind !== 'escort' || q.escort?.npc !== e.npc || q.escort.to !== e.to) out.push(`${what}: does not match quest ${e.quest}`);
    if (!c.rooms.has(e.room)) out.push(`${what}: in unknown room ${e.room}`);
    if (!Number.isInteger(e.hp) || e.hp <= 0 || e.hp > e.max) out.push(`${what}: HP ${e.hp} of ${e.max}`);
    if (s.escortOfParty.get(e.party) !== e.id) out.push(`${what}: party index points elsewhere`);
    if ((due.get(`escort:${e.id}`) ?? -Infinity) < e.at + BALANCE.escort.stallMs) out.push(`${what}: no stall timer`);
  }
}

/** Friends, rivals, bonds, parties and guilds: every link holds from both ends. */
function checkSocial(s: WorldState, out: string[]): void {
  const B = BALANCE;
  for (const a of s.agents.values()) {
    const who = `agent ${a.id} (${a.name})`;
    if (a.friends.length > B.social.maxFriends) out.push(`${who}: ${a.friends.length} friends`);
    if (Object.keys(a.friendReqs).length > B.social.maxFriendRequests) out.push(`${who}: too many friend requests`);
    if (a.rivals.length > B.social.maxRivals) out.push(`${who}: ${a.rivals.length} rivals`);
    if (new Set(a.friends).size !== a.friends.length || a.friends.includes(a.id)) out.push(`${who}: duplicate or self friend`);
    for (const id of a.friends) if (!s.agents.get(id)?.friends.includes(a.id)) out.push(`${who}: friendship with ${id} is one-sided`);
    const bonds = Object.entries(a.bonds);
    if (bonds.length > B.bond.keep) out.push(`${who}: ${bonds.length} bonds kept`);
    for (const [id, bond] of bonds) {
      if (id === a.id) out.push(`${who}: bond with itself`);
      if (!(bond.v >= 0 && bond.v <= B.bond.max)) out.push(`${who}: bond ${bond.v} with ${id}`);
      const other = s.agents.get(id)?.bonds[a.id];
      if (other && other.v !== bond.v) out.push(`${who}: bond with ${id} is ${bond.v} here and ${other.v} there`);
    }
    if (a.party && !s.parties.get(a.party)?.members.includes(a.id)) out.push(`${who}: in party ${a.party}, which does not list it`);
    if (a.guild && !s.guilds.get(a.guild)?.members.includes(a.id)) out.push(`${who}: in guild ${a.guild}, which does not list it`);
  }

  for (const p of s.parties.values()) {
    const what = `party ${p.id}`;
    if (p.members.length < 1 || p.members.length > B.party.maxSize) out.push(`${what}: ${p.members.length} members`);
    if (new Set(p.members).size !== p.members.length) out.push(`${what}: duplicate member`);
    if (!p.members.includes(p.leader)) out.push(`${what}: leader ${p.leader} is not a member`);
    for (const id of p.members) {
      const a = s.agents.get(id);
      if (a?.party !== p.id) out.push(`${what}: member ${id} points to party ${a?.party}`);
      else if (a.status !== 'active') out.push(`${what}: inactive member ${id}`);
    }
  }

  for (const g of s.guilds.values()) {
    const what = `guild ${g.id} (${g.name})`;
    if (!g.members.length || g.members.length > B.guild.maxMembers) out.push(`${what}: ${g.members.length} members`);
    if (new Set(g.members).size !== g.members.length) out.push(`${what}: duplicate member`);
    if (!g.members.includes(g.leader)) out.push(`${what}: leader ${g.leader} is not a member`);
    if (g.officers.includes(g.leader)) out.push(`${what}: leader listed as officer`);
    for (const id of g.officers) if (!g.members.includes(id)) out.push(`${what}: officer ${id} is not a member`);
    for (const id of g.members) if (s.agents.get(id)?.guild !== g.id) out.push(`${what}: member ${id} points elsewhere`);
    if (!isNatural(g.treasury)) out.push(`${what}: treasury ${g.treasury}`);
    for (const [id, qty] of Object.entries(g.vault)) {
      if (!Number.isInteger(qty) || qty <= 0) out.push(`${what}: ${qty} x ${id} in the vault`);
      if (!s.content.items.has(id)) out.push(`${what}: unknown item ${id} in the vault`);
    }
    if (s.guildNames.get(g.norm) !== g.id || s.guildSkeletons.get(g.skeleton) !== g.id) out.push(`${what}: name index out of sync`);
  }
  for (const [norm, id] of s.guildNames) if (s.guilds.get(id)?.norm !== norm) out.push(`guild name index: ${norm} -> ${id} does not match`);
}

/** Trades, the market and the village treasury, with their derived indexes. */
function checkEconomy(s: WorldState, out: string[]): void {
  const c = s.content;
  const goodsOk = (g: Goods) => isNatural(g.gold) && g.items.every((x) => c.items.has(x.item) && Number.isInteger(x.qty) && x.qty > 0);
  let indexed = 0;
  for (const set of s.tradesOf.values()) indexed += set.size;
  if (indexed !== s.trades.size * 2) out.push(`trade index holds ${indexed} entries for ${s.trades.size} trades`);
  for (const t of s.trades.values()) {
    if (!s.tradesOf.get(t.from)?.has(t.id) || !s.tradesOf.get(t.to)?.has(t.id)) out.push(`trade ${t.id}: missing from the index`);
    if (t.from === t.to) out.push(`trade ${t.id}: with itself`);
    if (!goodsOk(t.give) || !goodsOk(t.want)) out.push(`trade ${t.id}: malformed goods`);
  }

  let books = 0;
  for (const [item, book] of s.ordersByItem) {
    books += book.length;
    for (let i = 0; i < book.length; i++) {
      const o = book[i]!;
      if (o.item !== item || s.market.orders[o.id] !== o) out.push(`market book ${item}: stray order ${o.id}`);
      if (i > 0 && book[i - 1]!.price > o.price) out.push(`market book ${item}: not sorted by price`);
    }
  }
  const orders = Object.values(s.market.orders);
  if (books !== orders.length) out.push(`market: ${orders.length} orders but ${books} in the books`);
  const perSeller = new Map<string, number>();
  for (const o of orders) {
    const what = `order ${o.id}`;
    if (!c.items.has(o.item)) out.push(`${what}: unknown item ${o.item}`);
    if (!Number.isInteger(o.qty) || o.qty <= 0 || !Number.isInteger(o.price) || o.price <= 0) out.push(`${what}: qty ${o.qty} price ${o.price}`);
    if (!s.agents.has(o.seller)) out.push(`${what}: unknown seller ${o.seller}`);
    if (!s.ordersOf.get(o.seller)?.has(o.id)) out.push(`${what}: missing from the seller index`);
    perSeller.set(o.seller, (perSeller.get(o.seller) ?? 0) + 1);
  }
  for (const [seller, n] of perSeller) if (n > BALANCE.market.maxOrders) out.push(`seller ${seller}: ${n} open orders`);
  if (s.market.history.length > BALANCE.market.history) out.push(`market history holds ${s.market.history.length} trades`);
  if (s.board.length > BALANCE.board.maxPosts) out.push(`board holds ${s.board.length} posts`);
  if (!isNatural(s.village.treasury)) out.push(`village treasury ${s.village.treasury}`);
}
