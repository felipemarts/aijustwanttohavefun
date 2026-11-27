/**
 * Fuzz harness shared by the engine's fuzz tests (fuzz.*.test.ts): plausible commands from what an agent sees, and a
 * loop that checks, after every step, the invariants, the gold balance, that a refused action changed nothing and
 * that pure transfers kept the world's wealth whole. Test-only: not exported from the package.
 */
import { expect } from 'vitest';
import type { ClassId, GameEvent, Rng } from '@ajwf/shared';
import { touch } from './agent';
import { applyAction } from './apply';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { newRun } from './run';
import { HOUR, SEC, worldWealth, type Kit } from './testkit';
import { tick } from './tick';
import type { AgentState, ApplyResult } from './types';

export const CLASSES: ClassId[] = ['warrior', 'mage', 'rogue', 'cleric'];
const JUNK = ['', ' ', 'dragon', 'north-west', '@mon:slime', 'Iron Sword', 'x'.repeat(80), '../etc', 'null'];
const TEXTS = ['hello', 'anyone up for wolves?', 'visit https://spam.example now', 'my key is ajwf_sk_abc123', '​', 'well shit', 'ok'];

export const ANY_ACTION = [
  'move', 'attack', 'cast', 'taunt', 'revive', 'flee', 'release', 'gather', 'craft', 'choose_profession', 'take', 'drop', 'equip', 'unequip', 'use',
  'talk', 'shop_buy', 'shop_sell', 'rest', 'quest_accept', 'quest_turn_in',
];

export const SOCIAL_ACTION = [
  'friend_request', 'friend_accept', 'declare_rival', 'party_invite', 'party_accept', 'party_leave', 'party_loot_mode', 'party_say', 'party_give_loot',
  'trade_offer', 'trade_accept', 'trade_cancel', 'market_sell', 'market_list', 'market_buy', 'market_cancel', 'duel_invite', 'duel_accept',
  'board_post', 'board_reply', 'board_read', 'journal', 'guild_create', 'guild_invite', 'guild_join', 'guild_leave', 'guild_promote',
  'guild_deposit', 'guild_withdraw', 'guild_say', 'give', 'report_scam', 'place_bounty', 'guild_vote_coup',
];

/** Trust and betrayal (§7): PvP goes through attack and cast with agent names. */
export const TRUST_ACTIONS = ['attack', 'attack', 'cast', 'steal', 'give', 'report_scam', 'place_bounty', 'guild_vote_coup', 'revive', 'release'];

/** Class roles and the dungeon puzzles. */
export const PUZZLE_ACTIONS = ['scout', 'enchant', 'pull_lever', 'hold_gate', 'read_runes', 'disarm', 'pick_lock'];

/** Actions that only move gold and items between holders: the world's total wealth must not change. */
export const TRANSFERS = new Set(['trade_accept', 'market_sell', 'market_buy', 'market_cancel', 'guild_deposit', 'guild_withdraw', 'party_give_loot', 'give', 'steal', 'place_bounty', 'report_scam']);

export type Cmd = { action: string; params: Record<string, unknown> };

