import { describe, expect, it } from 'vitest';
import { BALANCE } from './balance';
import { bondLevel, bondScore, dropBond, raiseBond } from './bond';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { newRun } from './run';
import { errCode, errKey, keys, makeKit, MIN, narr, SEC, type Kit } from './testkit';
import type { AgentState } from './types';

/** Fails the action and checks the error key (`err.<slug>`). */
function refuse(k: Kit, a: AgentState, action: string, params: Record<string, unknown>, slug: string): void {
  const r = k.act(a, action, params);
  expect(errKey(r), `${action} ${JSON.stringify(params)}`).toBe(`err.${slug}`);
}

describe('friends', () => {
  it('request then accept: mutual friends, stats, quest step, events for both', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage', { room: 'forest.edge' });
    b.quests.t09_first_friend = { steps: [0], at: k.now };
    const r = k.ok(a, 'friend_request', { agent: 'bob' });
    expect(keys(r)).toEqual(['n.friend_request']);
    expect(b.friendReqs[a.id]).toBe(k.now);
    expect(r.events[0]!.type).toBe('friend_request');
    expect(observe(k.s, b.id, k.ctx()).pending).toEqual({ friends: ['Pip'] });
    const acc = k.ok(b, 'friend_accept', { agent: 'Pip' });
    expect(narr(acc, 'n.friend_added')).toEqual({ name: 'Pip' });
    expect(a.friends).toEqual([b.id]);
    expect(b.friends).toEqual([a.id]);
    expect(b.friendReqs).toEqual({});
    expect(a.stats.friends).toBe(1);
    expect(b.stats.friends).toBe(1);
    expect(a.achievements.friendly).toBeDefined();
    expect(b.quests.t09_first_friend!.steps).toEqual([1]);
    expect(acc.events.find((e) => e.type === 'friend')!.visibility).toBe('public');
    expect(observe(k.s, b.id, k.ctx()).pending).toBeUndefined();
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('asking someone who already asked you makes you friends at once', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage');
    k.ok(a, 'friend_request', { agent: 'Bob' });
    k.ok(b, 'friend_request', { agent: 'Pip' });
    expect(a.friends).toEqual([b.id]);
  });

  it('errors', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage');
    expect(k.err(a, 'friend_request', { agent: 'Nobody' })).toBe('TARGET_NOT_FOUND');
    refuse(k, a, 'friend_request', { agent: 'Pip' }, 'not_yourself_social');
    refuse(k, a, 'friend_accept', { agent: 'Bob' }, 'no_friend_request');
    k.ok(a, 'friend_request', { agent: 'Bob' });
    refuse(k, a, 'friend_request', { agent: 'Bob' }, 'friend_request_pending');
    k.ok(b, 'friend_accept', { agent: 'Pip' });
    refuse(k, a, 'friend_request', { agent: 'Bob' }, 'already_friends');
    refuse(k, b, 'friend_accept', { agent: 'Pip' }, 'already_friends');

    const c = k.add('Cid', 'rogue');
    a.friends.push(...Array.from({ length: BALANCE.social.maxFriends - 1 }, (_, i) => `x${i}`));
    refuse(k, a, 'friend_request', { agent: 'Cid' }, 'friends_full');
    k.ok(c, 'friend_request', { agent: 'Pip' });
    refuse(k, a, 'friend_accept', { agent: 'Cid' }, 'friends_full');
    refuse(k, c, 'friend_request', { agent: 'Pip' }, 'friend_request_pending');
    a.friends.length = 1;
    const d = k.add('Dee', 'cleric');
    for (let i = 0; i < BALANCE.social.maxFriendRequests; i++) d.friendReqs[`y${i}`] = k.now;
    refuse(k, a, 'friend_request', { agent: 'Dee' }, 'friend_requests_full');
    d.friendReqs = {};
    k.ok(d, 'friend_request', { agent: 'Pip' });
    d.friends.push(...Array.from({ length: BALANCE.social.maxFriends }, (_, i) => `z${i}`));
    refuse(k, a, 'friend_accept', { agent: 'Dee' }, 'friends_full_other');
  });
});

describe('rivals', () => {
  it('one-sided and public, with stat and achievement', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage', { room: 'forest.path' });
    const r = k.ok(a, 'declare_rival', { agent: 'Bob' });
    expect(a.rivals).toEqual([b.id]);
    expect(b.rivals).toEqual([]);
    const ev = r.events.find((e) => e.type === 'rival')!;
    expect(ev.visibility).toBe('public');
    expect(ev.drama).toBe(4);
    expect(a.stats.rivals).toBe(1);
    expect(a.achievements.archrival).toBeDefined();
    refuse(k, a, 'declare_rival', { agent: 'Bob' }, 'already_rival');
    refuse(k, a, 'declare_rival', { agent: 'pip' }, 'not_yourself_social');
    a.rivals.push(...Array.from({ length: BALANCE.social.maxRivals }, (_, i) => `x${i}`));
    k.add('Cid', 'rogue');
    refuse(k, a, 'declare_rival', { agent: 'Cid' }, 'rivals_full');
  });
});

