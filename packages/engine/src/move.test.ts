import { describe, expect, it } from 'vitest';
import { applyAction } from './apply';
import { BALANCE } from './balance';
import { exportAll } from './snapshot';
import { errCode, errKey, keys, makeKit, MIN, narr } from './testkit';

describe('applyAction envelope', () => {
  it('rejects unknown agents, unknown actions and bad params without touching the world', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    expect(errCode(applyAction(k.s, { agentId: 'nobody', action: 'move', params: { dir: 'north' } }, k.ctx()))).toBe('UNAUTHORIZED');
    expect(errCode(k.act(a, 'fly', {}))).toBe('INVALID_ACTION');
    expect(errCode(k.act(a, 'Move', { dir: 'north' }))).toBe('INVALID_ACTION');
    expect(errCode(k.act(a, 'move', {}))).toBe('INVALID_PARAMS');
    expect(errCode(k.act(a, 'move', { dir: 42 }))).toBe('INVALID_PARAMS');
    expect(a.room).toBe(BALANCE.startRoom);
    expect(a.ap).toBe(BALANCE.ap.max);
  });

  it('errors leave the world exactly as it was', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    k.step = 0;
    const before = JSON.stringify(exportAll(k.s));
    const failing: [string, Record<string, unknown>][] = [
      ['move', { dir: 'up' }],
      ['attack', { target: 'slime' }],
      ['equip', { item: 'iron_sword' }],
      ['shop_buy', { npc: 'olga', item: 'minor_potion', qty: 50 }],
      ['rest', {}],
      ['gather', { resource: 'wood' }],
      ['quest_turn_in', { quest: 't01_arrival' }],
      ['craft', { recipe: 'smelt_iron' }],
      ['emote', { emote: 'moonwalk' }],
      ['use', { item: 'bread' }],
    ];
    for (const [action, params] of failing) expect(errCode(k.act(a, action, params)), action).not.toBeNull();
    expect(JSON.stringify(exportAll(k.s))).toBe(before);
  });
});

describe('move', () => {
  it('walks through an exit, spending 1 AP and updating the room index', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage', { room: 'village.tavern' });
    const r = k.ok(a, 'move', { dir: 'north' });
    expect(a.room).toBe('village.tavern');
    expect(a.ap).toBe(BALANCE.ap.max - 1);
    expect(k.s.roomAgents.get('village.square')!.has(a.id)).toBe(false);
    expect(k.s.roomAgents.get('village.tavern')!.has(a.id)).toBe(true);
    expect(keys(r)).toEqual(['n.move', 'content.room.village.tavern.desc']);
    expect(narr(r, 'n.move')).toEqual({ dir: '@dir:north', room: '@room:village.tavern' });
    const ev = r.events.find((e) => e.type === 'move')!;
    expect(ev.payload).toMatchObject({ from: 'village.square', to: 'village.tavern', dir: 'north' });
    expect(a.visited).toEqual(['village.square', 'village.tavern']);
    expect(a.stats.rooms_visited).toBe(2);
    expect(b.room).toBe('village.tavern');
  });

  it('accepts short aliases, any case and the id of the next room', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    k.ok(a, 'move', { dir: 'n' });
    expect(a.room).toBe('village.tavern');
    k.ok(a, 'move', { dir: ' SOUTH ' });
    expect(a.room).toBe('village.square');
    k.ok(a, 'move', { dir: 'village.temple' });
    expect(a.room).toBe('village.temple');
  });

  it('fails on a missing exit and lists the exits', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const r = k.act(a, 'move', { dir: 'up' });
    expect(errCode(r)).toBe('TARGET_NOT_FOUND');
    expect(errKey(r)).toBe('err.no_exit');
    expect(!r.result.ok && r.result.error.msg.p?.exits).toBe('north, south, east, west');
    expect(errCode(k.act(a, 'move', { dir: 'd' }))).toBe('TARGET_NOT_FOUND');
  });

  it('respects gates: project, party, puzzle and boss', () => {
    const k = makeKit();
    const cases: [string, string, string, string][] = [
      ['village.river_bank', 'north', 'NOT_AVAILABLE_HERE', 'err.gate_project'],
      ['ruins.catacomb_stairs', 'down', 'PARTY_REQUIRED', 'err.gate_party'],
      ['dungeon.antechamber', 'south', 'NOT_AVAILABLE_HERE', 'err.gate_puzzle'],
      ['dungeon.boss_lair', 'north', 'NOT_AVAILABLE_HERE', 'err.gate_boss'],
    ];
    for (const [room, dir, code, key] of cases) {
      const a = k.add(`Gater${dir}${room.length}`, 'warrior', { room });
      const r = k.act(a, 'move', { dir });
      expect(errCode(r), room).toBe(code);
      expect(errKey(r), room).toBe(key);
      expect(a.room).toBe(room);
      expect(a.ap).toBe(BALANCE.ap.max);
    }
    // The other exits of a gated room stay open.
    const a = k.add('Walker', 'warrior', { room: 'village.river_bank' });
    k.ok(a, 'move', { dir: 'west' });
    expect(a.room).toBe('village.north_road');
  });

  it('is refused in combat, without AP and while fallen', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    k.ok(a, 'attack', { target: 'slime' });
    expect(k.err(a, 'move', { dir: 'east' })).toBe('IN_COMBAT');
    k.advance(2 * MIN);
    k.ok(a, 'move', { dir: 'east' });

    const b = k.add('Bob', 'warrior');
    b.ap = 0;
    b.apAt = k.now;
    const r = k.act(b, 'move', { dir: 'north' });
    expect(errCode(r)).toBe('NOT_ENOUGH_AP');
    expect(!r.result.ok && r.result.error.msg.p).toMatchObject({ need: 1, have: 0 });

    const c = k.add('Cyd', 'warrior');
    c.hp = 0;
    c.fallen = { at: k.now, until: k.now + 10 * MIN };
    expect(k.err(c, 'move', { dir: 'north' })).toBe('DEAD');
  });
});
