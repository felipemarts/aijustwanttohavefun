import { describe, expect, it } from 'vitest';
import { derive } from './agent';
import { BALANCE } from './balance';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { exportAll, restoreWorld, type Snapshot } from './snapshot';
import { HOUR, keys, makeKit, MIN, narr, partyUp, SEC, T0, type Kit } from './testkit';
import type { AgentState, MonsterInst } from './types';
import { nextWorldBossAt, worldBossInfo, worldBossLeadMs } from './worldboss';

const W = BALANCE.worldBoss;
const SPAWN = T0 + W.hourUtc * HOUR;

function colossus(k: Kit): MonsterInst | undefined {
  return k.monsters(W.room).find((m) => m.kind === W.monster);
}

function persist(k: Kit): Snapshot {
  return JSON.parse(JSON.stringify(exportAll(k.s))) as Snapshot;
}

describe('world boss schedule', () => {
  it('is announced ahead, rises at the fixed time, leaves after an hour if not beaten, and comes back the next day', () => {
    const k = makeKit();
    expect(nextWorldBossAt(T0)).toBe(SPAWN);
    expect(nextWorldBossAt(SPAWN)).toBe(SPAWN + 24 * HOUR);
    expect(worldBossInfo(k.s)).toEqual({ monster: W.monster, room: W.room, at: SPAWN, up: false });
    const watcher = k.add('Watcher', 'warrior');
    // Too early in the day: nothing in the observation yet.
    expect(observe(k.s, watcher.id, k.ctx()).world_boss).toBeUndefined();

    const before = k.advance(SPAWN - worldBossLeadMs(k.s) - k.now - SEC);
    expect(before.find((e) => e.type === 'world_boss_soon')).toBeUndefined();
    const soon = k.advance(SEC).find((e) => e.type === 'world_boss_soon')!;
    expect(soon).toMatchObject({ visibility: 'public', roomId: W.room, payload: { m: { k: 'ev.world_boss_soon', p: { mon: '@mon:ancient_colossus', minutes: 30, need: 8 } } } });
    expect(soon.drama).toBeGreaterThanOrEqual(7);
    expect(observe(k.s, watcher.id, k.ctx()).world_boss).toEqual({ id: W.monster, room: W.room, in: 30 });

    const rise = k.advance(30 * MIN).find((e) => e.type === 'world_boss')!;
    expect(rise).toMatchObject({ visibility: 'public', drama: 10, payload: { m: { k: 'ev.world_boss_spawn' } } });
    expect(colossus(k)).toMatchObject({ slot: -1, hp: k.c.monsters.get(W.monster)!.hp });
    expect(observe(k.s, watcher.id, k.ctx()).world_boss).toEqual({ id: W.monster, room: W.room, up: true });
    expect(worldBossInfo(k.s)).toMatchObject({ up: true, leaves: SPAWN + W.stayMs, at: SPAWN + 24 * HOUR });
    expect(checkInvariants(k.s, k.now)).toEqual([]);

    const gone = k.advance(W.stayMs).find((e) => e.type === 'world_boss_left')!;
    expect(gone).toMatchObject({ visibility: 'public', payload: { m: { k: 'ev.world_boss_left' } } });
    expect(colossus(k)).toBeUndefined();
    // Gone for today: tomorrow is another day.
    expect(observe(k.s, watcher.id, k.ctx()).world_boss).toBeUndefined();
    expect(checkInvariants(k.s, k.now)).toEqual([]);
    const next = [];
    for (let t = 0; t < 24 * HOUR; t += 10 * MIN) next.push(...k.advance(10 * MIN));
    expect(next.map((e) => e.type)).toEqual(expect.arrayContaining(['world_boss_soon', 'world_boss', 'world_boss_left']));
    expect(next.filter((e) => e.type === 'world_boss_soon')).toHaveLength(1);
  });

  it('survives a restart: the schedule, the announcement already made and the living boss', () => {
    const k = makeKit();
    k.advance(SPAWN - k.now + 10 * MIN);
    const boss = colossus(k)!;
    boss.hp -= 500;
    const s = restoreWorld(k.c, persist(k), k.now);
    expect(s.worldBoss).toEqual(k.s.worldBoss);
    expect(s.rooms.get(W.room)!.monsters.find((m) => m.uid === boss.uid)!.hp).toBe(boss.hp);
    expect(checkInvariants(s, k.now)).toEqual([]);
    // A snapshot from before the world boss existed gets a fresh schedule.
    const legacy = persist(k);
    legacy.world = legacy.world.filter((e) => !['wboss', 'puzzles', 'escorts'].includes(e.key));
    legacy.world.find((e) => e.key === 'timers')!.data = (legacy.world.find((e) => e.key === 'timers')!.data as { kind: string }[]).filter((t) => t.kind !== 'wboss');
    for (const e of legacy.world) if (e.key === `room:${W.room}`) (e.data as { monsters: MonsterInst[] }).monsters = [];
    const old = restoreWorld(k.c, legacy, k.now);
    expect(old.worldBoss.next).toBe(SPAWN + 24 * HOUR);
    expect(old.puzzles.dungeon_levers).toEqual({ open: 0, pulls: {}, hold: null, winch: 0, ready: 0 });
    expect(checkInvariants(old, k.now)).toEqual([]);
    // A server down through a whole appearance does not bring back a stale boss.
    const late = restoreWorld(k.c, persist(k), SPAWN + 3 * HOUR);
    expect(late.worldBoss.next).toBe(SPAWN + 24 * HOUR);
  });
});

