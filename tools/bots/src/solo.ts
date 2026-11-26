/**
 * Scripted solo bot (no LLM). It levels up alone in the forest: picks monsters its size, fights with its class
 * skill, drinks potions, walks back to the tavern to rest, waits for AP, buys potions and wears its armor.
 *
 * The decision is a pure function of what an agent can know through the public API: its observation (`observe`,
 * the same as `GET /look`), its inventory (what the free `inventory` action returns) and the static content.
 * Social bot profiles will sit next to this one and reuse the helpers at the bottom.
 */
import type { Content, Item } from '@ajwf/content';
import { BALANCE, observe, type ActionCtx, type Observation, type WorldState } from '@ajwf/engine';
import type { ActionName } from '@ajwf/shared';

export type BotCommand = { action: ActionName; params: Record<string, unknown> };
export type BotStep = BotCommand | { wait: number };

/** The part of the `inventory` action's answer a bot uses. */
export type InventoryView = {
  items: Record<string, number>;
  equipped: Record<'weapon' | 'armor' | 'trinket' | 'bag', string | null>;
  skills: { id: string; mp: number; level: number; known: boolean }[];
};

export type SoloView = { obs: Observation; inv: InventoryView };

/** Bot temperament. Not game balance: these only shape how cautious the bot is. */
export const SOLO_TUNING = {
  /** Below this share of HP the bot starts no new fight: it heals, eats or waits... */
  fightAbove: 0.7,
  /** ...and below this one it walks back to the tavern to rest. */
  recoverBelow: 0.5,
  /** In a fight, below this share it drinks a potion (or eats). */
  potionBelow: 0.3,
  /** In a fight with nothing to drink, below this share it runs. */
  fleeBelow: 0.2,
  /** With this much AP, time is worth more than the AP a walk to the tavern costs. */
  apRich: 120,
  /** Potions it likes to carry, and the gold it keeps aside for resting. */
  potions: 2,
  restReserve: 3,
  /** Monsters at most this many levels below the bot are still worth hunting. */
  huntBelow: 2,
  /** Waits, in milliseconds. */
  respawnWait: 30_000,
  regenWait: 20 * 60_000,
} as const;

const T = SOLO_TUNING;
const POTIONS = ['minor_potion', 'health_potion', 'greater_potion'];

const cmd = (action: ActionName, params: Record<string, unknown> = {}): BotCommand => ({ action, params });

/** The world as the bot may see it: its observation plus the answer of the free `inventory` action. */
export function soloView(s: WorldState, agentId: string, ctx: ActionCtx): SoloView {
  const obs = observe(s, agentId, ctx);
  const a = s.agents.get(agentId)!;
  const cls = s.content.classes.get(a.cls)!;
  return {
    obs,
    inv: {
      items: { ...a.inv },
      equipped: { ...a.equip },
      skills: cls.skills.map((id) => s.content.skills.get(id)!).map((sk) => ({ id: sk.id, mp: sk.mp, level: sk.level, known: a.level >= sk.level })),
    },
  };
}

/** Next command for a solo bot, or how long to wait before asking again. */
export function stepSoloBot(s: WorldState, agentId: string, ctx: ActionCtx): BotStep {
  return decideSolo(soloView(s, agentId, ctx), s.content);
}

