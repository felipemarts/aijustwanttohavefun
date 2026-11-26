import { describe, expect, it } from 'vitest';
import { derive } from './agent';
import { BALANCE } from './balance';
import { build, citizen, elect, TOWN_HALL } from './civic-testkit';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { dataOf, errCode, errKey, makeKit, narr, worldWealth, type Kit } from './testkit';
import type { AgentState } from './types';
import { isProjectDone, isUnlocked, marketSlots, questXpMult, worldBossWarning } from './unlocks';
import { splitOffer } from './village';
import { VILLAGE_ID } from './village-state';
import { villageView } from './village-view';

function refuse(k: Kit, a: AgentState, params: Record<string, unknown>, slug: string): void {
  const snap = () => JSON.stringify([a.gold, a.inv, a.stats, a.cooldowns, a.quests, k.s.village]);
  const before = snap();
  const r = k.act(a, 'contribute', params);
  expect(errKey(r), JSON.stringify(params)).toBe(`err.${slug}`);
  expect(r.events).toEqual([]);
  expect(snap()).toBe(before);
}

describe('contribute', () => {
  it('delivers gold and materials at the town hall: ledger, stats, progress, public event', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 3);
    a.gold = 300;
    a.inv.wood = 10;
    const before = worldWealth(k.s);
    const r = k.ok(a, 'contribute', { project: 'bridge', gold: 100, items: { wood: 10 } });
    expect(narr(r, 'n.contribute')).toMatchObject({ proj: '@proj:bridge', goods: 'gold x100, wood x10' });
    expect(a.gold).toBe(200);
    expect(a.inv.wood).toBeUndefined();
    const st = k.s.village.projects.bridge!;
    expect(st).toMatchObject({ gold: 100, items: { wood: 10 }, by: { [a.id]: 120 } });
    expect(a.stats.contributions).toBe(120);
    expect(a.stats.projects_contributed).toBe(1);
    expect(a.achievements.taxpayer).toBeDefined();
    const ev = r.events.find((e) => e.type === 'project_contribution')!;
    expect(ev).toMatchObject({ visibility: 'public', drama: 1, payload: { project: 'bridge', gold: 100, items: { wood: 10 }, value: 120 } });
    // A deliberate sink: exactly what was given left the world's circulation.
    const after = worldWealth(k.s);
    expect(before.gold - after.gold).toBe(100);
    expect((before.items.wood ?? 0) - (after.items.wood ?? 0)).toBe(10);
    expect(dataOf(r).contribution).toMatchObject({ project: 'bridge', progress: expect.any(Number) });
    expect(k.s.village.top).toEqual({ id: a.id, value: 120 });
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('works at the project site too; a second contribution to the same project is not a new project', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 3, { room: 'village.river_bank' });
    a.inv.stone = 4;
    k.ok(a, 'contribute', { project: 'bridge', items: { stone: 2 } });
    k.ok(a, 'contribute', { project: 'Bridge', items: [{ item: 'stone', qty: 2 }] });
    expect(a.stats.projects_contributed).toBe(1);
    expect(a.stats.contributions).toBe(8);
    expect(k.s.village.projects.bridge!.items.stone).toBe(4);
  });

  it('refuses unknown, locked, done projects, the wrong room, empty, unaffordable and unneeded offers, changing nothing', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 3);
    a.gold = 50;
    a.inv.wood = 5;
    a.inv.bread = 2;
    refuse(k, a, { project: 'castle', gold: 1 }, 'project_unknown');
    refuse(k, a, { project: 'library', gold: 1 }, 'project_locked');
    refuse(k, a, { project: 'bridge' }, 'goods_empty');
    refuse(k, a, { project: 'bridge', gold: 100 }, 'no_gold');
    refuse(k, a, { project: 'bridge', items: { wood: 6 } }, 'goods_missing');
    refuse(k, a, { project: 'bridge', items: { dragon_scale: 1 } }, 'item_unknown');
    refuse(k, a, { project: 'bridge', items: { bread: 2 } }, 'project_not_needed');
    k.place(a, 'village.square');
    refuse(k, a, { project: 'bridge', gold: 1 }, 'contribute_place');
    // The site of another project is not this project's site.
    k.place(a, 'village.plot_ne');
    refuse(k, a, { project: 'bridge', gold: 1 }, 'contribute_place');
    build(k, 'bridge');
    k.place(a, TOWN_HALL);
    refuse(k, a, { project: 'bridge', gold: 1 }, 'project_done');
    expect(errCode(k.act(a, 'contribute', { project: 'bridge', gold: 1 }))).toBe('CONFLICT');
  });

  it('never swallows excess: takes only what is missing and leaves the rest in the bag', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 3);
    a.gold = 900;
    a.inv.wood = 100;
    a.inv.bread = 3;
    const r = k.ok(a, 'contribute', { project: 'bridge', gold: 900, items: { wood: 100, bread: 3 } });
    expect(narr(r, 'n.contribute_trimmed')).toEqual({ goods: 'gold x400, wood x40, bread x3' });
    expect(a.gold).toBe(400);
    expect(a.inv.wood).toBe(40);
    expect(a.inv.bread).toBe(3);
    expect(k.s.village.projects.bridge).toMatchObject({ gold: 500, items: { wood: 60 } });
    // Gold and wood are complete now: offering only those is refused.
    refuse(k, a, { project: 'bridge', gold: 10, items: { wood: 5 } }, 'project_not_needed');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('advances the contribute quest step', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 3);
    a.inv.wood = 5;
    k.ok(a, 'quest_accept', { quest: 'c_civic_1' });
    for (let i = 0; i < 5; i++) k.ok(a, 'contribute', { project: 'bridge', items: { wood: 1 } });
    expect(a.quests.c_civic_1!.steps).toEqual([5]);
  });

  it('announces small gifts publicly at most once per interval; big ones always', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 3);
    a.gold = 1000;
    const vis = (gold: number) => k.ok(a, 'contribute', { project: 'bridge', gold }).events.find((e) => e.type === 'project_contribution')!.visibility;
    expect(vis(5)).toBe('public');
    expect(vis(5)).toBe('room');
    expect(vis(BALANCE.village.announceValue)).toBe('public');
    k.advance(BALANCE.village.announceEveryMs);
    expect(vis(5)).toBe('public');
  });

});

