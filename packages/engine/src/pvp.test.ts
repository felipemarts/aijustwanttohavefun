import { describe, expect, it } from 'vitest';
import { createRng } from '@ajwf/shared';
import { BALANCE, isNight } from './balance';
import { raiseBond, bondScore } from './bond';
import { checkInvariants } from './invariants';
import { eventsSince, observe } from './observe';
import { newRun } from './run';
import { errCode, errKey, MIN, narr, partyUp, scriptedRng, makeKit, worldWealth, type Kit } from './testkit';
import type { AgentState } from './types';

const SWAMP = 'swamp.marsh_edge';

function refuse(k: Kit, a: AgentState, action: string, params: Record<string, unknown>, slug: string): void {
  expect(errKey(k.act(a, action, params)), `${action} ${JSON.stringify(params)}`).toBe(`err.${slug}`);
}

/** Two level-10 agents face to face in a lawless room. */
function duo(k: Kit, room = SWAMP): { a: AgentState; b: AgentState } {
  const a = k.add('Brasa', 'warrior', { room, level: 10 });
  const b = k.add('Pip', 'rogue', { room, level: 10 });
  return { a, b };
}

const inbox = (k: Kit, x: AgentState) => eventsSince(k.s, x.id, 0, 64).events;

describe('PvP rules', () => {
  it('is refused in safe rooms, below level 8, beyond a gap of 5 and against the fallen, without touching anyone', () => {
    const k = makeKit();
    const { a, b } = duo(k, 'village.square');
    const snap = () => JSON.stringify([a.hp, a.ap, a.gold, a.inv, a.infamy, b.hp, b.gold, b.inv, b.fallen]);
    const before = snap();
    refuse(k, a, 'attack', { target: 'Pip' }, 'pvp_safe_zone');
    expect(errCode(k.act(a, 'attack', { target: 'Pip' }))).toBe('SAFE_ZONE');
    k.place(a, SWAMP);
    k.place(b, SWAMP);
    refuse(k, a, 'attack', { target: 'Brasa' }, 'pvp_self');
    a.level = 7;
    refuse(k, a, 'attack', { target: 'Pip' }, 'pvp_level');
    a.level = 10;
    b.level = 7;
    refuse(k, a, 'attack', { target: 'Pip' }, 'pvp_target_level');
    expect(errCode(k.act(a, 'attack', { target: 'Pip' }))).toBe('LEVEL_REQUIRED');
    b.level = 16;
    refuse(k, a, 'attack', { target: 'Pip' }, 'pvp_level_gap');
    expect(errCode(k.act(a, 'attack', { target: 'Pip' }))).toBe('LEVEL_GAP');
    b.level = 15;
    b.hp = 0;
    b.fallen = { at: k.now, until: k.now + MIN, by: 'x' };
    refuse(k, a, 'attack', { target: 'Pip' }, 'pvp_target_fallen');
    b.fallen = null;
    k.setLevel(b, 10);
    expect(snap()).toBe(before);
    // An agent in another room is "not here", not "no such monster".
    k.place(b, 'swamp.reeds');
    refuse(k, a, 'attack', { target: 'Pip' }, 'agent_not_here');
  });

  it('property: across many random pairs and rooms, attack and theft succeed only in allowed places, from level 8, within 5 levels', () => {
    const k = makeKit(7);
    const rng = createRng(4711);
    const rooms = [...k.c.rooms.keys()].filter((r) => !r.startsWith('dungeon.'));
    const pool: AgentState[] = [];
    for (let i = 0; i < 12; i++) pool.push(k.add(`Prop${i}`, i % 2 ? 'rogue' : 'warrior'));
    let allowed = 0;
    let refused = 0;
    for (let trial = 0; trial < 400; trial++) {
      const [a, b] = [rng.pick(pool), rng.pick(pool)];
      if (a === b) continue;
      const room = rng.chance(0.5) ? rng.pick(['swamp.marsh_edge', 'ruins.road', 'ruins.plaza', 'swamp.bog']) : rng.pick(rooms);
      for (const x of [a, b]) {
        x.fallen = null;
        k.setLevel(x, rng.int(1, 20));
        x.gold = 1000;
        x.ap = BALANCE.ap.max;
        x.cooldowns = {};
        k.place(x, room);
      }
      // Monsters out of the way, so the name always means the agent.
      k.s.rooms.get(room)!.monsters = [];
      k.s.respawns.delete(room);
      const lawless = k.c.rooms.get(room)!.flags.includes('lawless');
      const levelsOk = a.level >= 8 && b.level >= 8 && Math.abs(a.level - b.level) <= 5;
      const steal = a.cls === 'rogue' && rng.chance(0.5);
      k.now += rng.int(0, 120) * MIN;
      const placeOk = steal ? lawless || (k.c.rooms.get(room)!.zone === 'village' && isNight(k.now + k.step)) : lawless;
      const goldB = b.gold;
      const hpB = b.hp;
      const r = k.act(a, steal ? 'steal' : 'attack', { target: b.name });
      if (placeOk && levelsOk) {
        expect(r.result.ok, `${a.level} vs ${b.level} in ${room}: ${JSON.stringify(r.result)}`).toBe(true);
        allowed++;
      } else {
        expect(errCode(r), `${a.level} vs ${b.level} in ${room}`).toBe(!placeOk ? 'SAFE_ZONE' : a.level < 8 || b.level < 8 ? 'LEVEL_REQUIRED' : 'LEVEL_GAP');
        // Nobody below level 8, nobody too far apart, nobody in a safe room loses anything.
        expect(b.gold).toBe(goldB);
        expect(b.hp).toBe(hpB);
        refused++;
      }
    }
    expect(allowed).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(100);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('monsters come first: an agent name only matches when no living monster of that kind or uid is here', () => {
    const k = makeKit();
    const room = 'ruins.outskirts';
    const a = k.add('Brasa', 'warrior', { room, level: 14 });
    const bandit = k.add('Bandit', 'rogue', { room, level: 14 });
    const hp = bandit.hp;
    const r = k.ok(a, 'attack', { target: 'bandit' });
    expect(r.events.find((e) => e.type === 'attack')!.payload.mon).toBe('bandit');
    expect(bandit.hp).toBe(hp);
    k.s.rooms.get(room)!.monsters = k.s.rooms.get(room)!.monsters.filter((m) => m.kind !== 'bandit');
    a.combat = null;
    const r2 = k.ok(a, 'attack', { target: 'Bandit' });
    expect(r2.events.find((e) => e.type === 'attack')!.payload).toMatchObject({ pvp: true, victim: 'Bandit' });
    expect(bandit.hp).toBeLessThan(hp);
  });
});

describe('PvP rounds', () => {
  it('a round is a blow each: the attacker strikes, the target strikes back, both see it', () => {
    const k = makeKit();
    const { a, b } = duo(k);
    const watcher = k.add('Watcher', 'cleric', { room: SWAMP, level: 3 });
    const [ha, hb] = [a.hp, b.hp];
    const r = k.ok(a, 'attack', { target: 'Pip' });
    expect(narr(r, 'n.pvp_hit') ?? narr(r, 'n.pvp_hit_crit')).toMatchObject({ name: 'Pip' });
    expect(narr(r, 'n.pvp_hit_back')).toMatchObject({ name: 'Pip' });
    expect(a.hp).toBeLessThan(ha);
    expect(b.hp).toBeLessThan(hb);
    const hits = r.events.filter((e) => e.type === 'attack');
    expect(hits.map((e) => [e.actor, e.target])).toEqual([
      [a.id, b.id],
      [b.id, a.id],
    ]);
    expect(hits[0]!.payload).toMatchObject({ pvp: true, victim: 'Pip' });
    expect(hits[0]!.drama).toBeGreaterThan(1);
    expect(inbox(k, b).some((e) => e.type === 'attack' && e.actor === a.id)).toBe(true);
    expect(inbox(k, watcher).filter((e) => e.type === 'attack')).toHaveLength(2);
    // Party and guild mates are fair game too; a round costs 1 AP like any attack.
    expect(a.ap).toBe(BALANCE.ap.max - 1);
  });

  it('damage skills work on agents; heals and buffs are unchanged', () => {
    const k = makeKit();
    const { a, b } = duo(k);
    const hb = b.hp;
    const r = k.ok(a, 'cast', { skill: 'power_strike', target: 'Pip' });
    expect(r.events.find((e) => e.type === 'attack' && e.actor === a.id)!.payload).toMatchObject({ pvp: true, verb: 'skill' });
    expect(b.hp).toBeLessThan(hb);
    k.place(a, 'village.square');
    k.place(b, 'village.square');
    const mp = a.mp;
    refuse(k, a, 'cast', { skill: 'power_strike', target: 'Pip' }, 'pvp_safe_zone');
    // Refused before paying: only regeneration moved the MP.
    expect(a.mp).toBeGreaterThanOrEqual(mp);
    expect(a.mp).toBeLessThan(mp + 1);
  });

  it('a kill: exactly 25% of the gold and one random unequipped, non-quest item go to the killer; equipped items stay', () => {
    const k = makeKit();
    const { a, b } = duo(k);
    b.gold = 401;
    b.inv = { wolf_pelt: 1, lost_locket: 1 };
    const equip = { ...b.equip };
    b.hp = 1;
    const goldA = a.gold;
    const wealth = worldWealth(k.s);
    const r = k.ok(a, 'attack', { target: 'Pip' });
    expect(b.fallen).toMatchObject({ pvp: true, by: 'Brasa' });
    expect(b.gold).toBe(301);
    expect(a.gold).toBe(goldA + 100);
    expect(b.inv).toEqual({ lost_locket: 1 });
    expect(a.inv.wolf_pelt).toBe(1);
    expect(b.equip).toEqual(equip);
    expect(worldWealth(k.s)).toEqual(wealth);
    expect(narr(r, 'n.pvp_kill_item')).toEqual({ name: 'Pip', gold: 100, item: '@item:wolf_pelt' });
    const ev = r.events.find((e) => e.type === 'pvp_kill')!;
    expect(ev).toMatchObject({ actor: a.id, target: b.id, visibility: 'public' });
    expect(ev.payload).toMatchObject({ killer: 'Brasa', victim: 'Pip', gold: 100, item: 'wolf_pelt', room: SWAMP });
    expect(r.events.find((e) => e.type === 'fallen')!.payload).toMatchObject({ pvp: true, by: 'Brasa' });
    expect(a.stats.pvp_kills).toBe(1);
    expect(a.achievements.outlaw).toBeDefined();
    expect(a.infamy).toBe(BALANCE.infamy.kill);
    // No counter-blow from the fallen.
    expect(r.events.filter((e) => e.type === 'attack')).toHaveLength(1);
    expect(checkInvariants(k.s, k.now)).toEqual([]);

    // No double penalty: waking at the temple costs nothing more after a PvP death.
    const wake = k.advance(BALANCE.death.fallenMs + 1000);
    expect(b.fallen).toBeNull();
    expect(b.room).toBe(BALANCE.templeRoom);
    expect(b.gold).toBe(301);
    expect(wake.find((e) => e.type === 'respawn')!.payload.lost).toBe(0);
  });

  it('only equipped items: nothing but gold changes hands; full bags drop the item to the ground', () => {
    const k = makeKit();
    const { a, b } = duo(k);
    b.inv = {};
    b.gold = 3;
    b.hp = 1;
    const r = k.ok(a, 'attack', { target: 'Pip' });
    expect(narr(r, 'n.pvp_kill')).toEqual({ name: 'Pip', gold: 0 });
    expect(b.equip.weapon).toBe('worn_dagger');
    expect(r.events.find((e) => e.type === 'pvp_kill')!.payload).not.toHaveProperty('item');

    const c = k.add('Cara', 'mage', { room: SWAMP, level: 10 });
    c.inv = { iron_sword: 1 };
    c.hp = 1;
    // Fill the killer's bags with unstackable items.
    a.inv = { iron_sword: BALANCE.inventory.slots };
    const r2 = k.ok(a, 'attack', { target: 'Cara' });
    expect(narr(r2, 'n.pvp_kill_item_ground')).toMatchObject({ name: 'Cara', item: '@item:iron_sword' });
    expect(k.s.rooms.get(SWAMP)!.ground.iron_sword).toBe(1);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('a revive by a Cleric puts the victim back with nothing more lost', () => {
    const k = makeKit();
    const { a, b } = duo(k);
    const cleric = k.add('Ilse', 'cleric', { room: SWAMP, level: 10 });
    b.gold = 100;
    b.hp = 1;
    k.ok(a, 'attack', { target: 'Pip' });
    expect(b.gold).toBe(75);
    k.ok(cleric, 'revive', { target: 'Pip' });
    expect(b.fallen).toBeNull();
    expect(b.gold).toBe(75);
    expect(cleric.honor).toBe(BALANCE.honor.revive);
  });

  it('self-defense: a counter-blow that kills takes the toll but brings no infamy', () => {
    const k = makeKit();
    const { a, b } = duo(k);
    a.hp = 1;
    a.gold = 40;
    a.inv = {};
    const r = k.ok(a, 'attack', { target: 'Pip' });
    expect(a.fallen).toMatchObject({ pvp: true, by: 'Pip' });
    expect(a.gold).toBe(30);
    expect(narr(r, 'n.pvp_killed')).toMatchObject({ name: 'Pip', gold: 10 });
    expect(r.events.find((e) => e.type === 'pvp_kill')!.payload).toMatchObject({ killer: 'Pip', victim: 'Brasa' });
    expect(b.stats.pvp_kills).toBe(1);
    expect(b.infamy).toBe(0);
  });

  it('killing two agents makes the killer Wanted; killing a Wanted agent brings no infamy', () => {
    const k = makeKit();
    const { a, b } = duo(k);
    const c = k.add('Cara', 'mage', { room: SWAMP, level: 10 });
    b.hp = 1;
    k.ok(a, 'attack', { target: 'Pip' });
    expect(a.wanted).toBeNull();
    c.hp = 1;
    const r = k.ok(a, 'attack', { target: 'Cara' });
    expect(a.wanted).not.toBeNull();
    expect(a.title).toBe('wanted');
    expect(r.events.find((e) => e.type === 'wanted')).toMatchObject({ visibility: 'public', actor: a.id });
    expect(narr(r, 'n.wanted')).toBeDefined();
    const d = k.add('Dax', 'warrior', { room: SWAMP, level: 12 });
    a.hp = 1;
    k.ok(a, 'attack', { target: 'Dax' });
    expect(a.fallen).not.toBeNull();
    expect(d.stats.pvp_kills).toBe(1);
    expect(d.infamy).toBe(0);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });
});

describe('betrayal', () => {
  it('attacking a party member: public betrayal once, oathbreaker, cast out, bonds cut, honor lost', () => {
    const k = makeKit();
    const traitor = k.add('Brasa', 'warrior', { level: 10 });
    const victim = k.add('Pip', 'rogue', { level: 10 });
    const third = k.add('Cara', 'cleric', { level: 10 });
    partyUp(k, SWAMP, victim, traitor, third);
    raiseBond(newRun(k.s, k.now, k.rng), traitor, victim, 30);
    raiseBond(newRun(k.s, k.now, k.rng), traitor, third, 30);
    const partyId = victim.party!;
    const r = k.ok(traitor, 'attack', { target: 'Pip' });
    const ev = r.events.find((e) => e.type === 'betrayal')!;
    expect(ev).toMatchObject({ actor: traitor.id, target: victim.id, visibility: 'public' });
    expect(ev.drama).toBeGreaterThanOrEqual(15);
    expect(ev.payload).toMatchObject({ traitor: 'Brasa', victim: 'Pip', party: ['Pip', 'Brasa', 'Cara'] });
    expect(narr(r, 'n.betrayal')).toEqual({ name: 'Pip' });
    expect(traitor.party).toBeNull();
    expect(k.s.parties.get(partyId)!.members).toEqual([victim.id, third.id]);
    expect(traitor.titles).toContain('oathbreaker');
    expect(traitor.achievements.oathbreaker).toBeDefined();
    expect(traitor.stats.betrayals).toBe(1);
    expect(traitor.honor).toBe(BALANCE.honor.betrayal);
    expect(bondScore(traitor, victim)).toBe(0);
    expect(bondScore(traitor, third)).toBe(15);
    expect(inbox(k, third).some((e) => e.type === 'betrayal')).toBe(true);

    // Out of the party, further blows are plain PvP.
    const r2 = k.ok(traitor, 'attack', { target: 'Pip' });
    expect(r2.events.some((e) => e.type === 'betrayal')).toBe(false);
    // Taken back in, the same betrayal is not announced twice in that party.
    k.ok(victim, 'party_invite', { agent: 'Brasa' });
    k.ok(traitor, 'party_accept', { agent: 'Pip' });
    const r3 = k.ok(traitor, 'attack', { target: 'Pip' });
    expect(r3.events.some((e) => e.type === 'betrayal')).toBe(false);
    // Turning on another member is a new betrayal.
    const r4 = k.ok(traitor, 'attack', { target: 'Cara' });
    expect(r4.events.filter((e) => e.type === 'betrayal')).toHaveLength(1);
    expect(traitor.party).toBeNull();
    expect(traitor.stats.betrayals).toBe(2);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('a betrayal that leaves the victim alone dissolves the party', () => {
    const k = makeKit();
    const traitor = k.add('Brasa', 'warrior', { level: 10 });
    const victim = k.add('Pip', 'rogue', { level: 10 });
    partyUp(k, SWAMP, traitor, victim);
    k.ok(traitor, 'attack', { target: 'Pip' });
    expect(traitor.party).toBeNull();
    expect(victim.party).toBeNull();
    expect(k.s.parties.size).toBe(0);
  });
});

describe('steal', () => {
  /** A rogue and a mark in the swamp, with a scripted roll. */
  function setup(roll: number[]) {
    const k = makeKit();
    const thief = k.add('Pip', 'rogue', { room: SWAMP, level: 10 });
    const mark = k.add('Brasa', 'warrior', { room: SWAMP, level: 10 });
    const witness = k.add('Cara', 'cleric', { room: SWAMP, level: 10 });
    mark.gold = 1000;
    k.rng = scriptedRng(roll);
    return { k, thief, mark, witness };
  }

  it('success takes up to 10% of the carried gold and the victim is never told', () => {
    const { k, thief, mark, witness } = setup([0.01, 0.99]);
    const goldT = thief.gold;
    const wealth = worldWealth(k.s);
    const r = k.ok(thief, 'steal', { target: 'Brasa' });
    const taken = 1000 - mark.gold;
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThanOrEqual(100);
    expect(thief.gold).toBe(goldT + taken);
    expect(worldWealth(k.s)).toEqual(wealth);
    expect(narr(r, 'n.steal')).toEqual({ name: 'Brasa', gold: taken });
    const ev = r.events.find((e) => e.type === 'steal')!;
    expect(ev).toMatchObject({ actor: thief.id, target: mark.id, visibility: 'room', payload: { thief: 'Pip', victim: 'Brasa', gold: taken } });
    expect(inbox(k, mark).some((e) => e.type === 'steal')).toBe(false);
    expect(inbox(k, witness).some((e) => e.type === 'steal')).toBe(true);
    expect(thief.stats.steals).toBe(1);
    expect(thief.honor).toBe(BALANCE.honor.steal);
    expect(thief.infamy).toBe(0);
    expect(thief.ap).toBe(BALANCE.ap.max - 2);
  });

  it('failure warns the victim, is seen by the room and raises infamy', () => {
    const { k, thief, mark } = setup([0.999]);
    const r = k.ok(thief, 'steal', { target: 'Brasa' });
    expect(mark.gold).toBe(1000);
    expect(narr(r, 'n.steal_failed')).toEqual({ name: 'Brasa' });
    expect(r.events.find((e) => e.type === 'steal_failed')!.payload).toEqual({ m: expect.anything(), thief: 'Pip', victim: 'Brasa' });
    expect(inbox(k, mark).some((e) => e.type === 'steal_failed')).toBe(true);
    expect(thief.stats.steals_failed).toBe(1);
    expect(thief.infamy).toBe(BALANCE.infamy.stealFailed);
  });

  it('one attempt per target every 6 hours, whatever the outcome', () => {
    const { k, thief, mark } = setup([0.999]);
    const witness = k.s.agents.get([...k.s.roomAgents.get(SWAMP)!].find((id) => id !== thief.id && id !== mark.id)!)!;
    k.ok(thief, 'steal', { target: 'Brasa' });
    refuse(k, thief, 'steal', { target: 'Brasa' }, 'steal_cooldown');
    expect(errCode(k.act(thief, 'steal', { target: 'Brasa' }))).toBe('COOLDOWN');
    k.ok(thief, 'steal', { target: witness.name });
    k.advance(BALANCE.steal.cooldownMs);
    k.ok(thief, 'steal', { target: 'Brasa' });
    // Old cooldowns are swept as new ones are set.
    expect(Object.keys(thief.cooldowns).filter((x) => x.startsWith('steal:')).length).toBeLessThanOrEqual(2);
  });

  it('only Rogues; in the village only at night; never on newcomers', () => {
    const { k, thief, mark } = setup([0.01, 0.5]);
    refuse(k, mark, 'steal', { target: 'Pip' }, 'class_only');
    k.place(thief, 'village.square');
    k.place(mark, 'village.square');
    expect(isNight(k.now + k.step)).toBe(false);
    refuse(k, thief, 'steal', { target: 'Brasa' }, 'steal_place');
    k.advance(BALANCE.day.lengthMs * BALANCE.day.night + MIN);
    expect(isNight(k.now + k.step)).toBe(true);
    k.ok(thief, 'steal', { target: 'Brasa' });
    const newbie = k.add('Newbie', 'mage', { room: 'village.square', level: 5 });
    newbie.gold = 500;
    refuse(k, thief, 'steal', { target: 'Newbie' }, 'pvp_target_level');
    expect(newbie.gold).toBe(500);
    expect(observe(k.s, thief.id, k.ctx()).actions).toContain('steal');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });
});

describe('observe in lawless rooms', () => {
  it('offers attack against agents and steal to Rogues; marks Wanted agents; shows own Honor and Infamy only when set', () => {
    const k = makeKit();
    const { a, b } = duo(k);
    k.s.rooms.get(SWAMP)!.monsters = [];
    k.s.respawns.delete(SWAMP);
    const oa = observe(k.s, a.id, k.ctx());
    expect(oa.actions).toContain('attack');
    expect(oa.actions).toContain('give');
    expect(oa.actions).not.toContain('steal');
    expect(oa.you).not.toHaveProperty('honor');
    expect(oa.you).not.toHaveProperty('infamy');
    expect(observe(k.s, b.id, k.ctx()).actions).toContain('steal');
    a.infamy = 80;
    a.infamyAt = k.now;
    a.wanted = { since: k.now, prev: null, until: k.now + 20 * 60 * MIN };
    a.honor = -50;
    expect(observe(k.s, b.id, k.ctx()).room.agents.find((x) => x.name === 'Brasa')!.wanted).toBe(true);
    expect(observe(k.s, a.id, k.ctx()).you).toMatchObject({ honor: -50, infamy: 80 });
  });
});
