import { isPlainKey, own } from '@ajwf/shared';

/**
 * The few primitives that move gold and items between holders: agents, guild treasuries and vaults, the village
 * treasury, the ground, market escrow, bounties and project ledgers. Each one checks its amounts BEFORE changing
 * anything and throws a plain `Error` (an internal error, never a `GameError`) when an amount is not a safe
 * non-negative integer or a holder lacks what it is asked to give: handlers check balances first and refuse with
 * `fail`, so reaching one of these throws means a bug, which `applyAction` turns into an INTERNAL refusal.
 * A NaN balance once passed every `a.gold < x` check (NaN compares false); these checks fail closed instead.
 */

export function assertAmount(n: unknown, what: string): asserts n is number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error(`ledger: ${what} amount ${String(n)} is not a safe non-negative integer`);
}

/** Ids used as keys of stock records: never an `Object.prototype` name (writing `rec.__proto__` would lose the items). */
export function assertKey(key: string, what: string): void {
  if (!key || !isPlainKey(key)) throw new Error(`ledger: ${what} key ${JSON.stringify(key)} is not a valid id`);
}

/** Whether a balance covers an amount. NaN on either side, or a negative amount, answers no. */
export function covers(balance: number, amount: number): boolean {
  return amount >= 0 && balance >= amount;
}

type Treasury = { treasury: number };

/** Gold into a guild or village treasury. */
export function creditTreasury(holder: Treasury, gold: number, what: string): void {
  assertAmount(gold, what);
  assertAmount(holder.treasury, `${what} balance`);
  holder.treasury += gold;
}

/** Gold out of a guild or village treasury; it must hold it. */
export function debitTreasury(holder: Treasury, gold: number, what: string): void {
  assertAmount(gold, what);
  if (!covers(holder.treasury, gold)) throw new Error(`ledger: ${what} needs ${gold}, holds ${holder.treasury}`);
  holder.treasury -= gold;
}

/** Items into a stock record (inventory, vault, ground, project delivery): item id -> quantity. */
export function stockAdd(rec: Record<string, number>, item: string, qty: number, what: string): void {
  assertKey(item, what);
  assertAmount(qty, what);
  if (qty === 0) return;
  rec[item] = (own(rec, item) ?? 0) + qty;
}

/** Items out of a stock record; it must hold them. An emptied entry is removed. */
export function stockTake(rec: Record<string, number>, item: string, qty: number, what: string): void {
  assertAmount(qty, what);
  const have = own(rec, item) ?? 0;
  if (!covers(have, qty)) throw new Error(`ledger: ${what} needs ${qty} x ${item}, holds ${have}`);
  if (have === qty) delete rec[item];
  else rec[item] = have - qty;
}
