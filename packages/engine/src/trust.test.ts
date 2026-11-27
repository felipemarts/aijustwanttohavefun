import { describe, expect, it } from 'vitest';
import { BALANCE } from './balance';
import { bondScore } from './bond';
import { elect } from './civic-testkit';
import { checkInvariants } from './invariants';
import { eventsSince, observe } from './observe';
import { deactivateAgent } from './register';
import { exportAll, restoreWorld, type Snapshot } from './snapshot';
import { dataOf, errCode, errKey, HOUR, makeKit, narr, worldWealth, type Kit } from './testkit';
import { infamyNow, reputation } from './trust';
import type { AgentState, Guild } from './types';

const SWAMP = 'swamp.marsh_edge';

function refuse(k: Kit, a: AgentState, action: string, params: Record<string, unknown>, slug: string): void {
  expect(errKey(k.act(a, action, params)), `${action} ${JSON.stringify(params)}`).toBe(`err.${slug}`);
}

const inbox = (k: Kit, x: AgentState) => eventsSince(k.s, x.id, 0, 64).events;

/** Kills `victim` at the hands of `killer` in the swamp (one blow: the victim is left on 1 HP). */
function kill(k: Kit, killer: AgentState, victim: AgentState) {
  k.place(killer, SWAMP);
  k.place(victim, SWAMP);
  victim.hp = 1;
  return k.ok(killer, 'attack', { target: victim.name });
}

/** Two kills in a row: the killer ends up Wanted. */
function makeWanted(k: Kit, killer: AgentState): void {
  for (const n of ['VictimA', 'VictimB']) kill(k, killer, k.add(n, 'mage', { level: killer.level }));
  expect(killer.wanted).not.toBeNull();
}