describe('bonds', () => {
  it('rise on both sides, announce each level, Best Friend publicly with a stat', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage');
    const run = newRun(k.s, k.now, k.rng, a);
    raiseBond(run, a, b, BALANCE.bond.acquaintance);
    expect(a.bonds[b.id]!.v).toBe(BALANCE.bond.acquaintance);
    expect(b.bonds[a.id]!.v).toBe(BALANCE.bond.acquaintance);
    expect(run.events.map((e) => [e.type, e.visibility, e.payload.level])).toEqual([['bond', 'private', 'acquaintance']]);
    expect(run.narr.map((m) => m.k)).toEqual(['n.bond_level']);
    raiseBond(run, a, b, 1);
    expect(run.events).toHaveLength(1);
    raiseBond(run, a, b, BALANCE.bond.bestFriend);
    const best = run.events[run.events.length - 1]!;
    expect(best.visibility).toBe('public');
    expect(best.drama).toBe(7);
    expect(a.stats.best_friends).toBe(1);
    expect(b.stats.best_friends).toBe(1);
    expect(a.achievements.inseparable).toBeDefined();
    raiseBond(run, a, b, 10_000);
    expect(bondScore(a, b)).toBe(BALANCE.bond.max);
    expect(bondLevel(bondScore(a, b))).toBe('best_friend');
  });

  it('dropBond lowers both sides silently and never below zero', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage');
    const run = newRun(k.s, k.now, k.rng, a);
    raiseBond(run, a, b, 50);
    const events = run.events.length;
    dropBond(run, a, b, 45);
    expect(bondScore(a, b)).toBe(5);
    expect(bondScore(b, a)).toBe(5);
    dropBond(run, a, b, 100);
    expect(bondScore(a, b)).toBe(0);
    expect(run.events).toHaveLength(events);
  });

  it('keeps only the strongest bonds per agent; the other side still remembers', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const run = newRun(k.s, k.now, k.rng, a);
    const others = Array.from({ length: BALANCE.bond.keep + 1 }, (_, i) => k.add(`Peer${i}`, 'mage'));
    others.forEach((b, i) => raiseBond(run, a, b, 2 + i));
    expect(Object.keys(a.bonds)).toHaveLength(BALANCE.bond.keep);
    expect(a.bonds[others[0]!.id]).toBeUndefined();
    expect(bondScore(a, others[0]!)).toBe(2);
    // A new weakest bond is not even stored on the crowded side, which then has nothing new to save.
    const z = k.add('Zed', 'rogue');
    k.s.dirty.clear();
    raiseBond(run, a, z, 1);
    expect(a.bonds[z.id]).toBeUndefined();
    expect(bondScore(a, z)).toBe(1);
    expect([...k.s.dirty]).toEqual([`agent:${z.id}`]);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('chat in a crowded room bonds the speaker with the latest speakers only, never with every listener', () => {
    const k = makeKit();
    const room = 'village.tavern';
    const crowd = Array.from({ length: 200 }, (_, i) => k.add(`Crowd${i}`, 'mage', { room }));
    const dirtyAgents = () => [...k.s.dirty].filter((d) => d.startsWith('agent:')).length;
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      k.now += BALANCE.chat.sayCooldownMs;
      k.s.dirty.clear();
      k.ok(crowd[(i * 7) % crowd.length]!, 'say', { text: 'hello all' });
      worst = Math.max(worst, dirtyAgents());
    }
    // The speaker, plus at most the other speakers the room remembers: never the 199 listeners.
    expect(worst).toBeLessThanOrEqual(1 + BALANCE.camaraderie.speakersKept);
  });

  it('talking in the same room counts once per pair every few minutes', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage');
    k.ok(b, 'say', { text: 'hi' });
    k.ok(a, 'say', { text: 'hello' });
    expect(bondScore(a, b)).toBe(BALANCE.bond.talk);
    k.advance(BALANCE.chat.sayCooldownMs);
    k.ok(b, 'say', { text: 'again' });
    k.advance(BALANCE.chat.sayCooldownMs);
    k.ok(a, 'say', { text: 'and again' });
    expect(bondScore(a, b)).toBe(BALANCE.bond.talk);
    k.advance(BALANCE.bond.talkEveryMs);
    k.ok(b, 'say', { text: 'later' });
    expect(bondScore(a, b)).toBe(2 * BALANCE.bond.talk);
    // Someone who left does not bond with the ones still talking.
    k.ok(b, 'move', { dir: 'north' });
    k.advance(BALANCE.bond.talkEveryMs);
    k.ok(a, 'say', { text: 'anyone?' });
    expect(bondScore(a, b)).toBe(2 * BALANCE.bond.talk);
  });

  it('heals and revives build bonds', () => {
    const k = makeKit();
    const c = k.add('Cleo', 'cleric', { level: 5 });
    const w = k.add('Warri', 'warrior');
    w.hp = 5;
    k.ok(c, 'cast', { skill: 'heal', target: 'Warri' });
    expect(bondScore(c, w)).toBe(BALANCE.bond.heal);
    w.hp = 0;
    w.fallen = { at: k.now, until: k.now + MIN, by: 'x' };
    k.ok(c, 'revive', { target: 'Warri' });
    expect(bondScore(c, w)).toBe(BALANCE.bond.heal + BALANCE.bond.revive);
  });

  it('is shown in the observation from Acquaintance up', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage');
    const run = newRun(k.s, k.now, k.rng, a);
    raiseBond(run, a, b, BALANCE.bond.acquaintance - 1);
    expect(observe(k.s, a.id, k.ctx()).room.agents[0]!.bond).toBeUndefined();
    raiseBond(run, a, b, 1);
    expect(observe(k.s, a.id, k.ctx()).room.agents[0]!.bond).toBe('acquaintance');
    raiseBond(run, a, b, BALANCE.bond.friend);
    expect(observe(k.s, b.id, k.ctx()).room.agents[0]!.bond).toBe('friend');
  });
});

