import { describe, expect, it } from 'vitest';
import { createRng } from '@ajwf/shared';
import { applyAction } from './apply';
import { BALANCE } from './balance';
import { advanceTo, build, citizen, DAY, elect, TOWN_HALL } from './civic-testkit';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { exportAll, exportDirty, restoreWorld, type Snapshot } from './snapshot';
import { dataOf, errKey, makeKit, type Kit } from './testkit';
import { tick } from './tick';
import type { AgentState, Guild, Timer, WorldState } from './types';
import { VILLAGE_ID } from './village-state';
import { villageView } from './village-view';

function refuse(k: Kit, a: AgentState, params: Record<string, unknown>, slug: string): void {
  const g = a.guild ? k.s.guilds.get(a.guild) : undefined;
  const before = JSON.stringify([g, k.s.village]);
  const r = k.act(a, 'guild_build_hall', params);
  expect(errKey(r), JSON.stringify(params)).toBe(`err.${slug}`);
  expect(JSON.stringify([g, k.s.village])).toBe(before);
}

function guild(k: Kit, leader: AgentState, name: string): Guild {
  k.place(leader, 'village.guild_hall');
  leader.gold += BALANCE.guild.cost;
  k.ok(leader, 'guild_create', { name, colors: ['#112233', '#445566'] });
  return k.s.guilds.get(leader.guild!)!;
}

function fund(g: Guild): void {
  const H = BALANCE.village.hall;
  g.treasury += H.gold;
  for (const x of H.items) g.vault[x.item] = (g.vault[x.item] ?? 0) + x.qty;
}

describe('guild_build_hall', () => {
  it('the leader builds the hall on a free plot from the guild treasury; it shows with the village buildings', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 5);
    const g = guild(k, a, 'Iron Wolves');
    fund(g);
    g.treasury += 7;
    g.vault.wood! += 1;
    const r = k.ok(a, 'guild_build_hall', { plot: 'plot_s' });
    expect(g.treasury).toBe(7);
    expect(g.vault).toEqual({ wood: 1 });
    expect(k.s.village.halls['village.plot_s']).toEqual({ guild: g.id, at: k.now });
    const ev = r.events.find((e) => e.type === 'guild_hall_built')!;
    expect(ev).toMatchObject({ visibility: 'public', drama: 6, roomId: 'village.plot_s', payload: { guild: g.id, name: 'Iron Wolves', colors: ['#112233', '#445566'], plot: 'village.plot_s', cost: { gold: 1000, items: { wood: 40, stone: 40 } } } });
    expect(villageView(k.s, k.now).buildings['village.plot_s']).toEqual({ kind: 'guild_hall', guild: g.id, name: 'Iron Wolves', colors: ['#112233', '#445566'], at: k.now });
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('refuses: no guild, not the leader, not a plot, a project site, taken plots, a second hall, not enough in the vault', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 5);
    const b = citizen(k, 'Bob', 5);
    const c = citizen(k, 'Cid', 5);
    refuse(k, b, { plot: 'village.plot_s' }, 'not_in_guild');
    const g = guild(k, a, 'Iron Wolves');
    k.ok(a, 'guild_invite', { agent: 'Bob' });
    k.ok(b, 'guild_join', { guild: 'Iron Wolves' });
    k.ok(a, 'guild_promote', { agent: 'Bob' });
    refuse(k, b, { plot: 'village.plot_s' }, 'guild_not_leader');
    refuse(k, a, { plot: 'village.square' }, 'plot_unknown');
    refuse(k, a, { plot: 'swamp' }, 'plot_unknown');
    refuse(k, a, { plot: 'village.plot_ne' }, 'plot_reserved');
    refuse(k, a, { plot: 'village.plot_s' }, 'hall_cost');
    fund(g);
    k.ok(a, 'guild_build_hall', { plot: 'village.plot_s' });
    fund(g);
    refuse(k, a, { plot: 'village.plot_se' }, 'guild_has_hall');
    const h = guild(k, c, 'Night Owls');
    fund(h);
    refuse(k, c, { plot: 'village.plot_s' }, 'plot_taken');
    k.ok(c, 'guild_build_hall', { plot: 'village.plot_far' });
    expect(Object.keys(k.s.village.halls).sort()).toEqual(['village.plot_far', 'village.plot_s']);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('a guild that dissolves frees its plot; the leader standing there is offered the action', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 5);
    const g = guild(k, a, 'Iron Wolves');
    fund(g);
    k.place(a, 'village.plot_se');
    expect(observe(k.s, a.id, k.ctx()).actions).toContain('guild_build_hall');
    k.ok(a, 'guild_build_hall', { plot: 'village.plot_se' });
    expect(observe(k.s, a.id, k.ctx()).actions).not.toContain('guild_build_hall');
    k.ok(a, 'guild_leave');
    expect(k.s.guilds.size).toBe(0);
    expect(k.s.village.halls).toEqual({});
    expect(villageView(k.s, k.now).buildings).toEqual({});
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });
});

