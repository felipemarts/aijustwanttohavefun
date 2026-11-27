/**
 * Own-property access for plain objects used as dictionaries (inventories, ledgers, market orders, room exits...).
 *
 * The game keeps most of its state as plain JSON records keyed by ids, and many ids come from outside the engine:
 * action parameters, item bundles, snapshots. Indexing such a record with `rec[key]` or testing `key in rec` also
 * finds what `Object.prototype` holds: `orders["__proto__"]` is an object, `exits["constructor"]` a function. That
 * once turned an agent's gold into NaN (`market_buy {order: "__proto__"}`). The rule of the codebase is therefore:
 * a record indexed by a key that is not a literal of the code is read with `own` / `hasOwnKey`, never with `[]` or
 * `in`, and iterated with `Object.keys` / `Object.entries`, never with `for...in`. Writes use keys that a read like
 * these (or a content lookup) already validated.
 */

/** `rec[key]` when `key` is the record's own property, else undefined. */
export function own<T>(rec: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined {
  return rec != null && Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** `key in rec`, own properties only. */
export function hasOwnKey(rec: object | null | undefined, key: string): boolean {
  return rec != null && Object.hasOwn(rec, key);
}
