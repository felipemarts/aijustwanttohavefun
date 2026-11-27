/**
 * Behaviours shared by the scripted profiles: travel along routes, survive, fight sensibly, keep supplied, follow
 * the tutorial trail and the dailies, gather, sell, chat. Each one looks at the view and returns a step, or null
 * when it has nothing to do right now, so profiles compose them as an ordered list of preferences.
 */
import type { Content, Item, Quest } from '@ajwf/content';
import { BALANCE, realDay, restPrice, route } from '@ajwf/engine';
import { hashString, type ActionName } from '@ajwf/shared';
import { CHAT_LINES, EMOTES } from '../personality';
import { bestHeal, betterGear, decideSolo, SOLO_TUNING, usableSkill, type BotCommand, type BotStep } from '../solo';
import type { AgentView, DecideCtx, QuestView } from './types';

export const cmd = (action: ActionName, params: Record<string, unknown> = {}): BotCommand => ({ action, params });

/** Bot temperament (not game balance). */
export const BOT = {
  /** Short pause when there is nothing better to do here (a monster respawning, a party member coming). */
  shortWait: 45_000,
  /** A room found without prey or resources is left alone for this long. */
  avoidMs: 4 * 60_000,
  /** Gold kept aside for resting and potions before buying gear. */
  gearReserve: 40,
  /** Shared chat throttle for small talk. */
  chatEveryMs: 4 * 60_000,
  /** Items worth keeping a few of; everything else that a shop buys is sold when the bag fills. */
  sellWhenSlotsAbove: 18,
  /** Short pauses spent at an empty hunting room, waiting for a respawn, before trying another room. */
  groundWaits: 3,
  /** A resource room found empty is left alone this long (regrowth is slow, crowds are many). */
  depletedMs: 20 * 60_000,
  /** A grouped bot with party mates in the room stops starting fights below this share of HP (solo: 0.7). */
  groupFightAbove: 0.55,
  /** Below this share of HP a bot walks to the tavern; above it, out of town, it rests where it stands. */
  walkToRestBelow: 0.4,
} as const;

const POTION = 'minor_potion';
const HOUR = 3_600_000;

// ── Small helpers ────────────────────────────────────────────────────────────

export function stableHash(s: string): number {
  return parseInt(hashString(s).slice(0, 8), 16);
}

/** Wanted: the village refuses service (shops, the inn) until the Infamy decays. */
export function isWantedMe(v: AgentView): boolean {
  return v.obs.you.title === 'wanted' || (v.obs.you.infamy ?? 0) > BALANCE.infamy.wanted;
}

export function hpShare(v: AgentView): number {
  return v.obs.you.hp[0] / v.obs.you.hp[1];
}

export function inVillage(v: AgentView): boolean {
  return v.obs.room.zone === 'village';
}

export function have(v: AgentView, item: string): number {
  return v.inv.items[item] ?? 0;
}

export function npcRoom(c: Content, npc: string): string | undefined {
  return c.npcs.get(npc)?.room;
}

/** Party members standing in the room, as seen. */
export function partyHereSeen(v: AgentView): AgentView['obs']['room']['agents'] {
  return v.obs.room.agents.filter((a) => a.rel === 'party');
}

export function seen(v: AgentView): AgentView['obs']['room']['agents'] {
  return v.obs.room.agents;
}

const distCache = new WeakMap<Content, Map<string, Map<string, number>>>();

/** Moves from a room to every room reachable without crossing a gate. Cached: content never changes. */
export function distancesFrom(c: Content, from: string): Map<string, number> {
  let byRoom = distCache.get(c);
  if (!byRoom) distCache.set(c, (byRoom = new Map()));
  let d = byRoom.get(from);
  if (!d) {
    d = new Map([[from, 0]]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const room = c.rooms.get(queue[i]!)!;
      for (const [dir, to] of Object.entries(room.exits)) {
        if (room.gates[dir] || d.has(to)) continue;
        d.set(to, d.get(room.id)! + 1);
        queue.push(to);
      }
    }
    byRoom.set(from, d);
  }
  return d;
}

/** One step along the shortest route to a room; null when already there or the way is closed. */
export function travel(v: AgentView, x: DecideCtx, to: string): BotStep | null {
  const here = v.obs.room.id;
  if (here === to) return null;
  const path = route(x.c, here, to);
  const dir = path?.[0];
  if (!dir || v.obs.room.locked?.[dir]) return null;
  if (v.obs.you.ap[0] < 1) return { wait: BALANCE.ap.regenMs };
  const step = cmd('move', { dir });
  destinations.set(step, to);
  return step;
}

/** Where each move returned by `travel` was heading, so the walk can be finished (see `commit` and `keepGoing`). */
const destinations = new WeakMap<object, string>();
const GOAL_MS = 15 * 60_000;

/**
 * Called by every profile on the step it returns: a move towards a destination becomes the bot's goal, so the
 * next decisions finish that walk instead of flip-flopping between two wishes that rank rooms by distance.
 */
export function commit(x: DecideCtx, step: BotStep, now: number): BotStep {
  const to = destinations.get(step);
  if (to) x.mem.ext.goal = { room: to, until: now + GOAL_MS };
  else if (!('wait' in step)) delete x.mem.ext.goal;
  return step;
}

