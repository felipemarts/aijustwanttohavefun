import { describe, expect, it } from 'vitest';
import { createRng, type ClassId, type GameEvent, type Rng } from '@ajwf/shared';
import { touch } from './agent';
import { applyAction } from './apply';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { newRun } from './run';
import { HOUR, makeKit, SEC, totalGold, type Kit } from './testkit';
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

type Cmd = { action: string; params: Record<string, unknown> };

/** A command that makes sense more often than not, from what the agent can see and carries. */
function plausible(k: Kit, rng: Rng, a: AgentState): Cmd {
  const c = k.c;
  const o = observe(k.s, a.id, k.ctx());
  const pick = <T>(xs: readonly T[]): T | undefined => (xs.length ? rng.pick(xs) : undefined);
  const junk = () => rng.pick(JUNK);
  const maybe = <T>(v: T | undefined): T | string => (v === undefined || rng.chance(0.1) ? junk() : v);
  const inv = Object.keys(a.inv);
  const npcs = o.room.npcs.map((n) => n.id);
  const others = o.room.agents.map((x) => x.name);
  const anyName = () => pick([...k.s.agents.values()].map((x) => x.name)) ?? 'Nobody';

  if (rng.chance(0.03)) return { action: rng.pick(['fly', 'party_invite', 'trade_offer', 'vote', 'MOVE']), params: { agent: 'x' } };
  if (rng.chance(0.03)) return { action: rng.pick(['move', 'attack', 'shop_buy', 'say', 'use']), params: { dir: 3, target: [], qty: -1, text: 5, item: null } };

  // A little intent, so fights finish, the wounded rest and the fallen get up.
  if (o.you.in_combat && rng.chance(0.6)) return { action: 'attack', params: { target: o.you.in_combat } };
  if (o.you.fallen !== undefined && rng.chance(0.3)) return { action: 'release', params: {} };
  if (o.room.flags.includes('tavern') && o.you.hp[0] < o.you.hp[1] && rng.chance(0.5)) return { action: 'rest', params: {} };
  if (o.room.monsters.length && o.you.hp[0] > o.you.hp[1] / 2 && rng.chance(0.3)) return { action: 'attack', params: { target: rng.pick(o.room.monsters).id } };
  const base = rng.chance(0.7) ? o.actions : ANY_ACTION;
  const action = rng.pick(base);
  switch (action) {
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

/** Gold that the results say was created or destroyed. */
function goldFlow(events: GameEvent[], r?: ApplyResult): number {
  let d = 0;
  for (const e of events) {
    if (e.type === 'kill') for (const g of Object.values(e.payload.gold as Record<string, number>)) d += g;
    if (e.type === 'quest_done') d += e.payload.gold as number;
    if (e.type === 'respawn') d -= e.payload.lost as number;
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
      agents.push(a);
    }
    expect(checkInvariants(k.s, k.now)).toEqual([]);

    const okCount: Record<string, number> = {};
    const errCount: Record<string, number> = {};
    let gold = totalGold(k.s);
    let unchangedChecks = 0;
    let a = agents[0]!;
    let burst = 0;
    for (let step = 0; step < 20_000; step++) {
      // Agents act in bursts of a few quick actions (a fight, a shopping trip), then someone else gets a turn.
      if (burst-- <= 0) {
        a = rng.pick(agents);
        burst = rng.int(1, 15);
        k.now += rng.chance(0.01) ? rng.int(1, 3) * HOUR : rng.int(0, 120) * SEC;
      } else k.now += rng.int(1, 8) * SEC;
      const tickEvents = tick(k.s, k.ctx());
      gold += goldFlow(tickEvents);

      const cmd = plausible(k, rng, a);
      // Bring the actor up to date first, so an error can be checked to change nothing at all.
      touch(newRun(k.s, k.now, k.rng, a), a, false);
      const before = JSON.stringify([a, k.s.rooms.get(a.room)]);
      const room = a.room;
      let r: ApplyResult;
      try {
        r = applyAction(k.s, { agentId: a.id, ...cmd }, k.ctx());
      } catch (e) {
        throw new Error(`step ${step}: ${a.name} ${cmd.action} ${JSON.stringify(cmd.params)} threw ${(e as Error).stack}`, { cause: e });
      }
      if (r.result.ok) okCount[cmd.action] = (okCount[cmd.action] ?? 0) + 1;
      else {
        errCount[r.result.error.code] = (errCount[r.result.error.code] ?? 0) + 1;
        if (r.events.length === 0) {
          expect(JSON.stringify([a, k.s.rooms.get(room)]), `step ${step}: ${cmd.action} ${JSON.stringify(cmd.params)}`).toBe(before);
          unchangedChecks++;
        }
      }
      gold += goldFlow(r.events, r);
      const actual = totalGold(k.s);
      if (actual !== gold) throw new Error(`step ${step}: ${a.name} ${cmd.action} ${JSON.stringify(cmd.params)}: gold ${actual}, expected ${gold}`);
      const bad = checkInvariants(k.s, k.now);
      if (bad.length) throw new Error(`step ${step}: ${a.name} ${cmd.action} ${JSON.stringify(cmd.params)}:\n${bad.join('\n')}`);
    }

    const levels = agents.map((a) => a.level);
    const deaths = agents.reduce((n, a) => n + (a.stats.deaths ?? 0), 0);
    const kills = agents.reduce((n, a) => n + (a.stats.kills ?? 0), 0);
    console.log('fuzz ok actions', okCount);
    console.log('fuzz errors', errCount);
    console.log(`fuzz: kills ${kills}, deaths ${deaths}, levels ${levels.join(' ')}, unchanged-on-error checks ${unchangedChecks}`);
    // The run must have exercised the game, not just bounced off validation.
    for (const action of ['move', 'attack', 'cast', 'gather', 'shop_buy', 'shop_sell', 'equip', 'use', 'quest_accept', 'talk', 'say', 'emote', 'take', 'drop', 'rest', 'release']) {
      expect(okCount[action] ?? 0, action).toBeGreaterThan(0);
    }
    expect(kills).toBeGreaterThan(50);
    expect(deaths).toBeGreaterThan(0);
    expect(unchangedChecks).toBeGreaterThan(1000);
  });
});
