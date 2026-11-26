import { describe, expect, it } from 'vitest';
import { derive } from './agent';
import { BALANCE } from './balance';
import { errCode, errKey, keys, makeKit, narr } from './testkit';

describe('talk', () => {
  it('greets, lists quests and shop prices, answers topics', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const r = k.ok(a, 'talk', { npc: 'olga' });
    expect(keys(r)).toEqual(['n.talk', 'content.npc.olga.greet', 'n.talk_quests']);
    const npc = (r.result.ok && r.result.data?.npc) as Record<string, unknown>;
    expect(npc.quests).toContain('t01_arrival');
    expect(npc.quests).not.toContain('t02_innkeeper');
    expect((npc.sells as Record<string, number>).minor_potion).toBe(25);
    const t = k.ok(a, 'talk', { npc: 'npc.olga', topic: 'village' });
    expect(keys(t)).toContain('content.npc.olga.topic.village');
    expect(a.ap).toBe(BALANCE.ap.max);
  });

  it('the innkeeper quotes the rest price', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'village.tavern', level: 4 });
    const r = k.ok(a, 'talk', { npc: 'berta' });
    expect((r.result.ok && (r.result.data?.npc as Record<string, unknown>).rest_cost)).toBe(4 + 4 * 2);
  });

  it('errors: npc elsewhere, unknown topic', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    expect(errKey(k.act(a, 'talk', { npc: 'berta' }))).toBe('err.npc_not_here');
    const r = k.act(a, 'talk', { npc: 'olga', topic: 'dragons' });
    expect(errCode(r)).toBe('TARGET_NOT_FOUND');
    expect(errKey(r)).toBe('err.topic_unknown');
  });
});

describe('shops', () => {
  it('buys at the listed price', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    a.gold = 60;
    const r = k.ok(a, 'shop_buy', { npc: 'olga', item: 'Minor Potion', qty: 2 });
    expect(narr(r, 'n.shop_buy')).toEqual({ item: '@item:minor_potion', qty: 2, gold: 50 });
    expect(a.gold).toBe(10);
    expect(a.inv.minor_potion).toBe(2);
    expect(a.ap).toBe(BALANCE.ap.max);
  });

  it('buy errors: not a shop, not sold, no gold, full, in combat', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'village.temple' });
    expect(errKey(k.act(a, 'shop_buy', { npc: 'sister_ilse', item: 'bread' }))).toBe('err.not_a_shop');
    k.place(a, 'village.square');
    expect(errKey(k.act(a, 'shop_buy', { npc: 'olga', item: 'iron_sword' }))).toBe('err.shop_no_item');
    a.gold = 7;
    expect(k.err(a, 'shop_buy', { npc: 'olga', item: 'bread' })).toBe('NOT_ENOUGH_GOLD');
    expect(a.gold).toBe(7);
    const b = k.add('Fighter', 'warrior', { room: 'forest.edge' });
    k.ok(b, 'attack', { target: 'slime' });
    expect(k.err(b, 'shop_buy', { npc: 'olga', item: 'bread' })).toBe('IN_COMBAT');
  });

  it('sells for a share of the item value, only what the shop buys', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'village.tavern' });
    a.inv.wolf_pelt = 3;
    a.inv.iron_sword = 1;
    a.inv.lost_locket = 1;
    const gold = a.gold;
    const r = k.ok(a, 'shop_sell', { npc: 'berta', item: 'wolf_pelt', qty: 3 });
    // 5 * 0.5 = 2 each.
    expect(narr(r, 'n.shop_sell')).toEqual({ item: '@item:wolf_pelt', qty: 3, gold: 6 });
    expect(a.gold).toBe(gold + 6);
    expect(a.inv.wolf_pelt).toBeUndefined();
    expect(errKey(k.act(a, 'shop_sell', { npc: 'berta', item: 'iron_sword' }))).toBe('err.shop_wont_buy');
    expect(errKey(k.act(a, 'shop_sell', { npc: 'berta', item: 'lost_locket' }))).toBe('err.shop_wont_buy');
    expect(k.err(a, 'shop_sell', { npc: 'berta', item: 'wolf_pelt' })).toBe('MISSING_ITEMS');
    k.place(a, 'village.temple');
    expect(errKey(k.act(a, 'shop_sell', { npc: 'sister_ilse', item: 'iron_sword' }))).toBe('err.not_a_shop');
    // The equipped weapon is not in the bag, so it cannot be sold.
    k.place(a, 'village.smithy');
    expect(k.err(a, 'shop_sell', { npc: 'gunnar', item: 'rusty_sword' })).toBe('MISSING_ITEMS');
    k.ok(a, 'shop_sell', { npc: 'gunnar', item: 'iron_sword' });
    expect(a.inv.iron_sword).toBeUndefined();
  });
});

describe('rest', () => {
  it('restores HP and MP at the tavern for a fee that grows with level', () => {
    const k = makeKit();
    const a = k.add('Pip', 'mage', { room: 'village.tavern', level: 3 });
    a.hp = 5;
    a.mp = 1;
    const gold = a.gold;
    const r = k.ok(a, 'rest');
    expect(narr(r, 'n.rest')).toEqual({ gold: 4 + 3 * 2 });
    expect(a.gold).toBe(gold - 10);
    expect(a.hp).toBe(k.maxHp(a));
    expect(a.mp).toBe(derive(k.c, a, k.now).maxMp);
    expect(a.ap).toBe(BALANCE.ap.max);
  });

  it('errors: not a tavern, already rested, no gold', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    a.hp = 5;
    expect(errKey(k.act(a, 'rest'))).toBe('err.rest_tavern_only');
    k.place(a, 'village.tavern');
    a.gold = 2;
    expect(k.err(a, 'rest')).toBe('NOT_ENOUGH_GOLD');
    a.gold = 100;
    k.ok(a, 'rest');
    expect(errKey(k.act(a, 'rest'))).toBe('err.already_rested');
    expect(a.gold).toBe(94);
  });
});