describe('priority bonus', () => {
  it('splits an offer so the topped-up amount covers the need, never more', () => {
    expect(splitOffer(10, 60, 20)).toEqual({ take: 10, bonus: 2 });
    expect(splitOffer(12, 12, 20)).toEqual({ take: 10, bonus: 2 });
    expect(splitOffer(100, 7, 20)).toEqual({ take: 6, bonus: 1 });
    expect(splitOffer(3, 60, 20)).toEqual({ take: 3, bonus: 0 });
    expect(splitOffer(1, 1, 20)).toEqual({ take: 1, bonus: 0 });
    expect(splitOffer(9, 4, 0)).toEqual({ take: 4, bonus: 0 });
    for (let need = 1; need < 80; need++) {
      for (const offer of [1, 5, need, need + 9]) {
        const { take, bonus } = splitOffer(offer, need, 20);
        expect(take + bonus).toBeLessThanOrEqual(need);
        expect(take).toBeLessThanOrEqual(offer);
        expect(bonus).toBe(Math.min(Math.floor((take * 20) / 100), need - take));
      }
    }
  });

  it('tops up each contribution to the priority project by 20%, minted by the village and booked to it', () => {
    const k = makeKit();
    const m = citizen(k, 'Mayra', 5);
    elect(k, m);
    k.place(m, TOWN_HALL);
    k.ok(m, 'mayor_priority', { project: 'bridge' });
    const a = citizen(k, 'Pip', 3);
    a.gold = 100;
    a.inv.wood = 10;
    const before = worldWealth(k.s);
    const r = k.ok(a, 'contribute', { project: 'bridge', gold: 100, items: { wood: 10 } });
    const ev = r.events.find((e) => e.type === 'project_contribution')!;
    expect(ev.payload).toMatchObject({ gold: 100, items: { wood: 10 }, value: 120, bonus: { gold: 20, items: { wood: 2 } } });
    expect(narr(r, 'n.contribute_bonus')).toEqual({ goods: 'gold x20, wood x2' });
    const st = k.s.village.projects.bridge!;
    expect(st).toMatchObject({ gold: 120, items: { wood: 12 }, by: { [a.id]: 120, [VILLAGE_ID]: 24 } });
    // The bonus never enters circulation: the world only lost what the agent gave.
    const after = worldWealth(k.s);
    expect(before.gold - after.gold).toBe(100);
    expect((before.items.wood ?? 0) - (after.items.wood ?? 0)).toBe(10);
    expect(a.stats.contributions).toBe(120);
    // Near the end the giver pays only what, topped up, covers the need.
    a.inv.iron_ingot = 10;
    const r2 = k.ok(a, 'contribute', { project: 'bridge', items: { iron_ingot: 10 } });
    expect(r2.events.find((e) => e.type === 'project_contribution')!.payload).toMatchObject({ items: { iron_ingot: 9 }, bonus: { items: { iron_ingot: 1 } } });
    expect(a.inv.iron_ingot).toBe(1);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });
});