describe('camaraderie', () => {
  function chatty(k: Kit, room = 'village.square') {
    const a = k.add('Pip', 'warrior', { room });
    const b = k.add('Bob', 'mage', { room });
    return { a, b };
  }

  it('speaking after staying 10 minutes while someone else spoke gives the Camaraderie XP buff for an hour', () => {
    const k = makeKit();
    const { a, b } = chatty(k);
    k.advance(BALANCE.camaraderie.stayMs);
    k.ok(b, 'say', { text: 'nice day' });
    const r = k.ok(a, 'say', { text: 'indeed' });
    expect(narr(r, 'n.camaraderie')).toEqual({ pct: Math.round(BALANCE.camaraderie.xp * 100), minutes: BALANCE.camaraderie.durationMs / MIN });
    expect(a.buffs).toContainEqual({ id: 'camaraderie', stat: 'xp', value: BALANCE.camaraderie.xp, until: k.now + BALANCE.camaraderie.durationMs });
    // Refreshing is silent.
    k.advance(BALANCE.chat.sayCooldownMs);
    expect(keys(k.ok(a, 'say', { text: 'still here' }))).toEqual(['n.say']);
  });

  it('is +25% at the tavern', () => {
    const k = makeKit();
    const { a, b } = chatty(k, 'village.tavern');
    k.advance(BALANCE.camaraderie.stayMs);
    k.ok(b, 'say', { text: 'cheers' });
    k.ok(a, 'say', { text: 'cheers' });
    expect(a.buffs.find((x) => x.id === 'camaraderie')!.value).toBe(BALANCE.camaraderie.tavernXp);
  });

  it('needs time in the room and a recent other speaker', () => {
    const k = makeKit();
    const { a, b } = chatty(k);
    k.ok(b, 'say', { text: 'hi' });
    k.ok(a, 'say', { text: 'just arrived' });
    expect(a.buffs).toEqual([]);
    k.advance(BALANCE.camaraderie.stayMs + BALANCE.camaraderie.windowMs + SEC);
    k.ok(a, 'say', { text: 'talking alone' });
    expect(a.buffs).toEqual([]);
    k.ok(a, 'move', { dir: 'north' });
    k.ok(b, 'move', { dir: 'north' });
    k.advance(BALANCE.camaraderie.stayMs - 10 * SEC);
    k.ok(b, 'say', { text: 'hello' });
    k.ok(a, 'say', { text: 'too soon' });
    expect(a.buffs).toEqual([]);
  });

  it('boosts XP gains', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    a.buffs.push({ id: 'camaraderie', stat: 'xp', value: 0.25, until: k.now + BALANCE.camaraderie.durationMs });
    k.ok(a, 'gather', { resource: 'wood' });
    expect(a.xp).toBe(Math.round((BALANCE.xp.gatherBase + k.c.rooms.get('forest.edge')!.level) * 1.25));
  });
});

describe('observation of others', () => {
  it('lists party, friends, guild mates and rivals before strangers, within the cap', () => {
    const k = makeKit();
    const me = k.add('Pip', 'warrior');
    const strangers = Array.from({ length: 10 }, (_, i) => k.add(`Stranger${i}`, 'mage'));
    k.add('Rival', 'rogue');
    const friend = k.add('Friend', 'cleric');
    k.ok(me, 'declare_rival', { agent: 'Rival' });
    k.ok(me, 'friend_request', { agent: 'Friend' });
    k.ok(friend, 'friend_accept', { agent: 'Pip' });
    const o = observe(k.s, me.id, k.ctx());
    expect(o.room.agents.slice(0, 2).map((x) => [x.name, x.rel])).toEqual([
      ['Friend', 'friend'],
      ['Rival', 'rival'],
    ]);
    expect(o.room.agents).toHaveLength(8);
    expect(o.room.others).toBe(strangers.length + 2 - 8);
    expect(o.actions).toContain('trade_offer');
    expect(errCode(k.act(me, 'friend_accept', { agent: 'Rival' }))).toBe('TARGET_NOT_FOUND');
  });
});
