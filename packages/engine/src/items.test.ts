import { describe, expect, it } from 'vitest';
import { appearanceHash } from '@ajwf/appearance';
import { canFit, capacity, derive, giveOrDrop, slotsUsed } from './agent';
import { BALANCE } from './balance';
import { newRun } from './run';
import { errCode, errKey, keys, makeKit, MIN, narr } from './testkit';

describe('inventory', () => {
  it('stacks consumables and materials in one slot, equipment takes one slot each', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    expect(a.equip.weapon).toBe('rusty_sword');
    expect(a.inv).toEqual({ cloth_armor: 1, bread: 3 });
    expect(slotsUsed(k.c, a.inv)).toBe(2);
    a.inv.wood = 500;
    a.inv.iron_sword = 3;
    expect(slotsUsed(k.c, a.inv)).toBe(2 + 1 + 3);
    expect(capacity(k.c, a)).toBe(BALANCE.inventory.slots);
    const r = k.ok(a, 'inventory');
    expect(narr(r, 'n.inventory')).toEqual({ used: 6, cap: 30, gold: a.gold });
    const data = (r.result.ok && r.result.data?.inventory) as { items: Record<string, number>; skills: { id: string; known: boolean }[] };
    expect(data.items.wood).toBe(500);
    expect(data.skills.map((s) => s.known)).toEqual([true, false, false, false]);
    // The result is a copy, not a live view of the agent.
    a.inv.wood = 1;
    expect(data.items.wood).toBe(500);
  });

  it('refuses what does not fit and drops loot on the floor when full', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    a.inv = { iron_sword: 30 };
    expect(canFit(k.c, a, [{ item: 'bread', qty: 1 }])).toBe(false);
    expect(canFit(k.c, a, [{ item: 'bread', qty: 1 }], [{ item: 'iron_sword', qty: 1 }])).toBe(true);
    expect(k.err(a, 'shop_buy', { npc: 'olga', item: 'bread' })).toBe('INVENTORY_FULL');
    const kept = giveOrDrop(newRun(k.s, k.now, k.rng, a), a, 'wolf_pelt', 2);
    expect(kept).toBe(false);
    expect(k.s.rooms.get(a.room)!.ground.wolf_pelt).toBe(2);
  });
});

