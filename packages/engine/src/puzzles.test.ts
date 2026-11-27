import { describe, expect, it } from 'vitest';
import { derive } from './agent';
import { BALANCE, rogueChance } from './balance';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { errKey, errKeys, keys, makeKit, MIN, narr, partyUp, scriptedRng, SEC, type Kit } from './testkit';
import type { AgentState } from './types';

/** A warrior, a mage, a rogue and a cleric of level 16, partied up in `room`. */
function crew(k: Kit, room: string): { war: AgentState; mage: AgentState; rogue: AgentState; cleric: AgentState } {
  const war = k.add('Brak', 'warrior', { level: 16 });
  const mage = k.add('Ilsa', 'mage', { level: 16 });
  const rogue = k.add('Vex', 'rogue', { level: 16 });
  const cleric = k.add('Oren', 'cleric', { level: 16 });
  partyUp(k, room, war, mage, rogue, cleric);
  return { war, mage, rogue, cleric };
}

const blocked = (k: Kit, a: AgentState, dir: string) => errKey(k.act(a, 'move', { dir }));

/** A puzzle's tuning from content: every duration in these tests comes from here or from BALANCE. */
const puzzle = (k: Kit, id: string) => k.c.puzzles.get(id)!;

describe('levers', () => {
  it('open the way when two different agents pull both levers within the window, then close again', () => {
    const k = makeKit();
    const { war, mage, rogue, cleric } = crew(k, 'dungeon.antechamber');
    const lev = puzzle(k, 'dungeon_levers');
    for (const a of [war, mage, rogue]) a.quests.c_dungeon_1 = { steps: [0, 0], at: k.now };
    expect(blocked(k, war, 'south')).toBe('err.gate_puzzle');
    const first = k.ok(war, 'pull_lever', { target: 'sun_lever' });
    expect(narr(first, 'n.lever_pulled')).toEqual({ target: 'sun_lever', left: 1, seconds: lev.window_sec });
    expect(observe(k.s, mage.id, k.ctx()).room.puzzles![0]).toMatchObject({ id: 'dungeon_levers', do: 'pull_lever', pulled: ['sun_lever'] });
    k.advance((lev.window_sec / 2) * SEC);
    const second = k.ok(mage, 'pull_lever', { target: 'moon_lever' });
    expect(narr(second, 'n.puzzle_solved')).toEqual({ puzzle: '@puzzle:dungeon_levers', seconds: lev.open_sec });
    expect(second.events.map((e) => e.type)).toContain('puzzle_solved');
    // Both pullers and the party members standing with them get the credit and the quest step.
    for (const a of [war, mage, rogue, cleric]) expect(a.stats.puzzles_solved).toBe(1);
    for (const a of [war, mage, rogue]) expect(a.quests.c_dungeon_1!.steps).toEqual([1, 0]);
    expect(observe(k.s, cleric.id, k.ctx()).room.locked).toBeUndefined();
    expect(observe(k.s, cleric.id, k.ctx()).room.puzzles![0]!.open).toBe(lev.open_sec);
    k.ok(cleric, 'move', { dir: 'south' });
    expect(errKeys(k.act(rogue, 'pull_lever', { target: 'sun_lever' }))).toMatchObject({ code: 'CONFLICT', msg: 'err.puzzle_open' });
    // The way closes after open_sec and the puzzle can be solved again.
    const closing = k.advance(lev.open_sec * SEC);
    expect(closing.map((e) => e.type)).toContain('puzzle_closed');
    expect(blocked(k, rogue, 'south')).toBe('err.gate_puzzle');
    expect(observe(k.s, rogue.id, k.ctx()).room.locked).toEqual({ south: 'puzzle' });
    k.ok(rogue, 'pull_lever', { target: 'moon_lever' });
    k.ok(war, 'pull_lever', { target: 'sun_lever' });
    k.ok(war, 'move', { dir: 'south' });
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('are not solvable by one agent alone, nor by pulls further apart than the window', () => {
    const k = makeKit();
    const { war, mage } = crew(k, 'dungeon.antechamber');
    const lev = puzzle(k, 'dungeon_levers');
    k.ok(war, 'pull_lever', { target: 'sun_lever' });
    const twice = errKeys(k.act(war, 'pull_lever', { target: 'moon_lever' }));
    expect(twice).toMatchObject({ code: 'NOT_ALLOWED', msg: 'err.lever_same_agent', hint: 'hint.lever_same_agent', p: { target: 'moon_lever', other: 'sun_lever' } });
    // Pulling the same lever again is allowed (it restarts that lever), but never opens anything alone.
    k.ok(war, 'pull_lever', { target: 'sun_lever' });
    expect(blocked(k, war, 'south')).toBe('err.gate_puzzle');
    // Too late: the sun lever's pull has expired, so the moon lever starts a new window.
    k.advance((lev.window_sec + 1) * SEC);
    const late = k.ok(mage, 'pull_lever', { target: 'moon_lever' });
    expect(keys(late)).toContain('n.lever_pulled');
    expect(blocked(k, mage, 'south')).toBe('err.gate_puzzle');
    // A fresh pull of the sun lever within the new window does it.
    expect(keys(k.ok(war, 'pull_lever', { target: 'sun_lever' }))).toContain('n.puzzle_solved');
    // Unknown targets and wrong actions.
    expect(errKeys(k.act(war, 'pull_lever', { target: 'star_lever' }))).toMatchObject({ code: 'TARGET_NOT_FOUND', msg: 'err.puzzle_unknown', p: { here: 'sun_lever, moon_lever' } });
    expect(errKeys(k.act(mage, 'read_runes', { target: 'sun_lever' }))).toMatchObject({ code: 'NOT_ALLOWED', msg: 'err.puzzle_wrong_action' });
    k.place(war, 'village.square');
    expect(errKeys(k.act(war, 'pull_lever', { target: 'sun_lever' }))).toMatchObject({ msg: 'err.no_puzzle_here' });
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('accept the puzzle id and pick a lever not yet pulled', () => {
    const k = makeKit();
    const { war, mage } = crew(k, 'dungeon.antechamber');
    expect(narr(k.ok(war, 'pull_lever', { target: 'dungeon_levers' }), 'n.lever_pulled')).toMatchObject({ target: 'sun_lever' });
    expect(keys(k.ok(mage, 'pull_lever', { target: 'Dungeon Levers' }))).toContain('n.puzzle_solved');
  });
});

describe('trap', () => {
  it('only a Rogue can disarm it; failing hurts and keeps it armed; success opens the way for a while', () => {
    const k = makeKit();
    const { war, rogue, mage } = crew(k, 'dungeon.trapped_corridor');
    const wrong = errKeys(k.act(war, 'disarm', { target: 'blade_trap' }));
    expect(wrong).toMatchObject({ code: 'CLASS_REQUIRED', msg: 'err.class_action', hint: 'hint.class_action', p: { class: '@class:rogue', action: 'disarm' } });
    expect(blocked(k, war, 'south')).toBe('err.gate_puzzle');

    k.rng = scriptedRng([0.999]);
    const hp = rogue.hp;
    const miss = k.ok(rogue, 'disarm', { target: 'blade_trap' });
    const dmg = puzzle(k, 'dungeon_trap').damage;
    expect(narr(miss, 'n.trap_failed')).toEqual({ puzzle: '@puzzle:dungeon_trap', dmg });
    expect(rogue.hp).toBe(hp - dmg);
    expect(blocked(k, mage, 'south')).toBe('err.gate_puzzle');

    k.rng = scriptedRng([0]);
    expect(keys(k.ok(rogue, 'disarm', { target: 'blade_trap' }))).toContain('n.puzzle_solved');
    expect(rogue.stats.traps_disarmed).toBe(1);
    k.ok(mage, 'move', { dir: 'south' });
    k.advance(puzzle(k, 'dungeon_trap').open_sec * SEC);
    expect(blocked(k, war, 'south')).toBe('err.gate_puzzle');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('a failure can fell the Rogue, and the chance follows AGI without ever being certain or hopeless', () => {
    const k = makeKit();
    const { rogue } = crew(k, 'dungeon.trapped_corridor');
    rogue.hp = puzzle(k, 'dungeon_trap').damage - 1;
    k.rng = scriptedRng([0.999]);
    k.ok(rogue, 'disarm', { target: 'blade_trap' });
    expect(rogue.fallen).not.toBeNull();
    const P = BALANCE.puzzle;
    expect(rogueChance('trap', 0)).toBe(Math.max(P.chanceMin, P.trapBase));
    expect(rogueChance('trap', 10_000)).toBe(P.chanceMax);
    expect(rogueChance('trap', 20)).toBeCloseTo(P.trapBase + 20 * P.trapPerAgi);
    expect(P.chanceMax).toBeLessThan(1);
    expect(P.chanceMin).toBeGreaterThan(0);
    const agi = derive(k.c, rogue, k.now).agi;
    expect(rogueChance('trap', agi)).toBeLessThan(P.chanceMax);
  });
});

describe('seal', () => {
  it('only a Mage can read the runes; the way stays open for open_sec', () => {
    const k = makeKit();
    const { war, mage, rogue, cleric } = crew(k, 'dungeon.rune_door');
    for (const a of [rogue, cleric, war]) expect(errKeys(k.act(a, 'read_runes', { target: 'rune_seal' }))).toMatchObject({ code: 'CLASS_REQUIRED', p: { class: '@class:mage' } });
    expect(blocked(k, war, 'west')).toBe('err.gate_puzzle');
    expect(keys(k.ok(mage, 'read_runes', { target: 'rune_seal' }))).toContain('n.puzzle_solved');
    expect(mage.stats.seals_opened).toBe(1);
    k.ok(war, 'move', { dir: 'west' });
    k.advance(puzzle(k, 'dungeon_seal').open_sec * SEC);
    expect(blocked(k, rogue, 'west')).toBe('err.gate_puzzle');
  });
});

describe('gate', () => {
  it('a Warrior holds it for the others, cannot slip through himself, and the winch lets him follow', () => {
    const k = makeKit();
    const { war, mage, rogue, cleric } = crew(k, 'dungeon.gate_hall');
    expect(errKeys(k.act(mage, 'hold_gate', { target: 'portcullis' }))).toMatchObject({ code: 'CLASS_REQUIRED', p: { class: '@class:warrior' } });
    expect(blocked(k, mage, 'west')).toBe('err.gate_puzzle');
    const hold = k.ok(war, 'hold_gate', { target: 'portcullis' });
    expect(narr(hold, 'n.gate_held')).toEqual({ puzzle: '@puzzle:dungeon_gate', seconds: puzzle(k, 'dungeon_gate').open_sec });
    expect(war.stats.gates_held).toBe(1);
    expect(observe(k.s, mage.id, k.ctx()).room.puzzles![0]).toMatchObject({ id: 'dungeon_gate', held: 'Brak' });
    // The holder cannot pass, and refusing does not let go.
    expect(errKeys(k.act(war, 'move', { dir: 'west' }))).toMatchObject({ code: 'NOT_ALLOWED', msg: 'err.gate_holding', hint: 'hint.gate_holding' });
    expect(observe(k.s, war.id, k.ctx()).room.locked).toEqual({ west: 'puzzle' });
    expect(observe(k.s, mage.id, k.ctx()).room.locked).toBeUndefined();
    for (const a of [mage, rogue, cleric]) k.ok(a, 'move', { dir: 'west' });
    // From the far side, the winch.
    expect(observe(k.s, mage.id, k.ctx()).room.puzzles).toContainEqual({ id: 'dungeon_gate', do: 'pull_lever', targets: ['winch'] });
    expect(observe(k.s, mage.id, k.ctx()).actions).toContain('pull_lever');
    const crank = k.ok(mage, 'pull_lever', { target: 'winch' });
    expect(narr(crank, 'n.winch')).toEqual({ puzzle: '@puzzle:dungeon_gate', seconds: BALANCE.puzzle.winchMs / 1000 });
    const moved = k.ok(war, 'move', { dir: 'west' });
    expect(keys(moved)).toContain('n.gate_released');
    expect(war.room).toBe('dungeon.boss_lair');
    expect(k.s.puzzles.dungeon_gate!.hold).toBeNull();
    // Once the winch drops, the gate is shut from both sides of the story.
    k.advance(BALANCE.puzzle.winchMs + SEC);
    k.place(rogue, 'dungeon.gate_hall');
    expect(blocked(k, rogue, 'west')).toBe('err.gate_puzzle');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('closes when the Warrior walks away, falls or holds past open_sec', () => {
    const k = makeKit();
    const { war, mage } = crew(k, 'dungeon.gate_hall');
    k.ok(war, 'hold_gate', { target: 'portcullis' });
    const walk = k.ok(war, 'move', { dir: 'east' });
    expect(keys(walk)).toContain('n.gate_released');
    expect(walk.events.map((e) => e.type)).toContain('puzzle_closed');
    expect(blocked(k, mage, 'west')).toBe('err.gate_puzzle');

    k.place(war, 'dungeon.gate_hall');
    k.ok(war, 'hold_gate', { target: 'portcullis' });
    expect(errKeys(k.act(war, 'hold_gate', { target: 'portcullis' }))).toMatchObject({ code: 'CONFLICT', msg: 'err.puzzle_open' });
    const other = k.add('Torv', 'warrior', { level: 16, room: 'dungeon.gate_hall' });
    expect(errKeys(k.act(other, 'hold_gate', { target: 'portcullis' }))).toMatchObject({ code: 'CONFLICT', msg: 'err.gate_held', p: { name: 'Brak' } });
    war.hp = 0;
    war.fallen = { at: k.now, until: k.now + MIN, by: 'x' };
    expect(blocked(k, mage, 'west')).toBe('err.gate_puzzle');
    war.fallen = null;
    war.hp = k.maxHp(war);
    expect(blocked(k, mage, 'west')).toBeNull();
    k.place(mage, 'dungeon.gate_hall');
    k.advance(puzzle(k, 'dungeon_gate').open_sec * SEC);
    expect(blocked(k, mage, 'west')).toBe('err.gate_puzzle');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('the winch works without anyone holding the gate, for a short time', () => {
    const k = makeKit();
    const a = k.add('Solo', 'cleric', { level: 16, room: 'dungeon.boss_lair' });
    const b = k.add('Duo', 'mage', { level: 16, room: 'dungeon.gate_hall' });
    expect(errKeys(k.act(a, 'hold_gate', { target: 'portcullis' }))).toMatchObject({ msg: 'err.puzzle_unknown', p: { here: 'winch' } });
    k.ok(a, 'pull_lever', { target: 'winch' });
    k.ok(b, 'move', { dir: 'west' });
    k.place(b, 'dungeon.gate_hall');
    k.advance(BALANCE.puzzle.winchMs);
    expect(blocked(k, b, 'west')).toBe('err.gate_puzzle');
  });
});

describe('lock', () => {
  it('a Rogue picks it once per reset for the loot; failure means a short cooldown', () => {
    const k = makeKit();
    const rogue = k.add('Vex', 'rogue', { level: 16, room: 'dungeon.lever_hall' });
    const war = k.add('Brak', 'warrior', { level: 16, room: 'dungeon.lever_hall' });
    expect(errKeys(k.act(war, 'pick_lock', { target: 'old_chest' }))).toMatchObject({ code: 'CLASS_REQUIRED', p: { class: '@class:rogue' } });
    k.rng = scriptedRng([0.999]);
    expect(keys(k.ok(rogue, 'pick_lock', { target: 'old_chest' }))).toContain('n.lock_failed');
    expect(errKeys(k.act(rogue, 'pick_lock', { target: 'old_chest' }))).toMatchObject({ code: 'COOLDOWN', msg: 'err.lock_cooldown', hint: 'hint.lock_cooldown' });
    k.advance(BALANCE.puzzle.lockFailCooldownMs);
    k.rng = scriptedRng([0]);
    const r = k.ok(rogue, 'pick_lock', { target: 'old_chest' });
    expect(keys(r)).toContain('n.lock_picked');
    expect(rogue.inv).toMatchObject({ greater_potion: 2, ancient_relic: 2, silver_ore: 3 });
    expect(rogue.stats.locks_picked).toBe(1);
    expect(rogue.stats.puzzles_solved).toBe(1);
    const reset = puzzle(k, 'dungeon_chest').reset_sec;
    expect(errKeys(k.act(rogue, 'pick_lock', { target: 'old_chest' }))).toMatchObject({ code: 'NOT_AVAILABLE_HERE', msg: 'err.lock_empty', p: { minutes: Math.ceil(reset / 60) } });
    expect(observe(k.s, rogue.id, k.ctx()).room.puzzles).toContainEqual(expect.objectContaining({ id: 'dungeon_chest', do: 'pick_lock', cls: 'rogue', wait: reset - 1 }));
    k.advance(reset * SEC);
    expect(k.s.puzzles.dungeon_chest!.ready).toBe(0);
    k.ok(rogue, 'pick_lock', { target: 'old_chest' });
    expect(rogue.inv.greater_potion).toBe(4);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('in a party the loot follows the loot rule among the members standing there', () => {
    const k = makeKit();
    const { war, mage, rogue, cleric } = crew(k, 'dungeon.lever_hall');
    k.rng = scriptedRng([0]);
    const r = k.ok(rogue, 'pick_lock', { target: 'old_chest' });
    // Round robin: one stack each, starting from the first member.
    expect(war.inv.greater_potion).toBe(2);
    expect(mage.inv.ancient_relic).toBe(2);
    expect(rogue.inv.silver_ore).toBe(3);
    expect(narr(r, 'n.loot_to')).toEqual({ name: 'Brak', item: '@item:greater_potion', qty: 2 });
    expect(cleric.inv.greater_potion).toBeUndefined();
    // Every member present shares the solve.
    for (const a of [war, mage, rogue, cleric]) expect(a.stats.puzzles_solved).toBe(1);
  });
});

describe('party gate', () => {
  it('needs a party of 3 or 4 with at least 2 classes; the last ones can follow the first through', () => {
    const k = makeKit();
    const stairs = 'ruins.catacomb_stairs';
    const solo = k.add('Solo', 'warrior', { level: 16, room: stairs });
    expect(errKeys(k.act(solo, 'move', { dir: 'down' }))).toMatchObject({ code: 'PARTY_REQUIRED', msg: 'err.gate_party', hint: 'hint.gate_party', p: { n: 3, classes: 2 } });
    const [w1, w2, w3] = ['Wara', 'Warb', 'Warc'].map((n) => k.add(n, 'warrior', { level: 16 }));
    partyUp(k, stairs, w1!, w2!, w3!);
    expect(blocked(k, w1!, 'down')).toBe('err.gate_party');
    const [m1, c1] = [k.add('Maga', 'mage', { level: 16 }), k.add('Clera', 'cleric', { level: 16 })];
    partyUp(k, stairs, m1, c1);
    expect(blocked(k, m1, 'down')).toBe('err.gate_party');
    const r1 = k.add('Roga', 'rogue', { level: 16, room: stairs });
    k.ok(m1, 'party_invite', { agent: 'Roga' });
    k.ok(r1, 'party_accept', { agent: 'Maga' });
    expect(observe(k.s, m1.id, k.ctx()).room.locked).toBeUndefined();
    for (const a of [m1, c1, r1]) k.ok(a, 'move', { dir: 'down' });
    // A member far away does not count.
    k.place(r1, 'village.square');
    k.place(c1, stairs);
    expect(blocked(k, c1, 'down')).toBe('err.gate_party');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });
});

describe('boss gate', () => {
  it('opens while the boss is dead, waiting to respawn', () => {
    const k = makeKit();
    const a = k.add('Brak', 'warrior', { level: 20, room: 'dungeon.boss_lair' });
    expect(errKeys(k.act(a, 'move', { dir: 'north' }))).toMatchObject({ code: 'NOT_AVAILABLE_HERE', msg: 'err.gate_boss', p: { mon: '@mon:the_hollow_regent' } });
    const boss = k.monsters('dungeon.boss_lair')[0]!;
    boss.hp = 1;
    k.ok(a, 'attack', { target: 'the_hollow_regent' });
    expect(k.monsters('dungeon.boss_lair')).toHaveLength(0);
    expect(observe(k.s, a.id, k.ctx()).room.locked).toBeUndefined();
    k.ok(a, 'move', { dir: 'north' });
    k.ok(a, 'move', { dir: 'south' });
    // Bosses keep their respawn time, crowd or not.
    k.advance(k.c.monsters.get('the_hollow_regent')!.respawn_sec * SEC);
    expect(blocked(k, a, 'north')).toBe('err.gate_boss');
  });
});

describe('class utilities', () => {
  it('scout shows the next room without entering, even through a closed gate; Rogues only', () => {
    const k = makeKit();
    const { war, rogue } = crew(k, 'dungeon.antechamber');
    k.add('Elsewhere', 'mage', { room: 'dungeon.lever_hall' });
    expect(errKeys(k.act(war, 'scout', { target: 'south' }))).toMatchObject({ code: 'CLASS_REQUIRED', p: { class: '@class:rogue', action: 'scout' } });
    const r = k.ok(rogue, 'scout', { target: 's' });
    expect(r.result.ok && r.result.data?.scout).toEqual({ dir: 'south', room: 'dungeon.lever_hall', monsters: [{ id: 'crypt_guard', n: 2, lvl: 16 }], agents: 1, locked: 'puzzle' });
    expect(narr(r, 'n.scout')).toEqual({ dir: '@dir:south', room: '@room:dungeon.lever_hall', monsters: 2, agents: 1 });
    expect(keys(r)).toContain('n.scout_locked');
    expect(rogue.room).toBe('dungeon.antechamber');
    expect(errKey(k.act(rogue, 'scout', { target: 'west' }))).toBe('err.no_exit');
    expect(observe(k.s, rogue.id, k.ctx()).actions).toContain('scout');
    expect(observe(k.s, war.id, k.ctx()).actions).not.toContain('scout');
  });

  it('enchant: a Mage spends a crystal for +ATK on a weapon, for two hours', () => {
    const k = makeKit();
    const mage = k.add('Ilsa', 'mage', { level: 10 });
    const war = k.add('Brak', 'warrior', { level: 10 });
    expect(errKeys(k.act(war, 'enchant', {}))).toMatchObject({ code: 'CLASS_REQUIRED', p: { class: '@class:mage' } });
    expect(errKeys(k.act(mage, 'enchant', { target: 'Brak' }))).toMatchObject({ code: 'MISSING_ITEMS', msg: 'err.enchant_material' });
    expect(observe(k.s, mage.id, k.ctx()).actions).not.toContain('enchant');
    mage.inv.crystal = 2;
    expect(observe(k.s, mage.id, k.ctx()).actions).toContain('enchant');
    const atk = derive(k.c, war, k.now).atk;
    const r = k.ok(mage, 'enchant', { target: 'Brak' });
    expect(narr(r, 'n.enchant')).toEqual({ name: 'Brak', item: '@item:rusty_sword', atk: BALANCE.enchant.atk, minutes: BALANCE.enchant.durationMs / MIN });
    expect(mage.inv.crystal).toBe(1);
    expect(derive(k.c, war, k.now).atk).toBe(atk + BALANCE.enchant.atk);
    expect(mage.bonds[war.id]!.v).toBe(BALANCE.bond.enchant);
    const ev = r.events.find((e) => e.type === 'enchant')!;
    expect(ev).toMatchObject({ visibility: 'room', roomId: 'village.square', actor: mage.id, target: war.id });
    k.ok(mage, 'enchant', {});
    expect(mage.inv.crystal).toBeUndefined();
    k.advance(BALANCE.enchant.durationMs);
    k.refresh(war);
    expect(derive(k.c, war, k.now).atk).toBe(atk);
    war.equip.weapon = null;
    mage.inv.crystal = 1;
    expect(errKeys(k.act(mage, 'enchant', { target: 'Brak' }))).toMatchObject({ msg: 'err.enchant_no_weapon' });
  });
});

describe('observe', () => {
  it('lists the puzzles of the room and only the actions the agent can use on them', () => {
    const k = makeKit();
    const { war, rogue } = crew(k, 'dungeon.trapped_corridor');
    const o = observe(k.s, war.id, k.ctx());
    expect(o.room.puzzles).toEqual([{ id: 'dungeon_trap', do: 'disarm', targets: ['blade_trap'], cls: 'rogue' }]);
    expect(o.room.locked).toEqual({ south: 'puzzle' });
    expect(o.actions).not.toContain('disarm');
    expect(observe(k.s, rogue.id, k.ctx()).actions).toContain('disarm');
    k.place(war, 'dungeon.antechamber');
    expect(observe(k.s, war.id, k.ctx()).actions).toContain('pull_lever');
  });
});
