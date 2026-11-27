import type { Item } from '@ajwf/content';
import { bundleToList, ref, type ItemBundle } from '@ajwf/shared';
import { addGold, addItem, count, removeItem, takeGold } from './agent';
import { assertAmount, covers } from './ledger';
import { normId, wholeNumber } from './actions/util';
import { fail, type Run } from './run';
import type { AgentState, Goods } from './types';

/**
 * Gold and items as agents write them (`{ gold, items }`), folded to canonical ids. Quest items never change
 * hands: they belong to the quest that granted them.
 */
export function parseGoods(run: Run, raw: { gold?: number | undefined; items?: ItemBundle | undefined }): Goods {
  const merged = new Map<string, number>();
  for (const s of bundleToList(raw.items)) {
    const id = normId(s.item);
    const item: Item | undefined = run.c.items.get(id);
    if (!item) fail('TARGET_NOT_FOUND', 'item_unknown', { item: s.item });
    if (item.type === 'quest') fail('NOT_ALLOWED', 'quest_item_bound', { item: ref.item(id) });
    const qty = (merged.get(id) ?? 0) + s.qty;
    // The schemas bound each quantity; anything that is not a safe positive integer is refused all the same.
    wholeNumber(s.qty, 'qty', 1);
    wholeNumber(qty, 'qty', 1);
    merged.set(id, qty);
  }
  const gold = wholeNumber(raw.gold ?? 0, 'gold', 0);
  return { gold, items: [...merged].map(([item, qty]) => ({ item, qty })) };
}

export function isEmpty(g: Goods): boolean {
  return g.gold <= 0 && g.items.length === 0;
}

/** What the agent lacks to hand over these goods, as "item xN" strings (gold first); empty when it has it all. NaN never counts as enough. */
export function missingGoods(a: AgentState, g: Goods): string[] {
  const out: string[] = [];
  if (!covers(a.gold, g.gold)) out.push(`gold x${g.gold - a.gold}`);
  for (const s of g.items) if (!covers(count(a, s.item), s.qty)) out.push(`${s.item} x${s.qty - count(a, s.item)}`);
  return out;
}

/** Every amount of the goods is a safe non-negative integer (throws otherwise, before anything moves). */
export function assertGoods(g: Goods, what: string): void {
  assertAmount(g.gold, `${what} gold`);
  for (const s of g.items) assertAmount(s.qty, `${what} ${s.item}`);
}

/** Moves goods out of an agent. The caller refused with `missingGoods` first; checked again here before anything moves. */
export function takeGoods(a: AgentState, g: Goods): void {
  assertGoods(g, `goods from ${a.id}`);
  if (missingGoods(a, g).length) throw new Error(`ledger: ${a.id} lacks goods ${JSON.stringify(g)}`);
  takeGold(a, g.gold);
  for (const s of g.items) removeItem(a, s.item, s.qty);
}

export function putGoods(run: Run, a: AgentState, g: Goods): void {
  assertGoods(g, `goods to ${a.id}`);
  addGold(run, a, g.gold);
  for (const s of g.items) addItem(a, s.item, s.qty);
}

/** Shop value of the goods in gold (for public reports such as treasury withdrawals). */
export function goodsValue(run: Run, g: Goods): number {
  let v = g.gold;
  for (const s of g.items) v += (run.c.items.get(s.item)?.value ?? 0) * s.qty;
  return v;
}

/** Compact form for events and observation: `{ gold?, items? }` with items as a map. */
export function goodsView(g: Goods): { gold?: number; items?: Record<string, number> } {
  return {
    ...(g.gold > 0 ? { gold: g.gold } : {}),
    ...(g.items.length ? { items: Object.fromEntries(g.items.map((s) => [s.item, s.qty])) } : {}),
  };
}
