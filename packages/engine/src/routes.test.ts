import { describe, expect, it } from 'vitest';
import { buildContent, type Content, type Quest } from '@ajwf/content';
import { readContentFiles } from '@ajwf/content/node';
import { BALANCE, respawnDelayMs } from './balance';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { initialProgress } from './quests';
import { route, routeHint, walkFor } from './routes';
import { newRun } from './run';
import { errKeys, keys, makeKit, partyUp, SEC } from './testkit';

describe('routes', () => {
  it('finds the shortest walk, preferring exits without gates, and caches it per content', () => {
    const k = makeKit();
    const c = k.c;
    expect(route(c, 'village.square', 'village.square')).toEqual([]);
    expect(route(c, 'village.square', 'village.market')).toEqual(['east']);
    expect(route(c, 'forest.edge', 'village.square')).toEqual(['east', 'east', 'east']);
    // The bridge (a project gate) is one step away, but the long way round is open.
    const around = route(c, 'village.river_bank', 'mines.lower_gate')!;
    expect(around[0]).not.toBe('north');
    expect(around.length).toBeGreaterThan(1);
    // Only gated ways lead into the dungeon: then the route goes through the gate.
    expect(route(c, 'ruins.catacomb_stairs', 'dungeon.lever_hall')).toEqual(['down', 'south']);
    expect(route(c, 'village.square', 'nowhere')).toBeNull();
    expect(route(c, 'village.square', 'mines.forge_ruin')).toBe(route(c, 'village.square', 'mines.forge_ruin'));
    // Hints are capped and absent when already there.
    expect(routeHint(c, 'village.square', 'village.square')).toBeUndefined();
    expect(routeHint(c, 'dungeon.vault', 'village.square')!.length).toBe(BALANCE.routes.hintMax);
  });

  it('puts the way to the quest giver in quest_hint and in quest_giver_elsewhere', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    expect(observe(k.s, a.id, k.ctx()).quest_hint).toEqual({ id: 't01_arrival', giver: 'olga', room: 'village.square', state: 'offer', path: ['east', 'east', 'east'] });
    const r = errKeys(k.act(a, 'quest_accept', { quest: 't01_arrival' }));
    expect(r).toMatchObject({ msg: 'err.quest_giver_elsewhere', p: { path: 'east, east, east', room_id: 'village.square' } });
    k.place(a, 'dungeon.vault');
    expect(errKeys(k.act(a, 'quest_accept', { quest: 't01_arrival' }))!.p!.path).toMatch(/, \.\.\.$/);
    // While the quest is under way the hint has no path (the work is elsewhere).
    k.place(a, 'village.square');
    k.ok(a, 'quest_accept', { quest: 't01_arrival' });
    k.place(a, 'forest.edge');
    expect(observe(k.s, a.id, k.ctx()).quest_hint).toEqual({ id: 't01_arrival', giver: 'olga', room: 'village.square', state: 'active' });
  });
});

