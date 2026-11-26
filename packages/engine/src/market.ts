import { BALANCE } from './balance';
import type { MarketTrade, Order, WorldState } from './types';

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

export function addOrder(s: WorldState, o: Order): void {
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