/** Keeps walking to the current goal, if any (after survival, which always comes first). */
export function keepGoing(v: AgentView, x: DecideCtx): BotStep | null {
  const g = x.mem.ext.goal as { room: string; until: number } | undefined;
  if (!g) return null;
  if (g.room === v.obs.room.id || v.now > g.until || v.obs.you.in_combat) {
    delete x.mem.ext.goal;
    return null;
  }
  const step = travel(v, x, g.room);
  if (!step) delete x.mem.ext.goal;
  return step;
}

/** Nearest room (by moves) among candidates, skipping the ones the bot avoids. */
export function nearest(v: AgentView, x: DecideCtx, rooms: Iterable<string>, maxDist = Infinity): string | null {
  const d = distancesFrom(x.c, v.obs.room.id);
  let best: string | null = null;
  let bestD = Infinity;
  for (const r of rooms) {
    const dist = d.get(r);
    if (dist === undefined || dist > maxDist || avoided(x, r, v.now)) continue;
    if (dist < bestD || (dist === bestD && best !== null && r < best)) {
      best = r;
      bestD = dist;
    }
  }
  return best;
}

export function avoided(x: DecideCtx, room: string, now: number): boolean {
  return (x.mem.avoid.get(room) ?? 0) > now;
}

export function avoid(x: DecideCtx, room: string, now: number, ms: number = BOT.avoidMs): void {
  x.mem.avoid.set(room, now + ms);
}

// ── Talking ──────────────────────────────────────────────────────────────────

export function smallTalk(v: AgentView, x: DecideCtx, force = false): BotStep | null {
  if (!force && v.now - x.mem.lastChatAt < BOT.chatEveryMs) return null;
  x.mem.lastChatAt = v.now;
  const others = v.obs.room.agents;
  if (x.rng.chance(0.3)) {
    const target = others.length && x.rng.chance(0.5) ? x.rng.pick(others).name : undefined;
    return cmd('emote', { emote: x.rng.pick(EMOTES), ...(target ? { target } : {}) });
  }
  return cmd('say', { text: x.rng.pick(CHAT_LINES[x.lang]) });
}

// ── Survival and combat ──────────────────────────────────────────────────────

/** The monster kinds a bot of this level hunts. Elites and group bosses only with a party around. */
export function preyFor(c: Content, level: number, grouped: boolean, below = 3, above = 0, inDungeon = false): Set<string> {
  const outside = openWorldKinds(c);
  const fits = (m: Content['monsters'] extends Map<string, infer M> ? M : never) =>
    !m.boss && m.min_group <= 1 && !(m.solo_crush >= 2 && !grouped) && !(m.elite && !grouped) && (inDungeon || outside.has(m.id));
  const out = new Set<string>();
  for (const m of c.monsters.values()) if (fits(m) && m.level <= level + above && m.level >= level - below) out.add(m.id);
  if (out.size) return out;
  // Nothing of this level outside the dungeon: the strongest open-world prey not above the agent.
  let top = 0;
  for (const m of c.monsters.values()) if (fits(m) && m.level <= level + above) top = Math.max(top, m.level);
  for (const m of c.monsters.values()) if (fits(m) && m.level <= level + above && m.level >= top - below) out.add(m.id);
  return out;
}

const openWorldCache = new WeakMap<Content, Set<string>>();
/** Monster kinds that live somewhere outside the dungeon (dungeon rooms are behind its gates and puzzles). */
function openWorldKinds(c: Content): Set<string> {
  let s = openWorldCache.get(c);
  if (!s) {
    s = new Set();
    for (const r of c.rooms.values()) if (!r.flags.includes('dungeon')) for (const m of r.monsters) s.add(m.id);
    openWorldCache.set(c, s);
  }
  return s;
}

/**
 * Fallen, fighting or hurt: what keeps the bot alive. A grouped bot with a Cleric of its party standing by waits for
 * a revive instead of walking back from the temple, and asks the party for a heal instead of walking to the tavern.
 */