/** Eight (or `n`) level-15 agents at the pass, in solo play. */
function crowd(k: Kit, n: number): AgentState[] {
  return Array.from({ length: n }, (_, i) => {
    const a = k.add(`Giant${i}`, (['warrior', 'mage', 'rogue', 'cleric'] as const)[i % 4]!, { level: 15, room: W.room });
    return a;
  });
}

describe('group boss (min_group)', () => {
  it('takes a tenth of the damage while fewer than 8 fight it, and says why', () => {
    const k = makeKit();
    k.advance(SPAWN - k.now);
    const few = crowd(k, 3);
    const boss = colossus(k)!;
    const r = k.ok(few[0]!, 'attack', { target: W.monster });
    expect(narr(r, 'n.group_boss_weak')).toEqual({ mon: '@mon:ancient_colossus', n: 1, need: 8 });
    const dealt = k.c.monsters.get(W.monster)!.hp - boss.hp;
    const atk = derive(k.c, few[0]!, k.now).atk;
    // Never more than a tenth of the best possible full hit (crit included).
    expect(dealt).toBeLessThanOrEqual(Math.max(1, Math.round(atk * 1.15 * BALANCE.combat.critMult * BALANCE.group.underGroupDamage)));
    few[1]!.hp = 1000;
    expect(narr(k.ok(few[1]!, 'attack', { target: W.monster }), 'n.group_boss_weak')).toMatchObject({ n: 2 });
  });

  it('eight fighters hit it fully; everyone with kill credit rolls the drop table on their own', () => {
    const k = makeKit();
    k.advance(SPAWN - k.now);
    const eight = crowd(k, 8);
    const boss = colossus(k)!;
    for (const a of eight) {
      const r = k.ok(a, 'attack', { target: W.monster });
      a.hp = k.maxHp(a);
      // The first seven are still too few when they strike.
      if (a !== eight[7]) expect(keys(r)).toContain('n.group_boss_weak');
      else expect(keys(r)).not.toContain('n.group_boss_weak');
    }
    const hp = boss.hp;
    k.ok(eight[0]!, 'attack', { target: W.monster });
    const full = hp - boss.hp;
    expect(full).toBeGreaterThan(10);
    // Finish it: everyone keeps hitting (and stays alive), so everyone has a share.
    boss.hp = 400;
    for (let i = 0; i < 400 && colossus(k); i++) {
      const a = eight[i % 8]!;
      a.hp = k.maxHp(a);
      a.fallen = null;
      k.act(a, 'attack', { target: W.monster });
    }
    expect(colossus(k)).toBeUndefined();
    expect(k.s.worldBoss.uid).toBeNull();
    for (const a of eight) {
      expect(a.stats.world_boss_kills, a.name).toBe(1);
      // star_iron and 2 crystals drop with chance 1: each agent gets its own.
      expect(a.inv.star_iron, a.name).toBe(1);
      expect(a.inv.crystal, a.name).toBe(2);
    }
    expect(checkInvariants(k.s, k.now)).toEqual([]);
    // Killed: no leave event later, and the schedule moved on.
    expect(k.advance(W.stayMs).find((e) => e.type === 'world_boss_left')).toBeUndefined();
  });
});

describe('boss mechanics with a real party', () => {
  /** A level-20 agent with good gear. */
  function geared(k: Kit, name: string, cls: 'warrior' | 'mage' | 'rogue' | 'cleric'): AgentState {
    const a = k.add(name, cls, { level: 20, room: 'dungeon.boss_lair' });
    a.equip.armor = 'mithril_mail';
    a.hp = k.maxHp(a);
    return a;
  }

  it('the Hollow Regent crushes a lone agent; a taunting Warrior and a healing Cleric keep a party standing', () => {
    const lone = makeKit(11);
    const solo = geared(lone, 'Loner', 'warrior');
    let rounds = 0;
    while (!solo.fallen && rounds < 30) {
      lone.ok(solo, 'attack', { target: 'the_hollow_regent' });
      rounds++;
    }
    expect(solo.fallen).not.toBeNull();
    expect(rounds).toBeLessThanOrEqual(6);

    const k = makeKit(11);
    const war = geared(k, 'Brak', 'warrior');
    const mage = geared(k, 'Ilsa', 'mage');
    const cleric = geared(k, 'Oren', 'cleric');
    partyUp(k, 'dungeon.boss_lair', war, mage, cleric);
    k.ok(war, 'taunt', { target: 'the_hollow_regent' });
    let sweeps = 0;
    for (let round = 0; round < 12; round++) {
      const hit = k.ok(mage, 'attack', { target: 'the_hollow_regent' });
      if (keys(hit).includes('n.boss_sweep')) sweeps++;
      // The taunted boss hits the Warrior, not the Mage.
      expect(keys(hit)).toContain('n.monster_hits_other');
      const low = [war, mage].sort((x, y) => x.hp / k.maxHp(x) - y.hp / k.maxHp(y))[0]!;
      k.ok(cleric, 'cast', { skill: 'heal', target: low.name });
      if (round % 8 === 7) k.ok(war, 'taunt', { target: 'the_hollow_regent' });
    }
    expect(sweeps).toBe(12);
    for (const a of [war, mage, cleric]) expect(a.fallen, a.name).toBeNull();
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });
});
