/**
 * Trader: levels to 5 like anyone (hunting alone, quests), then picks a profession and lives from it: gathers or buys
 * the inputs of its recipes (from village shops or from other agents' market orders), crafts at the station, sells
 * the goods on the market a little under the shop price, offers guaranteed trades to agents at the market, and
 * founds a guild (or joins one) once it can afford it. It answers fair trade offers and guild invites.
 *
 * Coordination is through the game only: the market's order book (`market_list` answers), trade offers and invites.
 */
import { BALANCE } from '@ajwf/engine';
import type { BotStep } from '../solo';
import {
  absorbLast,
  answerPending,
  buyFromShop,
  civicVote,
  cmd,
  contributeSomething,
  gather,
  have,
  hunt,
  keepSupplied,
  nearest,
  preyFor,
  questKeep,
  quests,
  resourceRooms,
  sellJunk,
  stableHash,
  survive,
  travel,
  keepGoing,
} from './common';
import type { AgentView, DecideCtx, Profile } from './types';

const MIN = 60_000;

/** What each profession makes, in order of preference, and which outputs it sells. */
export const TRADE_PLAN: Record<string, { recipes: string[]; sell: string[] }> = {
  cook: { recipes: ['char_coal', 'bake_bread'], sell: ['coal', 'bread'] },
  blacksmith: { recipes: ['blow_flasks', 'smelt_iron', 'forge_buckles'], sell: ['flask', 'iron_ingot', 'buckle'] },
  alchemist: { recipes: ['brew_minor_potion', 'press_oil', 'mix_green_dye'], sell: ['minor_potion', 'oil', 'green_dye'] },
  tailor: { recipes: ['sew_chef_hat', 'sew_padded_armor'], sell: ['cos_chef_hat', 'padded_armor'] },
};

export const TRADER_TUNING = {
  /** Market price as a share of the cheapest NPC shop price (the ceiling), or of base value when no shop sells it. */
  priceOfShop: 0.85,
  priceOfValue: 1.6,
  /** Buy inputs from other agents' orders up to this multiple of their base value. */
  buyUpTo: 2.5,
  /** Gold needed to found a guild (the fee is 500). */
  guildAt: 700,
  /** Units of a good kept before listing them. */
  listAt: 3,
  marketEveryMs: 30 * MIN,
} as const;
const T = TRADER_TUNING;

function shopPrice(x: DecideCtx, item: string): number | null {
  let best: number | null = null;
  for (const n of x.c.npcs.values()) {
    const e = n.shop ? x.c.shops.get(n.shop)?.sells.find((s) => s.item === item) : undefined;
    if (e && (best === null || e.price < best)) best = e.price;
  }
  return best;
}

export function askPrice(x: DecideCtx, item: string): number {
  const shop = shopPrice(x, item);
  const value = x.c.items.get(item)?.value ?? 1;
  return Math.max(1, Math.floor(shop !== null ? shop * T.priceOfShop : value * T.priceOfValue));
}

/** Reads the answers of market actions: the order book of an item, our own new orders. */
function absorbMarket(v: AgentView, x: DecideCtx): void {
  const last = v.last;
  if (!last?.ok) return;
  if (last.action === 'market_list') {
    const m = last.data?.market as { item?: string; orders?: [string, number, number, string][] } | undefined;
    if (m?.item) {
      const book = (x.mem.ext.book as Record<string, { at: number; orders: [string, number, number, string][] }> | undefined) ?? {};
      book[m.item] = { at: v.now, orders: m.orders ?? [] };
      x.mem.ext.book = book;
    }
  }
  if (last.action === 'market_sell') x.mem.ext.orders = ((x.mem.ext.orders as number | undefined) ?? 0) + 1;
}

/** One unit of work towards the next craft: inputs (gathered, bought on the market or at a shop), then the station. */
function work(v: AgentView, x: DecideCtx, prof: string): BotStep | null {
  const plan = TRADE_PLAN[prof]!;
  const lvl = v.obs.you.lvl;
  const book = (x.mem.ext.book as Record<string, { at: number; orders: [string, number, number, string][] }> | undefined) ?? {};
  for (const rid of plan.recipes) {
    const r = x.c.recipes.get(rid);
    if (!r || r.level > lvl) continue;
    const short = r.inputs.filter((i) => have(v, i.item) < i.qty);
    if (!short.length) {
      const stations = [...x.c.rooms.values()].filter((room) => room.stations.includes(r.station) && room.zone === 'village').map((room) => room.id);
      if (stations.includes(v.obs.room.id)) return v.obs.you.ap[0] >= 2 ? cmd('craft', { recipe: r.id }) : { wait: BALANCE.ap.regenMs };
      const to = nearest(v, x, stations);
      if (to) return travel(v, x, to);
      continue;
    }
    for (const input of short) {
      const need = input.qty - have(v, input.item);
      // Another agent's order, cheap enough.
      const value = x.c.items.get(input.item)?.value ?? 1;
      const orders = book[input.item];
      if (v.obs.room.flags.includes('market') && orders && v.now - orders.at < 10 * MIN) {
        const o = orders.orders.find((row) => row[3] !== v.name && row[2] <= value * T.buyUpTo && row[2] * Math.min(need, row[1]) <= v.obs.you.gold);
        if (o) {
          orders.orders = orders.orders.filter((row) => row !== o);
          return cmd('market_buy', { order: o[0], qty: Math.min(need, o[1]) });
        }
      }
      if (v.obs.room.flags.includes('market') && (!orders || v.now - orders.at > T.marketEveryMs)) return cmd('market_list', { item: input.item });
      if (resourceRooms(x.c, input.item).length) {
        const g = gather(v, x, [input.item]);
        if (g) return g;
      }
      const buy = buyFromShop(v, x, input.item, need);
      if (buy) return buy;
    }
  }
  return null;
}