export function decideSolo(view: SoloView, c: Content): BotStep {
  const { obs, inv } = view;
  const me = obs.you;
  const hpShare = me.hp[0] / me.hp[1];
  const missing = me.hp[1] - me.hp[0];

  if (me.fallen !== undefined) return cmd('release');

  if (me.in_combat) {
    if (hpShare < T.potionBelow) {
      const drink = bestHeal(c, inv, missing);
      if (drink) return cmd('use', { item: drink });
      const heal = usableSkill(c, inv, me.mp[0], 'heal');
      if (heal && me.ap[0] >= 1) return cmd('cast', { skill: heal });
      if (hpShare < T.fleeBelow && me.ap[0] >= 1) return cmd('flee');
    }
    if (me.ap[0] < 1) return { wait: BALANCE.ap.regenMs };
    const skill = usableSkill(c, inv, me.mp[0], 'damage');
    return skill ? cmd('cast', { skill, target: me.in_combat }) : cmd('attack', { target: me.in_combat });
  }

  const gear = betterGear(c, inv, me.lvl);
  if (gear) return cmd('equip', { item: gear });

  const restPrice = BALANCE.rest.baseCost + me.lvl * BALANCE.rest.costPerLevel;
  if (hpShare < T.fightAbove) {
    // A healer heals itself; others eat when nothing is wasted, then go to the tavern or wait.
    const heal = usableSkill(c, inv, me.mp[0], 'heal');
    if (heal && me.ap[0] >= 1) return cmd('cast', { skill: heal });
    const food = bestHeal(c, inv, missing, ['food'], 0);
    if (food) return cmd('use', { item: food });
    // Badly hurt, already in the village (hysteresis: once on the way, keep going), or with AP to burn: waiting
    // would only waste the AP that cannot pile up past the maximum.
    const walk = hpShare < T.recoverBelow || obs.room.zone === 'village' || me.ap[0] >= T.apRich;
    if (walk && me.gold >= restPrice) {
      if (obs.room.flags.includes('tavern')) return cmd('rest');
      const dir = stepToward(c, obs.room.id, (r) => r.flags.includes('tavern'));
      if (dir && me.ap[0] >= 1) return cmd('move', { dir });
    }
    const minutes = ((T.fightAbove * me.hp[1] - me.hp[0]) / (me.hp[1] * BALANCE.regen.hpPerMin)) | 0;
    return { wait: Math.min(T.regenWait, Math.max(60_000, minutes * 60_000)) };
  }

  // Rest is free of AP: top up when passing through the tavern anyway.
  if (obs.room.flags.includes('tavern') && hpShare < 0.95 && me.gold >= restPrice) return cmd('rest');

  // Shopping, when in the village with gold to spare.
  const potions = POTIONS.reduce((n, id) => n + (inv.items[id] ?? 0), 0);
  const sells = (npc: string) => c.shops.get(c.npcs.get(npc)?.shop ?? '')?.sells.find((e) => e.item === POTIONS[0]);
  const potionPrice = Math.min(...[...c.npcs.keys()].map((id) => sells(id)?.price ?? Infinity));
  if (potions < T.potions && me.gold >= potionPrice + T.restReserve * restPrice && obs.room.zone === 'village') {
    const seller = obs.room.npcs.find((n) => sells(n.id));
    if (seller) return cmd('shop_buy', { npc: seller.id, item: POTIONS[0] });
    const dir = stepToward(c, obs.room.id, (r) => (c.npcsByRoom.get(r.id) ?? []).some((n) => sells(n.id)), 3);
    if (dir && me.ap[0] >= 1) return cmd('move', { dir });
  }

  if (me.ap[0] < 1) return { wait: BALANCE.ap.regenMs };

  // Hunt.
  const prey = preyKinds(c, me.lvl);
  const here = obs.room.monsters.filter((m) => prey.has(m.id)).sort((x, y) => y.lvl - x.lvl);
  if (here.length) {
    const skill = usableSkill(c, inv, me.mp[0], 'damage');
    const target = here[0]!.id;
    return skill ? cmd('cast', { skill, target }) : cmd('attack', { target });
  }
  const ground = huntingGround(c, obs.room.id, prey);
  if (ground && ground !== obs.room.id) {
    const dir = stepToward(c, obs.room.id, (r) => r.id === ground);
    if (dir) return cmd('move', { dir });
  }
  return { wait: T.respawnWait };
}

// ── Helpers shared with other bot profiles ───────────────────────────────────

/** First step of a shortest path (BFS over open exits) to the nearest room matching `goal`, or null. */
export function stepToward(c: Content, from: string, goal: (r: NonNullable<ReturnType<Content['rooms']['get']>>) => boolean, maxDist = Infinity): string | null {
  const start = c.rooms.get(from);
  if (!start || goal(start)) return null;
  const firstDir = new Map<string, string>([[from, '']]);
  let frontier = [from];
  for (let dist = 1; frontier.length && dist <= maxDist; dist++) {
    const next: string[] = [];
    for (const id of frontier) {
      const room = c.rooms.get(id)!;
      for (const [dir, to] of Object.entries(room.exits)) {
        if (room.gates[dir] || firstDir.has(to)) continue;
        const via = id === from ? dir : firstDir.get(id)!;
        firstDir.set(to, via);
        if (goal(c.rooms.get(to)!)) return via;
        next.push(to);
      }
    }
    frontier = next;
  }
  return null;
}

