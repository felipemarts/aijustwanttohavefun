import type { Content } from '@ajwf/content';
import type { MarketTrade } from '@ajwf/engine';

/** Market reference prices: recent player trades next to the fixed NPC shop prices (§8.3, §10.2). Pure. */

/** Trades older than this do not count in the recent average. */
export const RECENT_PRICE_MS = 7 * 24 * 3_600_000;

export type RecentPrice = { item: string; avg: number; qty: number; n: number; last: number };

/** Average unit price per item over the recent trades (weighted by quantity), most recently traded first. */
export function recentPrices(history: readonly MarketTrade[], now: number, windowMs = RECENT_PRICE_MS): RecentPrice[] {
  const by = new Map<string, RecentPrice & { gold: number }>();
  for (const t of history) {
    if (now - t.ts > windowMs || t.qty <= 0) continue;
    const r = by.get(t.item) ?? { item: t.item, avg: 0, qty: 0, n: 0, last: 0, gold: 0 };
    r.qty += t.qty;
    r.gold += t.qty * t.price;
    r.n++;
    r.last = Math.max(r.last, t.ts);
    by.set(t.item, r);
  }
  return [...by.values()]
    .map(({ gold, ...r }) => ({ ...r, avg: Math.round((gold / r.qty) * 10) / 10 }))
    .sort((a, b) => b.last - a.last || a.item.localeCompare(b.item));
}

/** NPC prices of an item: what a shop pays for it (the floor) and what a shop sells it for (the ceiling). */
export type NpcPrice = { buys?: number; sells?: number };

const npcCache = new WeakMap<Content, Map<string, NpcPrice>>();

/** Best NPC prices per item: the highest any shop pays, the lowest any shop asks. Cached per content. */
export function npcPrices(c: Content): Map<string, NpcPrice> {
  let m = npcCache.get(c);
  if (m) return m;
  m = new Map();
  for (const shop of c.shops.values()) {
    for (const e of shop.sells) {
      const cur = m.get(e.item) ?? {};
      if (cur.sells === undefined || e.price < cur.sells) cur.sells = e.price;
      m.set(e.item, cur);
    }
    for (const item of c.items.values()) {
      if (item.type === 'quest' || !(shop.buys as readonly string[]).includes(item.type)) continue;
      const pay = Math.max(1, Math.floor(item.value * shop.buy_rate));
      const cur = m.get(item.id) ?? {};
      if (cur.buys === undefined || pay > cur.buys) cur.buys = pay;
      m.set(item.id, cur);
    }
  }
  npcCache.set(c, m);
  return m;
}