// ── Snapshots ─────────────────────────────────────────────────────────────────

function persist(s: WorldState): Snapshot {
  return JSON.parse(JSON.stringify(exportAll(s))) as Snapshot;
}

function comparable(s: WorldState) {
  const snap = persist(s);
  for (const e of snap.world) if (e.key === 'timers') (e.data as Timer[]).sort((x, y) => x.at - y.at || JSON.stringify(x).localeCompare(JSON.stringify(y)));
  snap.world.sort((x, y) => x.key.localeCompare(y.key));
  return snap;
}

describe('civic snapshots', () => {
  it('round-trips the village mid-election: projects, priority, mayor, candidates, votes, halls', () => {
    const k = makeKit(7);
    const m = citizen(k, 'Mayra', 5);
    const ann = citizen(k, 'Ann', 5);
    const v1 = citizen(k, 'Vic', 3);
    elect(k, m);
    k.ok(m, 'mayor_priority', { project: 'bridge' });
    k.s.village.treasury = 50;
    ann.gold = 200;
    k.ok(ann, 'contribute', { project: 'bridge', gold: 100 });
    build(k, 'watchtower');
    const g = (() => {
      k.place(ann, 'village.guild_hall');
      ann.gold += BALANCE.guild.cost;
      k.ok(ann, 'guild_create', { name: 'Iron Wolves' });
      return k.s.guilds.get(ann.guild!)!;
    })();
    g.treasury = 2000;
    g.vault = { wood: 50, stone: 50 };
    k.ok(ann, 'guild_build_hall', { plot: 'plot_s' });
    k.ok(ann, 'run_for_mayor', { platform: 'Halls for every guild.' });
    advanceTo(k, k.s.village.election.voteAt);
    k.ok(v1, 'vote', { candidate: 'Ann' });
    expect(k.s.village.election.phase).toBe('voting');

    const copy = restoreWorld(k.c, persist(k.s), k.now);
    expect(comparable(copy)).toEqual(comparable(k.s));
    expect(checkInvariants(copy, k.now)).toEqual([]);
    // Both close the election the same way.
    const end = k.s.village.election.end;
    const rng = createRng(1);
    const a = tick(k.s, { now: end, rng });
    const b = tick(copy, { now: end, rng: createRng(1) });
    expect(b).toEqual(a);
    expect(copy.village.mayor?.name).toBe('Ann');
    expect(comparable(copy)).toEqual(comparable(k.s));
  });

  it('exportDirty carries the village after civic actions', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 3);
    a.gold = 5;
    exportDirty(k.s);
    k.ok(a, 'contribute', { project: 'bridge', gold: 5 });
    const snap = exportDirty(k.s);
    expect(snap.world.map((e) => e.key)).toContain('village');
  });

  it('loads a village saved before projects and elections existed, with exactly one election timer', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 3);
    const snap = persist(k.s);
    const v = snap.world.find((e) => e.key === 'village')!;
    v.data = { taxRate: 0.03, treasury: 40 };
    const timers = snap.world.find((e) => e.key === 'timers')!;
    timers.data = (timers.data as Timer[]).filter((t) => t.kind !== 'election');
    const later = k.now + DAY;
    const s = restoreWorld(k.c, snap, later);
    expect(s.village).toMatchObject({ taxRate: 0.03, treasury: 40, projects: {}, mayor: null, election: { n: 1, start: later, phase: 'candidacy' } });
    expect(s.timers.toJSON().filter((t) => t.kind === 'election')).toHaveLength(1);
    expect(checkInvariants(s, later)).toEqual([]);
    a.gold = 0;
    const b = s.agents.get(a.id)!;
    b.gold = 3;
    const r = applyAction(s, { agentId: b.id, action: 'contribute', params: { project: 'bridge', gold: 3 } }, { now: later + 1000, rng: k.rng });
    expect(r.result.ok).toBe(true);
  });

  it('drops civic entries pointing at things that are gone, and duplicate election timers', () => {
    const k = makeKit();
    const ann = citizen(k, 'Ann', 5);
    const vic = citizen(k, 'Vic', 3);
    k.ok(ann, 'run_for_mayor', { platform: 'Hello.' });
    advanceTo(k, k.s.village.election.voteAt);
    k.ok(vic, 'vote', { candidate: 'Ann' });
    const snap = persist(k.s);
    const v = snap.world.find((e) => e.key === 'village')!.data as WorldState['village'];
    v.projects.castle = { gold: 1, items: {}, by: {} };
    v.halls['village.plot_s'] = { guild: 'g-gone', at: 0 };
    v.election.votes.ghost = ann.id;
    v.election.tally[ann.id] = 2;
    (snap.world.find((e) => e.key === 'timers')!.data as Timer[]).push({ at: 1, kind: 'election' });
    const s = restoreWorld(k.c, snap, k.now);
    expect(s.village.projects).toEqual({});
    expect(s.village.halls).toEqual({});
    expect(s.village.election.votes).toEqual({ [vic.id]: ann.id });
    expect(s.village.election.tally).toEqual({ [ann.id]: 1 });
    expect(checkInvariants(s, k.now)).toEqual([]);
  });
});