describe('completion and the project tree', () => {
  it('completes with a public event, plaque and building; the next projects open; progress never goes back', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 3);
    a.gold = 100;
    k.ok(a, 'contribute', { project: 'bridge', gold: 100 });
    const b = build(k, 'bridge');
    const r = k.s.village.projects.bridge!;
    expect(r.doneAt).toBe(k.now);
    expect(isProjectDone(k.s, 'bridge')).toBe(true);
    expect(isUnlocked(k.s, 'mines_shortcut')).toBe(true);
    const view = villageView(k.s, k.now);
    expect(view.projects.find((p) => p.id === 'bridge')).toMatchObject({ status: 'done', progress: 1, doneAt: k.now });
    expect(view.projects.find((p) => p.id === 'arena')).toMatchObject({ status: 'available', progress: 0 });
    expect(view.projects.find((p) => p.id === 'statue')).toMatchObject({ status: 'locked' });
    expect(view.buildings['village.river_bank']).toEqual({ kind: 'project', project: 'bridge', building: 'bridge', at: k.now });
    expect(b.stats.contributions).toBeGreaterThan(a.stats.contributions!);
    expect(r.plaque!.map((l) => l.name)).toEqual([b.name, a.name]);
  });

  it('emits project_completed with site, building and plaque, and project_available for what it opens', () => {
    const k = makeKit();
    const p = k.c.projects.get('bridge')!;
    const a = citizen(k, 'Pip', 3);
    a.gold = p.cost.gold;
    for (const x of p.cost.items) a.inv[x.item] = x.qty;
    const r = k.ok(a, 'contribute', { project: 'bridge', gold: p.cost.gold, items: Object.fromEntries(p.cost.items.map((x) => [x.item, x.qty])) });
    expect(narr(r, 'n.project_done')).toEqual({ proj: '@proj:bridge' });
    const done = r.events.find((e) => e.type === 'project_completed')!;
    expect(done).toMatchObject({ visibility: 'public', drama: 9, roomId: 'village.river_bank', payload: { project: 'bridge', site: 'village.river_bank', building: 'bridge', unlocks: ['mines_shortcut'] } });
    expect(done.payload.plaque).toEqual([{ id: a.id, name: 'Pip', value: 500 + 60 * 2 + 40 * 2 + 10 * 18 }]);
    expect(r.events.filter((e) => e.type === 'project_available').map((e) => e.payload.project)).toEqual(['arena']);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('the plaque lists the top 5 by value, ties going to the earliest contributor', () => {
    const k = makeKit();
    const gifts: [string, number][] = [['Ann', 30], ['Ben', 50], ['Cid', 30], ['Dot', 10], ['Eve', 80], ['Fay', 5]];
    for (const [name, gold] of gifts) {
      const a = citizen(k, name, 3);
      a.gold = gold;
      k.ok(a, 'contribute', { project: 'watchtower', gold });
    }
    build(k, 'watchtower');
    const plaque = k.s.village.projects.watchtower!.plaque!;
    expect(plaque).toHaveLength(5);
    expect(plaque.slice(1).map((l) => [l.name, l.value])).toEqual([['Eve', 80], ['Ben', 50], ['Ann', 30], ['Cid', 30]]);
  });

  it('counts mayor funding on the plaque as the village (name null)', () => {
    const k = makeKit();
    const m = citizen(k, 'Mayra', 5);
    elect(k, m);
    k.s.village.treasury = 300;
    k.place(m, TOWN_HALL);
    k.ok(m, 'mayor_fund', { project: 'watchtower', gold: 300 });
    build(k, 'watchtower');
    expect(k.s.village.projects.watchtower!.plaque!.find((l) => l.id === VILLAGE_ID)).toEqual({ id: VILLAGE_ID, name: null, value: 300 });
  });
});

