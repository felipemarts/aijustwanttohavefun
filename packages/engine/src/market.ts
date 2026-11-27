import { BALANCE } from './balance';
import { assertAmount, stockAdd } from './ledger';
import { own } from '@ajwf/shared';
import type { AgentState, MarketTrade, Order, WorldState } from './types';

/** Keeps the per-item book sorted: cheapest first, then oldest. */
function insertSorted(list: Order[], o: Order): void {
  let i = list.length;
  while (i > 0 && (list[i - 1]!.price > o.price || (list[i - 1]!.price === o.price && list[i - 1]!.at > o.at))) i--;
  list.splice(i, 0, o);
}

/** Adds an order to the derived indexes (seller, item). */
export function indexOrder(s: WorldState, o: Order): void {
  let mine = s.ordersOf.get(o.seller);
  if (!mine) s.ordersOf.set(o.seller, (mine = new Set()));
  mine.add(o.id);
  let book = s.ordersByItem.get(o.item);
  if (!book) s.ordersByItem.set(o.item, (book = []));
  insertSorted(book, o);
}

/** Puts an order (its items already taken from the seller) in escrow. Throws before anything changes on bad amounts. */
export function addOrder(s: WorldState, o: Order): void {
  assertAmount(o.qty, `order ${o.id} qty`);
  assertAmount(o.price, `order ${o.id} price`);
  if (!(o.qty > 0 && o.price > 0)) throw new Error(`ledger: order ${o.id} with qty ${o.qty} price ${o.price}`);
  s.market.orders[o.id] = o;
  indexOrder(s, o);
  s.dirty.add('market');
}

export function removeOrder(s: WorldState, o: Order): void {
  delete s.market.orders[o.id];
  const mine = s.ordersOf.get(o.seller);
  mine?.delete(o.id);
  if (mine && !mine.size) s.ordersOf.delete(o.seller);
  const book = s.ordersByItem.get(o.item);
  if (book) {
    const left = book.filter((x) => x !== o);
    if (left.length) s.ordersByItem.set(o.item, left);
    else s.ordersByItem.delete(o.item);
  }
  s.dirty.add('market');
}

/**
 * Takes every open order of an agent off the market and puts the escrowed items back in its bags, over capacity if
 * need be: used when the agent is retired or banned (nobody can buy from it any more, and its goods cannot be moved
 * through the market by anyone else), and on restore for sellers already inactive. Bounded by the agent's orders.
 */
export function returnOrders(s: WorldState, a: AgentState): void {
  const ids = s.ordersOf.get(a.id);
  if (!ids?.size) return;
  for (const id of [...ids]) {
    const o = own(s.market.orders, id);
    if (!o) continue;
    removeOrder(s, o);
    stockAdd(a.inv, o.item, o.qty, `inventory of ${a.id}`);
  }
  s.dirty.add(`agent:${a.id}`);
}

export function ordersOf(s: WorldState, agentId: string): number {
  return s.ordersOf.get(agentId)?.size ?? 0;
}

/** Public price history: a bounded ring of the latest market trades. */
export function recordTrade(s: WorldState, t: MarketTrade): void {
  const h = s.market.history;
  h.push(t);
  if (h.length > BALANCE.market.history) h.splice(0, h.length - BALANCE.market.history);
  s.dirty.add('market');
}
