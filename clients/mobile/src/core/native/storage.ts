/**
 * `Storage` on expo-sqlite: one table `kv(key TEXT PRIMARY KEY, value TEXT)`. `list` is a range scan on the primary
 * key: `key >= prefix AND key < successor(prefix)`, plus the optional exclusive bounds, ordered by key, with a limit.
 * SQLite compares TEXT with BINARY collation (UTF-8 bytes); the core's keys are ASCII, where that equals JavaScript's
 * string order.
 */
import type { Storage } from '@ajwf/client-core';

/** The part of expo-sqlite's `SQLiteDatabase` this adapter uses. */
export type SqlDb = {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: (string | number | null)[]): Promise<unknown>;
  getFirstAsync<T>(source: string, ...params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(source: string, ...params: (string | number | null)[]): Promise<T[]>;
};

/** The smallest string greater than every string that starts with `prefix` (null: no upper bound). */
export function prefixEnd(prefix: string): string | null {
  for (let i = prefix.length - 1; i >= 0; i--) {
    const code = prefix.charCodeAt(i);
    if (code < 0xffff) return prefix.slice(0, i) + String.fromCharCode(code + 1);
  }
  return null;
}

export async function sqliteStorage(db: SqlDb): Promise<Storage> {
  await db.execAsync('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);');
  return {
    async get(key) {
      const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
      return row ? row.value : null;
    },
    async set(key, value) {
      await db.runAsync('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
    },
    async delete(key) {
      await db.runAsync('DELETE FROM kv WHERE key = ?', key);
    },
    async list(prefix, opts = {}) {
      const where: string[] = ['key >= ?'];
      const params: (string | number)[] = [prefix];
      const end = prefixEnd(prefix);
      if (end !== null) {
        where.push('key < ?');
        params.push(end);
      }
      if (opts.after !== undefined) {
        where.push('key > ?');
        params.push(opts.after);
      }
      if (opts.before !== undefined) {
        where.push('key < ?');
        params.push(opts.before);
      }
      let sql = `SELECT key, value FROM kv WHERE ${where.join(' AND ')} ORDER BY key ${opts.reverse ? 'DESC' : 'ASC'}`;
      if (opts.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(Math.max(0, Math.floor(opts.limit)));
      }
      return db.getAllAsync<{ key: string; value: string }>(sql, ...params);
    },
  };
}