// ── Invariants ────────────────────────────────────────────────────────────────

describe('civic invariants', () => {
  it('report each kind of violation', () => {
    const k = makeKit();
    const ann = citizen(k, 'Ann', 5);
    const vic = citizen(k, 'Vic', 3);
    k.ok(ann, 'run_for_mayor', { platform: 'Hello.' });
    advanceTo(k, k.s.village.election.voteAt);
    k.ok(vic, 'vote', { candidate: 'Ann' });
    expect(checkInvariants(k.s, k.now)).toEqual([]);
    const v = k.s.village;
    v.election.votes[ann.id] = ann.id;
    v.election.candidates.push({ ...v.election.candidates[0]! });
    v.taxRate = 0.5;
    v.projects.bridge = { gold: 9999, items: { bread: 1 }, by: { [VILLAGE_ID]: 3 } };
    v.projects.library = { gold: 1, items: {}, by: { [VILLAGE_ID]: 1 } };
    v.halls['village.plot_ne'] = { guild: 'gx', at: 0 };
    v.priority = 'statue';
    k.s.timers.push({ at: 5, kind: 'election' });
    vic.titles.push('mayor');
    const out = checkInvariants(k.s, k.now).join('\n');
    for (const bit of [
      'voted for itself',
      'is a candidate twice',
      'tally',
      'tax rate 0.5',
      '9999 gold of 500',
      'x bread',
      'ledger sums',
      'has progress before watchtower is done',
      'project site village.plot_ne',
      'missing guild gx',
      'priority statue is not an available project',
      'timers',
      'mayor title out of office',
    ]) {
      expect(out).toContain(bit);
    }
  });
});

// ── Conservation ──────────────────────────────────────────────────────────────

