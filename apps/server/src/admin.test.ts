import { checkInvariants } from '@ajwf/engine';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from './store/memory';
import { ADMIN, makeServer, type TestServer } from './test-helpers';

const sound = (s: TestServer) => expect(checkInvariants(s.game.state, s.game.now())).toEqual([]);

const admin = (s: TestServer, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, token: string | null = ADMIN) =>
  s.app.inject({ method, url, headers: token === null ? {} : { 'x-admin-token': token }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

describe('admin routes', () => {
  it('need the admin token (constant-time check) and answer 401 otherwise', async () => {
    const s = await makeServer();
    await s.register('Pip');
    const routes: ['GET' | 'POST' | 'DELETE', string, unknown?][] = [
      ['POST', '/api/admin/agents/Pip/mute', { minutes: 5 }],
      ['POST', '/api/admin/agents/Pip/ban', {}],
      ['POST', '/api/admin/agents/Pip/unban', {}],
      ['DELETE', '/api/admin/board/b1'],
      ['DELETE', '/api/admin/journal/j1'],
      ['POST', '/api/admin/blocked-words', { words: ['zorblax'] }],
      ['GET', '/api/admin/reports'],
      ['POST', '/api/admin/reports/r1/resolve', {}],
    ];
    for (const [method, url, body] of routes) {
      for (const token of [null, 'wrong', `${ADMIN}x`]) {
        const res = await admin(s, method, url, body, token);
        expect(res.statusCode, `${url} ${token}`).toBe(401);
      }
    }
    expect(s.game.agentByName('Pip')!.status).toBe('active');
    const off = await makeServer({ config: { adminToken: undefined } });
    expect((await admin(off, 'GET', '/api/admin/reports', undefined, 'anything')).statusCode).toBe(401);
  });

  it('mute: a muted agent cannot say until the time is up', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    expect((await admin(s, 'POST', '/api/admin/agents/pip/mute', { minutes: 10 })).json()).toMatchObject({ ok: true, agent: { name: 'Pip' } });
    expect((await s.act(key, 'say', { text: 'hello' })).json().error.code).toBe('MUTED');
    s.clock.advance(11 * 60_000);
    expect((await s.act(key, 'say', { text: 'hello' })).json().ok).toBe(true);
    expect((await admin(s, 'POST', '/api/admin/agents/Nobody/mute', { minutes: 1 })).statusCode).toBe(404);
    expect((await admin(s, 'POST', '/api/admin/agents/Pip/mute', { minutes: 99_999 })).statusCode).toBe(400);
  });

  it('ban: the key stops working and the agent leaves the world; unban brings it back', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    expect((await admin(s, 'POST', '/api/admin/agents/Pip/ban', {})).json()).toMatchObject({ ok: true, agent: { status: 'banned' } });
    expect((await s.get(key, '/api/v1/look')).statusCode).toBe(401);
    expect(s.store.agents.get(s.game.anyAgentByName('Pip')!.id)!.status).toBe('banned');
    expect(s.game.state.roomAgents.get('village.square')!.has(s.game.anyAgentByName('Pip')!.id)).toBe(false);
    sound(s);
    s.game.state.dirty.clear();
    expect((await admin(s, 'POST', '/api/admin/agents/Pip/unban', {})).json()).toMatchObject({ ok: true, agent: { status: 'active' } });
    const pip = s.game.anyAgentByName('Pip')!;
    expect(s.game.state.roomAgents.get('village.square')!.has(pip.id)).toBe(true);
    expect(s.game.state.dirty.has(`agent:${pip.id}`)).toBe(true);
    sound(s);
    expect((await s.get(key, '/api/v1/look')).statusCode).toBe(200);
    expect(s.store.agents.get(pip.id)!.status).toBe('active');
    // Unbanning an active agent changes nothing.
    expect((await admin(s, 'POST', '/api/admin/agents/Pip/unban', {})).json()).toMatchObject({ ok: true, agent: { status: 'active' } });
    sound(s);
  });

  it('unban never brings back a retired agent', async () => {
    const s = await makeServer();
    await s.register('Pip');
    const pip = s.game.anyAgentByName('Pip')!;
    await s.game.deactivate(pip.id, 'retired');
    expect((await admin(s, 'POST', '/api/admin/agents/Pip/unban', {})).json()).toMatchObject({ ok: true, agent: { status: 'retired' } });
    expect(s.store.agents.get(pip.id)!.status).toBe('retired');
    expect(s.game.state.roomAgents.get(pip.room)!.has(pip.id)).toBe(false);
    sound(s);
  });

  it('an unban that reached the store but not the last snapshot holds after a restart', async () => {
    const store = new MemoryStore();
    const first = await makeServer({ store });
    const { key } = await first.register('Pip');
    await admin(first, 'POST', '/api/admin/agents/Pip/ban', {});
    await first.persistence.snapshot();
    await admin(first, 'POST', '/api/admin/agents/Pip/unban', {});
    // Crash before the next snapshot: the row says active, the snapshot still says banned.
    const second = await makeServer({ store });
    expect(second.game.anyAgentByName('Pip')!.status).toBe('active');
    sound(second);
    expect((await second.get(key, '/api/v1/look')).statusCode).toBe(200);
  });

  it('deleting a board post removes it from /api/public/board, from memory and from the store', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    const { key: k2 } = await s.register('Brasa');
    const post = (await s.act(key, 'board_post', { text: 'Selling a cursed sword, cheap!', tag: 'trade' })).json();
    expect(post.ok).toBe(true);
    const keep = (await s.act(k2, 'board_post', { text: 'Looking for a cleric.', tag: 'lfg' })).json();
    expect(keep.ok).toBe(true);
    const board = async () => (await s.app.inject({ method: 'GET', url: '/api/public/board' })).json().posts as { id: string; text: string; replies: { text: string }[] }[];
    const before = await board();
    const id = before.find((p) => p.text.startsWith('Selling'))!.id;
    await s.chronicle.flush();
    expect([...s.store.posts.values()].some((p) => p.id === id)).toBe(true);

    s.game.state.dirty.clear();
    expect((await admin(s, 'DELETE', `/api/admin/board/${id}`)).json()).toEqual({ ok: true });
    expect(s.game.state.dirty.has(`post:${id}`)).toBe(true);
    sound(s);
    const after = await board();
    expect(after.map((p) => p.text)).toEqual(['Looking for a cleric.']);
    expect(s.game.state.board.some((p) => p.id === id)).toBe(false);
    expect([...s.store.posts.values()].some((p) => p.id === id)).toBe(false);
    expect((await s.act(k2, 'board_read', {})).json().data.posts.map((p: { id: string }) => p.id)).not.toContain(id);
    expect((await admin(s, 'DELETE', `/api/admin/board/${id}`)).statusCode).toBe(404);

    // A single reply.
    await s.act(key, 'board_reply', { post: keep.data?.post ?? after[0]!.id, text: 'I can heal, DM me.' });
    const withReply = await board();
    expect(withReply[0]!.replies.map((r) => r.text)).toEqual(['I can heal, DM me.']);
    expect((await admin(s, 'DELETE', `/api/admin/board/${withReply[0]!.id}.0`)).json().ok).toBe(true);
    expect((await admin(s, 'DELETE', `/api/admin/board/${withReply[0]!.id}.0`)).statusCode).toBe(404);
    sound(s);
    const noReply = await board();
    expect(noReply[0]!.replies).toEqual([]);
    expect(noReply[0]!.text).toBe('Looking for a cleric.');
  });

  it('deleting a journal entry removes it from the profile and the store, before or after the flush', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    await s.act(key, 'journal', { text: 'Today I met a very rude goblin.' });
    s.clock.advance(1000);
    await s.act(key, 'journal', { text: 'A good day at the forge.' });
    const profile = async () => (await s.app.inject({ method: 'GET', url: '/api/public/agents/Pip' })).json().agent.journal as { text: string }[];
    expect((await profile()).length).toBe(2);
    const rude = [...s.chronicle['pending'].journal].find((j) => j.text.includes('rude'))!.id;
    // Not flushed yet: removed from the pending writes too, so it never reaches the store.
    expect((await admin(s, 'DELETE', `/api/admin/journal/${rude}`)).json()).toEqual({ ok: true });
    await s.chronicle.flush();
    expect((await profile()).map((j) => j.text)).toEqual(['A good day at the forge.']);
    expect([...s.store.journal.values()].map((j) => j.text)).toEqual(['A good day at the forge.']);
    const good = [...s.store.journal.values()][0]!.id;
    expect((await admin(s, 'DELETE', `/api/admin/journal/${good}`)).json().ok).toBe(true);
    expect(await profile()).toEqual([]);
    expect(s.store.journal.size).toBe(0);
  });

  it('extends the word filter at runtime (names and messages) and keeps the words', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    expect((await admin(s, 'POST', '/api/admin/blocked-words', { words: ['Zorblax', 'zorblax'] })).json()).toEqual({ ok: true, added: 1 });
    expect([...s.store.blockedWords.keys()]).toEqual(['zorblax']);
    const reg = await s.app.inject({ method: 'POST', url: '/api/v1/agents/register', headers: { 'x-admin-token': ADMIN }, payload: { name: 'Zorblax', class: 'mage' } });
    expect(reg.json().error.code).toBe('NAME_INVALID');
    const { key: listener } = await s.register('Brasa');
    await s.get(listener, '/api/v1/look');
    await s.act(key, 'say', { text: 'you zorblax!' });
    const heard = (await s.get(listener, '/api/v1/look')).json().messages as { untrusted_text?: string }[];
    expect(heard.find((m) => m.untrusted_text)!.untrusted_text).toBe('you *******!');
    expect((await admin(s, 'POST', '/api/admin/blocked-words', { words: [] })).statusCode).toBe(400);
  });

  it('writes an audit log line for every admin action, without secrets', async () => {
    const lines: string[] = [];
    const s = await makeServer({ logStream: { write: (l: string) => void lines.push(l) } });
    await s.register('Pip');
    await admin(s, 'POST', '/api/admin/agents/Pip/mute', { minutes: 3 });
    await admin(s, 'POST', '/api/admin/agents/Pip/ban', {});
    const audit = lines.map((l) => JSON.parse(l) as { audit?: { action: string; name?: string } }).filter((l) => l.audit);
    expect(audit.map((l) => l.audit!.action)).toEqual(['mute', 'ban']);
    expect(audit[0]!.audit).toMatchObject({ name: 'Pip', minutes: 3 });
    expect(lines.join('\n')).not.toContain(ADMIN);
  });
});

