import { describe, expect, it } from 'vitest';
import type { ClassId } from '@ajwf/shared';
import { derive } from './agent';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { route } from './routes';
import { errKeys, makeKit, partyUp, type Kit } from './testkit';
import type { AgentState, ApplyResult } from './types';

/**
 * PLANEJAMENTO §16.4: "each puzzle is only solvable with the classes and number of agents required". A party walks
 * the Catacombs of the Hollow Regent from the stairs to the vault using only `applyAction` (setup aside), and a
 * party missing a class gets stuck where that class is needed.
 */

const GEAR: Record<ClassId, string> = { warrior: 'mithril_blade', mage: 'starfall_staff', rogue: 'shadow_dagger', cleric: 'wooden_mace' };

function delvers(k: Kit, classes: ClassId[]): AgentState[] {
  const names: Record<ClassId, string> = { warrior: 'Brak', mage: 'Ilsa', rogue: 'Vex', cleric: 'Oren' };
  const out = classes.map((cls, i) => {
    const a = k.add(`${names[cls]}${i}`, cls, { level: 20, room: 'ruins.road' });
    Object.assign(a.inv, { mithril_mail: 1, greater_potion: 6, greater_mana_potion: 3, [GEAR[cls]]: 1 });
    return a;
  });
  // Gearing up is part of the run.
  for (const a of out) {
    k.ok(a, 'equip', { item: 'mithril_mail' });
    if (a.equip.weapon !== GEAR[a.cls]) k.ok(a, 'equip', { item: GEAR[a.cls] });
  }
  partyUp(k, 'ruins.road', ...out);
  return out;
}

/** Everyone walks to `to`, one step each in turn, using the route helper. */
function walk(k: Kit, party: AgentState[], to: string): void {
  const dirs = route(k.c, party[0]!.room, to);
  if (!dirs) throw new Error(`no route to ${to}`);
  for (const dir of dirs) for (const a of party) k.ok(a, 'move', { dir });
}

function moveAll(k: Kit, party: AgentState[], dir: string): void {
  for (const a of party) k.ok(a, 'move', { dir });
}

const by = (party: AgentState[], cls: ClassId) => party.find((a) => a.cls === cls);

type Stuck = { room: string; tried: string } | null;

/** Solves the puzzle of the current room with whoever can; returns where and why the party is stuck, or null. */
function solveHere(k: Kit, party: AgentState[]): Stuck {
  const room = party[0]!.room;
  const tryAll = (action: string, target: string, cls: ClassId): Stuck => {
    const doer = by(party, cls);
    for (const a of party.filter((x) => x.cls !== cls)) expect(errKeys(k.act(a, action, { target }))?.code, `${a.cls} ${action}`).toBe('CLASS_REQUIRED');
    if (!doer) return { room, tried: action };
    for (let i = 0; i < 20; i++) {
      const r = k.ok(doer, action, { target });
      if (r.result.ok && r.result.narration.some((m) => m.k === 'n.puzzle_solved' || m.k === 'n.gate_held')) return null;
      // A failed disarm hurts: patch the Rogue up with a potion.
      if (doer.hp < derive(k.c, doer, k.now).maxHp / 2) k.ok(doer, 'use', { item: 'greater_potion' });
    }
    throw new Error(`${action} never worked`);
  };
  switch (room) {
    case 'dungeon.antechamber': {
      // Any two agents can do it, but two different ones.
      k.ok(party[0]!, 'pull_lever', { target: 'sun_lever' });
      expect(errKeys(k.act(party[0]!, 'pull_lever', { target: 'moon_lever' }))?.msg).toBe('err.lever_same_agent');
      k.ok(party[1]!, 'pull_lever', { target: 'moon_lever' });
      return null;
    }
    case 'dungeon.trapped_corridor':
      return tryAll('disarm', 'blade_trap', 'rogue');
    case 'dungeon.rune_door':
      return tryAll('read_runes', 'rune_seal', 'mage');
    case 'dungeon.gate_hall':
      return tryAll('hold_gate', 'portcullis', 'warrior');
    default:
      return null;
  }
}

/** Walks from the stairs to the boss lair through every puzzle. Returns where the party got stuck, or null. */
function descend(k: Kit, party: AgentState[]): Stuck {
  walk(k, party, 'ruins.catacomb_stairs');
  moveAll(k, party, 'down');
  const legs: [string, string][] = [
    ['dungeon.antechamber', 'south'],
    ['dungeon.lever_hall', 'east'],
    ['dungeon.trapped_corridor', 'south'],
    ['dungeon.rune_door', 'west'],
  ];
  for (const [room, dir] of legs) {
    expect(party[0]!.room).toBe(room);
    if (k.c.puzzlesByRoom.get(room)?.some((pz) => pz.type !== 'lock')) {
      // Closed until solved (it may still be open from an earlier pass).
      const stuck = solveHereIfClosed(k, party, dir);
      if (stuck) return stuck;
    }
    moveAll(k, party, dir);
  }
  // The gate hall: the Warrior holds the portcullis, the others pass, the winch brings him through.
  const stuck = solveHere(k, party);
  if (stuck) {
    for (const a of party) expect(errKeys(k.act(a, 'move', { dir: 'west' }))?.msg).toBe('err.gate_puzzle');
    return stuck;
  }
  const war = by(party, 'warrior')!;
  const others = party.filter((a) => a !== war);
  moveAll(k, others, 'west');
  expect(errKeys(k.act(war, 'move', { dir: 'west' }))?.msg).toBe('err.gate_holding');
  k.ok(others[0]!, 'pull_lever', { target: 'winch' });
  k.ok(war, 'move', { dir: 'west' });
  return null;
}

