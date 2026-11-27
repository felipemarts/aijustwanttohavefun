import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { makeServer, T0 } from '../test-helpers';
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

  it('stores and reads back the chronicle: highlights, gazettes, stats, board, journal, trades, timeline and secrets', async () => {
    await resetDatabase(url!);
    const store = await PgStore.open(url!);
    try {
      const s = await makeServer({ store });
      const pip = await s.register('Pip');
      const brasa = await s.register('Brasa');
      expect((await s.act(pip.key, 'whisper', { to: 'Brasa', text: 'meet me at the well' })).json().ok).toBe(true);
      expect((await s.act(brasa.key, 'board_post', { text: 'Rumor: the well is haunted', tag: 'rumor' })).json().ok).toBe(true);
      s.clock.advance(4000);
      expect((await s.act(pip.key, 'board_reply', { post: s.game.state.board[0]!.id, text: 'nonsense' })).json().ok).toBe(true);
      expect((await s.act(pip.key, 'journal', { text: 'A quiet start.' })).json().ok).toBe(true);
      const a = s.game.agentByName('Pip')!;
      for (const dir of s.path(a.room, 'village.town_hall')) await s.act(pip.key, 'move', { dir });
      const p = s.game.content.projects.get('bridge')!;
      a.gold += p.cost.gold;
      const items: Record<string, number> = {};
      for (const x of p.cost.items) a.inv[x.item] = items[x.item] = x.qty;
      expect((await s.act(pip.key, 'contribute', { project: 'bridge', gold: p.cost.gold, items })).json().ok).toBe(true);
      // The day closes: its edition and stats row go to the store too.
      s.clock.t = T0 + 86_400_000;
      s.chronicle.rollover(s.clock.now());
      await s.persistence.stop();
      await s.chronicle.stop();

      const hs = await store.listHighlights(null, 10);
      expect(hs.map((h) => h.type)).toContain('project_completed');
      expect(await store.getHighlight(hs[0]!.id)).toEqual(hs[0]);
      expect(await store.listHighlights(Number(hs[0]!.id.slice(1)), 10)).toEqual(hs.slice(1));
      const ed = await store.getGazette('2026-01-01');
      expect(ed).toMatchObject({ date: '2026-01-01', final: true, headline: { k: expect.stringMatching(/^gazette\.headline\.project_completed\./) } });
      expect(await store.listGazettes(5)).toEqual([{ date: '2026-01-01', headline: ed!.headline, final: true }]);
      expect(await store.listDailyStats(5)).toEqual([expect.objectContaining({ date: '2026-01-01', population: 2, projectsToday: 1 })]);
      const board = await store.listBoard({ tag: 'rumor', limit: 5 });
      expect(board.posts).toEqual([expect.objectContaining({ tag: 'rumor', text: 'Rumor: the well is haunted', parentId: null })]);
      expect(board.replies).toEqual([expect.objectContaining({ text: 'nonsense', parentId: board.posts[0]!.id })]);
      expect(await store.journalOf(a.id, 5)).toEqual([expect.objectContaining({ text: 'A quiet start.' })]);
      expect((await store.listTimeline()).map((e) => e.type)).toEqual(['project_completed', 'project_available']);
      const counts = await store.eventCounts(T0);
      expect(counts.whisper).toBeUndefined();
      expect(counts.project_completed).toBe(1);
      // Secrets: nothing before the reveal time, the whisper exactly at it.
      const whisper = (await store.delayedEvents(10))[0]!;
      expect(await store.revealedSecrets(whisper.revealAt! - 1, null, 10)).toEqual([]);
      expect((await store.revealedSecrets(whisper.revealAt!, null, 10)).map((r) => r.id)).toEqual([whisper.id]);

      // A second server over the same database pages secrets and highlights from it.
      const second = await makeServer({ store });
      second.clock.t = whisper.revealAt!;
      const page = (await second.app.inject({ method: 'GET', url: '/api/public/secrets' })).json();
      expect(page.conversations[0].messages[0].text).toBe('meet me at the well');
      expect((await second.app.inject({ method: 'GET', url: '/api/public/gazette/2026-01-01' })).json().final).toBe(true);
      await second.persistence.stop();
      await second.chronicle.stop();
    } finally {
      await store.close();
    }
  });
  it('owners on Postgres: claim, note, key regeneration, sessions, push, reports and moderation survive a restart', async () => {
    await resetDatabase(url!);
    const store1 = await PgStore.open(url!);
    const vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.org' };
    const pushSender = { send: async () => ({ ok: true as const }) };
    let cookie: string;
    let oldKey: string;
    let newKey: string;
    let token: string;
    let pipId: string;
    try {
      const first = await makeServer({ store: store1, config: { vapid }, pushSender });
      cookie = await first.ownerLogin('Ada');
      const u = await first.registerUnclaimed('Pip');
      ({ key: oldKey, token, id: pipId } = u);
      expect((await first.owner(cookie, 'POST', `/api/owner/claim/${token}`)).json().ok).toBe(true);
      expect((await first.owner(cookie, 'PUT', `/api/owner/agents/${pipId}/note`, { note: 'Become mayor' })).json().ok).toBe(true);
      newKey = (await first.owner(cookie, 'POST', `/api/owner/agents/${pipId}/regenerate-key`)).json().api_key;
      expect((await first.get(oldKey, '/api/v1/me')).statusCode).toBe(401);
      const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/pg', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } };
      expect((await first.owner(cookie, 'POST', '/api/owner/push/subscribe', sub)).json().ok).toBe(true);
      expect((await first.app.inject({ method: 'POST', url: '/api/public/report', payload: { kind: 'agent', target: 'Pip', reason: 'spam' } })).json().ok).toBe(true);
      expect((await first.act(newKey, 'journal', { text: 'secret plans' })).json().ok).toBe(true);
      first.clock.advance(1000);
      const summary = (await first.owner(cookie, 'GET', `/api/owner/agents/${pipId}/summary`)).json();
      expect(summary.ok).toBe(true);
      await first.persistence.stop();
      await first.chronicle.stop();
      const journalId = (await store1.journalOf(pipId, 5))[0]!.id;
      expect((await first.app.inject({ method: 'DELETE', url: `/api/admin/journal/${journalId}`, headers: { 'x-admin-token': 'test-admin-token-0123456789' } })).json().ok).toBe(true);
      expect(await store1.journalOf(pipId, 5)).toEqual([]);
      expect(await store1.listReports({ limit: 5 })).toEqual([expect.objectContaining({ kind: 'agent', targetId: pipId, reason: 'spam' })]);
    } finally {
      await store1.close();
    }

    const store2 = await PgStore.open(url!);
    try {
      const second = await makeServer({ store: store2, config: { vapid }, pushSender });
      // The regenerated key survives the restart; the old one stays dead; the session and ownership too.
      expect((await second.get(oldKey!, '/api/v1/me')).statusCode).toBe(401);
      const me = (await second.get(newKey!, '/api/v1/me')).json();
      expect(me).toMatchObject({ agent: { name: 'Pip', claimed: true }, owner_note: 'Become mayor' });
      const owner = (await second.owner(cookie!, 'GET', '/api/owner/me')).json();
      expect(owner.agents.map((a: { id: string }) => a.id)).toEqual([pipId!]);
      expect(owner.push).toEqual({ enabled: true, subscriptions: 1 });
      expect((await second.app.inject({ method: 'GET', url: `/api/owner/claim/${token!}` })).statusCode).toBe(404);
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      const rows = await client.query('SELECT claim_token, owner_id, key_hash FROM agents');
      const sessions = await client.query('SELECT id FROM sessions');
      await client.end();
      expect(rows.rows[0]).toMatchObject({ claim_token: null, owner_id: owner.owner.id });
      expect(JSON.stringify([rows.rows, sessions.rows])).not.toContain(newKey!);
      expect(JSON.stringify(sessions.rows)).not.toContain(cookie!.split('=')[1]!);

      expect((await second.owner(cookie!, 'DELETE', '/api/owner/me')).json().ok).toBe(true);
      expect((await second.get(newKey!, '/api/v1/me')).statusCode).toBe(401);
      expect(await store2.getOwner(owner.owner.id)).toBeNull();
      expect(await store2.listPushSubscriptions(owner.owner.id)).toEqual([]);
      await second.persistence.stop();
      await second.chronicle.stop();
    } finally {
      await store2.close();
    }
  });
});
