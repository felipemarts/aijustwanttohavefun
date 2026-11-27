import { describe, expect, it } from 'vitest';
import { BALANCE, realDay } from './balance';
import { observe } from './observe';
import { dailyQuests } from './quests';
import { errCode, errKey, HOUR, keys, makeKit, narr, T0, type Kit } from './testkit';
import type { AgentState } from './types';

const DAY = 24 * HOUR;

function walk(k: Kit, a: AgentState, dirs: string) {
  for (const d of dirs.split(' ')) k.ok(a, 'move', { dir: d });
}

function killSlimes(k: Kit, a: AgentState, n: number) {
  let kills = 0;
  for (let i = 0; i < 200 && kills < n; i++) {
    const m = k.monsters(a.room).find((x) => x.kind === 'slime');
    if (!m) {
      k.advance(61_000);
      continue;
    }
    k.ok(a, 'attack', { target: m.uid });
    if (m.hp <= 0) kills++;
    a.hp = k.maxHp(a);
  }
  expect(kills).toBe(n);
}

function questData(r: ReturnType<Kit['act']>): Record<string, unknown> {
  if (!r.result.ok) throw new Error('not ok');
  return r.result.data ?? {};
}

describe('tutorial trail', () => {
  it('chains the first eight quests through requires, with every step type progressing', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    expect(observe(k.s, a.id, k.ctx()).quest_hint).toEqual({ id: 't01_arrival', giver: 'olga', room: 'village.square', state: 'offer' });

    // t01: visit
    const acc = k.ok(a, 'quest_accept', { quest: 't01_arrival' });
    expect(keys(acc)).toEqual(['n.quest_accept', 'content.quest.t01_arrival.desc']);
    expect(questData(acc).quest).toMatchObject({ id: 't01_arrival', ready: false, steps: [{ do: 'visit', target: 'village.tavern', have: 0, need: 1 }] });
    expect(observe(k.s, a.id, k.ctx()).quest_hint!.state).toBe('active');
    const mv = k.ok(a, 'move', { dir: 'north' });
    expect(narr(mv, 'n.quest_ready')).toEqual({ quest: '@quest:t01_arrival', npc: '@npc:olga' });
    k.ok(a, 'move', { dir: 'south' });
    const gold0 = a.gold;
    const done = k.ok(a, 'quest_turn_in', { quest: 't01_arrival' });
    expect(narr(done, 'n.quest_done')).toEqual({ quest: '@quest:t01_arrival', gold: 10 });
    const t01Xp = k.c.quests.get('t01_arrival')!.rewards.xp;
    expect(narr(done, 'n.xp')).toEqual({ xp: t01Xp });
    expect(questData(done).next).toEqual({ id: 't02_innkeeper', giver: 'olga', room: 'village.square' });
    expect(a.gold).toBe(gold0 + 10);
    expect(a.xp).toBe(t01Xp);
    expect(a.quests).toEqual({});
    expect(a.questsDone.t01_arrival).toBe(k.now);
    expect(done.events.find((e) => e.type === 'quest_done')!.payload).toMatchObject({ quest: 't01_arrival', gold: 10 });

    // t02: talk
    k.ok(a, 'quest_accept', { quest: 't02_innkeeper' });
    k.ok(a, 'move', { dir: 'north' });
    expect(keys(k.ok(a, 'talk', { npc: 'berta' }))).toContain('n.quest_ready');
    k.ok(a, 'move', { dir: 'south' });
    k.ok(a, 'quest_turn_in', { quest: 't02_innkeeper' });
    expect(a.inv.bread).toBe(5);

    // t03: shop_buy
    k.ok(a, 'quest_accept', { quest: 't03_supplies' });
    k.ok(a, 'shop_buy', { npc: 'olga', item: 'minor_potion' });
    k.ok(a, 'quest_turn_in', { quest: 't03_supplies' });

    // t04: equip, given by the sergeant
    expect(errKey(k.act(a, 'quest_accept', { quest: 't04_gear_up' }))).toBe('err.quest_giver_elsewhere');
    walk(k, a, 'south west south');
    k.ok(a, 'quest_accept', { quest: 't04_gear_up' });
    expect(keys(k.ok(a, 'equip', { item: 'cloth_armor' }))).toContain('n.quest_ready');
    k.ok(a, 'quest_turn_in', { quest: 't04_gear_up' });

    // t05: kill
    k.ok(a, 'quest_accept', { quest: 't05_first_blood' });
    walk(k, a, 'north north west west');
    expect(a.room).toBe('forest.edge');
    killSlimes(k, a, 2);
    expect(a.quests.t05_first_blood!.steps).toEqual([2]);
    killSlimes(k, a, 2);
    expect(a.quests.t05_first_blood!.steps).toEqual([3]);

    expect(errKey(k.act(a, 'quest_turn_in', { quest: 't05_first_blood' }))).toBe('err.quest_giver_elsewhere');
    expect(errKey(k.act(a, 'quest_accept', { quest: 't06_woodcutter' }))).toBe('err.quest_requires');
    walk(k, a, 'east east south south');
    k.ok(a, 'quest_turn_in', { quest: 't05_first_blood' });
    expect(a.inv.minor_potion).toBe(3);
    walk(k, a, 'north north west west');

    // t06: gather, given by the ranger standing right here
    k.ok(a, 'quest_accept', { quest: 't06_woodcutter' });
    for (let i = 0; i < 3; i++) k.ok(a, 'gather', { resource: 'wood' });
    expect(a.quests.t06_woodcutter!.steps).toEqual([3]);
    expect(errKey(k.act(a, 'quest_turn_in', { quest: 't07_wolf_pelts' }))).toBe('err.quest_not_active');
    k.ok(a, 'quest_turn_in', { quest: 't06_woodcutter' });

    // t07: collect, read from the inventory and consumed on turn-in
    k.ok(a, 'quest_accept', { quest: 't07_wolf_pelts' });
    const incomplete = k.act(a, 'quest_turn_in', { quest: 't07_wolf_pelts' });
    expect(errCode(incomplete)).toBe('NOT_ALLOWED');
    expect(errKey(incomplete)).toBe('err.quest_incomplete');
    a.inv.wolf_pelt = 1;
    expect(k.ok(a, 'quest_list').result).toMatchObject({ data: { quests: { active: [{ id: 't07_wolf_pelts', steps: [{ have: 1, need: 2 }] }] } } });
    a.inv.wolf_pelt = 3;
    k.ok(a, 'quest_turn_in', { quest: 't07_wolf_pelts' });
    expect(a.inv.wolf_pelt).toBe(1);
    expect(a.inv.padded_armor).toBe(1);

    // t08: say (social), given by the innkeeper
    walk(k, a, 'east east east north');
    expect(a.room).toBe('village.tavern');
    k.ok(a, 'quest_accept', { quest: 't08_speak_up' });
    expect(keys(k.ok(a, 'say', { text: 'Hello, tavern!' }))).toContain('n.quest_ready');
    k.ok(a, 'quest_turn_in', { quest: 't08_speak_up' });

    expect(Object.keys(a.questsDone).length).toBe(8);
    expect(a.stats.tutorial_done).toBe(8);
    expect(a.stats.quests_done).toBe(8);
    expect(observe(k.s, a.id, k.ctx()).quest_hint).toMatchObject({ id: 't09_first_friend', state: 'offer' });
    expect(errKey(k.act(a, 'quest_accept', { quest: 't01_arrival' }))).toBe('err.quest_done');
  });

  it('accepting a quest whose state already holds is immediately ready', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    a.questsDone.t06_woodcutter = k.now;
    a.inv.wolf_pelt = 2;
    k.place(a, 'forest.edge');
    const r = k.ok(a, 'quest_accept', { quest: 't07_wolf_pelts' });
    expect(keys(r)).toContain('n.quest_ready');
  });
});

