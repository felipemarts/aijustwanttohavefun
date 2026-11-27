import { describe, expect, it } from 'vitest';
import { createRng } from '@ajwf/shared';
import { applyAction, applyParsed } from './apply';
import { BALANCE } from './balance';
import { expectSameWorld, settle, worldBytes } from './fuzzkit';
import { checkInvariants } from './invariants';
import { observe, eventsSince } from './observe';
import { exportAll, exportDirty, restoreWorld, type Snapshot } from './snapshot';
import { makeKit, narr, scriptedRng, SEC, worldWealth, type Kit } from './testkit';
import type { AgentState, ApplyResult, WorldState } from './types';

const SQUARE = 'village.square';
const F = BALANCE.fountain;

/** Applies an action at the kit's current instant, with the actor already brought up to date (nothing else runs). */
function now(k: Kit, a: AgentState, params: Record<string, unknown>): ApplyResult {
  settle(k, a);
  return applyAction(k.s, { agentId: a.id, action: 'wish', params }, k.ctx());
}

/** A refusal at this instant: its error, and the proof that the persisted world did not change at all. */
function refused(k: Kit, a: AgentState, params: Record<string, unknown>): { code: string; key: string; hint?: string; p?: Record<string, unknown> } {
  settle(k, a);
  const before = worldBytes(k.s);
  const r = applyAction(k.s, { agentId: a.id, action: 'wish', params }, k.ctx());
  if (r.result.ok) throw new Error(`wish ${JSON.stringify(params)} unexpectedly succeeded`);
  expect(r.events).toEqual([]);
  expectSameWorld(k.s, before, `wish ${JSON.stringify(params)}`);
  const e = r.result.error;
  return { code: e.code, key: e.msg.k, ...(e.hint ? { hint: e.hint.k } : {}), ...(e.msg.p ? { p: e.msg.p } : {}) };
}

const inbox = (k: Kit, x: AgentState) => eventsSince(k.s, x.id, 0, 64).events;

/** Through JSON, like the database would. */
function persist(s: WorldState): Snapshot {
  return JSON.parse(JSON.stringify(exportAll(s))) as Snapshot;
}

function square(seed = 1): { k: Kit; pip: AgentState; bob: AgentState } {
  const k = makeKit(seed);
  const pip = k.add('Pip', 'warrior', { room: SQUARE });
  const bob = k.add('Bob', 'mage', { room: SQUARE });
  return { k, pip, bob };
}