describe('equip and unequip', () => {
  it('equips armor from the bag, swapping the old piece back in', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { level: 3 });
    const def = derive(k.c, a, k.now).def;
    const r = k.ok(a, 'equip', { item: 'Cloth Armor' });
    expect(keys(r)).toEqual(['n.equip']);
    expect(a.equip.armor).toBe('cloth_armor');
    expect(a.inv.cloth_armor).toBeUndefined();
    expect(derive(k.c, a, k.now).def).toBe(def + 2);
    a.inv.padded_armor = 1;
    const r2 = k.ok(a, 'equip', { item: 'padded_armor' });
    expect(narr(r2, 'n.equip_swap')).toEqual({ item: '@item:padded_armor', old: '@item:cloth_armor' });
    expect(a.inv.cloth_armor).toBe(1);
    k.ok(a, 'unequip', { item: 'armor' });
    expect(a.equip.armor).toBeNull();
    expect(a.inv.padded_armor).toBe(1);
    k.ok(a, 'unequip', { item: 'rusty_sword' });
    expect(a.equip.weapon).toBeNull();
    expect(a.inv.rusty_sword).toBe(1);
  });

  it('equip errors: not carried, not equippable, class, level', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    expect(errKey(k.act(a, 'equip', { item: 'iron_sword' }))).toBe('err.item_not_carried');
    expect(errKey(k.act(a, 'equip', { item: 'bread' }))).toBe('err.not_equippable');
    a.inv.oak_staff = 1;
    expect(k.err(a, 'equip', { item: 'oak_staff' })).toBe('CLASS_REQUIRED');
    a.inv.iron_sword = 1;
    expect(k.err(a, 'equip', { item: 'iron_sword' })).toBe('LEVEL_REQUIRED');
    k.setLevel(a, 5);
    k.ok(a, 'equip', { item: 'iron_sword' });
    expect(a.equip.weapon).toBe('iron_sword');
    expect(k.err(a, 'unequip', { item: 'trinket' })).toBe('TARGET_NOT_FOUND');
    expect(k.err(a, 'unequip', { item: 'oak_staff' })).toBe('TARGET_NOT_FOUND');
  });

  it('losing VIT gear lowers max HP and clamps HP', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { level: 12 });
    a.inv.plate_armor = 1;
    k.ok(a, 'equip', { item: 'plate_armor' });
    a.hp = k.maxHp(a);
    k.ok(a, 'unequip', { item: 'armor' });
    expect(a.hp).toBe(k.maxHp(a));
  });

  it('unequip fails when the bag is full', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    a.inv = { iron_sword: 30 };
    expect(errKey(k.act(a, 'unequip', { item: 'weapon' }))).toBe('err.inventory_full');
    expect(a.equip.weapon).toBe('rusty_sword');
  });

  it('bags add slots; a smaller bag must still hold everything', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    a.inv.large_bag = 1;
    a.inv.small_bag = 1;
    k.ok(a, 'equip', { item: 'large_bag' });
    expect(capacity(k.c, a)).toBe(30 + 12);
    a.inv.iron_sword = 38; // 3 stacks + small_bag + 38 swords = 41 slots
    expect(slotsUsed(k.c, a.inv)).toBe(41);
    const r = k.act(a, 'equip', { item: 'small_bag' });
    expect(errCode(r)).toBe('INVENTORY_FULL');
    expect(errKey(r)).toBe('err.bag_too_small');
    expect(a.equip.bag).toBe('large_bag');
    expect(a.inv.small_bag).toBe(1);
    expect(a.inv.large_bag).toBeUndefined();
    expect(k.err(a, 'unequip', { item: 'bag' })).toBe('INVENTORY_FULL');
    a.inv.iron_sword = 10;
    k.ok(a, 'equip', { item: 'small_bag' });
    expect(capacity(k.c, a)).toBe(36);
    expect(a.inv.large_bag).toBe(1);
  });
});