export function survive(v: AgentView, x: DecideCtx, grouped: boolean): BotStep | null {
  const me = v.obs.you;
  const cleric = grouped && seen(v).some((a) => a.rel === 'party' && a.class === 'cleric' && !a.fallen);
  if (me.fallen !== undefined) {
    if (cleric && me.fallen > 20) return { wait: 20_000 };
    return cmd('release');
  }
  if (me.in_combat) {
    if (grouped && v.cls === 'warrior' && v.obs.you.lvl >= 5 && partyHereSeen(v).length > 0) {
      const at = (x.mem.ext.tauntAt as number | undefined) ?? -Infinity;
      if (v.now - at > 40_000 && me.mp[0] >= 5 && me.ap[0] >= 1 && hpShare(v) > 0.4) {
        x.mem.ext.tauntAt = v.now;
        return cmd('taunt', { target: me.in_combat });
      }
    }
    if (cleric && hpShare(v) < SOLO_TUNING.potionBelow + 0.1 && v.now - x.mem.askedHealAt > 30_000) {
      x.mem.askedHealAt = v.now;
      return cmd('party_say', { text: 'heal me please' });
    }
    return decideSolo(v, x.c);
  }
  // Wanted: no inn will take us; recover where we stand.
  if (isWantedMe(v) && !me.in_combat && hpShare(v) < SOLO_TUNING.fightAbove) {
    const food = snack(v, x);
    if (food) return food;
    const heal = usableSkill(x.c, v.inv, v.obs.you.mp[0], 'heal');
    if (heal && me.ap[0] >= 1) return cmd('cast', { skill: heal });
    return { wait: 5 * 60_000 };
  }
  // With party mates around (a Warrior to taunt, a Cleric to heal, someone to finish the kill) keep fighting lower.
  const mates = grouped && partyHereSeen(v).length > 0;
  if (hpShare(v) < (mates ? BOT.groupFightAbove : SOLO_TUNING.fightAbove)) {
    if (cleric && v.cls !== 'cleric') {
      if (v.now - x.mem.askedHealAt > 60_000) {
        x.mem.askedHealAt = v.now;
        return cmd('party_say', { text: 'heal me please' });
      }
      if (v.now - x.mem.askedHealAt < 40_000) return { wait: BOT.shortWait };
    }
    // With party mates here, recover on the spot: their kills keep sharing XP while we rest, no walk to the tavern.
    if (mates && hpShare(v) >= 0.2) {
      const food = snack(v, x);
      if (food) return food;
      const heal = usableSkill(x.c, v.inv, v.obs.you.mp[0], 'heal');
      if (heal && v.obs.you.ap[0] >= 1) return cmd('cast', { skill: heal });
      return { wait: 60_000 };
    }
    // Alone, only scratched, far from town and short of AP: rest where it stands rather than spend AP walking to the
    // tavern and back (with AP to spare, the walk is worth it: the session goes on).
    if (!inVillage(v) && hpShare(v) >= BOT.walkToRestBelow && v.obs.you.ap[0] < SOLO_TUNING.apRich) {
      const food = snack(v, x);
      if (food) return food;
      const heal = usableSkill(x.c, v.inv, v.obs.you.mp[0], 'heal');
      if (heal && v.obs.you.ap[0] >= 1) return cmd('cast', { skill: heal });
      const minutes = Math.ceil((SOLO_TUNING.fightAbove - hpShare(v)) / BALANCE.regen.hpPerMin);
      return { wait: Math.max(60_000, minutes * 60_000) };
    }
    return decideSolo(v, x.c);
  }
  return null;
}

/** Attack (or cast) a prey monster in this room, preferring one already wounded: someone is fighting it. */
export function strikeHere(v: AgentView, x: DecideCtx, prey: Set<string>, saveMp = false): BotStep | null {
  const here = v.obs.room.monsters.filter((m) => prey.has(m.id) && m.n > 0);
  if (!here.length) return null;
  if (v.obs.you.ap[0] < 1) return { wait: BALANCE.ap.regenMs };
  const wounded = here.find((m) => m.hp);
  const target = (wounded ?? [...here].sort((a, b) => b.lvl - a.lvl)[0]!).id;
  const skill = usableSkill(x.c, v.inv, saveMp ? v.obs.you.mp[0] / 2 : v.obs.you.mp[0], 'damage');
  return skill ? cmd('cast', { skill, target }) : cmd('attack', { target });
}

