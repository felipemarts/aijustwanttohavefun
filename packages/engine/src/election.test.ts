import { describe, expect, it } from 'vitest';
import { BALANCE } from './balance';
import { advanceTo, build, citizen, DAY, elect } from './civic-testkit';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { deactivateAgent } from './register';
import { dataOf, errCode, errKey, HOUR, makeKit, narr, T0, worldWealth, type Kit } from './testkit';
import type { AgentState } from './types';
import { villageView } from './village-view';

function refuse(k: Kit, a: AgentState, action: string, params: Record<string, unknown>, slug: string): void {
  const before = JSON.stringify([a.gold, a.stats, a.titles, k.s.village]);
  const r = k.act(a, action, params);
  expect(errKey(r), `${action} ${JSON.stringify(params)}`).toBe(`err.${slug}`);
  expect(r.events).toEqual([]);
  expect(JSON.stringify([a.gold, a.stats, a.titles, k.s.village])).toBe(before);
}

describe('election cycle', () => {
  it('starts with the world: candidacy for 5 days, voting for 48 hours, on one timer', () => {
    const k = makeKit();
    const e = k.s.village.election;
    expect(e).toMatchObject({ n: 1, start: T0, voteAt: T0 + 5 * DAY, end: T0 + 7 * DAY, phase: 'candidacy' });
    expect(k.s.timers.toJSON().filter((t) => t.kind === 'election')).toEqual([{ at: T0 + 5 * DAY, kind: 'election' }]);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('plays a full election through the timers', () => {
    const k = makeKit();
    const ann = citizen(k, 'Ann', 5);
    const ben = citizen(k, 'Ben', 7);
    const low = citizen(k, 'Lowly', 4);
    const kid = citizen(k, 'Kiddo', 2);
    const wild = citizen(k, 'Wild', 3, { claimed: false });
    const voters = ['Vic', 'Val', 'Vex'].map((n) => citizen(k, n, 3));

    // Candidacy.
    const r = k.ok(ann, 'run_for_mayor', { platform: 'A bridge by Friday! https://spam.example' });
    expect(narr(r, 'n.run_for_mayor')).toMatchObject({ n: 1 });
    const ev = r.events.find((e) => e.type === 'run_for_mayor')!;
    expect(ev).toMatchObject({ visibility: 'public', lang: 'en', payload: { text: 'A bridge by Friday! [link]', election: 1 } });
    expect(ev.payload.m).toBeUndefined();
    refuse(k, ann, 'run_for_mayor', { platform: 'again' }, 'already_candidate');
    refuse(k, low, 'run_for_mayor', { platform: 'me' }, 'mayor_level');
    expect(k.err(wild, 'run_for_mayor', { platform: 'me' })).toBe('UNCLAIMED_LIMIT');
    refuse(k, voters[0]!, 'vote', { candidate: 'Ann' }, 'vote_not_open');
    expect(observe(k.s, ben.id, k.ctx()).actions).toContain('run_for_mayor');
    k.ok(ben, 'run_for_mayor', { platform: 'Lower taxes.' });
    expect(observe(k.s, ben.id, k.ctx()).actions).not.toContain('run_for_mayor');

    // Voting opens.
    const opening = k.advance(5 * DAY);
    const phase = opening.find((e) => e.type === 'election_phase')!;
    expect(phase).toMatchObject({ visibility: 'public', payload: { election: 1, phase: 'voting', candidates: ['Ann', 'Ben'] } });
    expect(k.s.village.election.phase).toBe('voting');
    expect(observe(k.s, voters[0]!.id, k.ctx()).actions).toContain('vote');
    k.ok(voters[0]!, 'vote', { candidate: 'ann' });
    expect(observe(k.s, voters[0]!.id, k.ctx()).actions).not.toContain('vote');
    refuse(k, voters[0]!, 'vote', { candidate: 'Ben' }, 'already_voted');
    refuse(k, voters[0]!, 'vote', { candidate: 'Ann' }, 'already_voted');
    refuse(k, kid, 'vote', { candidate: 'Ann' }, 'vote_level');
    expect(k.err(wild, 'vote', { candidate: 'Ann' })).toBe('UNCLAIMED_LIMIT');
    refuse(k, ann, 'vote', { candidate: 'Ann' }, 'vote_self');
    refuse(k, voters[1]!, 'vote', { candidate: 'Lowly' }, 'not_candidate');
    refuse(k, voters[1]!, 'vote', { candidate: 'Nobody' }, 'not_candidate');
    k.ok(voters[1]!, 'vote', { candidate: 'Ann' });
    k.ok(ann, 'vote', { candidate: 'Ben' });
    expect(voters[0]!.stats.votes).toBe(1);
    expect(voters[0]!.achievements.voter).toBeDefined();
    // Live totals in the read model.
    expect(villageView(k.s, k.now).election.candidates.map((c) => [c.name, c.votes])).toEqual([['Ann', 2], ['Ben', 1]]);
    expect(checkInvariants(k.s, k.now)).toEqual([]);

    // Closing.
    const closing = k.advance(2 * DAY);
    const result = closing.find((e) => e.type === 'election_result')!;
    expect(result).toMatchObject({ visibility: 'public', drama: 9, actor: ann.id, payload: { n: 1, winner: 'Ann', winnerId: ann.id, voters: 3, previous: null } });
    expect(result.payload.votes).toEqual([{ id: ann.id, name: 'Ann', votes: 2 }, { id: ben.id, name: 'Ben', votes: 1 }]);
    expect(k.s.village.mayor).toMatchObject({ id: ann.id, name: 'Ann', election: 1 });
    expect(ann.titles).toContain('mayor');
    expect(ann.title).toBe('mayor');
    expect(ann.stats.mayor_elected).toBe(1);
    expect(ann.achievements.wf_mayor).toBeDefined();
    expect(voters[0]!.stats.votes_for_winner).toBe(1);
    expect(voters[1]!.stats.votes_for_winner).toBe(1);
    expect(ann.stats.votes_for_winner).toBeUndefined();
    expect(k.s.village.history).toHaveLength(1);
    // The next cycle starts at once.
    const next = closing.find((e) => e.type === 'election_phase')!;
    expect(next.payload).toMatchObject({ election: 2, phase: 'candidacy' });
    expect(k.s.village.election).toMatchObject({ n: 2, start: T0 + 7 * DAY, phase: 'candidacy', candidates: [], votes: {} });
    expect(villageView(k.s, k.now)).toMatchObject({ mayor: { name: 'Ann' }, lastElection: { winner: 'Ann' } });
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('a tie goes to the earliest candidacy; run_for_mayor works during voting too', () => {
    const k = makeKit();
    const ann = citizen(k, 'Ann', 5);
    const ben = citizen(k, 'Ben', 5);
    const [v1, v2] = ['Vic', 'Val'].map((n) => citizen(k, n, 3));
    k.ok(ben, 'run_for_mayor', { platform: 'First!' });
    advanceTo(k, k.s.village.election.voteAt);
    const r = k.ok(ann, 'run_for_mayor', { platform: 'Late but loud.' });
    expect(narr(r, 'n.run_for_mayor_voting')).toBeDefined();
    k.ok(v1!, 'vote', { candidate: 'Ann' });
    k.ok(v2!, 'vote', { candidate: 'Ben' });
    advanceTo(k, k.s.village.election.end);
    expect(k.s.village.mayor?.id).toBe(ben.id);
  });

  it('no candidates or no votes: no mayor, and the previous one steps down with the title', () => {
    const k = makeKit();
    const ann = citizen(k, 'Ann', 5);
    k.ok(ann, 'set_title', { title: null });
    elect(k, ann);
    expect(k.s.village.mayor?.id).toBe(ann.id);
    // Election 2: nobody runs.
    const evs = k.advance(7 * DAY);
    const res = evs.find((e) => e.type === 'election_result')!;
    expect(res).toMatchObject({ payload: { n: 2, winner: null, previous: 'Ann' } });
    expect((res.payload.m as { k: string }).k).toBe('ev.election_no_candidates');
    expect(k.s.village.mayor).toBeNull();
    expect(ann.titles).not.toContain('mayor');
    expect(ann.title).toBeNull();
    expect(ann.titles).toContain('former_mayor');
    // Election 3: a candidate, no votes.
    k.ok(ann, 'run_for_mayor', { platform: 'Back again.' });
    const evs3 = k.advance(7 * DAY);
    expect((evs3.find((e) => e.type === 'election_result')!.payload.m as { k: string }).k).toBe('ev.election_no_votes');
    expect(k.s.village.mayor).toBeNull();
    expect(k.s.village.history.map((h) => h.winner)).toEqual(['Ann', null, null]);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('hands the title over to a new mayor and restores the old one\'s previous title; re-election keeps it', () => {
    const k = makeKit();
    const ann = citizen(k, 'Ann', 5);
    const ben = citizen(k, 'Ben', 5);
    ann.titles.push('citizen');
    ann.title = 'citizen';
    elect(k, ann);
    expect(ann.title).toBe('mayor');
    elect(k, ann);
    expect(k.s.village.mayor).toMatchObject({ id: ann.id, election: 2 });
    expect(ann.stats.mayor_elected).toBe(2);
    const evs: string[] = [];
    k.ok(ben, 'run_for_mayor', { platform: 'Change.' });
    advanceTo(k, k.s.village.election.voteAt);
    k.ok(citizen(k, 'Vic', 3), 'vote', { candidate: 'Ben' });
    for (const e of k.advance(2 * DAY)) evs.push(e.type);
    expect(evs).toContain('election_result');
    expect(k.s.village.mayor?.id).toBe(ben.id);
    expect(ann.titles).not.toContain('mayor');
    expect(ann.title).toBe('citizen');
    expect(ben.title).toBe('mayor');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('banned or retired candidates cannot be voted for, nor win', () => {
    const k = makeKit();
    const ann = citizen(k, 'Ann', 5);
    const ben = citizen(k, 'Ben', 5);
    const [v1, v2, v3] = ['Vic', 'Val', 'Vex'].map((n) => citizen(k, n, 3));
    k.ok(ann, 'run_for_mayor', { platform: 'Vote Ann.' });
    k.ok(ben, 'run_for_mayor', { platform: 'Vote Ben.' });
    advanceTo(k, k.s.village.election.voteAt);
    k.ok(v1!, 'vote', { candidate: 'Ann' });
    k.ok(v2!, 'vote', { candidate: 'Ann' });
    k.ok(v3!, 'vote', { candidate: 'Ben' });
    deactivateAgent(k.s, ann.id, 'banned');
    const v4 = citizen(k, 'Vox', 3);
    refuse(k, v4, 'vote', { candidate: 'Ann' }, 'candidate_gone');
    advanceTo(k, k.s.village.election.end);
    expect(k.s.village.mayor?.id).toBe(ben.id);
    expect(villageView(k.s, k.now).lastElection!.votes).toEqual([
      { id: ann.id, name: 'Ann', votes: 2 },
      { id: ben.id, name: 'Ben', votes: 1 },
    ]);
  });

  it('a world stopped for weeks catches up without replaying every missed phase change', () => {
    const k = makeKit();
    k.advance(30 * DAY);
    const e = k.s.village.election;
    // Election 1 opened and closed late; election 2 started at that moment, not in the past.
    expect(e.n).toBe(2);
    expect(e.start).toBe(k.now);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('kingmaker: voting for the winner three times', () => {
    const k = makeKit();
    const ann = citizen(k, 'Ann', 5);
    const fan = citizen(k, 'Fan', 3);
    for (let i = 0; i < 3; i++) {
      k.ok(ann, 'run_for_mayor', { platform: 'Same as ever.' });
      advanceTo(k, k.s.village.election.voteAt);
      k.ok(fan, 'vote', { candidate: 'Ann' });
      advanceTo(k, k.s.village.election.end);
    }
    expect(fan.stats.votes_for_winner).toBe(3);
    expect(fan.titles).toContain('kingmaker');
  });
});

describe('mayor powers', () => {
  function withMayor(): { k: Kit; m: AgentState; joe: AgentState } {
    const k = makeKit();
    const m = citizen(k, 'Mayra', 5);
    const joe = citizen(k, 'Joe', 5);
    elect(k, m);
    return { k, m, joe };
  }

  it('only the mayor may use them; the mayor sees them at the town hall', () => {
    const { k, m, joe } = withMayor();
    k.s.village.treasury = 100;
    refuse(k, joe, 'mayor_priority', { project: 'bridge' }, 'not_mayor');
    refuse(k, joe, 'mayor_tax', { rate: 0.05 }, 'not_mayor');
    refuse(k, joe, 'mayor_fund', { project: 'bridge', gold: 10 }, 'not_mayor');
    refuse(k, joe, 'mayor_embezzle', { gold: 1 }, 'not_mayor');
    expect(observe(k.s, m.id, k.ctx()).actions).toEqual(expect.arrayContaining(['mayor_priority', 'mayor_tax', 'mayor_fund', 'mayor_embezzle']));
    expect(observe(k.s, joe.id, k.ctx()).actions).not.toContain('mayor_tax');
    // mayor_bounty arrives with a later task.
    expect(errCode(k.act(m, 'mayor_bounty', { agent: 'Joe', gold: 10 }))).toBe('INVALID_ACTION');
  });

  it('mayor_tax: 0 to 10%, read by the market', () => {
    const { k, m } = withMayor();
    expect(k.err(m, 'mayor_tax', { rate: 0.2 })).toBe('INVALID_PARAMS');
    expect(k.err(m, 'mayor_tax', { rate: -0.01 })).toBe('INVALID_PARAMS');
    refuse(k, m, 'mayor_tax', { rate: 0 }, 'tax_same');
    const r = k.ok(m, 'mayor_tax', { rate: 0.1 });
    expect(narr(r, 'n.mayor_tax')).toEqual({ pct: 10 });
    expect(r.events.find((e) => e.type === 'mayor_tax')).toMatchObject({ visibility: 'public', payload: { rate: 0.1, old: 0 } });
    expect(k.s.village.taxRate).toBe(0.1);
    // A market sale pays 10% into the treasury.
    const s = citizen(k, 'Seller', 3, { room: 'village.market' });
    const b = citizen(k, 'Buyer', 3, { room: 'village.market' });
    s.inv.wood = 1;
    b.gold = 100;
    const order = dataOf(k.ok(s, 'market_sell', { item: 'wood', qty: 1, price: 50 })).order;
    k.ok(b, 'market_buy', { order });
    expect(k.s.village.treasury).toBe(5);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('mayor_priority: an available project only, once', () => {
    const { k, m } = withMayor();
    refuse(k, m, 'mayor_priority', { project: 'library' }, 'project_locked');
    refuse(k, m, 'mayor_priority', { project: 'nope' }, 'project_unknown');
    const r = k.ok(m, 'mayor_priority', { project: 'watchtower' });
    expect(r.events.find((e) => e.type === 'mayor_priority')).toMatchObject({ visibility: 'public', payload: { project: 'watchtower' } });
    expect(k.s.village.priority).toBe('watchtower');
    refuse(k, m, 'mayor_priority', { project: 'watchtower' }, 'priority_same');
    build(k, 'watchtower');
    expect(k.s.village.priority).toBeNull();
    refuse(k, m, 'mayor_priority', { project: 'watchtower' }, 'project_done');
  });

  it('mayor_fund: treasury gold only, trimmed to the gold still missing', () => {
    const { k, m } = withMayor();
    k.s.village.treasury = 600;
    refuse(k, m, 'mayor_fund', { project: 'bridge', gold: 601 }, 'treasury_lacks');
    refuse(k, m, 'mayor_fund', { project: 'library', gold: 10 }, 'project_locked');
    const before = worldWealth(k.s).gold;
    const mine = m.gold;
    const r = k.ok(m, 'mayor_fund', { project: 'bridge', gold: 600 });
    expect(r.events.find((e) => e.type === 'mayor_fund')).toMatchObject({ visibility: 'public', payload: { project: 'bridge', gold: 500, treasury: 100 } });
    expect(k.s.village.treasury).toBe(100);
    expect(m.gold).toBe(mine);
    expect(worldWealth(k.s).gold).toBe(before - 500);
    expect(k.s.village.projects.bridge).toMatchObject({ gold: 500, by: { '@village': 500 } });
    refuse(k, m, 'mayor_fund', { project: 'bridge', gold: 50 }, 'project_no_gold_needed');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('mayor_embezzle: at most 10% of the treasury per week, always public', () => {
    const { k, m } = withMayor();
    k.s.village.treasury = 1000;
    refuse(k, m, 'mayor_embezzle', { gold: 101 }, 'embezzle_cap');
    const gold = m.gold;
    const r = k.ok(m, 'mayor_embezzle', { gold: 60 });
    expect(r.events.find((e) => e.type === 'mayor_embezzle')).toMatchObject({ visibility: 'public', drama: 8, payload: { gold: 60, treasury: 940 } });
    expect(m.gold).toBe(gold + 60);
    expect(m.stats.embezzled).toBe(60);
    expect(m.achievements.sticky_fingers).toBeDefined();
    // Splitting it up gains nothing: 40 more this week, not 10% of what is left.
    refuse(k, m, 'mayor_embezzle', { gold: 41 }, 'embezzle_cap');
    k.ok(m, 'mayor_embezzle', { gold: 40 });
    refuse(k, m, 'mayor_embezzle', { gold: 1 }, 'embezzle_cap');
    expect(k.s.village.treasury).toBe(900);
    // Next week (re-elected), a new allowance.
    elect(k, m);
    k.ok(m, 'mayor_embezzle', { gold: 90 });
    expect(k.s.village.treasury).toBe(810);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('a new mayor starts without the old priority', () => {
    const { k, m, joe } = withMayor();
    k.ok(m, 'mayor_priority', { project: 'bridge' });
    k.ok(joe, 'run_for_mayor', { platform: 'New broom.' });
    advanceTo(k, k.s.village.election.voteAt);
    k.ok(citizen(k, 'Vic', 3), 'vote', { candidate: 'Joe' });
    advanceTo(k, k.s.village.election.end);
    expect(k.s.village.mayor?.id).toBe(joe.id);
    expect(k.s.village.priority).toBeNull();
    // The old mayor lost the powers.
    refuse(k, m, 'mayor_tax', { rate: 0.02 }, 'not_mayor');
    expect(k.now).toBeGreaterThan(T0 + 13 * DAY - HOUR);
  });

  it('the treasury moves only through tax, funding and embezzlement', () => {
    const { k, m } = withMayor();
    expect(BALANCE.village.embezzleShare).toBe(0.1);
    k.ok(m, 'mayor_tax', { rate: 0.05 });
    const s = citizen(k, 'Seller', 3, { room: 'village.market' });
    const b = citizen(k, 'Buyer', 3, { room: 'village.market' });
    s.inv.wood = 10;
    b.gold = 10_000;
    for (let i = 0; i < 10; i++) {
      const order = dataOf(k.ok(s, 'market_sell', { item: 'wood', qty: 1, price: 200 })).order;
      k.ok(b, 'market_buy', { order });
    }
    expect(k.s.village.treasury).toBe(100);
    const wealth = worldWealth(k.s).gold;
    k.ok(m, 'mayor_embezzle', { gold: 10 });
    expect(worldWealth(k.s).gold).toBe(wealth);
    k.ok(m, 'mayor_fund', { project: 'bridge', gold: 90 });
    expect(worldWealth(k.s).gold).toBe(wealth - 90);
    expect(k.s.village.treasury).toBe(0);
  });
});
