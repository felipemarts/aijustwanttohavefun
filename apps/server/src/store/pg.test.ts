import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { makeServer } from '../test-helpers';
import { PgStore } from './pg';

const url = process.env.TEST_DATABASE_URL;

/** Wipes the test database. Refuses anything whose name does not say "test", so a dev database is never dropped. */
async function resetDatabase(connectionString: string): Promise<void> {
  const db = new URL(connectionString).pathname.slice(1);
  if (!/test/i.test(db)) throw new Error(`refusing to wipe database "${db}": TEST_DATABASE_URL must name a test database`);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
}

describe.skipIf(!url)('PgStore (TEST_DATABASE_URL)', () => {
  it('restarting the server preserves the state: migrate, register, act, flush, boot again', async () => {
    await resetDatabase(url!);
    const store1 = await PgStore.open(url!);
    const first = await makeServer({ store: store1 });
    const { key } = await first.register('Pip');
    const pip1 = first.game.agentByName('Pip')!;
    const item = Object.keys(pip1.inv)[0]!;
    expect((await first.act(key, 'drop', { item, qty: 1 })).json().ok).toBe(true);
    expect((await first.act(key, 'move', { dir: 'north' })).json().ok).toBe(true);
    const inv = { ...pip1.inv };
    const monsters = [...first.game.state.rooms.values()].flatMap((r) => r.monsters.map((m) => `${r.id}/${m.uid}/${m.kind}/${m.hp}`));
    const eventSeq = first.game.state.meta.eventSeq;
    await first.persistence.stop();
    await store1.close();

    const store2 = await PgStore.open(url!);
    try {
      const second = await makeServer({ store: store2 });
      const pip2 = second.game.agentByName('Pip')!;
      expect(pip2.room).toBe('village.tavern');
      expect(pip2.inv).toEqual(inv);
      expect(second.game.state.rooms.get('village.square')!.ground[item]).toBe(1);
      expect([...second.game.state.rooms.values()].flatMap((r) => r.monsters.map((m) => `${r.id}/${m.uid}/${m.kind}/${m.hp}`))).toEqual(monsters);
      expect(second.game.state.meta.eventSeq).toBe(eventSeq);
      // The API key survives as its hash: the same key authenticates against the new process.
      expect((await second.get(key, '/api/v1/me')).json().agent.name).toBe('Pip');

      const client = new pg.Client({ connectionString: url });
      await client.connect();
      const rows = await client.query('SELECT key_hash, claim_token FROM agents');
      const events = await client.query('SELECT count(*)::int AS n FROM events');
      await client.end();
      expect(rows.rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows.rows)).not.toContain(key);
      expect(events.rows[0].n).toBe(eventSeq);

      // New ids continue after the stored ones.
      await second.register('Brasa');
      expect(second.game.agentByName('Brasa')!.id).not.toBe(pip2.id);
      await second.persistence.stop();
    } finally {
      await store2.close();
    }
  });
});