describe('quest rules', () => {
  it('accept errors: unknown, active, level, too many, full bag, combat', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    expect(k.err(a, 'quest_accept', { quest: 'q_dragon' })).toBe('TARGET_NOT_FOUND');
    k.ok(a, 'quest_accept', { quest: 't01_arrival' });
    expect(errKey(k.act(a, 'quest_accept', { quest: 't01_arrival' }))).toBe('err.quest_active');
    k.place(a, 'village.tavern');
    const lvl = k.act(a, 'quest_accept', { quest: 's_sealed_letter' });
    expect(errCode(lvl)).toBe('LEVEL_REQUIRED');
    k.setLevel(a, 8);
    for (let i = 0; i < BALANCE.inventory.maxActiveQuests - 1; i++) a.quests[`fake_${i}`] = { steps: [0], at: k.now };
    expect(errKey(k.act(a, 'quest_accept', { quest: 's_sealed_letter' }))).toBe('err.quest_too_many');
    for (let i = 0; i < BALANCE.inventory.maxActiveQuests - 1; i++) delete a.quests[`fake_${i}`];
    a.inv = { iron_sword: 30 };
    expect(k.err(a, 'quest_accept', { quest: 's_sealed_letter' })).toBe('INVENTORY_FULL');
    a.inv = {};
    const r = k.ok(a, 'quest_accept', { quest: 's_sealed_letter' });
    expect(a.inv.sealed_letter).toBe(1);
    expect(questData(r).quest).toMatchObject({ ready: false });
    const b = k.add('Fighter', 'warrior', { room: 'forest.edge' });
    k.ok(b, 'attack', { target: 'slime' });
    expect(k.err(b, 'quest_accept', { quest: 't06_woodcutter' })).toBe('IN_COMBAT');
  });

  it('turn-in errors: items gone, bag full', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'village.tavern', level: 8 });
    k.ok(a, 'quest_accept', { quest: 's_sealed_letter' });
    a.quests.s_sealed_letter!.steps = [1];
    delete a.inv.sealed_letter;
    const r = k.act(a, 'quest_turn_in', { quest: 's_sealed_letter' });
    expect(errCode(r)).toBe('MISSING_ITEMS');
    expect(!r.result.ok && r.result.error.msg.p?.missing).toBe('sealed_letter x1');

    const b = k.add('Bob', 'warrior');
    k.ok(b, 'quest_accept', { quest: 't01_arrival' });
    b.questsDone.t01_arrival = k.now;
    delete b.quests.t01_arrival;
    k.ok(b, 'quest_accept', { quest: 't02_innkeeper' });
    b.quests.t02_innkeeper!.steps = [1];
    b.inv = { iron_sword: 30 };
    expect(k.err(b, 'quest_turn_in', { quest: 't02_innkeeper' })).toBe('INVENTORY_FULL');
    expect(b.quests.t02_innkeeper).toBeDefined();
  });

  it('kill steps of party quests do not count for a lone agent', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.path' });
    a.quests.t12_pack_hunt = { steps: [0], at: k.now };
    const m = k.monsters('forest.path').find((x) => x.kind === 'wolf')!;
    for (let i = 0; i < 30 && m.hp > 0; i++) {
      k.ok(a, 'attack', { target: m.uid });
      a.hp = k.maxHp(a);
    }
    expect(a.stats.kills).toBe(1);
    expect(a.quests.t12_pack_hunt!.steps).toEqual([0]);
  });
});