/** Lists goods on the market, or offers one to an agent at the market as a guaranteed trade. */
function sell(v: AgentView, x: DecideCtx, prof: string): BotStep | null {
  const plan = TRADE_PLAN[prof]!;
  const goods = plan.sell.filter((id) => have(v, id) >= T.listAt);
  if (!goods.length) return null;
  if (!v.obs.room.flags.includes('market')) return travel(v, x, 'village.market');
  const item = goods[0]!;
  // Now and then, a direct offer to someone here: one unit for its asking price.
  const buyer = v.obs.room.agents.find((a) => !a.fallen && a.name !== v.name);
  if (buyer && x.rng.chance(0.25)) return cmd('trade_offer', { to: buyer.name, give: { items: { [item]: 1 } }, want: { gold: askPrice(x, item) } });
  const orders = (x.mem.ext.orders as number | undefined) ?? 0;
  if (orders >= BALANCE.market.maxOrders) return null;
  return cmd('market_sell', { item, qty: have(v, item), price: askPrice(x, item) });
}

/** Founds a guild when rich enough, invites agents met at the guild hall or the market, puts some gold in. */
function guildLife(v: AgentView, x: DecideCtx): BotStep | null {
  const me = v.obs.you;
  if (!me.guild) {
    if (me.gold < T.guildAt || x.mem.ext.guildTried) return null;
    if (!v.obs.room.flags.includes('guild_hall')) return travel(v, x, 'village.guild_hall');
    x.mem.ext.guildTried = true;
    const name = `${v.name.split('_')[0]!.slice(0, 12)} Traders`;
    return cmd('guild_create', { name, motto: 'Fair prices, honest scales.' });
  }
  if (v.obs.actions?.includes('guild_invite')) {
    const invited = (x.mem.ext.ginvited as Set<string> | undefined) ?? new Set<string>();
    x.mem.ext.ginvited = invited;
    const who = v.obs.room.agents.find((a) => !a.rel && !invited.has(a.name));
    if (who) {
      invited.add(who.name);
      return cmd('guild_invite', { agent: who.name });
    }
  }
  if (me.gold > 400 && v.now - ((x.mem.ext.depositAt as number | undefined) ?? 0) > 6 * 60 * MIN) {
    x.mem.ext.depositAt = v.now;
    return cmd('guild_deposit', { gold: 50 });
  }
  return null;
}

export const trader: Profile = {
  id: 'trader',
  grouped: false,
  decide(v, x) {
    absorbLast(v, x);
    absorbMarket(v, x);
    if (v.last?.action === 'market_sell' && !v.last.ok) x.mem.ext.orders = BALANCE.market.maxOrders;
    // Orders fill up over time; assume a slot frees every few hours.
    if (v.now - ((x.mem.ext.ordersAt as number | undefined) ?? 0) > 4 * 60 * MIN) {
      x.mem.ext.ordersAt = v.now;
      x.mem.ext.orders = Math.max(0, ((x.mem.ext.orders as number | undefined) ?? 0) - 2);
    }
    const prof = v.profession;
    const keep = questKeep(v);
    if (prof) for (const rid of TRADE_PLAN[prof]!.recipes) for (const i of x.c.recipes.get(rid)?.inputs ?? []) keep.add(i.item);
    if (prof) for (const id of TRADE_PLAN[prof]!.sell) keep.add(id);
    const early =
      survive(v, x, false) ??
      keepGoing(v, x) ??
      answerPending(v, x, { friends: true, guild: true, trades: true }) ??
      keepSupplied(v, x) ??
      sellJunk(v, x, keep) ??
      civicVote(v, x);
    if (early) return early;
    if (!prof && v.obs.you.lvl >= 5) {
      const profs = Object.keys(TRADE_PLAN);
      return cmd('choose_profession', { profession: profs[stableHash(v.name + x.seed) % profs.length]! });
    }
    const q = quests(v, x, { social: false, grouped: false, extra: ['trade', 'friend', 'market'] });
    if (q) return q;
    if (prof) {
      // Half of the sessions' spare time goes to the trade, the rest to hunting (it still has to level).
      const g = guildLife(v, x) ?? sell(v, x, prof);
      if (g) return g;
      if (v.obs.room.flags.includes('town_hall') && x.rng.chance(0.3)) {
        const give = contributeSomething(v, x, 0.05, 10);
        if (give) return give;
      }
      const hour = Math.floor(v.now / (60 * MIN));
      if ((hour + stableHash(v.name)) % 3 !== 0) {
        const w = work(v, x, prof);
        if (w) return w;
      }
    }
    return hunt(v, x, preyFor(x.c, v.obs.you.lvl, false)) ?? { wait: 20_000 };
  },
};