describe('wish', () => {
  it('moves the coins from the agent into the pot, narrates the pot, and keeps the world’s gold whole', () => {
    const { k, pip, bob } = square();
    pip.gold = 50;
    const wealth = worldWealth(k.s);
    const r = now(k, pip, { gold: 3, text: 'A warm bed and a full belly' });
    expect(r.result.ok).toBe(true);
    expect(pip.gold).toBe(47);
    expect(k.s.fountain.pot).toBe(3);
    expect(narr(r, 'n.wish')).toEqual({ gold: 3, pot: 3 });
    expect(worldWealth(k.s)).toEqual(wealth);
    expect(pip.stats.wishes).toBe(1);
    expect(pip.achievements.first_wish).toBe(k.now);
    expect(pip.cooldowns.wish).toBe(k.now + F.cooldownMs);
    expect(k.s.dirty.has('fountain')).toBe(true);
    expect(checkInvariants(k.s, k.now)).toEqual([]);

    // One room event: the narration names the agent; the wish travels apart, for spectators.
    const ev = r.events.find((e) => e.type === 'wish')!;
    expect(ev).toMatchObject({ visibility: 'room', roomId: SQUARE, actor: pip.id, lang: 'en', drama: 1 });
    expect(ev.payload).toEqual({ m: { k: 'ev.wish', p: { actor: 'Pip' } }, text: 'A warm bed and a full belly' });
    expect(inbox(k, bob).map((e) => e.type)).toContain('wish');

    // A second toss, a minute later, with the default single coin and no words.
    k.now += F.cooldownMs;
    const r2 = now(k, pip, {});
    expect(r2.result.ok).toBe(true);
    expect(pip.gold).toBe(46);
    expect(narr(r2, 'n.wish')).toEqual({ gold: 1, pot: 4 });
    const ev2 = r2.events.find((e) => e.type === 'wish')!;
    expect(ev2.payload).toEqual({ m: { k: 'ev.wish', p: { actor: 'Pip' } } });
    expect(ev2.lang).toBeUndefined();
  });

  it('is offered where the fountain is, to claimed agents', () => {
    const { k, pip } = square();
    const ctx = { now: k.now, rng: createRng(1) };
    expect(k.c.rooms.get(SQUARE)!.flags).toContain('fountain');
    expect(observe(k.s, pip.id, ctx).actions).toContain('wish');
    const wild = k.add('Wild', 'rogue', { claimed: false, room: SQUARE });
    expect(observe(k.s, wild.id, ctx).actions).not.toContain('wish');
    k.place(pip, 'village.tavern');
    expect(observe(k.s, pip.id, ctx).actions).not.toContain('wish');
  });

  it('refuses away from the fountain, pointing at the square', () => {
    const { k, pip } = square();
    k.place(pip, 'village.tavern');
    expect(refused(k, pip, { gold: 1 })).toEqual({ code: 'NOT_AVAILABLE_HERE', key: 'err.no_fountain', hint: 'hint.no_fountain', p: { room: `@room:${SQUARE}` } });
  });

  it('refuses unclaimed agents, like give', () => {
    const { k } = square();
    const wild = k.add('Wild', 'rogue', { claimed: false, room: SQUARE });
    const wish = refused(k, wild, { gold: 1, text: 'more gold' });
    expect(wish).toEqual({ code: 'UNCLAIMED_LIMIT', key: 'err.unclaimed', hint: 'hint.unclaimed', p: { action: 'wish' } });
    const give = k.act(wild, 'give', { to: 'Pip', gold: 1 });
    expect(give.result.ok ? null : [give.result.error.code, give.result.error.msg.k]).toEqual([wish.code, wish.key]);
  });

  it('refuses an agent without the coins', () => {
    const { k, pip } = square();
    pip.gold = 2;
    expect(refused(k, pip, { gold: 3 })).toMatchObject({ code: 'NOT_ENOUGH_GOLD', key: 'err.no_gold', p: { need: 3, have: 2 } });
    pip.gold = 0;
    expect(refused(k, pip, {}).code).toBe('NOT_ENOUGH_GOLD');
  });

  it('allows one wish a minute, with the COOLDOWN code', () => {
    const { k, pip } = square();
    expect(now(k, pip, { gold: 1 }).result.ok).toBe(true);
    k.now += 20 * SEC;
    expect(refused(k, pip, { gold: 1 })).toEqual({ code: 'COOLDOWN', key: 'err.wish_cooldown', hint: 'hint.wish_cooldown', p: { seconds: 40 } });
    // The cooldown is checked before the text is cleaned: a refused wish with bad text is still a cooldown.
    expect(refused(k, pip, { gold: 1, text: '​' }).code).toBe('COOLDOWN');
    k.now += 40 * SEC;
    expect(now(k, pip, { gold: 1 }).result.ok).toBe(true);
  });

  it('cleans the text like chat, and a refused text starts no cooldown', () => {
    const { k, pip } = square();
    expect(refused(k, pip, { text: '​' })).toMatchObject({ code: 'INVALID_PARAMS', key: 'err.empty_text' });
    const r = now(k, pip, { text: 'visit https://spam.example now' });
    expect(r.result.ok).toBe(true);
    expect(r.events.find((e) => e.type === 'wish')!.payload.text).toBe('visit [link] now');
  });

  it('a muted agent may toss a coin, but not have its words shown', () => {
    const { k, pip } = square();
    pip.mutedUntil = k.now + 10 * 60_000;
    expect(refused(k, pip, { text: 'hello' })).toMatchObject({ code: 'MUTED', key: 'err.muted' });
    expect(now(k, pip, {}).result.ok).toBe(true);
  });

  it('refuses bad amounts, through the schemas and around them', () => {
    const { k, pip } = square();
    pip.gold = 1000;
    for (const gold of [0, 11, 1.5, -1]) expect(refused(k, pip, { gold }).code).toBe('INVALID_PARAMS');
    for (const gold of [NaN, 1.5, 0, -0, 11, 2 ** 53, Infinity]) {
      settle(k, pip);
      const before = worldBytes(k.s);
      const r = applyParsed(k.s, pip, 'wish', { gold }, k.ctx());
      expect(r.result.ok ? null : r.result.error.code, String(gold)).toBe('INVALID_PARAMS');
      expect(r.internal).toBeUndefined();
      expectSameWorld(k.s, before, `gold ${gold}`);
    }
  });
});

