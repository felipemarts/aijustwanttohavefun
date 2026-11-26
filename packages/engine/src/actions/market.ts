import { ref } from '@ajwf/shared';
import { addGold, addItem, bump, canFit, count, removeItem } from '../agent';
import { BALANCE } from '../balance';
import { addOrder, ordersOf, recordTrade, removeOrder } from '../market';
import { questEvent } from '../quests';
import { emit, fail, markAgent, msg, tell, type Run } from '../run';
import type { AgentState, Order } from '../types';
import { carried } from './items';
import { hasFlag, normId, type HandlerMap } from './util';

function atMarket(run: Run, a: AgentState): void {
  if (!hasFlag(run, a, 'market')) fail('NOT_AVAILABLE_HERE', 'market_only', { room: ref.room('village.market') });
}

function orderById(run: Run, raw: string): Order {
  const o = run.s.market.orders[raw.trim().toLowerCase()];
  if (!o) fail('TARGET_NOT_FOUND', 'order_unknown', { order: raw });
  return o;
}

export const marketActions: HandlerMap = {
  market_sell(run, a, p) {
    atMarket(run, a);
    const item = carried(run, a, p.item);
    if (item.type === 'quest') fail('NOT_ALLOWED', 'quest_item_bound', { item: ref.item(item.id) });
    if (count(a, item.id) < p.qty) fail('MISSING_ITEMS', 'not_enough_items', { item: ref.item(item.id), have: count(a, item.id), need: p.qty });
    const max = BALANCE.market.maxOrders;
    if (ordersOf(run.s, a.id) >= max) fail('CONFLICT', 'market_orders_full', { max });
    // The items leave the bag now and wait in the market until someone buys them or the seller cancels.
    removeItem(a, item.id, p.qty);
    const o: Order = { id: `o${(++run.s.meta.orderSeq).toString(36)}`, seller: a.id, item: item.id, qty: p.qty, price: p.price, at: run.now };
    addOrder(run.s, o);
    run.s.dirty.add('meta');
    run.data.order = o.id;
    tell(run, 'n.market_sell', { qty: p.qty, item: ref.item(item.id), price: p.price, order: o.id });
    emit(run, 'market_order', { room: a.room, actor: a.id, m: msg('ev.market_order', { actor: a.name, qty: p.qty, item: ref.item(item.id), price: p.price }), data: { order: o.id, item: item.id, qty: p.qty, price: p.price } });
    questEvent(run, a, 'market');
  },

  market_list(run, a, p) {
    atMarket(run, a);
    const rows = BALANCE.market.listRows;
    const name = (id: string) => run.s.agents.get(id)?.name ?? '?';
    if (p.item) {
      const id = normId(p.item);
      const book = run.s.ordersByItem.get(id) ?? [];
      // Rows: [order, qty, unit price, seller], cheapest first.
      run.data.market = { item: id, orders: book.slice(0, rows).map((o) => [o.id, o.qty, o.price, name(o.seller)]) };
      tell(run, 'n.market_list_item', { item: ref.item(id), n: book.length });
      return;
    }
    // Rows: [item, cheapest unit price, units on sale], cheapest first. Ask with item for the orders themselves.
    const summary: [string, number, number][] = [];
    for (const [item, book] of run.s.ordersByItem) summary.push([item, book[0]!.price, book.reduce((n, o) => n + o.qty, 0)]);
    summary.sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0]));
    run.data.market = { items: summary.slice(0, rows) };
    tell(run, 'n.market_list', { n: summary.length });
  },

  market_buy(run, a, p) {
    atMarket(run, a);
    const o = orderById(run, p.order);
    if (o.seller === a.id) fail('NOT_ALLOWED', 'order_own', { order: o.id });
    const qty = p.qty ?? o.qty;
    if (qty > o.qty) fail('CONFLICT', 'order_qty', { order: o.id, have: o.qty });
    const total = o.price * qty;
    if (a.gold < total) fail('NOT_ENOUGH_GOLD', 'no_gold', { need: total, have: a.gold });
    if (!canFit(run.c, a, [{ item: o.item, qty }])) fail('INVENTORY_FULL', 'inventory_full');
    const seller = run.s.agents.get(o.seller)!;
    const v = run.s.village;
    const tax = Math.floor(total * v.taxRate);
    a.gold -= total;
    addItem(a, o.item, qty);
    // The seller is paid even when away: the market holds the goods, so it can settle alone.
    addGold(run, seller, total - tax);
    v.treasury += tax;
    run.s.dirty.add('village');
    o.qty -= qty;
    if (o.qty <= 0) removeOrder(run.s, o);
    else run.s.dirty.add('market');
    recordTrade(run.s, { item: o.item, qty, price: o.price, buyer: a.id, seller: seller.id, ts: run.now });
    markAgent(run.s, seller);
    bump(run, seller, 'market_sales');
    questEvent(run, a, 'market');
    questEvent(run, seller, 'market');
    const item = ref.item(o.item);
    tell(run, 'n.market_buy', { qty, item, gold: total, name: seller.name });
    emit(run, 'market_sold', { actor: seller.id, target: a.id, vis: 'private', to: [seller.id], m: msg('ev.market_sold', { name: a.name, qty, item, gold: total - tax, tax }), data: { order: o.id, gold: total - tax } });
    emit(run, 'market_trade', {
      room: a.room,
      actor: a.id,
      target: seller.id,
      vis: 'public',
      drama: 1,
      m: msg('ev.market_trade', { actor: a.name, name: seller.name, qty, item, price: o.price }),
      data: { item: o.item, qty, price: o.price, buyer: a.name, seller: seller.name, tax },
    });
  },

  market_cancel(run, a, p) {
    atMarket(run, a);
    const o = orderById(run, p.order);
    if (o.seller !== a.id) fail('NOT_ALLOWED', 'order_not_yours', { order: o.id });
    if (!canFit(run.c, a, [{ item: o.item, qty: o.qty }])) fail('INVENTORY_FULL', 'inventory_full');
    removeOrder(run.s, o);
    addItem(a, o.item, o.qty);
    tell(run, 'n.market_cancel', { qty: o.qty, item: ref.item(o.item), order: o.id });
  },
};
