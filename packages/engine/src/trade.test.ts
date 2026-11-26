import { describe, expect, it } from 'vitest';
import { applyAction } from './apply';
import { BALANCE } from './balance';
import { bondScore } from './bond';
import { checkInvariants } from './invariants';
import { observe } from './observe';
import { dataOf, errKey, keys, makeKit, MIN, narr, worldWealth, type Kit } from './testkit';
import type { AgentState, ApplyResult } from './types';

function refuse(k: Kit, a: AgentState, action: string, params: Record<string, unknown>, slug: string): void {
  expect(errKey(k.act(a, action, params)), `${action} ${JSON.stringify(params)}`).toBe(`err.${slug}`);
}

function pair(k: Kit) {
  const a = k.add('Pip', 'warrior');
  const b = k.add('Bob', 'mage');
  a.gold = 100;
  b.gold = 50;
  a.inv = { iron_ore: 5, lost_locket: 1 };
  b.inv = { wolf_pelt: 3 };
  return { a, b };
}

describe('guaranteed trade', () => {
  it('offer, then accept: an atomic swap with stats, quest step and bond for both', () => {
    const k = makeKit();
    const { a, b } = pair(k);
    for (const x of [a, b]) x.quests.t10_fair_trade = { steps: [0], at: k.now };
    const r = k.ok(a, 'trade_offer', { to: 'Bob', give: { gold: 30, items: { iron_ore: 2 } }, want: { items: [{ item: 'wolf_pelt', qty: 2 }] } });
    const id = String(dataOf(r).trade);
    expect(narr(r, 'n.trade_offer')).toEqual({ name: 'Bob', trade: id, minutes: 10 });
    expect(r.events[0]!.payload).toMatchObject({ trade: id, give: { gold: 30, items: { iron_ore: 2 } }, want: { items: { wolf_pelt: 2 } } });
    // Nothing moves until the answer.
    expect(a.gold).toBe(100);
    expect(observe(k.s, b.id, k.ctx()).pending!.trades).toEqual([{ id, from: 'Pip', give: { gold: 30, items: { iron_ore: 2 } }, want: { items: { wolf_pelt: 2 } } }]);
    const before = worldWealth(k.s);
    const acc = k.ok(b, 'trade_accept', { trade: id });
    expect(keys(acc)).toContain('n.trade_done');
    expect([a.gold, b.gold]).toEqual([70, 80]);
    expect(a.inv).toEqual({ iron_ore: 3, lost_locket: 1, wolf_pelt: 2 });
    expect(b.inv).toEqual({ wolf_pelt: 1, iron_ore: 2 });
    expect(worldWealth(k.s)).toEqual(before);
    for (const x of [a, b]) {
      expect(x.stats.trades).toBe(1);
      expect(x.stats.clean_trades).toBe(1);
      expect(x.achievements.first_trade).toBeDefined();
      expect(x.quests.t10_fair_trade!.steps).toEqual([1]);
    }
    expect(bondScore(a, b)).toBe(BALANCE.bond.trade);
    expect(k.s.trades.size).toBe(0);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('offer errors', () => {
    const k = makeKit();
    const { a } = pair(k);
    k.add('Far', 'rogue', { room: 'forest.edge' });
    refuse(k, a, 'trade_offer', { to: 'Far', give: { gold: 1 }, want: {} }, 'agent_not_here');
    refuse(k, a, 'trade_offer', { to: 'Pip', give: { gold: 1 }, want: {} }, 'not_yourself_social');
    refuse(k, a, 'trade_offer', { to: 'Bob', give: {}, want: {} }, 'trade_empty');
    refuse(k, a, 'trade_offer', { to: 'Bob', give: { items: { excalibur: 1 } }, want: {} }, 'item_unknown');
    refuse(k, a, 'trade_offer', { to: 'Bob', give: { items: { lost_locket: 1 } }, want: {} }, 'quest_item_bound');
    refuse(k, a, 'trade_offer', { to: 'Bob', give: {}, want: { items: { lost_locket: 1 } } }, 'quest_item_bound');
    refuse(k, a, 'trade_offer', { to: 'Bob', give: { gold: 500, items: { iron_ore: 9 } }, want: {} }, 'trade_missing');
    for (let i = 0; i < BALANCE.trade.maxOffers; i++) k.ok(a, 'trade_offer', { to: 'Bob', give: { gold: 1 }, want: {} });
    refuse(k, a, 'trade_offer', { to: 'Bob', give: { gold: 1 }, want: {} }, 'trade_offers_full');
    const others = Array.from({ length: BALANCE.trade.maxOpen }, (_, i) => k.add(`Peer${i}`, 'cleric'));
    for (const o of others.slice(0, BALANCE.trade.maxOpen - BALANCE.trade.maxOffers)) k.ok(o, 'trade_offer', { to: 'Bob', give: { gold: 1 }, want: {} });
    refuse(k, others[others.length - 1]!, 'trade_offer', { to: 'Bob', give: { gold: 1 }, want: {} }, 'trade_target_busy');
  });

  it('accept re-checks both sides and fails without touching anything', () => {
    const k = makeKit();
    const { a, b } = pair(k);
    const t = (give: object, want: object) => String(dataOf(k.ok(a, 'trade_offer', { to: 'Bob', give, want })).trade);
    refuse(k, b, 'trade_accept', { trade: 'tzz' }, 'trade_unknown');
    const t1 = t({ gold: 10 }, { items: { wolf_pelt: 1 } });
    refuse(k, a, 'trade_accept', { trade: t1 }, 'trade_not_yours');
    a.gold = 5;
    refuse(k, b, 'trade_accept', { trade: t1 }, 'trade_they_lack');
    a.gold = 100;
    b.inv = {};
    refuse(k, b, 'trade_accept', { trade: t1 }, 'trade_missing');
    b.inv = { wolf_pelt: 1 };
    k.place(a, 'village.tavern');
    refuse(k, b, 'trade_accept', { trade: t1 }, 'trade_partner_gone');
    k.place(a, 'village.square');
    b.inv.cos_chef_hat = 30; // cosmetics do not stack: a full bag
    const t2 = t({ items: { iron_ore: 1 } }, {});
    const goods = () => JSON.stringify([a.gold, a.inv, b.gold, b.inv, [...k.s.trades.keys()]]);
    const before = goods();
    refuse(k, b, 'trade_accept', { trade: t2 }, 'inventory_full');
    expect(goods()).toBe(before);
    delete b.inv.cos_chef_hat;
    a.inv = { iron_ore: 5 };
    a.inv.cos_chef_hat = 30;
    refuse(k, b, 'trade_accept', { trade: t1 }, 'inventory_full_other');
    delete a.inv.cos_chef_hat;
    k.ok(b, 'trade_accept', { trade: t1 });
    refuse(k, b, 'trade_accept', { trade: t1 }, 'trade_unknown');
  });

  it('expires after 10 minutes: refused at once, cleared by the timer', () => {
    const k = makeKit();
    const { a, b } = pair(k);
    const id = String(dataOf(k.ok(a, 'trade_offer', { to: 'Bob', give: { gold: 1 }, want: {} })).trade);
    // Right at expiry, before any tick ran: the lazy check refuses it.
    k.now += BALANCE.trade.ttlMs;
    const late = applyAction(k.s, { agentId: b.id, action: 'trade_accept', params: { trade: id } }, k.ctx());
    expect(errKey(late)).toBe('err.trade_expired');
    expect(observe(k.s, b.id, k.ctx()).pending).toBeUndefined();
    expect(k.s.trades.size).toBe(1);
    k.advance(MIN);
    expect(k.s.trades.size).toBe(0);
    expect(k.s.tradesOf.size).toBe(0);
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('either side can cancel, nobody else', () => {
    const k = makeKit();
    const { a, b } = pair(k);
    const c = k.add('Cid', 'rogue');
    const open = () => String(dataOf(k.ok(a, 'trade_offer', { to: 'Bob', give: { gold: 1 }, want: {} })).trade);
    const t1 = open();
    refuse(k, c, 'trade_cancel', { trade: t1 }, 'trade_not_yours');
    const r = k.ok(a, 'trade_cancel', { trade: t1 });
    expect(narr(r, 'n.trade_cancelled')).toEqual({ trade: t1 });
    expect(r.events[0]!.target).toBe(b.id);
    const t2 = open();
    k.ok(b, 'trade_cancel', { trade: t2 });
    expect(k.s.trades.size).toBe(0);
    refuse(k, b, 'trade_cancel', { trade: t2 }, 'trade_unknown');
  });
});

describe('market', () => {
  function market(k: Kit) {
    const s = k.add('Seller', 'warrior', { room: 'village.market' });
    const b = k.add('Buyer', 'mage', { room: 'village.market' });
    s.inv = { iron_ore: 10, lost_locket: 1 };
    s.gold = 0;
    b.gold = 200;
    b.inv = {};
    return { s, b };
  }
  const orderOf = (r: ApplyResult) => String(dataOf(r).order);

  it('sell puts the items in escrow; buy pays the seller (even away) and records a public trade', () => {
    const k = makeKit();
    const { s, b } = market(k);
    const before = worldWealth(k.s);
    const sold = k.ok(s, 'market_sell', { item: 'iron_ore', qty: 4, price: 7 });
    const id = orderOf(sold);
    expect(s.inv.iron_ore).toBe(6);
    expect(worldWealth(k.s)).toEqual(before);
    k.place(s, 'forest.edge');
    const r = k.ok(b, 'market_buy', { order: id, qty: 3 });
    expect(narr(r, 'n.market_buy')).toEqual({ qty: 3, item: '@item:iron_ore', gold: 21, name: 'Seller' });
    expect([b.gold, s.gold]).toEqual([179, 21]);
    expect(b.inv.iron_ore).toBe(3);
    expect(k.s.market.orders[id]!.qty).toBe(1);
    const pub = r.events.find((e) => e.type === 'market_trade')!;
    expect(pub.visibility).toBe('public');
    expect(pub.payload).toMatchObject({ item: 'iron_ore', qty: 3, price: 7, buyer: 'Buyer', seller: 'Seller' });
    expect(r.events.find((e) => e.type === 'market_sold')!.target).toBe(b.id);
    expect(k.s.market.history).toEqual([{ item: 'iron_ore', qty: 3, price: 7, buyer: b.id, seller: s.id, ts: k.now }]);
    expect(s.stats.market_sales).toBe(1);
    expect(worldWealth(k.s)).toEqual(before);
    k.ok(b, 'market_buy', { order: id });
    expect(k.s.market.orders[id]).toBeUndefined();
    expect(checkInvariants(k.s, k.now)).toEqual([]);
  });

  it('the village takes its tax into the treasury', () => {
    const k = makeKit();
    const { s, b } = market(k);
    k.s.village.taxRate = 0.1;
    const id = orderOf(k.ok(s, 'market_sell', { item: 'iron_ore', qty: 5, price: 9 }));
    const before = worldWealth(k.s);
    k.ok(b, 'market_buy', { order: id });
    expect(s.gold).toBe(41);
    expect(k.s.village.treasury).toBe(4);
    expect(worldWealth(k.s)).toEqual(before);
  });

  it('lists cheapest first, per item or as a summary', () => {
    const k = makeKit();
    const { s, b } = market(k);
    b.inv = { wolf_pelt: 4, iron_ore: 1 };
    const o1 = orderOf(k.ok(s, 'market_sell', { item: 'iron_ore', qty: 2, price: 9 }));
    const o2 = orderOf(k.ok(b, 'market_sell', { item: 'iron_ore', qty: 1, price: 6 }));
    k.ok(b, 'market_sell', { item: 'wolf_pelt', qty: 4, price: 3 });
    const one = k.ok(s, 'market_list', { item: 'Iron Ore' });
    expect(dataOf(one).market).toEqual({ item: 'iron_ore', orders: [[o2, 1, 6, 'Buyer'], [o1, 2, 9, 'Seller']] });
    const all = k.ok(s, 'market_list', {});
    expect(dataOf(all).market).toEqual({ items: [['wolf_pelt', 3, 4], ['iron_ore', 6, 3]] });
    expect(narr(all, 'n.market_list')).toEqual({ n: 2 });
  });

  it('keeps a bounded price history', () => {
    const k = makeKit();
    const { s, b } = market(k);
    s.inv.iron_ore = 999;
    b.gold = 10_000;
    const id = orderOf(k.ok(s, 'market_sell', { item: 'iron_ore', qty: 999, price: 1 }));
    for (let i = 0; i < BALANCE.market.history + 5; i++) {
      k.ok(b, 'market_buy', { order: id, qty: 1 });
      if (i % 25 === 0) b.inv = {};
    }
    expect(k.s.market.history).toHaveLength(BALANCE.market.history);
  });

  it('cancel gives the items back to the owner only, space permitting', () => {
    const k = makeKit();
    const { s, b } = market(k);
    const id = orderOf(k.ok(s, 'market_sell', { item: 'iron_ore', qty: 10, price: 5 }));
    refuse(k, b, 'market_cancel', { order: id }, 'order_not_yours');
    s.inv.cos_chef_hat = 30;
    refuse(k, s, 'market_cancel', { order: id }, 'inventory_full');
    delete s.inv.cos_chef_hat;
    expect(narr(k.ok(s, 'market_cancel', { order: id }), 'n.market_cancel')).toEqual({ qty: 10, item: '@item:iron_ore', order: id });
    expect(s.inv.iron_ore).toBe(10);
    refuse(k, s, 'market_cancel', { order: id }, 'order_unknown');
  });

  it('errors', () => {
    const k = makeKit();
    const { s, b } = market(k);
    const away = k.add('Away', 'rogue');
    away.inv = { iron_ore: 1 };
    refuse(k, away, 'market_sell', { item: 'iron_ore', qty: 1, price: 1 }, 'market_only');
    refuse(k, away, 'market_list', {}, 'market_only');
    refuse(k, away, 'market_buy', { order: 'o1' }, 'market_only');
    refuse(k, away, 'market_cancel', { order: 'o1' }, 'market_only');
    refuse(k, s, 'market_sell', { item: 'wolf_pelt', qty: 1, price: 1 }, 'item_not_carried');
    refuse(k, s, 'market_sell', { item: 'lost_locket', qty: 1, price: 1 }, 'quest_item_bound');
    refuse(k, s, 'market_sell', { item: 'iron_ore', qty: 11, price: 1 }, 'not_enough_items');
    for (let i = 0; i < BALANCE.market.maxOrders; i++) k.ok(s, 'market_sell', { item: 'iron_ore', qty: 1, price: 2 });
    refuse(k, s, 'market_sell', { item: 'iron_ore', qty: 1, price: 1 }, 'market_orders_full');
    const id = [...k.s.ordersOf.get(s.id)!][0]!;
    refuse(k, b, 'market_buy', { order: 'o999' }, 'order_unknown');
    refuse(k, s, 'market_buy', { order: id }, 'order_own');
    refuse(k, b, 'market_buy', { order: id, qty: 2 }, 'order_qty');
    b.gold = 1;
    refuse(k, b, 'market_buy', { order: id }, 'no_gold');
    b.gold = 50;
    b.inv.cos_chef_hat = 30;
    refuse(k, b, 'market_buy', { order: id }, 'inventory_full');
    expect(observe(k.s, b.id, k.ctx()).actions).toEqual(expect.arrayContaining(['market_list', 'market_buy', 'market_sell']));
  });
});