describe('walks suggested to an agent', () => {
  /** Content where Olga, the first quest giver, stands behind the dungeon's lever gate. */
  function olgaInTheDungeon(): Content {
    const files = readContentFiles();
    return buildContent({ ...files, npcs: files.npcs!.map((n) => (n.id === 'olga' ? { ...n, room: 'dungeon.lever_hall' } : n)) });
  }

  it('follow exits only in the direction they go', () => {
    const files = readContentFiles();
    // A one-way exit: the market keeps its other exits but no longer leads west back to the square.
    const rooms = files.rooms!.map((r) => (r.id === 'village.market' ? { ...r, exits: Object.fromEntries(Object.entries(r.exits).filter(([d]) => d !== 'west')) } : r));
    const c = buildContent({ ...files, rooms });
    expect(route(c, 'village.square', 'village.market')).toEqual(['east']);
    const back = route(c, 'village.market', 'village.square')!;
    expect(back.length).toBeGreaterThan(1);
    let at = 'village.market';
    for (const dir of back) at = c.rooms.get(at)!.exits[dir]!;
    expect(at).toBe('village.square');
  });

  it('never lead through a gate that is shut to the agent: they go around it, or say the way is closed', () => {
    const k = makeKit();
    const solo = k.add('Solo', 'warrior', { level: 15, room: 'ruins.catacomb_stairs' });
    const run = () => newRun(k.s, k.now, k.rng, solo);
    // The content route goes down through the party gate; for an agent alone that way is shut, and there is no other.
    expect(route(k.c, 'ruins.catacomb_stairs', 'dungeon.antechamber')).toEqual(['down']);
    expect(walkFor(run(), solo, 'dungeon.antechamber')).toEqual({ closed: true });
    expect(k.err(solo, 'move', { dir: 'down' })).toBe('PARTY_REQUIRED');
    // A party of three with two classes may pass: then the walk is the route.
    const [w, m, c] = [k.add('Wade', 'warrior', { level: 15 }), k.add('Mira', 'mage', { level: 15 }), k.add('Cass', 'cleric', { level: 15 })];
    partyUp(k, 'ruins.catacomb_stairs', w, m, c);
    expect(walkFor(newRun(k.s, k.now, k.rng, w), w, 'dungeon.lever_hall')).toEqual({ closed: true });
    // Past the party gate, the levers still hold the way south until they are pulled.
    k.s.puzzles.dungeon_levers!.open = k.now + 60_000;
    const open = walkFor(newRun(k.s, k.now, k.rng, w), w, 'dungeon.lever_hall');
    expect(open).toEqual({ path: ['down', 'south'] });
    for (const dir of (open as { path: string[] }).path) for (const x of [w, m, c]) k.ok(x, 'move', { dir });
    // The bridge (a project not built) is shut: the walk goes the long way round, every step of it walkable.
    const b = k.add('Bea', 'warrior', { room: 'village.river_bank' });
    const around = walkFor(newRun(k.s, k.now, k.rng, b), b, 'mines.lower_gate') as { path: string[] };
    expect(around.path[0]).not.toBe('north');
    for (const dir of around.path) k.ok(b, 'move', { dir });
    expect(b.room).toBe('mines.lower_gate');
  });

  it('a quest giver behind a shut gate: the quest hint and the refusal say the way is closed instead of giving moves', () => {
    const k = makeKit(1, undefined, olgaInTheDungeon());
    const a = k.add('Pip', 'warrior', { room: 'ruins.catacomb_stairs' });
    expect(observe(k.s, a.id, k.ctx()).quest_hint).toEqual({ id: 't01_arrival', giver: 'olga', room: 'dungeon.lever_hall', state: 'offer', closed: true });
    expect(errKeys(k.act(a, 'quest_accept', { quest: 't01_arrival' }))).toMatchObject({
      msg: 'err.quest_giver_closed',
      hint: 'hint.quest_giver_closed',
      p: { room_id: 'dungeon.lever_hall' },
    });
  });
});

describe('retroactive quest steps', () => {
  it('equip, friend, guild, profession, party and visit count when already true on accept', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { level: 5 });
    const b = k.add('Bob', 'mage');
    const run = () => newRun(k.s, k.now, k.rng, a);
    const q = (steps: Quest['steps']): Quest => ({ ...k.c.quests.get('t04_gear_up')!, steps });
    // Only the starter weapon: an untargeted equip step is not done yet.
    expect(initialProgress(run(), a, q([{ type: 'equip', qty: 1 }, { type: 'equip', target: 'cloth_armor', qty: 1 }]))).toEqual([0, 0]);
    k.ok(a, 'equip', { item: 'cloth_armor' });
    expect(initialProgress(run(), a, q([{ type: 'equip', qty: 1 }, { type: 'equip', target: 'cloth_armor', qty: 1 }, { type: 'equip', target: 'iron_sword', qty: 1 }]))).toEqual([1, 1, 0]);

    expect(initialProgress(run(), a, q([{ type: 'friend', qty: 2 }, { type: 'guild', qty: 1 }, { type: 'party', qty: 1 }, { type: 'profession', qty: 1 }]))).toEqual([0, 0, 0, 0]);
    k.ok(a, 'friend_request', { agent: 'Bob' });
    k.ok(b, 'friend_accept', { agent: 'Pip' });
    partyUp(k, 'village.square', a, b);
    a.guild = 'g1';
    a.profession = 'cook';
    expect(initialProgress(run(), a, q([{ type: 'friend', qty: 2 }, { type: 'guild', qty: 1 }, { type: 'party', qty: 1 }, { type: 'profession', qty: 1 }]))).toEqual([1, 1, 1, 1]);
    expect(initialProgress(run(), a, q([{ type: 'visit', target: 'village.square', qty: 1 }, { type: 'visit', target: 'village.tavern', qty: 1 }]))).toEqual([1, 0]);
    a.guild = null;
  });

  it('the Gear Up quest is ready at once when the armor is already on', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'village.training_yard' });
    for (const id of ['t01_arrival', 't02_innkeeper', 't03_supplies']) a.questsDone[id] = k.now;
    k.ok(a, 'equip', { item: 'cloth_armor' });
    const r = k.ok(a, 'quest_accept', { quest: 't04_gear_up' });
    expect(keys(r)).toContain('n.quest_ready');
    expect(a.quests.t04_gear_up!.steps).toEqual([1]);
  });
});