describe('unlock effects', () => {
  it('bridge: the gates on both sides of the river open', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 8, { room: 'village.river_bank' });
    expect(errKey(k.act(a, 'move', { dir: 'north' }))).toBe('err.gate_project');
    expect(observe(k.s, a.id, k.ctx()).room.locked).toEqual({ north: 'project' });
    build(k, 'bridge');
    expect(observe(k.s, a.id, k.ctx()).room.locked).toBeUndefined();
    k.ok(a, 'move', { dir: 'north' });
    expect(a.room).toBe('mines.lower_gate');
    k.ok(a, 'move', { dir: 'south' });
    expect(a.room).toBe('village.river_bank');
  });

  it('covered market: twice the open sell orders per agent', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 3, { room: 'village.market' });
    a.inv.wood = 20;
    const max = BALANCE.market.maxOrders;
    for (let i = 0; i < max; i++) k.ok(a, 'market_sell', { item: 'wood', qty: 1, price: 5 });
    expect(errKey(k.act(a, 'market_sell', { item: 'wood', qty: 1, price: 5 }))).toBe('err.market_orders_full');
    build(k, 'inn_expansion');
    build(k, 'covered_market');
    expect(marketSlots(k.s)).toBe(2 * max);
    for (let i = 0; i < max; i++) k.ok(a, 'market_sell', { item: 'wood', qty: 1, price: 5 });
    expect(errKey(k.act(a, 'market_sell', { item: 'wood', qty: 1, price: 5 }))).toBe('err.market_orders_full');
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('inn expansion: a stronger Camaraderie bonus in the tavern', () => {
    const bonus = (inn: boolean) => {
      const k = makeKit();
      if (inn) build(k, 'inn_expansion');
      const a = citizen(k, 'Pip', 3, { room: 'village.tavern' });
      const b = citizen(k, 'Bob', 3, { room: 'village.tavern' });
      k.advance(BALANCE.camaraderie.stayMs);
      k.ok(b, 'say', { text: 'hello' });
      k.ok(a, 'say', { text: 'hi' });
      return a.buffs.find((x) => x.id === 'camaraderie')?.value;
    };
    expect(bonus(false)).toBe(BALANCE.camaraderie.tavernXp);
    expect(bonus(true)).toBe(BALANCE.village.innTavernXp);
  });

  it('arena: duels at the arena site once it is built', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 5, { room: 'village.plot_sw' });
    citizen(k, 'Bob', 5, { room: 'village.plot_sw' });
    expect(errKey(k.act(a, 'duel_invite', { agent: 'Bob' }))).toBe('err.duel_place');
    expect(observe(k.s, a.id, k.ctx()).actions).not.toContain('duel_invite');
    build(k, 'bridge');
    build(k, 'arena');
    k.ok(a, 'duel_invite', { agent: 'Bob' });
    expect(observe(k.s, a.id, k.ctx()).actions).toContain('duel_invite');
  });

  it('watchtower: the world-boss warning flag', () => {
    const k = makeKit();
    expect(worldBossWarning(k.s)).toBe(false);
    build(k, 'watchtower');
    expect(worldBossWarning(k.s)).toBe(true);
  });

  it('library: Mages get +10% max MP, everyone +5% quest-reward XP', () => {
    const k = makeKit();
    const mage = citizen(k, 'Merl', 3, { cls: 'mage' });
    const war = citizen(k, 'Pip', 3);
    const mp = derive(k.c, mage, k.now).maxMp;
    const wmp = derive(k.c, war, k.now).maxMp;
    build(k, 'watchtower');
    build(k, 'library');
    expect(questXpMult(k.s)).toBeCloseTo(1.05);
    k.ok(mage, 'inventory');
    k.ok(war, 'inventory');
    expect(derive(k.c, mage, k.now).maxMp).toBe(Math.floor(mp * 1.1));
    expect(derive(k.c, war, k.now).maxMp).toBe(wmp);
    // Quest rewards: c_civic_1 gives 400 XP, now 420.
    war.inv.wood = 5;
    k.ok(war, 'quest_accept', { quest: 'c_civic_1' });
    for (let i = 0; i < 5; i++) k.ok(war, 'contribute', { project: 'inn_expansion', items: { wood: 1 } });
    const xp = war.xp;
    k.ok(war, 'quest_turn_in', { quest: 'c_civic_1' });
    expect(war.xp - xp).toBe(420);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('statue: honors the top overall contributor with a title, name and sprite', () => {
    const k = makeKit();
    const top = citizen(k, 'Patron', 3);
    top.gold = 5000;
    k.ok(top, 'contribute', { project: 'bridge', gold: 500 });
    build(k, 'bridge');
    build(k, 'watchtower');
    build(k, 'inn_expansion');
    build(k, 'statue');
    // The builders each gave one project's worth; the patron gave 500 gold only, so a builder is the top.
    const honoree = k.s.village.honoree!;
    const best = [...k.s.agents.values()].sort((x, y) => (y.stats.contributions ?? 0) - (x.stats.contributions ?? 0))[0]!;
    expect(honoree).toMatchObject({ id: best.id, name: best.name, sprite: best.lookHash, value: best.stats.contributions });
    expect(best.titles).toContain('honored');
    expect(villageView(k.s, k.now).honoree).toMatchObject({ name: best.name, sprite: best.lookHash });
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('statue: the top contributor is tracked incrementally, ties keeping the first to reach it', () => {
    const k = makeKit();
    const a = citizen(k, 'Ann', 3);
    const b = citizen(k, 'Ben', 3);
    a.gold = b.gold = 100;
    k.ok(a, 'contribute', { project: 'bridge', gold: 40 });
    k.ok(b, 'contribute', { project: 'bridge', gold: 40 });
    expect(k.s.village.top).toEqual({ id: a.id, value: 40 });
    k.ok(b, 'contribute', { project: 'watchtower', gold: 1 });
    expect(k.s.village.top).toEqual({ id: b.id, value: 41 });
  });
});

describe('observe', () => {
  it('shows the project at its site and the open ones at the town hall, with contribute', () => {
    const k = makeKit();
    const a = citizen(k, 'Pip', 3, { room: 'village.river_bank' });
    a.gold = 50;
    k.ok(a, 'contribute', { project: 'bridge', gold: 50 });
    let o = observe(k.s, a.id, k.ctx());
    expect(o.room.project).toEqual({ id: 'bridge', progress: 0.05 });
    expect(o.actions).toContain('contribute');
    k.place(a, TOWN_HALL);
    o = observe(k.s, a.id, k.ctx());
    expect(o.room.projects!.map((p) => p.id)).toEqual(['bridge', 'watchtower', 'inn_expansion']);
    expect(o.actions).toContain('contribute');
    build(k, 'bridge');
    k.place(a, 'village.river_bank');
    o = observe(k.s, a.id, k.ctx());
    expect(o.room.project).toEqual({ id: 'bridge', progress: 1, done: true });
    expect(o.actions).not.toContain('contribute');
    k.place(a, 'village.temple');
    expect(observe(k.s, a.id, k.ctx()).room.project).toBeUndefined();
  });
});