/** A command that makes sense more often than not, from what the agent can see and carries. */
export function plausible(k: Kit, rng: Rng, a: AgentState, anyActions: readonly string[] = ANY_ACTION): Cmd {
  const c = k.c;
  const s = k.s;
  const o = observe(s, a.id, k.ctx());
  const pick = <T>(xs: readonly T[]): T | undefined => (xs.length ? rng.pick(xs) : undefined);
  const junk = () => rng.pick(JUNK);
  const maybe = <T>(v: T | undefined): T | string => (v === undefined || rng.chance(0.1) ? junk() : v);
  const inv = Object.keys(a.inv);
  const npcs = o.room.npcs.map((n) => n.id);
  const others = o.room.agents.map((x) => x.name);
  const anyName = () => pick([...s.agents.values()].map((x) => x.name)) ?? 'Nobody';
  const someone = () => maybe(rng.chance(0.7) ? pick(others) : anyName());
  const goods = () => ({
    ...(rng.chance(0.5) ? { gold: rng.int(0, 40) } : {}),
    ...(rng.chance(0.6) ? { items: { [String(maybe(pick(inv)))]: rng.int(1, 2) } } : {}),
  });
  const guildGoods = () => {
    const g = a.guild ? s.guilds.get(a.guild) : undefined;
    const held = rng.chance(0.5) && g ? Object.keys(g.vault) : inv;
    return { ...(rng.chance(0.6) ? { gold: rng.int(1, 60) } : {}), ...(rng.chance(0.6) ? { items: [{ item: String(maybe(pick(held))), qty: rng.int(1, 2) }] } : {}) };
  };

  if (rng.chance(0.03)) return { action: rng.pick(['fly', 'give', 'vote', 'guild_vote_coup', 'MOVE']), params: { agent: 'x' } };
  if (rng.chance(0.03)) return { action: rng.pick(['move', 'attack', 'shop_buy', 'say', 'use', 'trade_offer', 'market_sell']), params: { dir: 3, target: [], qty: -1, text: 5, item: null, give: 'x' } };

  // A little intent, so fights finish, the wounded rest, the fallen get up and requests get answered.
  if (o.you.in_combat && rng.chance(0.6)) return { action: 'attack', params: { target: o.you.in_combat } };
  if (o.you.fallen !== undefined && rng.chance(0.3)) return { action: 'release', params: {} };
  if (o.room.flags.includes('tavern') && o.you.hp[0] < o.you.hp[1] && rng.chance(0.5)) return { action: 'rest', params: {} };
  const p = o.pending;
  if (p && rng.chance(0.5)) {
    const answers: Cmd[] = [
      ...(p.trades ? [{ action: rng.chance(0.8) ? 'trade_accept' : 'trade_cancel', params: { trade: rng.pick(p.trades).id } }] : []),
      ...(p.party ? [{ action: 'party_accept', params: { agent: rng.pick(p.party) } }] : []),
      ...(p.friends ? [{ action: 'friend_accept', params: { agent: rng.pick(p.friends) } }] : []),
      ...(p.guild ? [{ action: 'guild_join', params: { guild: rng.pick(p.guild) } }] : []),
      ...(p.duel ? [{ action: 'duel_accept', params: { agent: rng.pick(p.duel) } }] : []),
    ];
    return rng.pick(answers);
  }
  if (a.guild && rng.chance(0.05)) return { action: rng.pick(['guild_deposit', 'guild_withdraw']), params: guildGoods() };
  if (o.room.monsters.length && o.you.hp[0] > o.you.hp[1] / 2 && rng.chance(0.3)) return { action: 'attack', params: { target: rng.pick(o.room.monsters).id } };
  const base = rng.chance(0.7) ? o.actions : anyActions;
  const action = rng.pick(base);
  switch (action) {
    case 'friend_request':
    case 'friend_accept':
    case 'declare_rival':
    case 'party_invite':
    case 'party_accept':
    case 'duel_invite':
    case 'duel_accept':
    case 'guild_invite':
    case 'guild_promote':
      return { action, params: { agent: someone() } };
    case 'party_leave':
    case 'guild_leave':
    case 'board_read':
      return { action, params: action === 'board_read' && rng.chance(0.3) ? { tag: 'rumor' } : {} };
    case 'party_loot_mode':
      return { action, params: { mode: rng.pick(['round_robin', 'leader']) } };
    case 'party_say':
    case 'guild_say':
    case 'journal':
      return { action, params: { text: rng.pick(TEXTS) } };
    case 'party_give_loot':
      return { action, params: { agent: someone(), item: maybe(pick(inv)) } };
    case 'trade_offer':
      return { action, params: { to: someone(), give: goods(), want: goods() } };
    case 'trade_accept':
    case 'trade_cancel':
      return { action, params: { trade: maybe(pick([...s.trades.keys()])) } };
    case 'market_sell':
      return { action, params: { item: maybe(pick(inv)), qty: rng.int(1, 3), price: rng.int(1, 60) } };
    case 'market_list':
      return { action, params: rng.chance(0.5) ? { item: maybe(pick([...s.ordersByItem.keys()])) } : {} };
    case 'market_buy':
    case 'market_cancel': {
      const ids = Object.keys(s.market.orders);
      const mine = [...(s.ordersOf.get(a.id) ?? [])];
      return { action, params: { order: maybe(pick(action === 'market_cancel' && rng.chance(0.8) ? mine : ids)), ...(rng.chance(0.5) ? { qty: rng.int(1, 3) } : {}) } };
    }
    case 'board_post':
      return { action, params: { text: rng.pick(TEXTS), tag: rng.pick(['rumor', 'lfg', 'trade', 'general']) } };
    case 'board_reply':
      return { action, params: { post: maybe(pick(s.board.map((x) => x.id))), text: rng.pick(TEXTS) } };
    case 'guild_create':
      return { action, params: { name: rng.chance(0.8) ? `Order of ${a.name}` : rng.pick(['ab', 'Admin', 'Bad  Spaces', 'Order of Fuzz0']), ...(rng.chance(0.5) ? { motto: rng.pick(TEXTS) } : {}) } };
    case 'guild_join':
      return { action, params: { guild: maybe(pick([...s.guilds.values()].map((g) => g.name))) } };
    case 'guild_deposit':
    case 'guild_withdraw':
      return { action, params: guildGoods() };
    case 'contribute':
      return { action, params: { project: maybe(pick([...(o.room.projects ?? []).map((x) => x.id), ...(o.room.project ? [o.room.project.id] : [])])), ...goods() } };
    case 'move':
      return { action, params: { dir: maybe(pick(Object.keys(o.room.exits))) } };
    case 'attack':
      return { action, params: { target: maybe(pick([...o.room.monsters.map((m) => m.id), ...(rng.chance(0.5) ? others : [])])) } };
    case 'steal':
      return { action, params: { target: someone() } };
    case 'give':
      return { action, params: { to: someone(), ...goods() } };
    case 'report_scam': {
      const g = rng.chance(0.8) ? pick(a.gives) : undefined;
      const to = g ? s.agents.get(g.to)?.name : undefined;
      return { action, params: { agent: rng.chance(0.85) && to ? to : someone(), event_id: g ? (rng.chance(0.9) ? g.id : junk()) : String(rng.int(1, 999)) } };
    }
    case 'place_bounty': {
      const infamous = [...s.agents.values()].filter((x) => x.infamy > 0 && x !== a).map((x) => x.name);
      return { action, params: { agent: maybe(pick(infamous) ?? anyName()), gold: rng.chance(0.1) ? 5 : rng.int(10, 80) } };
    }
    case 'guild_vote_coup':
      return { action, params: {} };
    case 'cast': {
      const skill = maybe(pick(c.classes.get(rng.chance(0.9) ? a.cls : rng.pick(CLASSES))!.skills));
      const kind = c.skills.get(String(skill))?.kind;
      const target = kind === 'heal' || kind === 'revive' ? pick([a.name, ...others]) : pick([...o.room.monsters.map((m) => m.id), ...(rng.chance(0.3) ? others : [])]);
      return { action, params: rng.chance(0.3) || target === undefined ? { skill } : { skill, target } };
    }
    case 'flee':
    case 'release':
    case 'rest':
    case 'inventory':
    case 'quest_list':
      return { action, params: {} };
    case 'gather':
      return { action, params: { resource: maybe(pick(Object.keys(o.room.resources ?? {}))) } };
    case 'talk': {
      const npc = maybe(pick(npcs));
      const topics = c.npcs.get(String(npc))?.topics ?? [];
      return { action, params: rng.chance(0.5) ? { npc } : { npc, topic: maybe(pick(topics)) } };
    }
    case 'shop_buy': {
      const npc = maybe(pick(npcs.filter((n) => c.npcs.get(n)?.shop)));
      const sells = c.shops.get(c.npcs.get(String(npc))?.shop ?? '')?.sells.map((e) => e.item) ?? [];
      return { action, params: { npc, item: maybe(pick(sells)), qty: rng.chance(0.1) ? 40 : rng.int(1, 3) } };
    }
    case 'shop_sell':
      return { action, params: { npc: maybe(pick(npcs)), item: maybe(pick(inv)), qty: rng.int(1, 2) } };
    case 'quest_accept':
    case 'quest_turn_in': {
      const here = npcs.flatMap((n) => c.questsByGiver.get(n) ?? []).map((q) => q.id);
      const mine = Object.keys(a.quests);
      return { action, params: { quest: maybe(pick(action === 'quest_turn_in' && rng.chance(0.7) ? mine : here)) } };
    }
    case 'take':
      return { action, params: { item: maybe(pick(Object.keys(o.room.items ?? {}))), ...(rng.chance(0.5) ? { qty: rng.int(1, 3) } : {}) } };
    case 'choose_profession':
      return { action, params: { profession: rng.pick(['blacksmith', 'alchemist', 'tailor', 'cook']) } };
    case 'craft':
      return { action, params: { recipe: maybe(pick([...c.recipes.values()].filter((r) => r.profession === a.profession).map((r) => r.id))) } };
    case 'say':
      return { action, params: { text: rng.pick(TEXTS) } };
    case 'whisper':
      return { action, params: { to: rng.chance(0.8) ? anyName() : junk(), text: rng.pick(TEXTS) } };
    case 'emote':
      return { action, params: { emote: maybe(pick([...c.emotes.keys()])), ...(rng.chance(0.4) ? { target: maybe(pick(others)) } : {}) } };
    case 'equip':
    case 'use':
    case 'drop':
      return { action, params: { item: maybe(pick(inv)), ...(action === 'drop' && rng.chance(0.5) ? { qty: rng.int(1, 5) } : {}) } };
    case 'unequip':
      return { action, params: { item: maybe(pick(['weapon', 'armor', 'trinket', 'bag', ...Object.values(a.equip).filter((x): x is string => !!x)])) } };
    case 'taunt':
    case 'revive':
      return { action, params: { target: maybe(pick(action === 'revive' ? others : o.room.monsters.map((m) => m.id))) } };
    case 'scout':
      return { action, params: { target: maybe(pick(Object.keys(o.room.exits))) } };
    case 'enchant':
      return { action, params: rng.chance(0.4) ? {} : { target: someone() } };
    case 'pull_lever':
    case 'hold_gate':
    case 'read_runes':
    case 'disarm':
    case 'pick_lock': {
      const mine = (o.room.puzzles ?? []).filter((x) => x.do === action || rng.chance(0.2));
      return { action, params: { target: maybe(pick(mine.flatMap((x) => (rng.chance(0.1) ? [x.id] : x.targets)))) } };
    }
    default:
      return { action, params: {} };
  }
}