describe('give and report_scam', () => {
  it('hands goods over on trust: room event whose id the giver is told, bond, record kept, wealth conserved', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage');
    const watcher = k.add('Watcher', 'rogue');
    a.gold = 100;
    a.inv.iron_ore = 3;
    const wealth = worldWealth(k.s);
    const r = k.ok(a, 'give', { to: 'Bob', gold: 40, items: { 'Iron Ore': 2 } });
    expect(a.gold).toBe(60);
    expect(b.gold).toBe(BALANCE.startGold + 40);
    expect(b.inv.iron_ore).toBe(2);
    expect(worldWealth(k.s)).toEqual(wealth);
    const ev = r.events.find((e) => e.type === 'give')!;
    expect(ev).toMatchObject({ actor: a.id, target: b.id, visibility: 'room', payload: { from: 'Pip', to: 'Bob', gold: 40, items: { iron_ore: 2 }, value: 52 } });
    expect(narr(r, 'n.give')).toMatchObject({ name: 'Bob', event: ev.id, value: 52 });
    expect(dataOf(r).event_id).toBe(ev.id);
    expect(a.gives).toEqual([{ id: ev.id, to: b.id, value: 52, at: k.now }]);
    expect(bondScore(a, b)).toBe(BALANCE.give.bond);
    expect(inbox(k, b).some((e) => e.id === ev.id)).toBe(true);
    expect(inbox(k, watcher).some((e) => e.id === ev.id)).toBe(true);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('refuses gifts that cannot happen, changing nothing', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage');
    k.add('Far', 'mage', { room: 'forest.edge' });
    const u = k.add('Wild', 'rogue', { claimed: false });
    a.inv.lost_locket = 1;
    refuse(k, a, 'give', { to: 'Pip', gold: 1 }, 'not_yourself_social');
    refuse(k, a, 'give', { to: 'Far', gold: 1 }, 'agent_not_here');
    refuse(k, a, 'give', { to: 'Bob' }, 'goods_empty');
    refuse(k, a, 'give', { to: 'Bob', gold: 9999 }, 'goods_missing');
    refuse(k, a, 'give', { to: 'Bob', items: { lost_locket: 1 } }, 'quest_item_bound');
    refuse(k, a, 'give', { to: 'Bob', items: { dragon_egg: 1 } }, 'item_unknown');
    a.inv.iron_sword = 1;
    b.inv = { iron_sword: BALANCE.inventory.slots };
    refuse(k, a, 'give', { to: 'Bob', items: { iron_sword: 1 } }, 'inventory_full_other');
    expect(errCode(k.act(u, 'give', { to: 'Bob', gold: 1 }))).toBe('UNCLAIMED_LIMIT');
    expect(a.gives).toEqual([]);
    expect(a.gold).toBe(BALANCE.startGold);
  });

  it('report_scam: only the giver, only against the receiver, within 24 hours, once', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'mage');
    const c = k.add('Cara', 'cleric');
    a.gold = 500;
    b.stats.clean_trades = 12;
    const id = String(dataOf(k.ok(a, 'give', { to: 'Bob', gold: 100 })).event_id);
    refuse(k, a, 'report_scam', { agent: 'Nobody', event_id: id }, 'agent_unknown');
    refuse(k, a, 'report_scam', { agent: 'Bob', event_id: '999999' }, 'scam_no_give');
    refuse(k, c, 'report_scam', { agent: 'Bob', event_id: id }, 'scam_no_give');
    refuse(k, a, 'report_scam', { agent: 'Cara', event_id: id }, 'scam_wrong_agent');
    const honor = b.honor;
    const r = k.ok(a, 'report_scam', { agent: 'Bob', event_id: id });
    expect(r.events.find((e) => e.type === 'scam_reported')).toMatchObject({
      visibility: 'public',
      actor: a.id,
      target: b.id,
      payload: { victim: 'Pip', accused: 'Bob', value: 100 },
    });
    expect(a.stats.scams_suffered).toBe(1);
    expect(b.stats.scams_reported).toBe(1);
    expect(b.stats.clean_trades).toBe(0);
    expect(b.honor).toBe(honor + BALANCE.honor.scam);
    // No automatic punishment: Bob keeps the gold.
    expect(b.gold).toBe(BALANCE.startGold + 100);
    refuse(k, a, 'report_scam', { agent: 'Bob', event_id: id }, 'scam_already_reported');
    expect(errCode(k.act(a, 'report_scam', { agent: 'Bob', event_id: id }))).toBe('CONFLICT');

    const late = String(dataOf(k.ok(a, 'give', { to: 'Bob', gold: 1 })).event_id);
    k.advance(BALANCE.give.reportWindowMs + 1000);
    refuse(k, a, 'report_scam', { agent: 'Bob', event_id: late }, 'scam_too_late');
    expect(reputation(k.s, b.id, k.now)).toMatchObject({ scam_reports: 1, scams_suffered: 0 });
    expect(reputation(k.s, a.id, k.now)).toMatchObject({ scams_suffered: 1 });
  });

  it('keeps a bounded list of recent gives', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    k.add('Bob', 'mage');
    a.gold = 1000;
    for (let i = 0; i < BALANCE.give.kept + 5; i++) k.ok(a, 'give', { to: 'Bob', gold: 1 });
    expect(a.gives).toHaveLength(BALANCE.give.kept);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });
});

