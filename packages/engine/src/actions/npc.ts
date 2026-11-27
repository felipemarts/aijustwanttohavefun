import { ref } from '@ajwf/shared';
import { addGold, addItem, canFit, count, derive, removeItem } from '../agent';
import { restPrice } from '../balance';
import { questBlocker, questEvent, questReady } from '../quests';
import { fail, tell, type Run } from '../run';
import { wantedHours } from '../trust';
import type { AgentState } from '../types';
import { hasFlag, normId, npcHere, type HandlerMap } from './util';

/** Price a shop pays for one unit of an item, or 0 when it does not buy that kind of thing. */
export function shopBuyPrice(run: Run, shopId: string, itemId: string): number {
  const shop = run.c.shops.get(shopId)!;
  const item = run.c.items.get(itemId);
  if (!item || item.type === 'quest' || !(shop.buys as string[]).includes(item.type)) return 0;
  return Math.max(1, Math.floor(item.value * shop.buy_rate));
}

/** Village shopkeepers and the innkeeper turn Wanted agents away; traders out in the wilds do not ask. */
function refuseWanted(run: Run, a: AgentState): void {
  if (a.wanted && run.c.rooms.get(a.room)?.zone === 'village') fail('NOT_ALLOWED', 'wanted_refused', { hours: wantedHours(a, run.now) });
}

export function restCost(a: AgentState): number {
  return restPrice(a.level);
}

export const npcActions: HandlerMap = {
  talk(run, a, p) {
    const npc = npcHere(run, a, p.npc);
    const topic = p.topic ? normId(p.topic) : undefined;
    if (topic && !npc.topics.includes(topic)) {
      fail('TARGET_NOT_FOUND', 'topic_unknown', { npc: ref.npc(npc.id), topics: npc.topics.join(', ') });
    }
    tell(run, 'n.talk', { npc: ref.npc(npc.id) });
    tell(run, topic ? `content.npc.${npc.id}.topic.${topic}` : `content.npc.${npc.id}.greet`);
    const offers: string[] = [];
    const ready: string[] = [];
    for (const q of run.c.questsByGiver.get(npc.id) ?? []) {
      if (a.quests[q.id]) {
        if (questReady(a, q)) ready.push(q.id);
      } else if (!questBlocker(run, a, q)) offers.push(q.id);
    }
    run.data.npc = {
      id: npc.id,
      roles: npc.roles,
      topics: npc.topics,
      ...(offers.length ? { quests: offers } : {}),
      ...(ready.length ? { turn_in: ready } : {}),
      ...(npc.shop ? { sells: Object.fromEntries(run.c.shops.get(npc.shop)!.sells.map((e) => [e.item, e.price])) } : {}),
      ...(npc.roles.includes('innkeeper') ? { rest_cost: restCost(a) } : {}),
    };
    if (offers.length) tell(run, 'n.talk_quests', { n: offers.length });
    if (ready.length) tell(run, 'n.talk_turn_in', { n: ready.length });
    questEvent(run, a, 'talk', npc.id);
  },

  shop_buy(run, a, p) {
    const npc = npcHere(run, a, p.npc);
    if (!npc.shop) fail('NOT_AVAILABLE_HERE', 'not_a_shop', { npc: ref.npc(npc.id) });
    refuseWanted(run, a);
    const id = normId(p.item);
    const entry = run.c.shops.get(npc.shop)!.sells.find((e) => e.item === id);
    if (!entry) fail('TARGET_NOT_FOUND', 'shop_no_item', { npc: ref.npc(npc.id), item: p.item });
    const total = entry.price * p.qty;
    if (a.gold < total) fail('NOT_ENOUGH_GOLD', 'no_gold', { need: total, have: a.gold });
    if (!canFit(run.c, a, [{ item: id, qty: p.qty }])) fail('INVENTORY_FULL', 'inventory_full');
    a.gold -= total;
    addItem(a, id, p.qty);
    tell(run, 'n.shop_buy', { item: ref.item(id), qty: p.qty, gold: total });
    questEvent(run, a, 'shop_buy', id, p.qty);
  },

  shop_sell(run, a, p) {
    const npc = npcHere(run, a, p.npc);
    if (!npc.shop) fail('NOT_AVAILABLE_HERE', 'not_a_shop', { npc: ref.npc(npc.id) });
    refuseWanted(run, a);
    const id = normId(p.item);
    if (count(a, id) < p.qty) fail('MISSING_ITEMS', 'not_enough_items', { item: p.item, have: count(a, id), need: p.qty });
    const price = shopBuyPrice(run, npc.shop, id);
    if (price <= 0) fail('NOT_ALLOWED', 'shop_wont_buy', { npc: ref.npc(npc.id), item: ref.item(id) });
    removeItem(a, id, p.qty);
    addGold(run, a, price * p.qty);
    tell(run, 'n.shop_sell', { item: ref.item(id), qty: p.qty, gold: price * p.qty });
  },

  rest(run, a) {
    if (!hasFlag(run, a, 'tavern')) fail('NOT_AVAILABLE_HERE', 'rest_tavern_only', { room: ref.room('village.tavern') });
    refuseWanted(run, a);
    const d = derive(run.c, a, run.now);
    if (a.hp >= d.maxHp && a.mp >= d.maxMp) fail('NOT_ALLOWED', 'already_rested');
    const cost = restCost(a);
    if (a.gold < cost) fail('NOT_ENOUGH_GOLD', 'no_gold', { need: cost, have: a.gold });
    a.gold -= cost;
    a.hp = d.maxHp;
    a.mp = d.maxMp;
    tell(run, 'n.rest', { gold: cost });
    questEvent(run, a, 'rest');
  },
};
