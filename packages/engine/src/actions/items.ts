import type { Item } from '@ajwf/content';
import { hasOption, appearanceHash, type Layer } from '@ajwf/appearance';
import { ref } from '@ajwf/shared';
import { addBuff, addItem, bump, canFit, capacity, count, derive, removeItem, slotsUsed } from '../agent';
import { questEvent } from '../quests';
import { emit, fail, markAgent, markRoom, msg, tell, type Run } from '../run';
import type { AgentState, EquipSlot } from '../types';
import { roomState } from '../world';
import { normId, type HandlerMap } from './util';

/** An item the agent carries (inventory only), by loose id. */
function carried(run: Run, a: AgentState, raw: string): Item {
  const id = normId(raw);
  const item = run.c.items.get(id);
  if (!item || count(a, id) <= 0) fail('TARGET_NOT_FOUND', 'item_not_carried', { item: raw });
  return item;
}

function slotOf(item: Item): EquipSlot | null {
  return item.type === 'weapon' || item.type === 'armor' || item.type === 'trinket' || item.type === 'bag' ? item.type : null;
}

/** Wearing a cosmetic or using a dye changes the look for good; the item is consumed. */
function applyCosmetic(run: Run, a: AgentState, item: Item): void {
  const cos = item.cosmetic!;
  const layer = cos.layer as Layer;
  if (!hasOption(layer, cos.option)) fail('INTERNAL', 'cosmetic_misconfigured');
  if (a.appearance[layer] === cos.option) fail('NOT_ALLOWED', 'already_wearing', { item: ref.item(item.id) });
  removeItem(a, item.id, 1);
  const old = a.lookHash;
  a.appearance = { ...a.appearance, [layer]: cos.option };
  a.lookHash = appearanceHash(a.appearance);
  const s = run.s;
  const left = (s.lookHashes.get(old) ?? 1) - 1;
  if (left <= 0) s.lookHashes.delete(old);
  else s.lookHashes.set(old, left);
  s.lookHashes.set(a.lookHash, (s.lookHashes.get(a.lookHash) ?? 0) + 1);
  bump(run, a, 'cosmetics_owned');
  tell(run, 'n.cosmetic_applied', { item: ref.item(item.id) });
  emit(run, 'look_changed', {
    room: a.room,
    actor: a.id,
    vis: 'public',
    to: 'room',
    drama: 1,
    m: msg('ev.look_changed', { actor: a.name, item: ref.item(item.id) }),
    data: { layer, option: cos.option, hash: a.lookHash },
  });
}

function equipItem(run: Run, a: AgentState, item: Item): void {
  if (item.cosmetic) return applyCosmetic(run, a, item);
  const slot = slotOf(item);
  if (!slot) fail('NOT_ALLOWED', 'not_equippable', { item: ref.item(item.id) });
  if (item.classes && !item.classes.includes(a.cls)) {
    fail('CLASS_REQUIRED', 'item_class', { item: ref.item(item.id), class: ref.cls(item.classes[0]!) });
  }
  if (a.level < item.level) fail('LEVEL_REQUIRED', 'item_level', { item: ref.item(item.id), level: item.level });
  const old = a.equip[slot];
  removeItem(a, item.id, 1);
  if (old) addItem(a, old, 1);
  a.equip[slot] = item.id;
  // A smaller bag must still hold everything.
  if (slot === 'bag' && slotsUsed(run.c, a.inv) > capacity(run.c, a)) {
    a.equip[slot] = old;
    if (old) removeItem(a, old, 1);
    addItem(a, item.id, 1);
    fail('INVENTORY_FULL', 'bag_too_small');
  }
  // Max HP/MP may have dropped with the swap.
  const d = derive(run.c, a, run.now);
  a.hp = Math.min(a.hp, d.maxHp);
  a.mp = Math.min(a.mp, d.maxMp);
  tell(run, old ? 'n.equip_swap' : 'n.equip', { item: ref.item(item.id), ...(old ? { old: ref.item(old) } : {}) });
  questEvent(run, a, 'equip', item.id);
}

