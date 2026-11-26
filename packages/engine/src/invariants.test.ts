import { describe, expect, it } from 'vitest';
import { createRng, type ClassId, type GameEvent, type Rng } from '@ajwf/shared';
import { touch } from './agent';
import { applyAction } from './apply';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { newRun } from './run';
import { HOUR, makeKit, SEC, worldWealth, type Kit } from './testkit';
import { tick } from './tick';
import type { AgentState, ApplyResult } from './types';

describe('checkInvariants', () => {
  it('is empty for a fresh world', () => {
    const k = makeKit();
    k.add('Pip', 'warrior');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('reports each kind of violation', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Wild', 'mage', { claimed: false });
    a.gold = -1;
    a.ap = 999;
    a.hp = 10_000;
    a.inv.wood = 0;
    a.inv.iron_sword = 40;
    b.level = 7;
    b.hp = 0;
    k.s.roomAgents.get('village.square')!.delete(b.id);
    const m = k.monsters('forest.edge')[0]!;
    m.hp = 0;
    k.monsters('forest.edge').push({ ...k.monsters('forest.edge')[1]!, uid: 'mx' });
    k.monsters('forest.path').push({ uid: 'my', kind: 'dragon', hp: 5, slot: -1, threat: {}, taunt: null, lastHit: 0 });
    k.s.rooms.get('forest.edge')!.resources.wood!.qty = 99;
    const v = checkInvariants(k.s, k.now).join('\n');
    for (const bit of ['gold -1', 'AP 999', 'above max', '0 x wood', 'inventory slots', 'unclaimed agent at level 7', 'while standing', 'missing from the index', 'HP 0', 'second living monster', 'unknown kind', 'stock 99']) {
      expect(v).toContain(bit);
    }
  });
});

// ── Fuzz ──────────────────────────────────────────────────────────────────────

const CLASSES: ClassId[] = ['warrior', 'mage', 'rogue', 'cleric'];
const JUNK = ['', ' ', 'dragon', 'north-west', '@mon:slime', 'Iron Sword', 'x'.repeat(80), '../etc', 'null'];
const TEXTS = ['hello', 'anyone up for wolves?', 'visit https://spam.example now', 'my key is ajwf_sk_abc123', '​', 'well shit', 'ok'];

const ANY_ACTION = [
  'move', 'attack', 'cast', 'taunt', 'revive', 'flee', 'release', 'gather', 'craft', 'choose_profession', 'take', 'drop', 'equip', 'unequip', 'use',
  'talk', 'shop_buy', 'shop_sell', 'rest', 'quest_accept', 'quest_turn_in',
];

const SOCIAL_ACTION = [
  'friend_request', 'friend_accept', 'declare_rival', 'party_invite', 'party_accept', 'party_leave', 'party_loot_mode', 'party_say', 'party_give_loot',
  'trade_offer', 'trade_accept', 'trade_cancel', 'market_sell', 'market_list', 'market_buy', 'market_cancel', 'duel_invite', 'duel_accept',
  'board_post', 'board_reply', 'board_read', 'journal', 'guild_create', 'guild_invite', 'guild_join', 'guild_leave', 'guild_promote',
  'guild_deposit', 'guild_withdraw', 'guild_say',
];

/** Actions that only move gold and items between holders: the world's total wealth must not change. */
const TRANSFERS = new Set(['trade_accept', 'market_sell', 'market_buy', 'market_cancel', 'guild_deposit', 'guild_withdraw', 'party_give_loot']);

type Cmd = { action: string; params: Record<string, unknown> };

/** A command that makes sense more often than not, from what the agent can see and carries. */
function plausible(k: Kit, rng: Rng, a: AgentState, anyActions: readonly string[] = ANY_ACTION): Cmd {
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
    case 'move':
      return { action, params: { dir: maybe(pick(Object.keys(o.room.exits))) } };
    case 'attack':
      return { action, params: { target: maybe(pick(o.room.monsters.map((m) => m.id))) } };
    case 'cast': {
      const skill = maybe(pick(c.classes.get(rng.chance(0.9) ? a.cls : rng.pick(CLASSES))!.skills));
      const kind = c.skills.get(String(skill))?.kind;
      const target = kind === 'heal' || kind === 'revive' ? pick([a.name, ...others]) : pick(o.room.monsters.map((m) => m.id));
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
    default:
      return { action, params: {} };
  }
}

/** Gold that the results say was created or destroyed (gold held by guilds and the village still counts as existing). */
function goldFlow(events: GameEvent[], r?: ApplyResult): number {
  let d = 0;
  for (const e of events) {
    if (e.type === 'kill') for (const g of Object.values(e.payload.gold as Record<string, number>)) d += g;
    if (e.type === 'quest_done') d += e.payload.gold as number;
    if (e.type === 'respawn') d -= e.payload.lost as number;
    if (e.type === 'guild_founded') d -= e.payload.cost as number;
    if (e.type === 'guild_disbanded') d -= (e.payload.lost as { gold: number }).gold;
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

type FuzzStats = { ok: Record<string, number>; errors: Record<string, number>; unchanged: number; transfers: number };

/**
 * Lets agents act at random for `steps` actions, checking after each one: the invariants, the gold balance, that a
 * refused action changed nothing, and that pure transfers kept the world's wealth whole.
 */
function fuzz(k: Kit, rng: Rng, agents: AgentState[], steps: number, anyActions: readonly string[], home?: Map<AgentState, string>): FuzzStats {
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

describe('fuzz', () => {
  it('20,000 plausible and implausible actions by 30 agents keep every invariant and conserve gold', () => {
    const k = makeKit(2026);
    const rng = createRng(77);
    const rooms = ['village.square', 'village.tavern', 'village.smithy', 'forest.edge', 'forest.path', 'forest.glade', 'forest.old_oak', 'forest.creek', 'hills.trail', 'mines.entrance'];
    const agents: AgentState[] = [];
    for (let i = 0; i < 30; i++) {
      const a = k.add(`Fuzz${i}`, CLASSES[i % 4]!, { claimed: i % 6 !== 5, room: rooms[i % rooms.length], level: i % 6 === 5 ? 1 + (i % 3) : 1 + (i % 7) });
      a.gold = rng.int(0, 300);
      if (i % 5 === 0) Object.assign(a.inv, { iron_ore: 6, coal: 3, copper_ore: 2, stone: 2, minor_potion: 2, red_dye: 1, small_bag: 1, cos_chef_hat: 1 });
      if (i % 9 === 0) a.mutedUntil = k.now + 2 * HOUR;
      // The ones starting at the tavern arrive wounded, so resting gets exercised.
      if (a.room === 'village.tavern') a.hp = 1;
      agents.push(a);
    }
    expect(checkInvariants(k.s, k.now)).toEqual([]);

    const f = fuzz(k, rng, agents, 20_000, [...ANY_ACTION, ...SOCIAL_ACTION]);
    const levels = agents.map((a) => a.level);
    const deaths = agents.reduce((n, a) => n + (a.stats.deaths ?? 0), 0);
    const kills = agents.reduce((n, a) => n + (a.stats.kills ?? 0), 0);
    console.log('fuzz ok actions', f.ok);
    console.log('fuzz errors', f.errors);
    console.log(`fuzz: kills ${kills}, deaths ${deaths}, levels ${levels.join(' ')}, unchanged-on-error checks ${f.unchanged}`);
    // The run must have exercised the game, not just bounced off validation.
    for (const action of ['move', 'attack', 'cast', 'gather', 'shop_buy', 'shop_sell', 'equip', 'use', 'quest_accept', 'talk', 'say', 'emote', 'take', 'drop', 'rest', 'release']) {
      expect(f.ok[action] ?? 0, action).toBeGreaterThan(0);
    }
    expect(kills).toBeGreaterThan(50);
    expect(deaths).toBeGreaterThan(0);
    expect(f.unchanged).toBeGreaterThan(1000);
  });

  it('12,000 social and trading actions in the village keep every invariant and conserve gold and items', () => {
    const k = makeKit(4242);
    const rng = createRng(99);
    const rooms = ['village.market', 'village.tavern', 'village.guild_hall', 'village.training_yard', 'village.square', 'forest.edge'];
    const agents: AgentState[] = [];
    for (let i = 0; i < 18; i++) {
      const a = k.add(`Soc${i}`, CLASSES[i % 4]!, { claimed: i % 9 !== 8, room: rooms[i % rooms.length], level: i % 9 === 8 ? 2 : i % 3 === 0 ? 11 : 1 + (i % 5) });
      a.gold = rng.int(200, 900);
      Object.assign(a.inv, { iron_ore: 6, wood: 5, minor_potion: 3, wolf_pelt: 2, bread: 4 });
      agents.push(a);
    }
    // Social actions dominate: what the room suggests, or any social action at all.
    const f = fuzz(k, rng, agents, 12_000, SOCIAL_ACTION, new Map(agents.map((a) => [a, a.room])));
    console.log('social fuzz ok actions', f.ok);
    console.log('social fuzz errors', f.errors);
    console.log(`social fuzz: transfers checked ${f.transfers}, unchanged-on-error checks ${f.unchanged}`);
    for (const action of [
      'friend_request', 'friend_accept', 'declare_rival', 'party_invite', 'party_accept', 'party_leave', 'party_say', 'trade_offer', 'trade_accept',
      'trade_cancel', 'market_sell', 'market_buy', 'market_list', 'duel_invite', 'duel_accept', 'board_post', 'board_read', 'journal', 'guild_create',
      'guild_invite', 'guild_join', 'guild_deposit', 'guild_withdraw', 'guild_say',
    ]) {
      expect(f.ok[action] ?? 0, action).toBeGreaterThan(0);
    }
    expect(f.transfers).toBeGreaterThan(100);
    expect(f.unchanged).toBeGreaterThan(500);
  });
});
