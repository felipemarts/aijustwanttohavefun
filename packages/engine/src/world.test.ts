import { describe, expect, it } from 'vitest';
import { applyAction } from './apply';
import { BALANCE, dayPhase, isNight } from './balance';
import { MAX_AGENTS_LISTED, observe } from './observe';
import { HOUR, makeKit, MIN, SEC } from './testkit';

const NIGHTFALL = BALANCE.day.night * BALANCE.day.lengthMs;

describe('day and night', () => {
  it('night creatures appear at nightfall and leave at dawn', () => {
    const k = makeKit();
    expect(dayPhase(k.now)).toBe('dawn');
    const shadow = () => k.monsters('forest.glade').filter((m) => m.kind === 'shadow_wolf');
    expect(shadow()).toEqual([]);
    expect(k.monsters('forest.glade').length).toBe(3);

    k.advance(NIGHTFALL - SEC);
    expect(shadow()).toEqual([]);
    let evs = k.advance(SEC);
    expect(isNight(k.now)).toBe(true);
    expect(shadow().length).toBe(1);
    expect(k.monsters('forest.hollow').filter((m) => m.kind === 'shadow_wolf').length).toBe(2);
    expect(evs.filter((e) => e.type === 'spawn').map((e) => e.payload.mon)).toContain('shadow_wolf');
    expect(evs.find((e) => e.type === 'day_phase')!.payload).toEqual({ night: true });

    evs = k.advance(BALANCE.day.lengthMs - NIGHTFALL);
    expect(isNight(k.now)).toBe(false);
    expect(shadow()).toEqual([]);
    expect(evs.find((e) => e.type === 'day_phase')!.payload).toEqual({ night: false });
    // And they come back the next night.
    k.advance(NIGHTFALL);
    expect(shadow().length).toBe(1);
  });

  it('a night creature that is being fought stays past dawn; killed by day, it waits for the night', () => {
    const k = makeKit();
    k.advance(NIGHTFALL + 30 * MIN);
    const a = k.add('Pip', 'warrior', { room: 'forest.glade', level: 10 });
    const m = k.monsters('forest.glade').find((x) => x.kind === 'shadow_wolf')!;
    k.advance(BALANCE.day.lengthMs - NIGHTFALL - 30 * MIN - 10 * SEC);
    k.ok(a, 'attack', { target: m.uid });
    k.advance(20 * SEC); // dawn
    expect(isNight(k.now)).toBe(false);
    expect(k.monsters('forest.glade')).toContain(m);
    for (let i = 0; i < 50 && m.hp > 0; i++) {
      k.ok(a, 'attack', { target: m.uid });
      a.hp = k.maxHp(a);
    }
    expect(m.hp).toBe(0);
    k.advance(10 * MIN);
    expect(k.monsters('forest.glade').some((x) => x.kind === 'shadow_wolf')).toBe(false);
    k.advance(NIGHTFALL);
    expect(k.monsters('forest.glade').some((x) => x.kind === 'shadow_wolf')).toBe(true);
  });

  it('an abandoned fight does not keep a night creature around', () => {
    const k = makeKit();
    k.advance(NIGHTFALL + 30 * MIN);
    const a = k.add('Pip', 'warrior', { room: 'forest.glade', level: 10 });
    const m = k.monsters('forest.glade').find((x) => x.kind === 'shadow_wolf')!;
    k.ok(a, 'attack', { target: m.uid });
    k.ok(a, 'cast', { skill: 'power_strike', target: m.uid });
    k.advance(BALANCE.day.lengthMs - NIGHTFALL - 30 * MIN);
    expect(isNight(k.now)).toBe(false);
    expect(k.monsters('forest.glade')).not.toContain(m);
  });
});