function solveHereIfClosed(k: Kit, party: AgentState[], dir: string): Stuck {
  // It may still be open from an earlier pass.
  if (!observe(k.s, party[0]!.id, k.ctx()).room.locked?.[dir]) return null;
  const stuck = solveHere(k, party);
  if (stuck) for (const a of party) expect(errKeys(k.act(a, 'move', { dir }))?.msg).toBe('err.gate_puzzle');
  return stuck;
}

const ok = (r: ApplyResult) => r.result.ok;

/** The boss fight: the Warrior taunts and tanks, the Cleric heals, the Mage and the Rogue deal damage. */
function fightRegent(k: Kit, party: AgentState[]): boolean {
  const boss = () => k.monsters('dungeon.boss_lair').find((m) => m.kind === 'the_hollow_regent');
  const war = by(party, 'warrior');
  const cleric = by(party, 'cleric');
  const dps = party.filter((a) => a.cls === 'mage' || a.cls === 'rogue');
  const pct = (a: AgentState) => a.hp / derive(k.c, a, k.now).maxHp;
  let lastTaunt = -Infinity;
  if (war) k.ok(war, 'cast', { skill: 'shield_wall' });
  for (let round = 0; round < 200 && boss(); round++) {
    if (party.every((a) => a.fallen)) return false;
    if (war && !war.fallen) {
      if (k.now - lastTaunt > 30_000) {
        if (ok(k.act(war, 'taunt', { target: 'the_hollow_regent' }))) lastTaunt = k.now;
      } else if (pct(war) < 0.35) k.act(war, 'use', { item: 'greater_potion' });
      else k.act(war, 'attack', { target: 'the_hollow_regent' });
    }
    if (cleric && !cleric.fallen) {
      const down = party.find((a) => a.fallen);
      const hurt = party.filter((a) => !a.fallen).sort((x, y) => pct(x) - pct(y))[0]!;
      if (down) k.act(cleric, 'revive', { target: down.name });
      else if (cleric.mp < 20) k.act(cleric, 'use', { item: 'greater_mana_potion' });
      else if (pct(hurt) < 0.8) k.act(cleric, 'cast', { skill: 'heal', target: hurt.name });
    }
    for (const a of dps) {
      if (a.fallen || !boss()) continue;
      if (pct(a) < 0.4) k.act(a, 'use', { item: 'greater_potion' });
      else if (a.cls === 'mage' && a.mp >= 6) k.act(a, 'cast', { skill: 'firebolt', target: 'the_hollow_regent' });
      else k.act(a, 'attack', { target: 'the_hollow_regent' });
    }
  }
  return !boss();
}

describe('the Catacombs of the Hollow Regent', () => {
  it('a party of Warrior, Mage, Rogue and Cleric goes from the stairs to the vault and completes both dungeon chains', () => {
    const k = makeKit(7);
    const party = delvers(k, ['warrior', 'mage', 'rogue', 'cleric']);
    for (const a of party) k.ok(a, 'quest_accept', { quest: 'c_dungeon_1' });
    expect(descend(k, party)).toBeNull();
    for (const a of party) expect(a.quests.c_dungeon_1!.steps).toEqual([1, 1]);

    // Back up to the scholar for the second chain, then down again.
    walk(k, party, 'ruins.road');
    for (const a of party) {
      k.ok(a, 'quest_turn_in', { quest: 'c_dungeon_1' });
      k.ok(a, 'quest_accept', { quest: 'c_dungeon_2' });
    }
    expect(descend(k, party)).toBeNull();
    expect(party.every((a) => a.room === 'dungeon.boss_lair')).toBe(true);
    expect(errKeys(k.act(party[0]!, 'move', { dir: 'north' }))?.msg).toBe('err.gate_boss');

    expect(fightRegent(k, party)).toBe(true);
    for (const a of party.filter((x) => x.fallen)) k.ok(by(party, 'cleric')!, 'revive', { target: a.name });
    for (const a of party) expect(a.quests.c_dungeon_2!.steps).toEqual([1]);
    moveAll(k, party, 'north');
    const rogue = by(party, 'rogue')!;
    for (let i = 0; i < 20 && !rogue.stats.locks_picked; i++) {
      const r = k.act(rogue, 'pick_lock', { target: 'regent_coffer' });
      if (!r.result.ok && r.result.error.code === 'COOLDOWN') k.advance(30_000);
    }
    expect(rogue.stats.locks_picked).toBe(1);

    walk(k, party, 'ruins.road');
    for (const a of party) k.ok(a, 'quest_turn_in', { quest: 'c_dungeon_2' });
    for (const a of party) {
      expect(a.questsDone.c_dungeon_1).toBeDefined();
      expect(a.questsDone.c_dungeon_2).toBeDefined();
      expect(a.stats.boss_kills).toBe(1);
    }
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  const stuckAt: [ClassId, string, string][] = [
    ['rogue', 'dungeon.trapped_corridor', 'disarm'],
    ['mage', 'dungeon.rune_door', 'read_runes'],
    ['warrior', 'dungeon.gate_hall', 'hold_gate'],
  ];
  for (const [missing, room, action] of stuckAt) {
    it(`a party without a ${missing} gets stuck at ${room}`, () => {
      const k = makeKit(7);
      const classes = (['warrior', 'mage', 'rogue', 'cleric'] as ClassId[]).filter((c) => c !== missing);
      const party = delvers(k, classes);
      expect(descend(k, party)).toEqual({ room, tried: action });
      expect(checkInvariants(k.s, k.now)).toEqual([]);
    });
  }
});