describe('use', () => {
  it('potions heal up to the maximum and are consumed', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    a.inv.minor_potion = 2;
    const max = k.maxHp(a);
    expect(errKey(k.act(a, 'use', { item: 'minor_potion' }))).toBe('err.no_need');
    a.hp = max - 10;
    a.regenAt = k.now + 10_000; // no regeneration noise
    const r = k.ok(a, 'use', { item: 'minor_potion' });
    expect(narr(r, 'n.use_heal')).toEqual({ hp: 10 });
    expect(a.hp).toBe(max);
    expect(a.inv.minor_potion).toBe(1);
  });

  it('works in combat for free', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    a.inv.minor_potion = 1;
    k.ok(a, 'attack', { target: 'slime' });
    a.hp = 10;
    const ap = a.ap;
    k.ok(a, 'use', { item: 'minor_potion' });
    expect(a.hp).toBe(50);
    expect(a.ap).toBe(ap);
    expect(a.inv.minor_potion).toBeUndefined();
  });

  it('mana potions restore MP; food gives buffs', () => {
    const k = makeKit();
    const a = k.add('Magus', 'mage');
    a.inv.mana_potion = 1;
    a.inv.hearty_stew = 1;
    a.inv.roast_boar = 1;
    a.mp = 0;
    a.regenAt = k.now + 10_000;
    k.ok(a, 'use', { item: 'mana_potion' });
    expect(a.mp).toBe(40);
    // Food with a buff is always welcome, even at full health.
    const r = k.ok(a, 'use', { item: 'hearty_stew' });
    expect(narr(r, 'n.use_buff')).toEqual({ minutes: 60 });
    expect(a.buffs).toEqual([{ id: 'hearty', stat: 'xp', value: 0.1, until: k.now + 60 * MIN }]);
    const atk = derive(k.c, a, k.now).atk;
    k.ok(a, 'use', { item: 'roast_boar' });
    expect(derive(k.c, a, k.now).atk).toBe(atk + 3);
  });

  it('an XP food buff raises XP gains', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior', { room: 'forest.edge' });
    a.inv.hearty_stew = 1;
    k.ok(a, 'use', { item: 'hearty_stew' });
    const m = k.monsters('forest.edge')[0]!;
    let r;
    for (let i = 0; i < 10 && m.hp > 0; i++) r = k.ok(a, 'attack', { target: m.uid });
    expect(narr(r!, 'n.kill')!.xp).toBe(Math.round(k.c.monsters.get('slime')!.xp * 1.1));
  });

  it('use errors: not carried, not usable', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    expect(k.err(a, 'use', { item: 'minor_potion' })).toBe('TARGET_NOT_FOUND');
    a.inv.wood = 1;
    expect(errKey(k.act(a, 'use', { item: 'wood' }))).toBe('err.not_usable');
    // Equipment can be "used": it gets equipped.
    k.ok(a, 'use', { item: 'cloth_armor' });
    expect(a.equip.armor).toBe('cloth_armor');
  });

  it('cosmetics and dyes change the look for good and update the look hash index', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const oldHash = a.lookHash;
    a.inv.cos_chef_hat = 1;
    a.inv.red_dye = 2;
    a.appearance = { ...a.appearance, dye: 'd5' };
    a.lookHash = appearanceHash(a.appearance);
    k.s.lookHashes.delete(oldHash);
    k.s.lookHashes.set(a.lookHash, 1);
    const before = a.lookHash;
    const r = k.ok(a, 'equip', { item: 'cos_chef_hat' });
    expect(keys(r)).toEqual(['n.cosmetic_applied']);
    expect(a.appearance.hat).toBe('chef_hat');
    expect(a.lookHash).toBe(appearanceHash(a.appearance));
    expect(a.lookHash).not.toBe(before);
    expect(k.s.lookHashes.has(before)).toBe(false);
    expect(k.s.lookHashes.get(a.lookHash)).toBe(1);
    expect(a.inv.cos_chef_hat).toBeUndefined();
    expect(a.equip).toMatchObject({ armor: null, trinket: null });
    const ev = r.events.find((e) => e.type === 'look_changed')!;
    expect(ev.payload).toMatchObject({ layer: 'hat', option: 'chef_hat', hash: a.lookHash });
    k.ok(a, 'use', { item: 'red_dye' });
    expect(a.appearance.dye).toBe('d0');
    expect(a.inv.red_dye).toBe(1);
    expect(errKey(k.act(a, 'use', { item: 'red_dye' }))).toBe('err.already_wearing');
    expect(a.inv.red_dye).toBe(1);
    expect(a.stats.cosmetics_owned).toBe(2);
  });
});

describe('take and drop', () => {
  it('drops on the ground and picks back up', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'warrior');
    k.ok(a, 'drop', { item: 'bread', qty: 2 });
    expect(a.inv.bread).toBe(1);
    expect(k.s.rooms.get('village.square')!.ground.bread).toBe(2);
    // Dropping more than carried drops what there is.
    k.ok(a, 'drop', { item: 'bread', qty: 50 });
    expect(a.inv.bread).toBeUndefined();
    expect(k.s.rooms.get('village.square')!.ground.bread).toBe(3);
    k.ok(b, 'take', { item: 'bread', qty: 1 });
    expect(b.inv.bread).toBe(4);
    k.ok(b, 'take', { item: 'bread' });
    expect(b.inv.bread).toBe(6);
    expect(k.s.rooms.get('village.square')!.ground).toEqual({});
  });

  it('errors: nothing there, not carried, quest items, full bag', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    expect(errKey(k.act(a, 'take', { item: 'bread' }))).toBe('err.item_not_here');
    expect(k.err(a, 'drop', { item: 'wood' })).toBe('TARGET_NOT_FOUND');
    a.inv.sealed_letter = 1;
    expect(errKey(k.act(a, 'drop', { item: 'sealed_letter' }))).toBe('err.quest_item');
    k.s.rooms.get(a.room)!.ground.iron_sword = 2;
    a.inv = { iron_sword: 30 };
    expect(k.err(a, 'take', { item: 'iron_sword' })).toBe('INVENTORY_FULL');
    expect(k.s.rooms.get(a.room)!.ground.iron_sword).toBe(2);
  });
});