describe('respawn', () => {
  it('a killed monster comes back in its slot after its timer, through tick', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    const m = k.monsters('forest.edge')[1]!;
    for (let i = 0; i < 10 && m.hp > 0; i++) k.ok(a, 'attack', { target: m.uid });
    expect(k.monsters('forest.edge').length).toBe(2);
    let evs = k.advance(58 * SEC);
    expect(evs.filter((e) => e.type === 'spawn')).toEqual([]);
    evs = k.advance(2 * SEC);
    const spawn = evs.find((e) => e.type === 'spawn')!;
    expect(spawn.roomId).toBe('forest.edge');
    const back = k.monsters('forest.edge').find((x) => x.slot === m.slot)!;
    expect(back.uid).toBe(spawn.target);
    expect(back.uid).not.toBe(m.uid);
    expect(back.hp).toBe(30);
    expect(k.monsters('forest.edge').length).toBe(3);
  });

  it('tick only runs what is due and is cheap when nothing is', () => {
    const k = makeKit();
    const size = k.s.timers.size;
    expect(k.advance(SEC)).toEqual([]);
    expect(k.s.timers.size).toBe(size);
  });
});

describe('observe', () => {
  it('describes the agent and its room compactly', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    k.add('Bob', 'mage', { room: 'forest.edge' });
    const o = observe(k.s, a.id, k.ctx());
    expect(o.you).toMatchObject({ name: 'Pip', lvl: 1, hp: [k.maxHp(a), k.maxHp(a)], ap: [240, 240], gold: 25, xp: [0, 100], bag: [2, 30] });
    expect(o.room).toMatchObject({
      id: 'forest.edge',
      zone: 'forest',
      exits: { east: 'village.west_gate', west: 'forest.path' },
      monsters: [{ id: 'slime', n: 3, lvl: 1 }],
      npcs: [{ id: 'ranger_fen', roles: ['quest'] }],
      resources: { wood: 8, green_herb: 6 },
    });
    expect(o.room.agents.map((x) => x.name)).toEqual(['Bob']);
    expect(o.actions).toEqual(expect.arrayContaining(['move', 'attack', 'cast', 'gather', 'talk', 'quest_accept', 'say']));
    expect(o.actions).not.toContain('flee');
    expect(o.time).toBe('dawn');

    k.ok(a, 'attack', { target: 'slime' });
    const fight = observe(k.s, a.id, k.ctx());
    expect(fight.you.in_combat).toBe('slime');
    expect(fight.actions).toEqual(expect.arrayContaining(['attack', 'flee', 'use']));
    expect(fight.actions).not.toContain('move');
    expect(fight.room.monsters[0]!.hp).toEqual([k.monsters('forest.edge').find((m) => m.uid === a.combat!.mon)!.hp, 30]);
  });

  it('lists gates, ground items and caps the number of agents shown', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'village.river_bank' });
    for (let i = 0; i < MAX_AGENTS_LISTED + 3; i++) k.add(`Crowd${i}`, 'warrior', { room: 'village.river_bank' });
    k.s.rooms.get('village.river_bank')!.ground.bread = 2;
    const o = observe(k.s, a.id, k.ctx());
    expect(o.room.locked).toEqual({ north: 'project' });
    expect(o.room.items).toEqual({ bread: 2 });
    expect(o.room.agents.length).toBe(MAX_AGENTS_LISTED);
    expect(o.room.others).toBe(3);
    expect(o.actions).toContain('take');
  });

  it('a fallen agent sees its countdown and is not woken by looking', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    a.hp = 1;
    k.ok(a, 'attack', { target: 'slime' });
    let o = observe(k.s, a.id, k.ctx());
    expect(o.you.fallen).toBe(BALANCE.death.fallenMs / 1000);
    expect(o.you.hp[0]).toBe(0);
    expect(o.actions).toEqual(['release', 'say', 'whisper']);
    // Past the deadline but before the tick: looking does not move the agent.
    k.now += BALANCE.death.fallenMs + SEC;
    o = observe(k.s, a.id, k.ctx());
    expect(a.room).toBe('forest.edge');
    expect(o.you.fallen).toBe(0);
    // Acting does, even before the timer runs.
    const r = applyAction(k.s, { agentId: a.id, action: 'inventory' }, k.ctx());
    expect(a.room).toBe(BALANCE.templeRoom);
    expect(r.events.map((e) => e.type)).toContain('respawn');
  });

  it('the ground list in an observation is a copy', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    k.ok(a, 'drop', { item: 'bread' });
    const o = observe(k.s, a.id, k.ctx());
    k.ok(a, 'take', { item: 'bread' });
    expect(o.room.items).toEqual({ bread: 1 });
    expect(k.now - k.s.meta.createdAt).toBeLessThan(HOUR);
  });
});