export const itemActions: HandlerMap = {
  inventory(run, a) {
    const d = derive(run.c, a, run.now);
    tell(run, 'n.inventory', { used: slotsUsed(run.c, a.inv), cap: capacity(run.c, a), gold: a.gold });
    run.data.inventory = {
      items: { ...a.inv },
      equipped: { ...a.equip },
      slots: [slotsUsed(run.c, a.inv), capacity(run.c, a)],
      stats: { str: d.str, int: d.int, agi: d.agi, vit: d.vit, atk: Math.round(d.atk), def: Math.round(d.def) },
      profession: a.profession,
      skills: run.c.classes
        .get(a.cls)!
        .skills.map((id) => run.c.skills.get(id)!)
        .map((sk) => ({ id: sk.id, mp: sk.mp, level: sk.level, known: a.level >= sk.level })),
    };
  },

  equip(run, a, p) {
    equipItem(run, a, carried(run, a, p.item));
  },

  unequip(run, a, p) {
    const id = normId(p.item);
    const slot = (['weapon', 'armor', 'trinket', 'bag'] as const).find((s) => s === id || a.equip[s] === id);
    const cur = slot ? a.equip[slot] : null;
    if (!slot || !cur) fail('TARGET_NOT_FOUND', 'not_equipped', { item: p.item });
    a.equip[slot] = null;
    addItem(a, cur, 1);
    if (slotsUsed(run.c, a.inv) > capacity(run.c, a)) {
      removeItem(a, cur, 1);
      a.equip[slot] = cur;
      fail('INVENTORY_FULL', 'inventory_full');
    }
    const d = derive(run.c, a, run.now);
    a.hp = Math.max(1, Math.min(a.hp, d.maxHp));
    a.mp = Math.min(a.mp, d.maxMp);
    tell(run, 'n.unequip', { item: ref.item(cur) });
  },

  use(run, a, p) {
    const item = carried(run, a, p.item);
    if (item.cosmetic) return applyCosmetic(run, a, item);
    if (slotOf(item)) return equipItem(run, a, item);
    const fx = item.effect;
    if (!fx) fail('NOT_ALLOWED', 'not_usable', { item: ref.item(item.id) });
    const d = derive(run.c, a, run.now);
    const heal = fx.heal ? Math.min(fx.heal, d.maxHp - a.hp) : 0;
    const mana = fx.mp ? Math.min(fx.mp, d.maxMp - a.mp) : 0;
    if (!fx.buff && heal <= 0 && mana <= 0) fail('NOT_ALLOWED', 'no_need', { item: ref.item(item.id) });
    removeItem(a, item.id, 1);
    a.hp += Math.max(0, heal);
    a.mp += Math.max(0, mana);
    if (fx.buff) addBuff(a, { id: fx.buff.id, stat: fx.buff.stat, value: fx.buff.value, until: run.now + fx.buff.minutes * 60_000 });
    tell(run, 'n.use', { item: ref.item(item.id) });
    if (heal > 0) tell(run, 'n.use_heal', { hp: Math.round(heal) });
    if (mana > 0) tell(run, 'n.use_mana', { mp: Math.round(mana) });
    if (fx.buff) tell(run, 'n.use_buff', { minutes: fx.buff.minutes });
  },

  drop(run, a, p) {
    const item = carried(run, a, p.item);
    if (item.type === 'quest') fail('NOT_ALLOWED', 'quest_item', { item: ref.item(item.id) });
    const qty = Math.min(p.qty ?? 1, count(a, item.id));
    removeItem(a, item.id, qty);
    const ground = roomState(run.s, a.room).ground;
    ground[item.id] = (ground[item.id] ?? 0) + qty;
    markRoom(run.s, a.room);
    tell(run, 'n.drop', { item: ref.item(item.id), qty });
    emit(run, 'drop', { room: a.room, actor: a.id, m: msg('ev.drop', { actor: a.name, item: ref.item(item.id), qty }), data: { item: item.id, qty } });
  },

  take(run, a, p) {
    const id = normId(p.item);
    const ground = roomState(run.s, a.room).ground;
    const there = ground[id] ?? 0;
    if (there <= 0 || !run.c.items.has(id)) fail('TARGET_NOT_FOUND', 'item_not_here', { item: p.item });
    const qty = Math.min(p.qty ?? there, there);
    if (!canFit(run.c, a, [{ item: id, qty }])) fail('INVENTORY_FULL', 'inventory_full');
    if (there - qty <= 0) delete ground[id];
    else ground[id] = there - qty;
    addItem(a, id, qty);
    markRoom(run.s, a.room);
    markAgent(run.s, a);
    tell(run, 'n.take', { item: ref.item(id), qty });
    emit(run, 'take', { room: a.room, actor: a.id, m: msg('ev.take', { actor: a.name, item: ref.item(id), qty }), data: { item: id, qty } });
  },
};
