import { describe, expect, it } from 'vitest';
import { BALANCE } from './balance';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { questReady } from './quests';
import { route } from './routes';
import { exportAll, restoreWorld, type Snapshot } from './snapshot';
import { errKeys, keys, makeKit, MIN, narr, partyUp, type Kit } from './testkit';
import type { AgentState, Escort } from './types';

const QUEST = 'e_mines_caravan';
const MARKET = 'village.market';
const DEST = 'mines.entrance';

function guards(k: Kit, cls: 'warrior' | 'mage' = 'mage'): AgentState[] {
  const a = k.add('Ayla', 'rogue', { level: 12 });
  const b = k.add('Bodo', cls, { level: 12 });
  return partyUp(k, MARKET, a, b);
}

function escortOf(k: Kit): Escort | undefined {
  return [...k.s.escorts.values()][0];
}

/** Both guards walk to `to`, the first one leading each step. */
function walk(k: Kit, party: AgentState[], to: string): void {
  for (const dir of route(k.c, party[0]!.room, to)!) for (const a of party) k.ok(a, 'move', { dir });
}

describe('escort quests', () => {
  it('need a party; the NPC follows two guards room by room and completes the quest at the destination', () => {
    const k = makeKit();
    const solo = k.add('Solo', 'cleric', { level: 12, room: MARKET });
    expect(errKeys(k.act(solo, 'quest_accept', { quest: QUEST }))).toMatchObject({ code: 'PARTY_REQUIRED', msg: 'err.escort_party', hint: 'hint.escort_party', p: { n: 2 } });
    expect(solo.quests[QUEST]).toBeUndefined();

    const [a, b] = guards(k);
    const start = k.ok(a!, 'quest_accept', { quest: QUEST });
    expect(narr(start, 'n.escort_start')).toEqual({ npc: '@npc:merchant_bram', room: `@room:${DEST}`, n: 2 });
    expect(keys(k.ok(b!, 'quest_accept', { quest: QUEST }))).toContain('n.escort_joined');
    expect(k.s.escorts.size).toBe(1);
    const e = escortOf(k)!;
    expect(e).toMatchObject({ npc: 'merchant_bram', room: MARKET, hp: 100, guards: [a!.id, b!.id] });
    expect(observe(k.s, a!.id, k.ctx()).room.escorts).toEqual([{ npc: 'merchant_bram', hp: [100, 100], to: DEST }]);

    // One guard ahead is not enough; the second one brings the NPC along.
    k.ok(a!, 'move', { dir: 'west' });
    expect(e.room).toBe(MARKET);
    const step = k.ok(b!, 'move', { dir: 'west' });
    expect(narr(step, 'n.escort_step')).toMatchObject({ npc: '@npc:merchant_bram', room: '@room:village.square', hp: 100 });
    expect(e.room).toBe('village.square');
    expect(observe(k.s, a!.id, k.ctx()).room.escorts).toHaveLength(1);
    expect(observe(k.s, solo.id, k.ctx()).room.escorts).toBeUndefined();
    expect(checkInvariants(k.s, k.now)).toEqual([]);

    // Rooms with monsters hurt the NPC on arrival: 2 boars, 3 bats and a wolf, 2 kobolds, 3 bats.
    walk(k, [a!, b!], DEST);
    expect(k.s.escorts.size).toBe(0);
    for (const g of [a!, b!]) {
      expect(questReady(g, k.c.quests.get(QUEST)!)).toBe(true);
    }
    expect(observe(k.s, a!.id, k.ctx()).room.escorts).toBeUndefined();
    walk(k, [a!, b!], MARKET);
    for (const g of [a!, b!]) k.ok(g, 'quest_turn_in', { quest: QUEST });
    expect(a!.stats.escorts_done).toBe(1);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('monsters bite the NPC on arrival, half as hard with a Warrior guard', () => {
    const hpAfter = (cls: 'warrior' | 'mage') => {
      const k = makeKit();
      const party = guards(k, cls);
      for (const g of party) k.ok(g, 'quest_accept', { quest: QUEST });
      walk(k, party, 'hills.trail');
      return escortOf(k)!.hp;
    };
    const B = BALANCE.escort;
    expect(hpAfter('mage')).toBe(B.hp - 2 * B.dmgPerMonster);
    expect(hpAfter('warrior')).toBe(B.hp - Math.round(2 * B.dmgPerMonster * B.warriorFactor));
  });

  it('fails when the NPC falls: a public event, and the guards lose the quest (they can take it again)', () => {
    const k = makeKit();
    const [a, b] = guards(k);
    for (const g of [a!, b!]) k.ok(g, 'quest_accept', { quest: QUEST });
    walk(k, [a!, b!], 'village.north_road');
    escortOf(k)!.hp = 5;
    k.ok(a!, 'move', { dir: 'west' });
    const fell = k.ok(b!, 'move', { dir: 'west' });
    expect(keys(fell)).toContain('n.escort_failed');
    const ev = fell.events.find((x) => x.type === 'escort_failed')!;
    expect(ev).toMatchObject({ visibility: 'public', payload: { m: { k: 'ev.escort_failed' } } });
    expect(ev.drama).toBeGreaterThanOrEqual(5);
    expect(k.s.escorts.size).toBe(0);
    expect(a!.quests[QUEST]).toBeUndefined();
    expect(b!.quests[QUEST]).toBeUndefined();
    expect(checkInvariants(k.s, k.now)).toEqual([]);
    walk(k, [a!, b!], MARKET);
    k.ok(a!, 'quest_accept', { quest: QUEST });
    expect(k.s.escorts.size).toBe(1);
  });

  it('expires when left waiting too long, and one party runs one escort at a time', () => {
    const k = makeKit();
    const [a, b] = guards(k);
    k.ok(a!, 'quest_accept', { quest: QUEST });
    expect(errKeys(k.act(b!, 'quest_accept', { quest: 'e_ruins_caravan' }))).toMatchObject({ code: 'CONFLICT', msg: 'err.escort_busy' });
    k.advance(BALANCE.escort.stallMs - MIN);
    expect(k.s.escorts.size).toBe(1);
    const lost = k.advance(MIN);
    expect(lost.map((e) => e.type)).toContain('escort_lost');
    expect(k.s.escorts.size).toBe(0);
    expect(a!.quests[QUEST]).toBeUndefined();
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('survives a restart', () => {
    const k = makeKit();
    const party = guards(k);
    for (const g of party) k.ok(g, 'quest_accept', { quest: QUEST });
    walk(k, party, 'village.tavern');
    const snap = JSON.parse(JSON.stringify(exportAll(k.s))) as Snapshot;
    const s = restoreWorld(k.c, snap, k.now);
    expect([...s.escorts.values()]).toEqual([...k.s.escorts.values()]);
    expect(s.escortsIn.get('village.tavern')?.size).toBe(1);
    expect(s.escortOfParty.get(party[0]!.party!)).toBe(escortOf(k)!.id);
    expect(checkInvariants(s, k.now)).toEqual([]);
  });
});
