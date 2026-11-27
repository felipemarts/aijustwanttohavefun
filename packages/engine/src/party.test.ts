import { describe, expect, it } from 'vitest';
import { derive } from './agent';
import { BALANCE } from './balance';
import { bondScore, raiseBond } from './bond';
import { killMonster } from './combat';
import { checkInvariants } from './invariants';
import { observe, eventsSince } from './observe';
import { partyHere } from './party';
import { deactivateAgent } from './register';
import { newRun } from './run';
import { exportAll, restoreWorld, type Snapshot } from './snapshot';
import { tick } from './tick';
import { errKey, HOUR, keys, makeKit, MIN, narr, scriptedRng, worldWealth, type Kit } from './testkit';
import type { AgentState } from './types';

function refuse(k: Kit, a: AgentState, action: string, params: Record<string, unknown>, slug: string): void {
  expect(errKey(k.act(a, action, params)), `${action} ${JSON.stringify(params)}`).toBe(`err.${slug}`);
}

/** Leader plus members, all in `room`, partied up through the actions. */
function party(k: Kit, room: string, ...members: AgentState[]): AgentState[] {
  const [leader, ...rest] = members;
  for (const m of members) k.place(m, room);
  for (const m of rest) {
    k.ok(leader!, 'party_invite', { agent: m.name });
    k.ok(m, 'party_accept', { agent: leader!.name });
  }
  return members;
}