/** Rooms worth hunting in for this prey, best first: many daytime slots of the strongest prey, not too far. */
export function huntingGrounds(c: Content, from: string, prey: Set<string>): string[] {
  const dist = distancesFrom(c, from);
  const scored: [string, number][] = [];
  for (const room of c.rooms.values()) {
    const d = dist.get(room.id);
    if (d === undefined) continue;
    let worth = 0;
    for (const m of room.monsters) {
      if (m.night || !prey.has(m.id)) continue;
      worth += m.count * c.monsters.get(m.id)!.xp;
    }
    if (worth > 0) scored.push([room.id, worth / (d + 3)]);
  }
  return scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

/**
 * Hunts: fights prey here, otherwise walks to a good hunting room. Crowded rooms (found empty) are avoided for a
 * while; bots spread over the best few rooms by name so a crowd does not pile into the single best one.
 */
export function hunt(v: AgentView, x: DecideCtx, prey: Set<string>, saveMp = false): BotStep | null {
  const strike = strikeHere(v, x, prey, saveMp);
  if (strike) {
    x.mem.ext.groundWaits = 0;
    return strike;
  }
  const here = v.obs.room.id;
  const grounds = huntingGrounds(x.c, here, prey);
  if (grounds.includes(here)) {
    // Monsters come back quickly where people are: waiting a little costs no AP, walking does.
    const waited = (x.mem.ext.groundWaits as number | undefined) ?? 0;
    if (waited < BOT.groundWaits) {
      x.mem.ext.groundWaits = waited + 1;
      return { wait: BOT.shortWait };
    }
    avoid(x, here, v.now);
  }
  x.mem.ext.groundWaits = 0;
  let open = grounds.filter((r) => !avoided(x, r, v.now));
  // Every good room was found empty lately: go back to the best ones and wait there (crowds bring monsters back faster).
  if (!open.length) {
    open = grounds.slice(0, 2);
    if (open.includes(here)) return { wait: BOT.shortWait };
  }
  if (!open.length) return null;
  // Keep walking to the room chosen before (the ranking changes with distance as the bot moves).
  const key = [...prey].sort().join(',');
  const prev = x.mem.ext.ground as { room: string; key: string } | undefined;
  let pick = prev && prev.key === key && open.includes(prev.room) ? prev.room : undefined;
  if (!pick) {
    pick = open[stableHash(v.name + v.obs.you.lvl) % Math.min(2, open.length)]!;
    x.mem.ext.ground = { room: pick, key };
  }
  return travel(v, x, pick);
}

// ── Supplies ─────────────────────────────────────────────────────────────────

function shopsSelling(c: Content, item: string): { npc: string; room: string; price: number }[] {
  const out: { npc: string; room: string; price: number }[] = [];
  for (const n of c.npcs.values()) {
    const e = n.shop ? c.shops.get(n.shop)?.sells.find((s) => s.item === item) : undefined;
    if (e && c.rooms.get(n.room)?.zone === 'village') out.push({ npc: n.id, room: n.room, price: e.price });
  }
  return out;
}

/** Buys `item` from the nearest village shop that sells it (walking there), or null when it cannot. */
export function buyFromShop(v: AgentView, x: DecideCtx, item: string, qty = 1): BotStep | null {
  if (isWantedMe(v)) return null;
  const shops = shopsSelling(x.c, item);
  if (!shops.length || v.obs.you.gold < shops[0]!.price * qty) return null;
  // A full bag only takes more of what it already holds.
  const bag = v.obs.you.bag;
  if (bag && bag[0] >= bag[1] && have(v, item) === 0) return null;
  const here = shops.find((s) => s.room === v.obs.room.id);
  if (here) return cmd('shop_buy', { npc: here.npc, item, qty });
  const to = nearest(v, x, shops.map((s) => s.room));
  return to ? travel(v, x, to) : null;
}

function gearScore(it: Item | undefined): number {
  const s = it?.stats;
  return s ? (s.atk ?? 0) * 2 + (s.def ?? 0) * 2 + (s.str ?? 0) + (s.int ?? 0) + (s.agi ?? 0) + (s.vit ?? 0) : 0;
}

/** A shop item that beats what is worn, for this class and level, affordable with a reserve. */
function gearToBuy(v: AgentView, c: Content): string | null {
  let best: { id: string; gain: number } | null = null;
  for (const slot of ['weapon', 'armor'] as const) {
    const worn = gearScore(c.items.get(v.inv.equipped[slot] ?? ''));
    for (const n of c.npcs.values()) {
      if (!n.shop || c.rooms.get(n.room)?.zone !== 'village') continue;
      for (const e of c.shops.get(n.shop)!.sells) {
        const it = c.items.get(e.item)!;
        if (it.type !== slot || it.level > v.obs.you.lvl || (it.classes && !it.classes.includes(v.cls))) continue;
        if (e.price + BOT.gearReserve > v.obs.you.gold || have(v, it.id) > 0) continue;
        const gain = gearScore(it) - worn;
        if (gain > 0 && (!best || gain > best.gain)) best = { id: it.id, gain };
      }
    }
  }
  return best?.id ?? null;
}

/** Equip better gear, buy potions and better gear in the village, rest when passing the tavern hurt. */
export function keepSupplied(v: AgentView, x: DecideCtx): BotStep | null {
  const gear = betterGear(x.c, v.inv, v.obs.you.lvl);
  if (gear) return cmd('equip', { item: gear });
  if (!inVillage(v) || isWantedMe(v)) return null;
  const restCost = restPrice(v.obs.you.lvl);
  const me = v.obs.you;
  if (v.obs.room.flags.includes('tavern') && (me.hp[0] < me.hp[1] * 0.9 || me.mp[0] < me.mp[1] * 0.5) && me.gold >= restCost) return cmd('rest');
  const toBuy = gearToBuy(v, x.c);
  if (toBuy) return buyFromShop(v, x, toBuy);
  const potions = have(v, POTION) + have(v, 'health_potion') + have(v, 'greater_potion');
  if (potions < SOLO_TUNING.potions && me.gold >= 25 + 3 * restCost) return buyFromShop(v, x, POTION);
  return null;
}

/** Items the bot keeps (quest needs, its trade); everything else a shop buys is fair game for selling. */
export function sellJunk(v: AgentView, x: DecideCtx, keep: Set<string>): BotStep | null {
  if (!inVillage(v) || isWantedMe(v)) return null;
  const c = x.c;
  const used = Object.keys(v.inv.items).length;
  if (used < BOT.sellWhenSlotsAbove && v.obs.you.gold > 60) return null;
  const sellable = (npc: string): string | null => {
    const shop = c.shops.get(c.npcs.get(npc)?.shop ?? '');
    if (!shop) return null;
    for (const [id, qty] of Object.entries(v.inv.items)) {
      const it = c.items.get(id);
      if (!it || qty <= 0 || keep.has(id) || it.type === 'quest' || !(shop.buys as string[]).includes(it.type)) continue;
      if (it.type === 'consumable' || it.type === 'food') continue;
      // Gear: only what is no better than what is worn.
      if ((it.type === 'weapon' || it.type === 'armor' || it.type === 'trinket') && gearScore(it) > gearScore(c.items.get(v.inv.equipped[it.type] ?? ''))) continue;
      return id;
    }
    return null;
  };
  for (const n of v.obs.room.npcs) {
    const item = sellable(n.id);
    if (item) return cmd('shop_sell', { npc: n.id, item, qty: v.inv.items[item]! });
  }
  if (used < BOT.sellWhenSlotsAbove || !sellable('olga')) return null;
  // The general store buys almost anything.
  return travel(v, x, npcRoom(c, 'olga')!);
}

// ── Gathering ────────────────────────────────────────────────────────────────

export function resourceRooms(c: Content, item: string): string[] {
  return [...c.rooms.values()].filter((r) => !r.flags.includes('lawless') && r.resources.some((x) => x.id === item)).map((r) => r.id);
}

/** Gathers one of `wanted` here, or walks to the nearest room (within `maxDist` moves) that has some. */
export function gather(v: AgentView, x: DecideCtx, wanted: string[], maxDist = Infinity): BotStep | null {
  const res = v.obs.room.resources ?? {};
  const bag = v.obs.you.bag;
  // A full bag only takes more of what it already holds.
  const here = wanted.filter((id) => (res[id] ?? 0) > 0 && !(bag && bag[0] >= bag[1] && have(v, id) === 0));
  if (here.length) return v.obs.you.ap[0] >= 2 ? cmd('gather', { resource: here[0]! }) : { wait: BALANCE.ap.regenMs };
  if (wanted.some((id) => id in res)) avoid(x, v.obs.room.id, v.now, BOT.depletedMs);
  const rooms = new Set(wanted.flatMap((id) => resourceRooms(x.c, id)));
  const to = nearest(v, x, rooms, maxDist);
  return to ? travel(v, x, to) : null;
}

// ── Quests ───────────────────────────────────────────────────────────────────

/** Step kinds a solo bot can do on its own. Grouped (social) bots also do the ones that need other agents. */
const SOLO_STEPS = new Set(['visit', 'talk', 'shop_buy', 'equip', 'kill', 'gather', 'collect', 'say', 'emote', 'board_post', 'journal', 'level', 'profession', 'craft', 'rest', 'contribute']);
const SOCIAL_STEPS = new Set([...SOLO_STEPS, 'friend', 'trade', 'party']);

export type QuestPolicy = {
  /** Can take part in quests that need other agents (friend, trade, party, party_min). */
  social: boolean;
  /** Extra step kinds this profile handles (market, guild, vote). */
  extra?: string[];
  grouped: boolean;
  /** Called for steps the shared code does not know how to do. */
  custom?: (v: AgentView, x: DecideCtx, q: QuestView, step: QuestView['steps'][number]) => BotStep | null;
};

function doable(x: DecideCtx, q: Quest, level: number, p: QuestPolicy): boolean {
  if (x.mem.abandoned.has(q.id)) return false;
  if (q.kind === 'escort' || (q.party_min > 1 && !p.social)) return false;
  const kinds = p.social ? SOCIAL_STEPS : SOLO_STEPS;
  return q.steps.every((st) => {
    if (!kinds.has(st.type) && !p.extra?.includes(st.type)) return false;
    if (st.type === 'kill') {
      const m = st.target ? x.c.monsters.get(st.target) : undefined;
      if (m && (m.level > level + 1 || m.boss || (m.elite && q.party_min <= 1))) return false;
    }
    if (st.type === 'collect' && st.target) return collectSource(x.c, st.target, level) !== null;
    return true;
  });
}

/** How to come by an item: a resource to gather, a monster that drops it, or a shop. */
function collectSource(c: Content, item: string, level: number): { kind: 'gather' | 'hunt' | 'buy'; id: string } | null {
  if (resourceRooms(c, item).length) return { kind: 'gather', id: item };
  let mon: { id: string; chance: number } | null = null;
  for (const m of c.monsters.values()) {
    if (m.boss || m.elite || m.level > level + 1) continue;
    const d = m.drops.find((dr) => dr.item === item);
    if (d && (!mon || d.chance > mon.chance)) mon = { id: m.id, chance: d.chance };
  }
  if (mon && mon.chance >= 0.2) return { kind: 'hunt', id: mon.id };
  if (shopsSelling(c, item).length) return { kind: 'buy', id: item };
  return null;
}

/** Items the active quests ask the bot to hold (not to be sold). */
export function questKeep(v: AgentView): Set<string> {
  const out = new Set<string>();
  for (const q of v.quests) for (const st of q.steps) if (st.target && (st.do === 'collect' || st.do === 'deliver')) out.add(st.target);
  return out;
}

/** Reads what the previous action answered: the daily quests from `quest_list`. */
export function absorbLast(v: AgentView, x: DecideCtx): void {
  const last = v.last;
  if (!last) return;
  if (last.action === 'quest_list' && last.ok) {
    const qs = last.data?.quests as { daily?: { id: string; done: boolean }[] } | undefined;
    x.mem.daily = { day: realDay(v.now), level: v.obs.you.lvl, ids: (qs?.daily ?? []).filter((d) => !d.done).map((d) => d.id) };
  }
  if (last.action === 'quest_accept' && !last.ok) x.mem.abandoned.add(String(last.params.quest));
  if (last.action === 'quest_turn_in' && !last.ok && last.code === 'MISSING_ITEMS') x.mem.abandoned.add(String(last.params.quest));
  if (last.action === 'board_read' && last.ok) {
    const posts = (last.data?.posts as { by: string; tag: string }[] | undefined) ?? [];
    for (const p of posts) {
      if (p.by === v.name) continue;
      if (p.tag === 'lfg') x.mem.lfg.set(p.by, v.now);
      if (p.tag === 'campaign' && !x.mem.candidates.includes(p.by)) x.mem.candidates.push(p.by);
    }
  }
  // Someone we invited already found a group, or left: forget them.
  if (last.action === 'party_invite' && !last.ok) x.mem.lfg.delete(String(last.params.agent));
  if (last.action === 'vote' && !last.ok) x.mem.candidates = x.mem.candidates.filter((n) => n !== last.params.candidate);
  for (const [name, at] of x.mem.lfg) if (v.now - at > 45 * 60_000) x.mem.lfg.delete(name);
}

// ── Answering other agents ───────────────────────────────────────────────────

/** Value of goods at item base price. */
export function goodsWorth(c: Content, g: { gold?: number; items?: Record<string, number> }): number {
  let v = g.gold ?? 0;
  for (const [id, qty] of Object.entries(g.items ?? {})) v += (c.items.get(id)?.value ?? 0) * qty;
  return v;
}

/**
 * Answers what other agents asked: friend requests, guild invites, and guaranteed trades that are fair (what we pay
 * is worth at most a little more than what we get, and we have it). Party invites are the social profiles' business.
 */
export function answerPending(v: AgentView, x: DecideCtx, o: { friends?: boolean; guild?: boolean; trades?: boolean }): BotStep | null {
  const p = v.obs.pending;
  if (!p) return null;
  if (o.friends && p.friends?.length) return cmd('friend_accept', { agent: p.friends[0]! });
  const noGuild = (x.mem.ext.noGuild as Set<string> | undefined) ?? new Set<string>();
  x.mem.ext.noGuild = noGuild;
  if (v.last?.action === 'guild_join' && !v.last.ok) noGuild.add(String(v.last.params.guild));
  const guild = p.guild?.find((g) => !noGuild.has(g));
  if (o.guild && guild && !v.obs.you.guild) return cmd('guild_join', { guild });
  if (o.trades && p.trades?.length) {
    for (const t of p.trades) {
      if ((x.mem.ext.declined as Set<string> | undefined)?.has(t.id)) continue;
      // Nothing from an agent we stopped trusting (see trust.ts).
      if ((x.mem.ext.trust as { distrust?: Map<string, string> } | undefined)?.distrust?.has(t.from)) continue;
      const pay = goodsWorth(x.c, t.want);
      const get = goodsWorth(x.c, t.give);
      const canPay = (t.want.gold ?? 0) <= v.obs.you.gold && Object.entries(t.want.items ?? {}).every(([id, n]) => have(v, id) >= n);
      const here = v.obs.room.agents.some((a) => a.name === t.from);
      if (canPay && here && pay <= get * 1.6 + 5) return cmd('trade_accept', { trade: t.id });
      const declined = (x.mem.ext.declined as Set<string> | undefined) ?? new Set<string>();
      declined.add(t.id);
      x.mem.ext.declined = declined;
    }
  }
  return null;
}

/** During an election: learn the candidates from the board's campaign posts, then vote for one. */
export function civicVote(v: AgentView, x: DecideCtx): BotStep | null {
  if (!v.obs.actions?.includes('vote')) return null;
  const cands = x.mem.candidates.filter((n) => n !== v.name);
  if (cands.length) return cmd('vote', { candidate: cands[stableHash(v.name) % cands.length]! });
  if (v.now - x.mem.boardReadAt < 30 * 60_000) return null;
  if (v.obs.room.flags.includes('board')) {
    x.mem.boardReadAt = v.now;
    return cmd('board_read', { tag: 'campaign' });
  }
  return inVillage(v) ? travel(v, x, 'village.square') : null;
}

/** One step of the work an active quest asks for, or null when this bot cannot (or need not) do anything for it. */
function questWork(v: AgentView, x: DecideCtx, q: QuestView, p: QuestPolicy): BotStep | null {
  const c = x.c;
  const lvl = v.obs.you.lvl;
  for (const st of q.steps) {
    if (st.have >= st.need) continue;
    const t = st.target;
    switch (st.do) {
      case 'visit':
        if (t) return travel(v, x, t);
        break;
      case 'talk':
        if (t) {
          const room = npcRoom(c, t);
          if (room && room === v.obs.room.id) return cmd('talk', { npc: t });
          if (room) return travel(v, x, room);
        }
        break;
      case 'shop_buy':
        if (t) return buyFromShop(v, x, t);
        break;
      case 'equip':
        if (t && have(v, t)) return cmd('equip', { item: t });
        if (t) return buyFromShop(v, x, t);
        break;
      case 'kill': {
        if (q.party_min && q.party_min > 1) break; // the party's hunt handles it
        const prey = t ? new Set([t]) : preyFor(c, lvl, p.grouped);
        return hunt(v, x, prey);
      }
      case 'gather':
        if (t) return gather(v, x, [t], QUEST_GATHER_DIST);
        break;
      case 'collect': {
        if (!t) break;
        const src = collectSource(c, t, lvl);
        if (src?.kind === 'gather') return gather(v, x, [t], QUEST_GATHER_DIST);
        if (src?.kind === 'hunt') return hunt(v, x, new Set([src.id]));
        if (src?.kind === 'buy') return buyFromShop(v, x, t, st.need - st.have);
        break;
      }
      case 'say':
        return cmd('say', { text: x.rng.pick(CHAT_LINES[x.lang]) });
      case 'emote':
        return cmd('emote', { emote: t ?? x.rng.pick(EMOTES) });
      case 'board_post': {
        if (v.obs.room.flags.includes('board')) {
          if (v.now - x.mem.postedAt < BALANCE.board.postCooldownMs) return { wait: BOT.shortWait };
          x.mem.postedAt = v.now;
          return cmd('board_post', { text: 'Greetings from a new adventurer. Happy to help anyone who needs it.', tag: 'general' });
        }
        return travel(v, x, 'village.tavern');
      }
      case 'journal':
        return cmd('journal', { text: `Day ${realDay(v.now)}: level ${lvl}, still learning the ways of Mistvale.` });
      case 'rest':
        if (v.obs.room.flags.includes('tavern')) return v.obs.you.hp[0] < v.obs.you.hp[1] || v.obs.you.mp[0] < v.obs.you.mp[1] ? cmd('rest') : null;
        return travel(v, x, 'village.tavern');
      case 'profession':
        if (!v.profession && lvl >= 5) return cmd('choose_profession', { profession: (x.mem.ext.profession as string | undefined) ?? defaultProfession(v, x) });
        break;
      case 'craft':
        return craftSomething(v, x);
      case 'contribute':
        return contributeSomething(v, x);
      case 'friend': {
        const asked = (x.mem.ext.friendAsked as Set<string> | undefined) ?? new Set<string>();
        x.mem.ext.friendAsked = asked;
        const who = v.obs.room.agents.find((a) => a.rel !== 'friend' && !a.fallen && !asked.has(a.name));
        if (who) {
          asked.add(who.name);
          return cmd('friend_request', { agent: who.name });
        }
        return inVillage(v) && v.obs.room.id !== 'village.tavern' ? travel(v, x, 'village.tavern') : null;
      }
      case 'trade': {
        // A small, fair guaranteed trade: something cheap for its base value in gold.
        const item = Object.keys(v.inv.items).find((id) => {
          const it = c.items.get(id);
          return it && (it.type === 'material' || it.type === 'food') && !questKeep(v).has(id);
        });
        // Friends answer; strangers may well ignore the offer.
        const who = v.obs.room.agents.find((a) => !a.fallen && a.rel === 'friend') ?? (x.rng.chance(0.2) ? v.obs.room.agents.find((a) => !a.fallen) : undefined);
        const since = v.now - ((x.mem.ext.tradeAt as number | undefined) ?? 0);
        // Give the partner a moment to answer.
        if (since < 2 * 60_000) return { wait: BOT.shortWait };
        if (item && who && since > 5 * 60_000) {
          x.mem.ext.tradeAt = v.now;
          return cmd('trade_offer', { to: who.name, give: { items: { [item]: 1 } }, want: { gold: Math.max(1, c.items.get(item)!.value) } });
        }
        return inVillage(v) && v.obs.room.id !== 'village.market' && !who ? travel(v, x, 'village.market') : null;
      }
      default: {
        const custom = p.custom?.(v, x, q, st);
        if (custom) return custom;
      }
    }
  }
  return null;
}

export function defaultProfession(v: AgentView, x: DecideCtx): string {
  const profs = ['cook', 'blacksmith', 'alchemist', 'tailor'];
  return profs[stableHash(v.name + x.seed) % profs.length]!;
}

/** The first recipe each profession can make from things a bot can gather or buy cheaply. */
export const STARTER_RECIPE: Record<string, string> = { cook: 'char_coal', blacksmith: 'blow_flasks', alchemist: 'mix_green_dye', tailor: 'sew_chef_hat' };

/** Works towards one craft of the profession's starter recipe: gather or buy the inputs, walk to the station. */
export function craftSomething(v: AgentView, x: DecideCtx, recipeId?: string): BotStep | null {
  const prof = v.profession;
  if (!prof) return null;
  const r = x.c.recipes.get(recipeId ?? STARTER_RECIPE[prof] ?? '');
  if (!r || r.level > v.obs.you.lvl) return null;
  for (const input of r.inputs) {
    if (have(v, input.item) >= input.qty) continue;
    if (resourceRooms(x.c, input.item).length) return gather(v, x, [input.item]);
    return buyFromShop(v, x, input.item, input.qty - have(v, input.item));
  }
  const station = [...x.c.rooms.values()].filter((room) => room.stations.includes(r.station) && room.zone === 'village').map((room) => room.id);
  if (station.includes(v.obs.room.id)) return v.obs.you.ap[0] >= 2 ? cmd('craft', { recipe: r.id }) : { wait: BALANCE.ap.regenMs };
  const to = nearest(v, x, station);
  return to ? travel(v, x, to) : null;
}

/**
 * Gives something useful to a village project: materials the bot carries that a project still needs, otherwise a
 * little gold. Walks to the town hall first. The `/village` read model says what is missing.
 */
export function contributeSomething(v: AgentView, x: DecideCtx, goldShare = 0.15, minGold = 5): BotStep | null {
  const vil = v.village();
  const open = vil.projects.filter((p) => p.status === 'available' && p.missing);
  if (!open.length) return null;
  // Only walk to the town hall with something a project still needs.
  const canGive = open.some((p) => Object.keys(p.missing!.items).some((item) => have(v, item) > 0) || (p.missing!.gold > 0 && Math.floor(v.obs.you.gold * goldShare) >= minGold));
  if (!canGive) return null;
  if (!v.obs.room.flags.includes('town_hall')) return travel(v, x, 'village.town_hall');
  // The mayor's priority first (topped up by the village), then the one closest to done.
  open.sort((a, b) => Number(b.id === vil.priority) - Number(a.id === vil.priority) || b.progress - a.progress);
  for (const p of open) {
    const items: Record<string, number> = {};
    for (const [item, qty] of Object.entries(p.missing!.items)) if (have(v, item) > 0) items[item] = Math.min(qty, have(v, item));
    const gold = Math.min(p.missing!.gold, Math.floor(v.obs.you.gold * goldShare));
    if (Object.keys(items).length || gold >= minGold) {
      return cmd('contribute', { project: p.id, ...(Object.keys(items).length ? { items } : {}), ...(gold >= minGold && p.missing!.gold > 0 ? { gold } : {}) });
    }
  }
  return null;
}

/**
 * The quest loop: turn in what is ready, take the next tutorial quest and today's dailies when this profile can do
 * them, then work on the active ones (tutorial first). Asks `quest_list` once per real day and level bracket.
 */
/** Decisions spent on a quest without progress before it is set aside, and for how long. */
const QUEST_PATIENCE = 40;
/** A quest does not send the bot further than this to gather (resources are contested; walking costs AP). */
const QUEST_GATHER_DIST = 2;
const QUEST_REST_MS = 4 * HOUR;

export function quests(v: AgentView, x: DecideCtx, p: QuestPolicy): BotStep | null {
  const c = x.c;
  const lvl = v.obs.you.lvl;
  const here = v.obs.room.id;
  // Ready: hand in.
  for (const q of v.quests) {
    if (!q.ready || x.mem.abandoned.has(q.id)) continue;
    const room = npcRoom(c, q.giver);
    if (room === here) return cmd('quest_turn_in', { quest: q.id });
    const go = room ? travel(v, x, room) : null;
    if (go) return go;
  }
  // The tutorial trail.
  const hint = v.obs.quest_hint;
  if (hint && hint.state === 'offer') {
    const q = c.quests.get(hint.id);
    if (q && q.level <= lvl && doable(x, q, lvl, p)) {
      if (hint.room === here) return cmd('quest_accept', { quest: q.id });
      const go = travel(v, x, hint.room);
      if (go) return go;
    }
  }
  // Dailies: ask once per day and bracket, then take the doable ones.
  const day = realDay(v.now);
  const bracket = (l: number) => (l >= 12 ? 3 : l >= 10 ? 2 : l >= 5 ? 1 : 0);
  if (!x.mem.daily || x.mem.daily.day !== day || bracket(x.mem.daily.level) !== bracket(lvl)) {
    x.mem.skipped.clear();
    for (const id of [...x.mem.abandoned]) if (c.quests.get(id)?.kind === 'daily') x.mem.abandoned.delete(id);
    return cmd('quest_list');
  }
  const active = new Set(v.quests.map((q) => q.id));
  for (const id of x.mem.daily.ids) {
    if (active.has(id) || x.mem.skipped.has(id)) continue;
    const q = c.quests.get(id);
    if (!q || !doable(x, q, lvl, p) || active.size >= BALANCE.inventory.maxActiveQuests - 1) {
      x.mem.skipped.add(id);
      continue;
    }
    const room = npcRoom(c, q.giver)!;
    // Only detour for a daily when its giver is close.
    const dist = distancesFrom(c, here).get(room);
    if (dist === undefined || dist > 6) {
      x.mem.skipped.add(id);
      continue;
    }
    if (room === here) {
      x.mem.daily.ids = x.mem.daily.ids.filter((d) => d !== id);
      return cmd('quest_accept', { quest: id });
    }
    return travel(v, x, room);
  }
  // Work: tutorial first, then the rest.
  const ordered = [...v.quests].sort((a, b) => Number(b.kind === 'tutorial') - Number(a.kind === 'tutorial'));
  const tries = (x.mem.ext.qtries as Record<string, { have: number; n: number; skipUntil: number }> | undefined) ?? {};
  x.mem.ext.qtries = tries;
  let walk: BotStep | null = null;
  for (const q of ordered) {
    if (x.mem.abandoned.has(q.id) || q.ready) continue;
    const def = c.quests.get(q.id);
    if (!def || !doable(x, def, lvl, p)) continue;
    // A quest that does not move after many tries (nobody to trade with, prey always taken) rests for a while.
    const prog = q.steps.reduce((n, st) => n + st.have, 0);
    const t = tries[q.id] ?? { have: prog, n: 0, skipUntil: 0 };
    tries[q.id] = t;
    if (t.skipUntil > v.now) continue;
    if (t.have !== prog) {
      t.have = prog;
      t.n = 0;
    }
    const step = questWork(v, x, q, p);
    if (!step) continue;
    if (++t.n > QUEST_PATIENCE) {
      t.n = 0;
      t.skipUntil = v.now + QUEST_REST_MS;
      continue;
    }
    // Work that can be done right here comes before work that needs a walk.
    if (!('action' in step) || step.action !== 'move') return step;
    walk ??= step;
  }
  return walk;
}

/** Heals with food or potions out of combat when nothing is wasted; used when no tavern is near. */
export function snack(v: AgentView, x: DecideCtx): BotStep | null {
  const missing = v.obs.you.hp[1] - v.obs.you.hp[0];
  const food = bestHeal(x.c, v.inv, missing, ['food'], 0);
  return food ? cmd('use', { item: food }) : null;
}

/** Hours in a real day, for the profiles' daily routines. */
export const DAY_MS = 24 * HOUR;