/** Shortest distances (in moves) from a room to every reachable room. */
export function distances(c: Content, from: string): Map<string, number> {
  const dist = new Map([[from, 0]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const room = c.rooms.get(queue[i]!)!;
    for (const [dir, to] of Object.entries(room.exits)) {
      if (room.gates[dir] || dist.has(to)) continue;
      dist.set(to, dist.get(room.id)! + 1);
      queue.push(to);
    }
  }
  return dist;
}

/** Ordinary monsters a solo agent of this level can take on and still learn from. */
export function preyKinds(c: Content, level: number): Set<string> {
  const out = new Set<string>();
  for (const m of c.monsters.values()) {
    if (m.boss || m.elite || m.solo_crush > 1) continue;
    if (m.level <= level && m.level >= level - T.huntBelow) out.add(m.id);
  }
  // Nothing in range (very high levels): anything not above the agent.
  if (!out.size) for (const m of c.monsters.values()) if (!m.boss && !m.elite && m.level <= level) out.add(m.id);
  return out;
}

/** The room where hunting pays best: many day-time slots of the strongest prey, not too far away. */
export function huntingGround(c: Content, from: string, prey: Set<string>): string | null {
  const dist = distances(c, from);
  let best: string | null = null;
  let bestScore = 0;
  for (const room of c.rooms.values()) {
    const d = dist.get(room.id);
    if (d === undefined) continue;
    let worth = 0;
    for (const m of room.monsters) {
      if (m.night || !prey.has(m.id)) continue;
      const kind = c.monsters.get(m.id)!;
      worth += m.count * kind.xp;
    }
    // Rooms with stronger creatures that do not count as prey are fine: monsters never attack first.
    const score = worth / (d + 3);
    if (score > bestScore || (score === bestScore && best !== null && room.id < best)) {
      best = room.id;
      bestScore = score;
    }
  }
  return best;
}

/** A known skill of the given kind the agent can pay for, preferring the strongest. */
export function usableSkill(c: Content, inv: InventoryView, mp: number, kind: 'damage' | 'heal'): string | null {
  const ok = inv.skills
    .filter((s) => s.known && s.mp <= mp)
    .map((s) => c.skills.get(s.id)!)
    .filter((s) => s.kind === kind && s.cooldown_sec === 0)
    .sort((x, y) => y.power - x.power);
  return ok[0]?.id ?? null;
}

/** The carried potion or food that heals the most of what is missing (the smaller one on ties), wasting at most `maxWaste` HP. */
export function bestHeal(c: Content, inv: InventoryView, missing: number, types: Item['type'][] = ['consumable', 'food'], maxWaste = Infinity): string | null {
  let best: { id: string; heal: number; useful: number } | null = null;
  for (const [id, qty] of Object.entries(inv.items)) {
    const item = c.items.get(id);
    const heal = item?.effect?.heal ?? 0;
    if (!item || qty <= 0 || heal <= 0 || !types.includes(item.type) || heal - missing > maxWaste) continue;
    const useful = Math.min(heal, missing);
    if (!best || useful > best.useful || (useful === best.useful && heal < best.heal)) best = { id, heal, useful };
  }
  return best?.id ?? null;
}

/** An item in the bag that beats what is worn in its slot (more attack or defense), or null. */
export function betterGear(c: Content, inv: InventoryView, level: number): string | null {
  const cls = c.skills.get(inv.skills[0]?.id ?? '')?.class;
  const score = (it: Item | undefined) => (it?.stats ? (it.stats.atk ?? 0) * 2 + (it.stats.def ?? 0) * 2 + (it.stats.str ?? 0) + (it.stats.int ?? 0) + (it.stats.agi ?? 0) + (it.stats.vit ?? 0) : 0);
  for (const id of Object.keys(inv.items)) {
    const item = c.items.get(id);
    if (!item || (item.type !== 'weapon' && item.type !== 'armor' && item.type !== 'trinket')) continue;
    if (item.level > level || (item.classes && (!cls || !item.classes.includes(cls)))) continue;
    const worn = inv.equipped[item.type];
    if (score(item) > score(worn ? c.items.get(worn) : undefined)) return id;
  }
  return null;
}