describe('Honor and Infamy', () => {
  it('Honor rises healing others and contributing to projects', () => {
    const k = makeKit();
    const cleric = k.add('Ilse', 'cleric', { level: 5 });
    const hurt = k.add('Bob', 'warrior', { level: 5 });
    hurt.hp = 10;
    k.ok(cleric, 'cast', { skill: 'heal', target: 'Bob' });
    expect(cleric.honor).toBe(BALANCE.honor.heal);
    k.place(cleric, 'village.town_hall');
    cleric.inv.wood = 5;
    k.ok(cleric, 'contribute', { project: 'bridge', items: { wood: 5 } });
    expect(cleric.honor).toBe(BALANCE.honor.heal + BALANCE.honor.contributeBase);
  });

  it('Wanted: forced title while it lasts, refused by village shops and the inn, served in the wilds, cleared with the old title back', () => {
    const k = makeKit();
    const a = k.add('Brasa', 'warrior', { level: 12 });
    a.titles.push('phoenix');
    a.title = 'phoenix';
    a.gold = 2000;
    makeWanted(k, a);
    expect(a.title).toBe('wanted');
    expect(a.titles).toContain('wanted');
    refuse(k, a, 'set_title', { title: 'phoenix' }, 'title_wanted');
    a.fallen = null;
    k.place(a, 'village.square');
    refuse(k, a, 'shop_buy', { npc: 'olga', item: 'bread' }, 'wanted_refused');
    a.inv.wolf_pelt = 1;
    expect(errCode(k.act(a, 'shop_sell', { npc: 'olga', item: 'wolf_pelt' }))).toBe('NOT_ALLOWED');
    k.place(a, 'village.tavern');
    a.hp = 5;
    refuse(k, a, 'rest', {}, 'wanted_refused');
    k.place(a, 'swamp.witch_hut');
    k.ok(a, 'shop_buy', { npc: 'hag_morwen', item: 'bog_lily' });
    const watcher = k.add('Seer', 'mage', { room: 'swamp.witch_hut' });
    expect(observe(k.s, watcher.id, k.ctx()).room.agents.find((x) => x.name === 'Brasa')!.wanted).toBe(true);
    expect(checkInvariants(k.s, k.now)).toEqual([]);

    // Infamy decays lazily; the timer clears Wanted exactly when it falls back under the line.
    const until = a.wanted!.until;
    expect(until - k.now).toBeLessThanOrEqual(((2 * BALANCE.infamy.kill - BALANCE.infamy.wanted) * HOUR) / BALANCE.infamy.decayPerHour + 1000);
    const events = k.advance(until - k.now);
    expect(events.find((e) => e.type === 'wanted_cleared')).toMatchObject({ visibility: 'public', actor: a.id, payload: { agent: 'Brasa' } });
    expect(a.wanted).toBeNull();
    expect(a.title).toBe('phoenix');
    expect(a.titles).not.toContain('wanted');
    expect(infamyNow(a, k.now)).toBeCloseTo(BALANCE.infamy.wanted, 5);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('a new kill while Wanted pushes the end further away; stale timers do nothing', () => {
    const k = makeKit();
    const a = k.add('Brasa', 'warrior', { level: 12 });
    makeWanted(k, a);
    const first = a.wanted!.until;
    kill(k, a, k.add('VictimC', 'mage', { level: 12 }));
    expect(a.wanted!.until).toBeGreaterThan(first);
    const ev = k.advance(first - k.now + 1000);
    expect(ev.some((e) => e.type === 'wanted_cleared')).toBe(false);
    expect(a.wanted).not.toBeNull();
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });
});

describe('bounties', () => {
  it('place_bounty: escrowed in a pool; refused without infamy, on oneself, without the gold, unknown names', () => {
    const k = makeKit();
    const outlaw = k.add('Brasa', 'warrior', { level: 10 });
    const a = k.add('Pip', 'rogue', { level: 10 });
    const b = k.add('Bob', 'mage', { level: 10 });
    a.gold = 500;
    b.gold = 500;
    refuse(k, a, 'place_bounty', { agent: 'Brasa', gold: 100 }, 'bounty_no_infamy');
    kill(k, outlaw, k.add('Victim', 'cleric', { level: 10 }));
    refuse(k, a, 'place_bounty', { agent: 'Nobody', gold: 100 }, 'agent_unknown');
    refuse(k, outlaw, 'place_bounty', { agent: 'Brasa', gold: 100 }, 'bounty_self');
    refuse(k, a, 'place_bounty', { agent: 'Brasa', gold: 9999 }, 'no_gold');
    expect(errCode(k.act(a, 'place_bounty', { agent: 'Brasa', gold: 5 }))).toBe('INVALID_PARAMS');
    const wealth = worldWealth(k.s);
    const r = k.ok(a, 'place_bounty', { agent: 'Brasa', gold: 100 });
    k.ok(b, 'place_bounty', { agent: 'Brasa', gold: 50 });
    k.ok(a, 'place_bounty', { agent: 'Brasa', gold: 25 });
    expect(worldWealth(k.s)).toEqual(wealth);
    expect(a.gold).toBe(375);
    expect(r.events.find((e) => e.type === 'bounty_placed')).toMatchObject({ visibility: 'public', payload: { by: 'Pip', target: 'Brasa', gold: 100, total: 100 } });
    expect(inbox(k, outlaw).some((e) => e.type === 'bounty_placed')).toBe(true);
    expect(k.s.bounties[outlaw.id]).toMatchObject({ total: 175, by: [{ id: a.id, gold: 125 }, { id: b.id, gold: 50 }] });
    expect(a.stats.bounties_placed).toBe(2);
    expect(reputation(k.s, outlaw.id, k.now)).toMatchObject({ bounty: 175, pvp_kills: 1 });
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('the contributor list is bounded', () => {
    const k = makeKit();
    const outlaw = k.add('Brasa', 'warrior', { level: 10 });
    kill(k, outlaw, k.add('Victim', 'cleric', { level: 10 }));
    for (let i = 0; i < BALANCE.bounty.maxContributors; i++) k.ok(k.add(`Payer${i}`, 'mage'), 'place_bounty', { agent: 'Brasa', gold: 10 });
    const late = k.add('Late', 'mage');
    refuse(k, late, 'place_bounty', { agent: 'Brasa', gold: 10 }, 'bounty_full');
    k.ok(k.s.agents.get(k.s.bounties[outlaw.id]!.by[0]!.id)!, 'place_bounty', { agent: 'Brasa', gold: 10 });
  });

  it('whoever kills the target in PvP collects the whole pool, without infamy for it', () => {
    const k = makeKit();
    const outlaw = k.add('Brasa', 'warrior', { level: 10 });
    const hunter = k.add('Hunter', 'rogue', { level: 10 });
    const payer = k.add('Payer', 'mage');
    payer.gold = 300;
    kill(k, outlaw, k.add('Victim', 'cleric', { level: 10 }));
    k.ok(payer, 'place_bounty', { agent: 'Brasa', gold: 300 });
    outlaw.fallen = null;
    outlaw.hp = 1;
    outlaw.gold = 0;
    outlaw.inv = {};
    const wealth = worldWealth(k.s);
    const gold = hunter.gold;
    const r = kill(k, hunter, outlaw);
    expect(r.events.find((e) => e.type === 'bounty_claimed')).toMatchObject({ visibility: 'public', payload: { hunter: 'Hunter', target: 'Brasa', gold: 300 } });
    expect(narr(r, 'n.bounty_claimed')).toEqual({ name: 'Brasa', gold: 300 });
    expect(hunter.gold).toBe(gold + 300);
    expect(k.s.bounties[outlaw.id]).toBeUndefined();
    expect(hunter.infamy).toBe(0);
    expect(hunter.stats.bounties_claimed).toBe(1);
    expect(hunter.titles).toContain('bounty_hunter');
    expect(worldWealth(k.s)).toEqual(wealth);
    expect(reputation(k.s, hunter.id, k.now)).toMatchObject({ bounties_claimed: 1, pvp_kills: 1, infamy: 0 });
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('a pool on an agent whose infamy stayed at zero long enough goes back to each payer, the village into the treasury', () => {
    const k = makeKit();
    const outlaw = k.add('Brasa', 'warrior', { level: 10 });
    const p1 = k.add('Payer', 'mage');
    const mayor = k.add('Maya', 'cleric', { level: 6, room: 'village.town_hall' });
    elect(k, mayor);
    k.s.village.treasury = 500;
    p1.gold = 200;
    kill(k, outlaw, k.add('Victim', 'cleric', { level: 10 }));
    k.ok(p1, 'place_bounty', { agent: 'Brasa', gold: 120 });
    refuse(k, p1, 'mayor_bounty', { agent: 'Brasa', gold: 100 }, 'not_mayor');
    refuse(k, mayor, 'mayor_bounty', { agent: 'Brasa', gold: 900 }, 'treasury_lacks');
    const r = k.ok(mayor, 'mayor_bounty', { agent: 'Brasa', gold: 100 });
    expect(r.events.find((e) => e.type === 'bounty_placed')!.payload).toMatchObject({ by: '@village', mayor: 'Maya', target: 'Brasa', gold: 100, total: 220 });
    expect(k.s.village.treasury).toBe(400);
    const wealth = worldWealth(k.s);
    // Infamy reaches zero after kill / decay hours; the refund waits the extra delay.
    const zeroAt = outlaw.infamyAt + (outlaw.infamy * HOUR) / BALANCE.infamy.decayPerHour;
    k.advance(zeroAt + BALANCE.bounty.refundAfterMs - k.now - HOUR);
    expect(k.s.bounties[outlaw.id]).toBeDefined();
    const ev = k.advance(2 * HOUR);
    expect(ev.find((e) => e.type === 'bounty_refunded')!.payload).toMatchObject({ target: 'Brasa', gold: 220 });
    expect(k.s.bounties[outlaw.id]).toBeUndefined();
    expect(p1.gold).toBe(200);
    expect(k.s.village.treasury).toBe(500);
    expect(worldWealth(k.s)).toEqual(wealth);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('new infamy postpones the refund', () => {
    const k = makeKit();
    const outlaw = k.add('Brasa', 'warrior', { level: 10 });
    const p1 = k.add('Payer', 'mage');
    p1.gold = 200;
    kill(k, outlaw, k.add('Victim', 'cleric', { level: 10 }));
    k.ok(p1, 'place_bounty', { agent: 'Brasa', gold: 100 });
    const due = k.s.bounties[outlaw.id]!.due;
    k.advance(20 * HOUR);
    outlaw.fallen = null;
    kill(k, outlaw, k.add('Victim2', 'cleric', { level: 10 }));
    k.advance(due - k.now + 1000);
    expect(k.s.bounties[outlaw.id]).toBeDefined();
    expect(k.s.bounties[outlaw.id]!.due).toBeGreaterThan(due);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });
});

describe('guild intrigue', () => {
  const HALL = 'village.guild_hall';
  function guild(k: Kit, leader: AgentState, ...members: AgentState[]): Guild {
    k.place(leader, HALL);
    leader.gold += BALANCE.guild.cost;
    k.ok(leader, 'guild_create', { name: 'Iron Wolves' });
    const g = k.s.guilds.get(leader.guild!)!;
    for (const m of members) {
      k.place(m, HALL);
      k.ok(leader, 'guild_invite', { agent: m.name });
      k.ok(m, 'guild_join', { guild: 'Iron Wolves' });
    }
    return g;
  }

  it('an officer takes over at once from a leader inactive for 72 hours; the old leader stays as a member', () => {
    const k = makeKit();
    const [lead, off1, off2, mem] = ['Lead', 'Off1', 'Off2', 'Mem'].map((n) => k.add(n, 'warrior'));
    const g = guild(k, lead!, off1!, off2!, mem!);
    k.ok(lead!, 'guild_promote', { agent: 'Off1' });
    k.ok(lead!, 'guild_promote', { agent: 'Off2' });
    refuse(k, lead!, 'guild_vote_coup', {}, 'coup_leader');
    // Before 72 hours, an officer's call is only a vote.
    k.ok(off2!, 'guild_vote_coup', {});
    expect(g.leader).toBe(lead!.id);
    expect(g.coup).toEqual([off2!.id]);
    refuse(k, off2!, 'guild_vote_coup', {}, 'coup_already_voted');
    k.advance(BALANCE.coup.inactiveMs);
    expect(observe(k.s, off2!.id, k.ctx()).actions).toContain('guild_vote_coup');
    const r = k.ok(off2!, 'guild_vote_coup', {});
    expect(r.events.find((e) => e.type === 'guild_coup')).toMatchObject({ visibility: 'public', payload: { guild: 'Iron Wolves', old: 'Lead', new: 'Off2', reason: 'inactive' } });
    expect(g.leader).toBe(off2!.id);
    expect(g.officers).toEqual([off1!.id]);
    expect(g.members).toContain(lead!.id);
    expect(g.coup).toEqual([]);
    expect(off2!.stats.coups_won).toBe(1);
    expect(off2!.titles).toContain('usurper');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('banned leaders count as inactive; a plain member only votes', () => {
    const k = makeKit();
    const [lead, off, mem] = ['Lead', 'Off', 'Mem'].map((n) => k.add(n, 'warrior'));
    const g = guild(k, lead!, off!, mem!);
    k.ok(lead!, 'guild_promote', { agent: 'Off' });
    deactivateAgent(k.s, lead!.id, 'banned');
    k.ok(mem!, 'guild_vote_coup', {});
    expect(g.leader).toBe(lead!.id);
    k.ok(off!, 'guild_vote_coup', {});
    expect(g.leader).toBe(off!.id);
  });

  it('60% of the members voting hands the lead to the longest-serving officer among the voters', () => {
    const k = makeKit();
    const names = ['Lead', 'Oona', 'Otto', 'Mira', 'Milo'];
    const [lead, o1, o2, m1, m2] = names.map((n) => k.add(n, 'warrior'));
    const g = guild(k, lead!, o1!, o2!, m1!, m2!);
    k.ok(lead!, 'guild_promote', { agent: 'Oona' });
    k.ok(lead!, 'guild_promote', { agent: 'Otto' });
    k.ok(m1!, 'guild_vote_coup', {});
    const r = k.ok(o2!, 'guild_vote_coup', {});
    expect(narr(r, 'n.coup_vote')).toMatchObject({ n: 2, need: 3 });
    expect(r.events.find((e) => e.type === 'guild_coup_vote')).toBeDefined();
    const r2 = k.ok(m2!, 'guild_vote_coup', {});
    // Oona serves longer but did not vote: Otto takes over.
    expect(r2.events.find((e) => e.type === 'guild_coup')!.payload).toMatchObject({ old: 'Lead', new: 'Otto', reason: 'vote' });
    expect(narr(r2, 'n.coup_done')).toMatchObject({ name: 'Otto', old: 'Lead' });
    expect(g.leader).toBe(o2!.id);
    expect(g.officers).toEqual([o1!.id]);
    expect(g.coup).toEqual([]);
    // Without any officer among the voters, the longest-serving officer.
    k.ok(m1!, 'guild_vote_coup', {});
    k.ok(m2!, 'guild_vote_coup', {});
    k.ok(lead!, 'guild_vote_coup', {});
    expect(g.leader).toBe(o1!.id);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('votes reset when the leader leaves; voters who leave stop counting', () => {
    const k = makeKit();
    const [lead, o1, m1] = ['Lead', 'Oona', 'Mira'].map((n) => k.add(n, 'warrior'));
    const g = guild(k, lead!, o1!, m1!);
    k.ok(m1!, 'guild_vote_coup', {});
    k.ok(lead!, 'guild_leave', {});
    expect(g.coup).toEqual([]);
    refuse(k, k.add('Out', 'mage'), 'guild_vote_coup', {}, 'not_in_guild');
  });

  it('withdrawing half the treasury or more is announced as a looting', () => {
    const k = makeKit();
    const [lead, off] = ['Lead', 'Off'].map((n) => k.add(n, 'warrior'));
    const g = guild(k, lead!, off!);
    k.ok(lead!, 'guild_promote', { agent: 'Off' });
    lead!.gold = 1000;
    k.ok(lead!, 'guild_deposit', { gold: 1000 });
    const small = k.ok(off!, 'guild_withdraw', { gold: 100 });
    expect(small.events.some((e) => e.type === 'treasury_looted')).toBe(false);
    const r = k.ok(off!, 'guild_withdraw', { gold: 800 });
    const ev = r.events.find((e) => e.type === 'treasury_looted')!;
    expect(ev).toMatchObject({ visibility: 'public', actor: off!.id, payload: { guild: 'Iron Wolves', by: 'Off', value: 800, share: 0.89 } });
    expect(ev.drama).toBeGreaterThanOrEqual(10);
    expect(off!.stats.treasury_looted).toBe(1);
    expect(off!.achievements.vault_cleaner).toBeDefined();
    // A treasury worth too little is not news.
    const tiny = k.ok(off!, 'guild_withdraw', { gold: 100 });
    expect(tiny.events.some((e) => e.type === 'treasury_looted')).toBe(false);
    expect(g.treasury).toBe(0);
  });
});

describe('reputation and snapshots', () => {
  it('the reputation model reads everything a profile shows', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    expect(reputation(k.s, 'nobody', k.now)).toBeNull();
    expect(reputation(k.s, a.id, k.now)).toEqual({
      name: 'Pip',
      trades: 0,
      scam_reports: 0,
      scams_suffered: 0,
      betrayals: 0,
      pvp_kills: 0,
      bounties_claimed: 0,
      bounty: 0,
      honor: 0,
      infamy: 0,
      wanted: false,
    });
  });

  it('honor, infamy, Wanted, gives, bounties, coup votes and PvP falls survive exportAll / restoreWorld', () => {
    const k = makeKit();
    const outlaw = k.add('Brasa', 'warrior', { level: 12 });
    makeWanted(k, outlaw);
    const payer = k.add('Payer', 'mage');
    payer.gold = 100;
    k.ok(payer, 'place_bounty', { agent: 'Brasa', gold: 60 });
    k.add('Bob', 'mage');
    k.ok(payer, 'give', { to: 'Bob', gold: 10 });
    const [lead, mem, m2] = ['Lead', 'Mem', 'Mem2'].map((n) => k.add(n, 'warrior', { room: 'village.guild_hall' }));
    lead!.gold = 1000;
    k.ok(lead!, 'guild_create', { name: 'Iron Wolves' });
    for (const m of [mem!, m2!]) {
      k.ok(lead!, 'guild_invite', { agent: m.name });
      k.ok(m, 'guild_join', { guild: 'Iron Wolves' });
    }
    k.ok(mem!, 'guild_vote_coup', {});
    const snap = JSON.parse(JSON.stringify(exportAll(k.s))) as Snapshot;
    const r = restoreWorld(k.c, snap, k.now);
    const o = r.agents.get(outlaw.id)!;
    expect(o.wanted).toEqual(outlaw.wanted);
    expect(o.infamy).toBe(outlaw.infamy);
    expect(o.title).toBe('wanted');
    expect(r.agents.get(payer.id)!.gives).toEqual(payer.gives);
    expect(r.bounties).toEqual(k.s.bounties);
    expect(r.guilds.get(lead!.guild!)!.coup).toEqual([mem!.id]);
    const victim = r.agents.get(k.s.byName.get('victima')!)!;
    expect(victim.fallen?.pvp).toBe(true);
    expect(checkInvariants(r, k.now)).toEqual([]);
    expect(worldWealth(r)).toEqual(worldWealth(k.s));

    // Older snapshots, from before these fields existed, load with defaults.
    for (const a of snap.agents) {
      const raw = a as Partial<AgentState>;
      delete raw.honor;
      delete raw.infamy;
      delete raw.infamyAt;
      delete raw.wanted;
      delete raw.gives;
      raw.titles = (raw.titles ?? []).filter((t) => t !== 'wanted');
      if (raw.title === 'wanted') raw.title = null;
    }
    const old = { agents: snap.agents, world: snap.world.filter((e) => e.key !== 'bounties').map((e) => (e.key.startsWith('guild:') ? { ...e, data: { ...(e.data as Guild), coup: undefined } } : e)) };
    const r2 = restoreWorld(k.c, old as Snapshot, k.now);
    expect(r2.agents.get(outlaw.id)).toMatchObject({ honor: 0, infamy: 0, wanted: null, gives: [] });
    expect(r2.guilds.get(lead!.guild!)!.coup).toEqual([]);
    expect(r2.bounties).toEqual({});
    expect(checkInvariants(r2, k.now)).toEqual([]);
  });
});