/** Gold that the results say was created or destroyed (gold held by guilds and the village still counts as existing). */
export function goldFlow(events: GameEvent[], r?: ApplyResult): number {
  let d = 0;
  for (const e of events) {
    if (e.type === 'kill') for (const g of Object.values(e.payload.gold as Record<string, number>)) d += g;
    if (e.type === 'quest_done') d += e.payload.gold as number;
    if (e.type === 'respawn') d -= e.payload.lost as number;
    if (e.type === 'guild_founded') d -= e.payload.cost as number;
    if (e.type === 'guild_disbanded') d -= (e.payload.lost as { gold: number }).gold;
    // Civic sinks (see civic.fuzz.test.ts for the full civic fuzz).
    if (e.type === 'project_contribution' || e.type === 'mayor_fund') d -= (e.payload.gold as number | undefined) ?? 0;
    if (e.type === 'guild_hall_built') d -= (e.payload.cost as { gold: number }).gold;
  }
  if (r?.result.ok) {
    for (const m of r.result.narration) {
      const g = Number(m.p?.gold ?? 0);
      if (m.k === 'n.shop_sell') d += g;
      if (m.k === 'n.shop_buy' || m.k === 'n.rest') d -= g;
    }
  }
  return d;
}

export type FuzzStats = { ok: Record<string, number>; errors: Record<string, number>; unchanged: number; transfers: number };