describe('party actions', () => {
  it('invite creates the party, accept joins it; both get the party quest step', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage');
    for (const x of [a, b]) x.quests.t11_better_together = { steps: [0], at: k.now };
    const inv = k.ok(a, 'party_invite', { agent: 'Bob' });
    expect(narr(inv, 'n.party_invite')).toEqual({ name: 'Bob', minutes: BALANCE.party.inviteMs / MIN });
    expect(a.party).not.toBeNull();
    expect(k.s.parties.get(a.party!)!.members).toEqual([a.id]);
    expect(b.partyInvites[a.id]).toBe(k.now + BALANCE.party.inviteMs);
    expect(observe(k.s, b.id, k.ctx()).pending).toEqual({ party: ['Pip'] });
    expect(observe(k.s, b.id, k.ctx()).actions).toContain('party_accept');
    const acc = k.ok(b, 'party_accept', { agent: 'Pip' });
    expect(narr(acc, 'n.party_joined')).toEqual({ leader: 'Pip', n: 2 });
    expect(b.party).toBe(a.party);
    expect(b.partyInvites).toEqual({});
    expect(a.quests.t11_better_together!.steps).toEqual([1]);
    expect(b.quests.t11_better_together!.steps).toEqual([1]);
    expect(observe(k.s, b.id, k.ctx()).you.party).toEqual({ leader: 'Pip', members: ['Pip'], loot: 'round_robin' });
    expect(observe(k.s, a.id, k.ctx()).room.agents[0]!.rel).toBe('party');
    expect(partyHere(newRun(k.s, k.now, k.rng), a)).toEqual([a, b]);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('invite errors', () => {
    const k = makeKit();
    const [a, b, c, , e] = ['Pip', 'Bob', 'Cid', 'Dee', 'Eve'].map((n) => k.add(n, 'warrior'));
    const far = k.add('Far', 'mage', { room: 'forest.edge' });
    refuse(k, a!, 'party_invite', { agent: 'Far' }, 'agent_not_here');
    refuse(k, a!, 'party_invite', { agent: 'Pip' }, 'not_yourself_social');
    party(k, 'village.square', a!, b!);
    refuse(k, b!, 'party_invite', { agent: 'Cid' }, 'party_not_leader');
    refuse(k, a!, 'party_invite', { agent: 'Bob' }, 'already_party_member');
    k.ok(c!, 'party_invite', { agent: 'Dee' });
    refuse(k, a!, 'party_invite', { agent: 'Cid' }, 'target_in_party');
    party(k, 'village.square', a!, e!, far);
    refuse(k, a!, 'party_invite', { agent: 'Dee' }, 'party_full');
    const g = k.add('Gus', 'rogue');
    for (let i = 0; i < BALANCE.party.maxInvites; i++) g.partyInvites[`x${i}`] = k.now + HOUR;
    refuse(k, c!, 'party_invite', { agent: 'Gus' }, 'party_invites_full');
    // Expired invites do not count.
    for (const id of Object.keys(g.partyInvites)) g.partyInvites[id] = k.now;
    k.ok(c!, 'party_invite', { agent: 'Gus' });
    expect(Object.keys(g.partyInvites)).toEqual([c!.id]);
  });

  it('accept errors: no invite, expired, already in a party, full, inviter gone', () => {
    const k = makeKit();
    const [a, b, c] = ['Pip', 'Bob', 'Cid'].map((n) => k.add(n, 'warrior'));
    refuse(k, b!, 'party_accept', { agent: 'Pip' }, 'no_party_invite');
    k.ok(a!, 'party_invite', { agent: 'Bob' });
    k.advance(BALANCE.party.inviteMs);
    refuse(k, b!, 'party_accept', { agent: 'Pip' }, 'no_party_invite');
    k.ok(a!, 'party_invite', { agent: 'Bob' });
    k.ok(c!, 'party_invite', { agent: 'Bob' });
    k.ok(b!, 'party_accept', { agent: 'Pip' });
    refuse(k, b!, 'party_accept', { agent: 'Cid' }, 'already_in_party');
    const d = k.add('Dee', 'mage');
    k.ok(a!, 'party_invite', { agent: 'Dee' });
    k.place(d, 'forest.edge');
    refuse(k, d, 'party_accept', { agent: 'Pip' }, 'agent_not_here');
    k.place(d, 'village.square');
    const e = k.add('Eve', 'mage');
    k.ok(a!, 'party_invite', { agent: 'Eve' });
    k.ok(e, 'party_accept', { agent: 'Pip' });
    const f = k.add('Fay', 'mage');
    f.partyInvites[a!.id] = k.now + MIN;
    k.ok(d, 'party_accept', { agent: 'Pip' });
    refuse(k, f, 'party_accept', { agent: 'Pip' }, 'party_full');
  });

  it('accepting after the inviter was left alone restarts the party around the inviter', () => {
    const k = makeKit();
    const [a, b, c] = ['Pip', 'Bob', 'Cid'].map((n) => k.add(n, 'warrior'));
    party(k, 'village.square', a!, b!);
    k.ok(a!, 'party_invite', { agent: 'Cid' });
    k.ok(b!, 'party_leave');
    expect(a!.party).toBeNull();
    k.ok(c!, 'party_accept', { agent: 'Pip' });
    const p = k.s.parties.get(a!.party!)!;
    expect(p.leader).toBe(a!.id);
    expect(p.members).toEqual([a!.id, c!.id]);
  });

  it('leave: leadership passes to the earliest joiner, a party of one dissolves, time together bonds', () => {
    const k = makeKit();
    const [a, b, c] = ['Pip', 'Bob', 'Cid'].map((n) => k.add(n, 'warrior'));
    party(k, 'village.square', a!, b!, c!);
    const id = a!.party!;
    k.advance(2 * HOUR);
    const r = k.ok(a!, 'party_leave');
    expect(keys(r)).toEqual(['n.party_left']);
    expect(r.events.find((e) => e.type === 'party_leave')!.payload.leader).toBe(b!.id);
    expect(k.s.parties.get(id)!.leader).toBe(b!.id);
    expect(bondScore(a!, b!)).toBe(Math.floor(2 * BALANCE.bond.partyPerHour));
    k.ok(c!, 'party_leave');
    expect(k.s.parties.has(id)).toBe(false);
    expect(b!.party).toBeNull();
    refuse(k, b!, 'party_leave', {}, 'not_in_party');
    // Leaving a party of one (an invite nobody answered) dissolves it.
    k.ok(a!, 'party_invite', { agent: 'Bob' });
    expect(keys(k.ok(a!, 'party_leave'))).toEqual(['n.party_disbanded']);
    expect(k.s.parties.size).toBe(0);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('a retired or banned agent leaves its party', () => {
    const k = makeKit();
    const [a, b, c] = ['Pip', 'Bob', 'Cid'].map((n) => k.add(n, 'warrior'));
    party(k, 'village.square', a!, b!, c!);
    deactivateAgent(k.s, a!.id, 'banned');
    expect(k.s.parties.get(b!.party!)!.leader).toBe(b!.id);
    expect(a!.party).toBeNull();
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('loot mode: leader only, announced to the party', () => {
    const k = makeKit();
    const [a, b] = party(k, 'village.square', k.add('Pip', 'warrior'), k.add('Bob', 'mage'));
    refuse(k, b!, 'party_loot_mode', { mode: 'leader' }, 'party_not_leader');
    refuse(k, a!, 'party_loot_mode', { mode: 'round_robin' }, 'loot_mode_same');
    const r = k.ok(a!, 'party_loot_mode', { mode: 'leader' });
    expect(narr(r, 'n.loot_mode')).toEqual({ mode: 'leader' });
    expect(k.s.parties.get(a!.party!)!.loot).toBe('leader');
    expect(r.events[0]!.payload.mode).toBe('leader');
    const solo = k.add('Solo', 'rogue');
    refuse(k, solo, 'party_loot_mode', { mode: 'leader' }, 'not_in_party');
  });

  it('party_say reaches members anywhere and is revealed after 24 h', () => {
    const k = makeKit();
    const [a, b] = party(k, 'village.square', k.add('Pip', 'warrior'), k.add('Bob', 'mage'));
    k.place(b!, 'forest.edge');
    const cursor = k.s.meta.eventSeq;
    const r = k.ok(a!, 'party_say', { text: 'meet at the oak' });
    const ev = r.events[0]!;
    expect(ev).toMatchObject({ type: 'party_say', visibility: 'delayed', revealAt: k.now + 24 * HOUR, payload: { text: 'meet at the oak' } });
    expect(eventsSince(k.s, b!.id, cursor).events).toEqual([ev]);
    refuse(k, k.add('Solo', 'rogue'), 'party_say', { text: 'hi' }, 'not_in_party');
  });

  it('party_give_loot: the leader hands a carried item to a member here', () => {
    const k = makeKit();
    const [a, b] = party(k, 'village.square', k.add('Pip', 'warrior'), k.add('Bob', 'mage'));
    k.add('Out', 'rogue');
    a!.inv.wolf_pelt = 2;
    a!.inv.lost_locket = 1;
    const before = worldWealth(k.s);
    k.ok(a!, 'party_give_loot', { agent: 'Bob', item: 'wolf_pelt' });
    expect(a!.inv.wolf_pelt).toBe(1);
    expect(b!.inv.wolf_pelt).toBe(1);
    expect(worldWealth(k.s)).toEqual(before);
    refuse(k, b!, 'party_give_loot', { agent: 'Pip', item: 'bread' }, 'party_not_leader');
    refuse(k, a!, 'party_give_loot', { agent: 'Out', item: 'wolf_pelt' }, 'not_party_member');
    refuse(k, a!, 'party_give_loot', { agent: 'Pip', item: 'wolf_pelt' }, 'not_yourself_social');
    refuse(k, a!, 'party_give_loot', { agent: 'Bob', item: 'iron_sword' }, 'item_not_carried');
    refuse(k, a!, 'party_give_loot', { agent: 'Bob', item: 'lost_locket' }, 'quest_item_bound');
    b!.inv.cos_chef_hat = 40; // cosmetics do not stack: 40 slots
    refuse(k, a!, 'party_give_loot', { agent: 'Bob', item: 'wolf_pelt' }, 'inventory_full_other');
  });
});

describe('kill sharing', () => {
  /** Kills a slime in forest.edge with the given damage table, with every roll at 0 (gold min, every drop). */
  function kill(k: Kit, threat: [AgentState, number][]): ReturnType<typeof newRun> {
    const m = k.monsters('forest.edge').find((x) => x.kind === 'slime')!;
    for (const [b, dmg] of threat) m.threat[b.id] = dmg;
    const run = newRun(k.s, k.now, scriptedRng([0]), threat[0]![0]);
    killMonster(run, 'forest.edge', m);
    return run;
  }

  it('a party is one side: every member present gets the full XP, grown per extra member, even with no damage dealt', () => {
    const k = makeKit();
    const [w, c] = party(k, 'forest.edge', k.add('Warri', 'warrior'), k.add('Cleo', 'cleric'));
    w!.gold = c!.gold = 0;
    w!.quests.t05_first_blood = { steps: [0], at: k.now };
    c!.quests.t05_first_blood = { steps: [0], at: k.now };
    kill(k, [[w!, 30]]);
    // slime XP * (1 + bonus) each, not divided; gold (min 1) is split evenly and goes to the leader.
    const each = Math.round(k.c.monsters.get('slime')!.xp * (1 + BALANCE.party.xpPerExtraMember));
    expect(w!.xp).toBe(each);
    expect(c!.xp).toBe(each);
    expect([w!.gold, c!.gold]).toEqual([1, 0]);
    expect(w!.stats.kills).toBe(1);
    expect(c!.stats.kills).toBe(1);
    expect(c!.quests.t05_first_blood!.steps).toEqual([1]);
    expect(bondScore(w!, c!)).toBe(BALANCE.bond.kill);
  });

  it('sides share by damage; a solo fighter keeps the old rules', () => {
    const k = makeKit();
    const [w, m] = party(k, 'forest.edge', k.add('Warri', 'warrior'), k.add('Magus', 'mage'));
    const r = k.add('Rogo', 'rogue', { room: 'forest.edge' });
    for (const x of [w!, m!, r]) x.gold = 0;
    const run = kill(k, [
      [w!, 10],
      [m!, 5],
      [r, 15],
    ]);
    // Party side 15/30, solo side 15/30.
    const slimeXp = k.c.monsters.get('slime')!.xp;
    expect(r.xp).toBe(Math.max(1, Math.round(slimeXp * 0.5)));
    expect(w!.xp).toBe(Math.max(1, Math.round(slimeXp * 0.5 * (1 + BALANCE.party.xpPerExtraMember))));
    expect(m!.xp).toBe(w!.xp);
    const ev = run.events.find((e) => e.type === 'kill')!;
    expect(Object.values(ev.payload.gold as Record<string, number>).reduce((x, y) => x + y, 0)).toBe(1);
  });

  it('fallen members are left out of the side', () => {
    const k = makeKit();
    const [w, c] = party(k, 'forest.edge', k.add('Warri', 'warrior'), k.add('Cleo', 'cleric'));
    c!.hp = 0;
    c!.fallen = { at: k.now, until: k.now + MIN, by: 'slime' };
    kill(k, [[w!, 30]]);
    expect(w!.xp).toBe(k.c.monsters.get('slime')!.xp);
    expect(c!.xp).toBe(0);
  });

  it('drops rotate in round robin and go to the leader in leader mode', () => {
    const k = makeKit();
    const [w, c] = party(k, 'forest.edge', k.add('Warri', 'warrior'), k.add('Cleo', 'cleric'));
    kill(k, [[w!, 30]]);
    kill(k, [[w!, 30]]);
    expect([w!.inv.slime_gel, c!.inv.slime_gel]).toEqual([1, 1]);
    k.ok(w!, 'party_loot_mode', { mode: 'leader' });
    kill(k, [[c!, 30]]);
    expect([w!.inv.slime_gel, c!.inv.slime_gel]).toEqual([2, 1]);
  });

  it('mentoring: a veteran with a newcomer in the party earns mentor points', () => {
    const k = makeKit();
    const [v, n] = party(k, 'forest.edge', k.add('Vet', 'warrior', { level: 10 }), k.add('Newb', 'mage', { level: 3 }));
    kill(k, [[n!, 30]]);
    expect(v!.stats.mentor_points).toBe(1);
    expect(n!.stats.mentor_points).toBeUndefined();
  });

  it('only counts party_min quest kills with enough party members in the room', () => {
    const k = makeKit();
    const [w, m] = party(k, 'forest.path', k.add('Warri', 'warrior'), k.add('Magus', 'mage'));
    w!.quests.t12_pack_hunt = { steps: [0], at: k.now };
    k.place(m!, 'village.square');
    const wolf = k.monsters('forest.path').find((x) => x.kind === 'wolf')!;
    wolf.threat[w!.id] = 55;
    killMonster(newRun(k.s, k.now, scriptedRng([0]), w!), 'forest.path', wolf);
    expect(w!.quests.t12_pack_hunt!.steps).toEqual([0]);
    k.place(m!, 'forest.path');
    const wolf2 = k.monsters('forest.path').find((x) => x.kind === 'wolf')!;
    wolf2.threat[w!.id] = 55;
    killMonster(newRun(k.s, k.now, scriptedRng([0]), w!), 'forest.path', wolf2);
    expect(w!.quests.t12_pack_hunt!.steps).toEqual([1]);
  });

  it('a Best Friend in the party and the room adds 5% damage', () => {
    const k = makeKit();
    const [w, m] = party(k, 'forest.path', k.add('Warri', 'warrior', { level: 8 }), k.add('Magus', 'mage'));
    const hit = () => {
      const wolf = k.monsters('forest.path').find((x) => x.kind === 'wolf')!;
      wolf.hp = 55;
      k.rng = scriptedRng([0.99, 0.5]);
      const r = k.ok(w!, 'attack', { target: wolf.uid });
      w!.hp = k.maxHp(w!);
      return Number(narr(r, 'n.hit')!.dmg);
    };
    const plain = hit();
    raiseBond(newRun(k.s, k.now, k.rng), w!, m!, BALANCE.bond.bestFriend);
    const boosted = hit();
    const atk = derive(k.c, w!, k.now).atk;
    expect(plain).toBe(Math.round(atk - 3 * 0.5));
    expect(boosted).toBe(Math.round(atk * 1.05 - 3 * 0.5));
    k.place(m!, 'village.square');
    expect(hit()).toBe(plain);
  });
});

describe('helping newcomers', () => {
  it('a veteran partied with a newbie who turns in a quest gets help_newbie', () => {
    const k = makeKit();
    const [newb, vet] = party(k, 'village.square', k.add('Newb', 'mage', { level: 2 }), k.add('Vet', 'warrior', { level: 8 }));
    const close = k.add('Close', 'rogue', { level: 4 });
    vet!.quests.d_helping_hand = { steps: [0], at: k.now };
    k.ok(newb!, 'party_invite', { agent: 'Close' });
    k.ok(close, 'party_accept', { agent: 'Newb' });
    k.ok(newb!, 'quest_accept', { quest: 't01_arrival' });
    k.ok(newb!, 'move', { dir: 'north' });
    k.ok(newb!, 'move', { dir: 'south' });
    k.ok(newb!, 'quest_turn_in', { quest: 't01_arrival' });
    expect(vet!.stats.newbies_helped).toBe(1);
    expect(vet!.quests.d_helping_hand!.steps).toEqual([1]);
    expect(close.stats.newbies_helped).toBeUndefined();
  });
});

describe('party invites: what the inviter hears, and where members are', () => {
  it('an invite that lapses unanswered tells the inviter once, even after a renewal or a restart; an accepted one never does', () => {
    const k = makeKit();
    const [a, b, c] = ['Pip', 'Bob', 'Cid'].map((n) => k.add(n, 'warrior'));
    const ms = BALANCE.party.inviteMs;
    const expiredFor = (evs: ReturnType<Kit['advance']>, who: AgentState) => evs.filter((e) => e.type === 'party_invite_expired' && e.target === who.id);
    k.step = 0;
    k.ok(a!, 'party_invite', { agent: 'Bob' });
    // Renewed halfway: the first expiry passes silently, the renewed one is told.
    k.advance(ms / 2);
    k.ok(a!, 'party_invite', { agent: 'Bob' });
    expect(expiredFor(k.advance(ms / 2), a!)).toEqual([]);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
    const lapsed = expiredFor(k.advance(ms / 2), a!);
    expect(lapsed).toHaveLength(1);
    expect(lapsed[0]!.payload.m).toEqual({ k: 'ev.party_invite_expired', p: { name: 'Bob' } });
    expect(lapsed[0]!.visibility).toBe('private');
    expect(b!.partyInvites).toEqual({});
    // Delivered to the inviter only, in the ring that room chatter cannot push out.
    expect(eventsSince(k.s, a!.id, 0).events.map((e) => e.type)).toContain('party_invite_expired');
    expect(eventsSince(k.s, b!.id, 0).events.map((e) => e.type)).not.toContain('party_invite_expired');
    expect(expiredFor(k.advance(ms), a!)).toEqual([]);
    // Accepted: nothing to tell later (the join itself reached the inviter as party_join).
    k.ok(c!, 'party_invite', { agent: 'Bob' });
    const joined = k.ok(b!, 'party_accept', { agent: 'Cid' });
    expect(joined.events.find((e) => e.type === 'party_join')).toBeDefined();
    expect(expiredFor(k.advance(ms), c!)).toEqual([]);
    // Pending across a restart: the rebuilt index still tells the inviter.
    k.add('Dee', 'mage');
    k.ok(a!, 'party_invite', { agent: 'Dee' });
    const restored = restoreWorld(k.c, JSON.parse(JSON.stringify(exportAll(k.s))) as Snapshot, k.now);
    expect(checkInvariants(restored, k.now)).toEqual([]);
    const later = tick(restored, { now: k.now + ms, rng: k.rng });
    expect(later.filter((e) => e.type === 'party_invite_expired').map((e) => e.target)).toEqual([a!.id]);
  });

  it('the invite tells the invitee how to answer and that both must stand in the same room', () => {
    const k = makeKit();
    const [a, b] = ['Pip', 'Bob'].map((n) => k.add(n, 'warrior'));
    const r = k.ok(a!, 'party_invite', { agent: 'Bob' });
    expect(r.events.find((e) => e.type === 'party_invite')!.payload.m).toEqual({ k: 'ev.party_invite', p: { actor: 'Pip', minutes: BALANCE.party.inviteMs / MIN } });
    // The engine's rule that the texts state: accepting needs the inviter in the room.
    k.place(a!, 'village.tavern');
    expect(errKey(k.act(b!, 'party_accept', { agent: 'Pip' }))).toBe('err.agent_not_here');
  });

  it('lists the room of each member who is not in the viewer room', () => {
    const k = makeKit();
    const [a, b, c] = ['Pip', 'Bob', 'Cid'].map((n) => k.add(n, 'warrior'));
    party(k, 'village.square', a!, b!, c!);
    expect(observe(k.s, a!.id, k.ctx()).you.party).toEqual({ leader: 'Pip', members: ['Bob', 'Cid'], loot: 'round_robin' });
    k.ok(c!, 'move', { dir: 'north' });
    expect(observe(k.s, a!.id, k.ctx()).you.party).toEqual({ leader: 'Pip', members: ['Bob', 'Cid'], away: { Cid: 'village.tavern' }, loot: 'round_robin' });
    expect(observe(k.s, c!.id, k.ctx()).you.party).toEqual({ leader: 'Pip', members: ['Pip', 'Bob'], away: { Pip: 'village.square', Bob: 'village.square' }, loot: 'round_robin' });
  });
});