describe('daily quests', () => {
  it('offers three per day and level bracket, one of them social, the same for everyone', () => {
    const k = makeKit();
    const seen = new Set<string>();
    for (let d = 0; d < 20; d++) {
      const now = T0 + d * DAY + 5 * HOUR;
      for (const level of [1, 5, 12]) {
        const list = dailyQuests(k.s, now, level);
        expect(list.length).toBe(3);
        expect(new Set(list).size).toBe(3);
        const quests = list.map((id) => k.c.quests.get(id)!);
        expect(quests.every((q) => q.kind === 'daily' && q.level <= level)).toBe(true);
        expect(quests.filter((q) => q.social).length).toBe(1);
        expect(quests[2]!.social).toBe(true);
        // Stable within the day, and independent of the world instance.
        expect(dailyQuests(k.s, now + 10 * HOUR, level)).toEqual(list);
        expect(dailyQuests(makeKit(99).s, now - 4 * HOUR, level)).toEqual(list);
        if (level === 1) seen.add(list.join());
      }
    }
    expect(seen.size).toBeGreaterThan(2);
  });

  it('can be done once per day, and only the ones on offer', () => {
    const k = makeKit();
    const offered = dailyQuests(k.s, k.now, 1);
    const off = [...k.c.quests.values()].find((q) => q.kind === 'daily' && q.level === 1 && !offered.includes(q.id))!;
    const a = k.add('Pip', 'warrior', { room: k.c.npcs.get(off.giver)!.room });
    expect(errKey(k.act(a, 'quest_accept', { quest: off.id }))).toBe('err.quest_not_today');

    // Find a day when the slime cleanup is offered and do it twice.
    let day = 0;
    while (!dailyQuests(k.s, T0 + day * DAY, 1).includes('d_slime_cleanup')) day++;
    k.advance(day * DAY + HOUR);
    const b = k.add('Hunter', 'warrior', { room: 'village.training_yard' });
    k.ok(b, 'quest_accept', { quest: 'd_slime_cleanup' });
    expect(realDay(k.now)).toBe(realDay(T0) + day);
    k.place(b, 'forest.edge');
    killSlimes(k, b, 8);
    k.place(b, 'village.training_yard');
    k.ok(b, 'quest_turn_in', { quest: 'd_slime_cleanup' });
    expect(b.stats.dailies_done).toBe(1);
    expect(errKey(k.act(b, 'quest_accept', { quest: 'd_slime_cleanup' }))).toBe('err.quest_done');
    const lst = k.ok(b, 'quest_list');
    const daily = (questData(lst).quests as { daily: { id: string; done: boolean }[] }).daily;
    expect(daily.find((d) => d.id === 'd_slime_cleanup')!.done).toBe(true);
  });
});