/**
 * Lets agents act at random for `steps` actions, checking after each one: the invariants, the gold balance, that a
 * refused action changed nothing, and that pure transfers kept the world's wealth whole.
 */
export function fuzz(k: Kit, rng: Rng, agents: AgentState[], steps: number, anyActions: readonly string[], home?: Map<AgentState, string>): FuzzStats {
  const stats: FuzzStats = { ok: {}, errors: {}, unchanged: 0, transfers: 0 };
  let gold = worldWealth(k.s).gold;
  let a = agents[0]!;
  let burst = 0;
  for (let step = 0; step < steps; step++) {
    // Agents act in bursts of a few quick actions (a fight, a shopping trip), then someone else gets a turn.
    if (burst-- <= 0) {
      a = rng.pick(agents);
      burst = rng.int(1, 15);
      k.now += rng.chance(0.01) ? rng.int(1, 3) * HOUR : rng.int(0, 120) * SEC;
    } else k.now += rng.int(1, 8) * SEC;
    const tickEvents = tick(k.s, k.ctx());
    gold += goldFlow(tickEvents);

    // Wanderers walk back home now and then, so the same agents keep meeting.
    const back = home?.get(a);
    if (back && a.room !== back && !a.combat && !a.fallen && rng.chance(0.2)) k.place(a, back);
    const cmd = plausible(k, rng, a, anyActions);
    const what = () => `step ${step}: ${a.name} ${cmd.action} ${JSON.stringify(cmd.params)}`;
    // Bring the actor up to date first, so an error can be checked to change nothing at all.
    touch(newRun(k.s, k.now, k.rng, a), a, false);
    const before = JSON.stringify([a, k.s.rooms.get(a.room)]);
    const wealth = TRANSFERS.has(cmd.action) ? worldWealth(k.s) : null;
    const room = a.room;
    let r: ApplyResult;
    try {
      r = applyAction(k.s, { agentId: a.id, ...cmd }, k.ctx());
    } catch (e) {
      throw new Error(`${what()} threw ${(e as Error).stack}`, { cause: e });
    }
    if (r.result.ok) {
      stats.ok[cmd.action] = (stats.ok[cmd.action] ?? 0) + 1;
      if (wealth) {
        expect(worldWealth(k.s), what()).toEqual(wealth);
        stats.transfers++;
      }
    } else {
      stats.errors[r.result.error.code] = (stats.errors[r.result.error.code] ?? 0) + 1;
      if (r.events.length === 0) {
        expect(JSON.stringify([a, k.s.rooms.get(room)]), what()).toBe(before);
        stats.unchanged++;
      }
    }
    gold += goldFlow(r.events, r);
    const actual = worldWealth(k.s).gold;
    if (actual !== gold) throw new Error(`${what()}: gold ${actual}, expected ${gold}`);
    const bad = checkInvariants(k.s, k.now);
    if (bad.length) throw new Error(`${what()}:\n${bad.join('\n')}`);
  }
  return stats;
}