describe('public reports', () => {
  it('stores a report with a fixed reason and cleaned details; admins list it without the reporter', async () => {
    const s = await makeServer();
    await s.register('Pip');
    const report = (payload: unknown, ip = '198.51.100.60') => s.app.inject({ method: 'POST', url: '/api/public/report', remoteAddress: ip, payload: payload as Record<string, unknown> });
    const ok = await report({ kind: 'agent', target: 'pip', reason: 'harassment', details: `keeps insulting people, see https://x.example${String.fromCharCode(0x202e)}` });
    expect(ok.json()).toEqual({ ok: true });
    expect((await report({ kind: 'agent', target: 'pip', reason: 'i do not like them' })).statusCode).toBe(400);
    expect((await report({ kind: 'database', target: 'x', reason: 'spam' })).statusCode).toBe(400);
    const list = (await admin(s, 'GET', '/api/admin/reports')).json().reports;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'agent', targetId: s.game.agentByName('Pip')!.id, reason: 'harassment', details: 'keeps insulting people, see [link]', resolved: false });
    expect(list[0].reporterHash).toBeUndefined();
    expect(JSON.stringify([...s.store.reports.values()])).not.toContain('198.51.100.60');
    expect((await admin(s, 'POST', `/api/admin/reports/${list[0].id}/resolve`, {})).json()).toEqual({ ok: true });
    expect((await admin(s, 'GET', '/api/admin/reports?resolved=0')).json().reports).toEqual([]);
  });

  it('is rate-limited per IP', async () => {
    const s = await makeServer();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await s.app.inject({ method: 'POST', url: '/api/public/report', remoteAddress: '198.51.100.61', payload: { kind: 'board_post', target: `b${i}`, reason: 'spam' } })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});
