/** The SQLite adapter against a real SQLite (Node's built-in), shaped like expo-sqlite's async API. */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { prefixEnd, sqliteStorage, type SqlDb } from './storage';

function nodeSqlDb(): SqlDb {
  const db = new DatabaseSync(':memory:');
  return {
    async execAsync(sql) {
      db.exec(sql);
    },
    async runAsync(sql, ...params) {
      return db.prepare(sql).run(...params);
    },
    async getFirstAsync<T>(sql: string, ...params: (string | number | null)[]) {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async getAllAsync<T>(sql: string, ...params: (string | number | null)[]) {
      return db.prepare(sql).all(...params) as T[];
    },
  };
}

describe('sqliteStorage', () => {
  it('gets, upserts and deletes', async () => {
    const s = await sqliteStorage(nodeSqlDb());
    expect(await s.get('a')).toBeNull();
    await s.set('a', '1');
    await s.set('a', '2');
    expect(await s.get('a')).toBe('2');
    await s.delete('a');
    expect(await s.get('a')).toBeNull();
  });

  it('lists one prefix in key order, with bounds, reverse and limit', async () => {
    const s = await sqliteStorage(nodeSqlDb());
    for (const k of ['log/c1/0003', 'log/c1/0001', 'log/c1/0002', 'log/c10/0001', 'log/c2/0001', 'log/c1', 'loh', 'chat/c1/0001']) await s.set(k, k);
    const keys = async (prefix: string, o?: Parameters<typeof s.list>[1]) => (await s.list(prefix, o)).map((e) => e.key);
    expect(await keys('log/c1/')).toEqual(['log/c1/0001', 'log/c1/0002', 'log/c1/0003']);
    expect(await keys('log/c1/', { reverse: true, limit: 2 })).toEqual(['log/c1/0003', 'log/c1/0002']);
    expect(await keys('log/c1/', { before: 'log/c1/0003', reverse: true })).toEqual(['log/c1/0002', 'log/c1/0001']);
    expect(await keys('log/c1/', { after: 'log/c1/0001' })).toEqual(['log/c1/0002', 'log/c1/0003']);
    expect(await keys('log/c1/', { limit: 0 })).toEqual([]);
    expect(await keys('log/')).toEqual(['log/c1', 'log/c1/0001', 'log/c1/0002', 'log/c1/0003', 'log/c10/0001', 'log/c2/0001']);
    expect((await keys('')).length).toBe(8);
  });

  it('treats prefixes literally (no LIKE wildcards)', async () => {
    const s = await sqliteStorage(nodeSqlDb());
    await s.set('a%b', '1');
    await s.set('axb', '2');
    await s.set('a_b', '3');
    expect((await s.list('a%')).map((e) => e.key)).toEqual(['a%b']);
    expect((await s.list('a_')).map((e) => e.key)).toEqual(['a_b']);
  });

  it('computes the end of a prefix range', () => {
    expect(prefixEnd('log/')).toBe('log0');
    expect(prefixEnd('')).toBeNull();
    expect(prefixEnd('a￿')).toBe('b');
  });
});