describe('the fountain’s jackpot', () => {
  it('never fires while the pot held less than the minimum before the toss', () => {
    const { k, pip } = square();
    pip.gold = 1000;
    // Every roll would win.
    k.rng = scriptedRng([0]);
    k.s.fountain.pot = F.minPot - 1;
    const r = now(k, pip, { gold: 10 });
    expect(r.result.ok).toBe(true);
    expect(r.events.map((e) => e.type)).not.toContain('fountain_jackpot');
    expect(k.s.fountain.pot).toBe(F.minPot + 9);
    expect(pip.gold).toBe(990);
  });

  it('pays the whole pot, the coins just tossed included, and empties it', () => {
    const { k, pip, bob } = square();
    pip.gold = 100;
    k.s.fountain.pot = 40;
    const wealth = worldWealth(k.s);
    k.rng = scriptedRng([0]);
    const r = now(k, pip, { gold: 2, text: 'something shiny' });
    expect(r.result.ok).toBe(true);
    expect(k.s.fountain.pot).toBe(0);
    expect(pip.gold).toBe(100 - 2 + 42);
    expect(worldWealth(k.s)).toEqual(wealth);
    expect(narr(r, 'n.wish')).toEqual({ gold: 2, pot: 42 });
    expect(narr(r, 'n.wish_jackpot')).toEqual({ gold: 42 });
    const ev = r.events.find((e) => e.type === 'fountain_jackpot')!;
    expect(ev).toMatchObject({ visibility: 'public', roomId: SQUARE, actor: pip.id, drama: 9, payload: { gold: 42, m: { k: 'ev.fountain_jackpot', p: { actor: 'Pip', gold: 42, room: `@room:${SQUARE}` } } } });
    expect(inbox(k, bob).map((e) => e.type)).toEqual(expect.arrayContaining(['wish', 'fountain_jackpot']));
    expect(pip.stats.jackpots).toBe(1);
    expect(pip.achievements.wish_granted).toBe(k.now);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('wins with chance coins × chancePerCoin: linear in the coins tossed', () => {
    const roll = 10 * F.chancePerCoin - 0.0001;
    for (const [gold, wins] of [[10, true], [9, false]] as const) {
      const { k, pip } = square();
      pip.gold = 100;
      k.s.fountain.pot = 500;
      k.rng = scriptedRng([roll]);
      const r = now(k, pip, { gold });
      expect(r.events.some((e) => e.type === 'fountain_jackpot'), `${gold} coins`).toBe(wins);
    }
  });
});

describe('the jackpot roll with an unpredictable source', () => {
  it('uses `luck` when the caller gives one, and never the shared rng', () => {
    for (const [luck, wins] of [[0, true], [0.999, false]] as const) {
      const { k, pip } = square();
      pip.gold = 100;
      k.s.fountain.pot = 500;
      // The seeded rng would say the opposite.
      const rng = scriptedRng([wins ? 0.999 : 0]);
      const r = applyAction(k.s, { agentId: pip.id, action: 'wish', params: { gold: 10 } }, { now: k.now, rng, luck: () => luck });
      expect(r.result.ok).toBe(true);
      expect(r.events.some((e) => e.type === 'fountain_jackpot'), `luck ${luck}`).toBe(wins);
    }
  });
});

describe('the fountain’s pot in snapshots', () => {
  it('survives a round trip and is saved when it changes', () => {
    const { k, pip } = square();
    exportDirty(k.s);
    expect(now(k, pip, { gold: 5 }).result.ok).toBe(true);
    expect(exportDirty(k.s).world.find((e) => e.key === 'fountain')?.data).toEqual({ pot: 5 });
    k.s.fountain.pot = 37;
    const back = restoreWorld(k.c, persist(k.s), k.now);
    expect(back.fountain).toEqual({ pot: 37 });
    expect(worldWealth(back)).toEqual(worldWealth(k.s));
    expect(checkInvariants(back, k.now)).toEqual([]);
  });

  it('loads an older snapshot without a pot as an empty pot, and does not trust a broken one', () => {
    const { k } = square();
    k.s.fountain.pot = 12;
    const snap = persist(k.s);
    const old = { ...snap, world: snap.world.filter((e) => e.key !== 'fountain') };
    expect(restoreWorld(k.c, old, k.now).fountain).toEqual({ pot: 0 });
    for (const pot of [-3, 1.5, 'lots', null]) {
      const bad = { ...snap, world: snap.world.map((e) => (e.key === 'fountain' ? { key: e.key, data: { pot } } : e)) };
      expect(restoreWorld(k.c, bad, k.now).fountain, String(pot)).toEqual({ pot: 0 });
    }
  });

  it('a pot that is not a whole number of coins breaks an invariant', () => {
    const { k } = square();
    k.s.fountain.pot = NaN;
    expect(checkInvariants(k.s, k.now)).toContain('fountain pot NaN');
  });
});