describe('civic conservation', () => {
  it('every civic movement of gold and items is accounted for by its event', () => {
    const k = makeKit(11);
    const m = citizen(k, 'Mayra', 5);
    elect(k, m);
    k.ok(m, 'mayor_tax', { rate: 0.1 });
    k.ok(m, 'mayor_priority', { project: 'inn_expansion' });
    const ann = citizen(k, 'Ann', 5, { room: 'village.market' });
    const bob = citizen(k, 'Bob', 5, { room: 'village.market' });
    ann.inv.wood = 200;
    ann.inv.linen = 30;
    ann.inv.pot = 5;
    bob.gold = 5000;

    const wealth = () => {
      let gold = k.s.village.treasury;
      const items: Record<string, number> = {};
      for (const a of k.s.agents.values()) {
        gold += a.gold;
        for (const [id, n] of Object.entries(a.inv)) items[id] = (items[id] ?? 0) + n;
      }
      for (const o of Object.values(k.s.market.orders)) items[o.item] = (items[o.item] ?? 0) + o.qty;
      for (const g of k.s.guilds.values()) {
        gold += g.treasury;
        for (const [id, n] of Object.entries(g.vault)) items[id] = (items[id] ?? 0) + n;
      }
      return { gold, items };
    };
    let expected = wealth();
    const check = (events: { type: string; payload: Record<string, unknown> }[]) => {
      for (const e of events) {
        const p = e.payload as { gold?: number; items?: Record<string, number>; cost?: { gold?: number; items?: Record<string, number> } };
        if (e.type === 'project_contribution') {
          expected.gold -= p.gold ?? 0;
          for (const [id, n] of Object.entries(p.items ?? {})) expected.items[id] = (expected.items[id] ?? 0) - n;
        }
        if (e.type === 'mayor_fund') expected.gold -= p.gold ?? 0;
        if (e.type === 'guild_hall_built') {
          expected.gold -= p.cost?.gold ?? 0;
          for (const [id, n] of Object.entries(p.cost?.items ?? {})) expected.items[id] = (expected.items[id] ?? 0) - n;
        }
        if (e.type === 'guild_founded') expected.gold -= BALANCE.guild.cost;
      }
      const now = wealth();
      for (const id of Object.keys(expected.items)) if (!expected.items[id]) delete expected.items[id];
      expect(now).toEqual(expected);
      expected = now;
    };

    // Market sales feed the treasury through the tax.
    for (let i = 0; i < 5; i++) {
      const order = dataOf(k.ok(ann, 'market_sell', { item: 'wood', qty: 2, price: 100 })).order;
      check(k.ok(bob, 'market_buy', { order }).events);
    }
    expect(k.s.village.treasury).toBe(100);
    k.place(ann, TOWN_HALL);
    check(k.ok(ann, 'contribute', { project: 'inn_expansion', items: { wood: 30, linen: 30, pot: 5 } }).events);
    check(k.ok(m, 'mayor_fund', { project: 'inn_expansion', gold: 80 }).events);
    check(k.ok(m, 'mayor_embezzle', { gold: 2 }).events);
    bob.gold += 100;
    expected.gold += 100;
    k.place(bob, TOWN_HALL);
    check(k.ok(bob, 'contribute', { project: 'inn_expansion', gold: 2000 }).events);
    expect(k.s.village.projects.inn_expansion!.doneAt).toBeUndefined();
    k.place(ann, TOWN_HALL);
    check(k.ok(ann, 'contribute', { project: 'inn_expansion', items: { wood: 60 } }).events);
    k.place(bob, 'village.guild_hall');
    bob.gold += BALANCE.guild.cost;
    expected.gold += BALANCE.guild.cost;
    check(k.ok(bob, 'guild_create', { name: 'Coin Hoard' }).events);
    const g = k.s.guilds.get(bob.guild!)!;
    bob.inv.stone = (bob.inv.stone ?? 0) + 40;
    bob.inv.wood = (bob.inv.wood ?? 0) + 40;
    expected.items.stone = (expected.items.stone ?? 0) + 40;
    expected.items.wood = (expected.items.wood ?? 0) + 40;
    check(k.ok(bob, 'guild_deposit', { gold: bob.gold, items: { stone: 40, wood: 40 } }).events);
    expect(g.treasury).toBeGreaterThanOrEqual(1000);
    check(k.ok(bob, 'guild_build_hall', { plot: 'village.plot_far' }).events);
    // Election closing moves nothing.
    check(k.advance(7 * DAY));
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('a refused civic action changes nothing at all', () => {
    const k = makeKit();
    const m = citizen(k, 'Mayra', 5);
    elect(k, m);
    m.gold = 0;
    const before = JSON.stringify(persist(k.s).world.filter((e) => e.key === 'village'));
    for (const [action, params] of [
      ['mayor_embezzle', { gold: 1 }],
      ['mayor_fund', { project: 'bridge', gold: 1 }],
      ['contribute', { project: 'bridge', gold: 1 }],
      ['vote', { candidate: 'Mayra' }],
    ] as const) {
      const r = k.act(m, action, params);
      expect(r.result.ok, action).toBe(false);
    }
    expect(JSON.stringify(persist(k.s).world.filter((e) => e.key === 'village'))).toBe(before);
  });
});