describe('crowded rooms', () => {
  it('bring monsters back faster, with a floor; bosses keep their time', () => {
    const R = BALANCE.respawn;
    expect(respawnDelayMs(120_000, 0, false)).toBe(120_000);
    expect(respawnDelayMs(120_000, 1, false)).toBe(120_000);
    expect(respawnDelayMs(120_000, 2, false)).toBe(Math.round(120_000 / (1 + R.crowdK)));
    expect(respawnDelayMs(120_000, 30, false)).toBe(Math.round(120_000 / (1 + R.crowdK * 29)));
    expect(respawnDelayMs(120_000, 30, false)).toBeLessThan(30_000);
    expect(respawnDelayMs(120_000, 10_000, false)).toBe(R.crowdFloorMs);
    // A base already under the floor is never lengthened.
    expect(respawnDelayMs(5_000, 50, false)).toBe(5_000);
    expect(respawnDelayMs(7_200_000, 30, true)).toBe(7_200_000);
  });

  it('a kill in a crowded room schedules a quicker respawn, and a missing monster says when it returns', () => {
    const k = makeKit();
    const hunters = Array.from({ length: 10 }, (_, i) => k.add(`Hunter${i}`, 'warrior', { level: 10, room: 'forest.edge' }));
    const slimes = k.monsters('forest.edge').filter((m) => m.kind === 'slime');
    for (const m of slimes) m.hp = 1;
    for (const m of [...slimes]) k.ok(hunters[0]!, 'attack', { target: m.uid });
    const base = k.c.monsters.get('slime')!.respawn_sec * 1000;
    const delay = respawnDelayMs(base, 10, false);
    expect(delay).toBeLessThan(base);
    const pending = [...k.s.respawns.get('forest.edge')!.values()];
    expect(pending).toHaveLength(3);
    const r = errKeys(k.act(hunters[1]!, 'attack', { target: 'slime' }));
    expect(r).toMatchObject({ code: 'TARGET_NOT_FOUND', msg: 'err.monster_respawning', hint: 'hint.monster_respawning' });
    expect(r!.p!.seconds).toBeLessThanOrEqual(delay / 1000);
    expect(r!.p!.seconds).toBeGreaterThan(delay / 1000 - 5);
    // Monsters that never live here keep the plain answer.
    expect(errKeys(k.act(hunters[1]!, 'attack', { target: 'dragon' }))!.msg).toBe('err.monster_not_here');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
    k.advance(delay);
    expect(k.monsters('forest.edge').filter((m) => m.kind === 'slime')).toHaveLength(3);
    expect(k.s.respawns.get('forest.edge')!.size).toBe(0);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('one agent alone sees the usual respawn time', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { level: 10, room: 'forest.edge' });
    const m = k.monsters('forest.edge')[0]!;
    m.hp = 1;
    k.ok(a, 'attack', { target: m.uid });
    expect(k.s.respawns.get('forest.edge')!.get(m.slot)).toBe(k.now + k.c.monsters.get(m.kind)!.respawn_sec * SEC);
  });
});
