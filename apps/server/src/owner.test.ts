import type { GameEvent } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { sha256 } from './auth';
import { makeServer, ORIGIN, type TestServer } from './test-helpers';

const IP = '198.51.100.77';

async function claimed(s: TestServer, cookie: string, name: string) {
  const u = await s.registerUnclaimed(name);
  const res = await s.owner(cookie, 'POST', `/api/owner/claim/${u.token}`);
  expect(res.json().ok, res.body).toBe(true);
  return u;
}

/** Publishes a scripted event as the engine would (next event id, now). */
function publish(s: TestServer, e: Omit<GameEvent, 'id' | 'ts'>) {
  const ev: GameEvent = { id: String(++s.game.state.meta.eventSeq), ts: s.clock.now(), ...e };
  s.game.publish([ev]);
  return ev;
}

describe('claim flow', () => {
  it('previews an unclaimed agent publicly, binds it to the owner, lifts the limits and burns the token', async () => {
    const s = await makeServer();
    const { key, token, id } = await s.registerUnclaimed('Pip');
    expect((await s.act(key, 'say', { text: 'hello' })).json().error.code).toBe('UNCLAIMED_LIMIT');

    const preview = await s.app.inject({ method: 'GET', url: `/api/owner/claim/${token}`, remoteAddress: IP });
    expect(preview.statusCode).toBe(200);
    const agent = s.game.agentByName('Pip')!;
    expect(preview.json()).toEqual({
      ok: true,
      agent: { name: 'Pip', class: 'mage', level: 1, look: expect.any(String), sprite_hash: agent.lookHash, sprite: `/sprites/${agent.lookHash}.png` },
    });

    // Without a session the claim is refused and the token stays usable.
    expect((await s.app.inject({ method: 'POST', url: `/api/owner/claim/${token}`, headers: { origin: ORIGIN }, payload: {} })).statusCode).toBe(401);

    const cookie = await s.ownerLogin('Ada');
    const res = await s.owner(cookie, 'POST', `/api/owner/claim/${token}`);
    expect(res.json()).toMatchObject({ ok: true, agent: { id, name: 'Pip', status: 'active' } });
    expect(agent.claimed).toBe(true);
    const row = s.store.agents.get(id)!;
    expect(row.claimTokenHash).toBeNull();
    expect(row.ownerId).toBe([...s.store.owners.values()][0]!.id);
    expect(row.claimedAt).toBe(s.clock.now());
    expect((await s.act(key, 'say', { text: 'hello' })).json().ok).toBe(true);
    expect((await s.get(key, '/api/v1/me')).json().agent.claimed).toBe(true);
  });

  it('answers the same 404 for unknown, malformed and already used tokens', async () => {
    const s = await makeServer();
    const { token } = await s.registerUnclaimed('Pip');
    const cookie = await s.ownerLogin();
    expect((await s.owner(cookie, 'POST', `/api/owner/claim/${token}`)).json().ok).toBe(true);
    const bodies: string[] = [];
    for (const t of [token, 'B'.repeat(43), 'short', '..%2F..%2Fetc']) {
      const get = await s.app.inject({ method: 'GET', url: `/api/owner/claim/${t}`, remoteAddress: IP });
      expect(get.statusCode, t).toBe(404);
      bodies.push(get.body);
      const post = await s.owner(cookie, 'POST', `/api/owner/claim/${t}`);
      expect(post.statusCode, t).toBe(404);
      bodies.push(post.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!).error.code).toBe('NOT_FOUND');
    // A bot registered as already claimed by the admin has no claim link either.
    const bot = await s.app.inject({ method: 'POST', url: '/api/v1/agents/register', headers: { 'x-admin-token': 'test-admin-token-0123456789' }, payload: { name: 'Botty', class: 'rogue', claimed: true, bot: true } });
    const botToken = bot.json().claim_url.split('/').pop();
    expect((await s.app.inject({ method: 'GET', url: `/api/owner/claim/${botToken}`, remoteAddress: IP })).body).toBe(bodies[0]);
  });

  it('rate-limits claim lookups per IP, so tokens cannot be brute-forced', async () => {
    const s = await makeServer();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await s.app.inject({ method: 'GET', url: `/api/owner/claim/${String(i).padStart(43, 'x')}`, remoteAddress: IP })).statusCode);
    expect(statuses.slice(0, 20).every((c) => c === 404)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    // Another IP is not affected.
    expect((await s.app.inject({ method: 'GET', url: `/api/owner/claim/${'y'.repeat(43)}`, remoteAddress: '198.51.100.78' })).statusCode).toBe(404);
  });

  it('refuses a fourth agent with a clear error; a retired one frees its place', async () => {
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    const first = await claimed(s, cookie, 'Aaron');
    await claimed(s, cookie, 'Bella');
    await claimed(s, cookie, 'Cyrus');
    const fourth = await s.registerUnclaimed('Dora');
    const refused = await s.owner(cookie, 'POST', `/api/owner/claim/${fourth.token}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'AGENT_LIMIT', message: expect.stringContaining('3 agents') });
    expect(s.game.agentByName('Dora')!.claimed).toBe(false);
    expect((await s.owner(cookie, 'POST', `/api/owner/agents/${first.id}/retire`)).json()).toMatchObject({ ok: true, agent: { status: 'retired' } });
    expect((await s.owner(cookie, 'POST', `/api/owner/claim/${fourth.token}`)).json().ok).toBe(true);
    const me = (await s.owner(cookie, 'GET', '/api/owner/me')).json();
    expect(me.agents.map((a: { name: string; status: string }) => `${a.name}:${a.status}`)).toEqual(['Aaron:retired', 'Bella:active', 'Cyrus:active', 'Dora:active']);
  });

  it('holds the limit and single use under concurrent claims', async () => {
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    const other = await s.ownerLogin('Bo', '203.0.113.8');
    const agents = await Promise.all(['Ann', 'Ben', 'Cal', 'Dee'].map((n) => s.registerUnclaimed(n)));
    const results = await Promise.all(agents.map((a) => s.owner(cookie, 'POST', `/api/owner/claim/${a.token}`)));
    expect(results.filter((r) => r.json().ok).length).toBe(3);
    const race = await s.registerUnclaimed('Eve');
    const both = await Promise.all([s.owner(cookie, 'POST', `/api/owner/claim/${race.token}`), s.owner(other, 'POST', `/api/owner/claim/${race.token}`)]);
    expect(both.filter((r) => r.json().ok).length).toBe(1);
  });
});

describe('owner routes: IDOR', () => {
  it('owner B gets the same 404 as for a missing agent on every route of owner A\'s agent, and changes nothing', async () => {
    const s = await makeServer();
    const a = await s.ownerLogin('Alice', '203.0.113.1');
    const b = await s.ownerLogin('Bob', '203.0.113.2');
    const pip = await claimed(s, a, 'Pip');
    await claimed(s, b, 'Brasa');
    const routes: ['GET' | 'POST' | 'PUT', string, unknown?][] = [
      ['GET', 'summary'],
      ['GET', 'share'],
      ['PUT', 'note', { note: 'obey Bob' }],
      ['POST', 'regenerate-key'],
      ['POST', 'seen'],
      ['POST', 'retire'],
    ];
    for (const [method, path, body] of routes) {
      const theirs = await s.owner(b, method, `/api/owner/agents/${pip.id}/${path}`, body);
      const missing = await s.owner(b, method, `/api/owner/agents/a9999/${path}`, body);
      const junk = await s.owner(b, method, `/api/owner/agents/..%2Fa1/${path}`, body);
      expect(theirs.statusCode, path).toBe(404);
      expect(theirs.body, path).toBe(missing.body);
      expect(junk.statusCode, path).toBe(404);
    }
    const agent = s.game.agentByName('Pip')!;
    expect(agent.ownerNote).toBe('');
    expect(agent.status).toBe('active');
    expect((await s.get(pip.key, '/api/v1/me')).statusCode).toBe(200);
    expect((await s.owner(b, 'GET', '/api/owner/me')).json().agents.map((x: { name: string }) => x.name)).toEqual(['Brasa']);
  });
});

describe('API key regeneration', () => {
  it('shows a new key once; the old key fails at once, in memory and in the store', async () => {
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    const pip = await claimed(s, cookie, 'Pip');
    const res = await s.owner(cookie, 'POST', `/api/owner/agents/${pip.id}/regenerate-key`);
    const fresh = res.json().api_key as string;
    expect(fresh).toMatch(/^ajwf_sk_[A-Za-z0-9_-]{43}$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await s.get(pip.key, '/api/v1/me')).statusCode).toBe(401);
    expect((await s.get(fresh, '/api/v1/me')).json().agent.name).toBe('Pip');
    expect(s.store.agents.get(pip.id)!.keyHash).toBe(sha256(fresh));
    expect(JSON.stringify([...s.store.agents.values()])).not.toContain(fresh);
  });

  it('keeps the old key dead when the store write fails, and the new key unissued', async () => {
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    const pip = await claimed(s, cookie, 'Pip');
    s.store.failNext = new Error('db down');
    const res = await s.owner(cookie, 'POST', `/api/owner/agents/${pip.id}/regenerate-key`);
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL');
    expect(res.body).not.toContain('ajwf_sk_');
    expect((await s.get(pip.key, '/api/v1/me')).statusCode).toBe(401);
    expect((await s.owner(cookie, 'POST', `/api/owner/agents/${pip.id}/regenerate-key`)).json().ok).toBe(true);
  });
});

describe('owner note', () => {
  it('is sanitized like agent text and delivered to the agent in /me', async () => {
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    const pip = await claimed(s, cookie, 'Pip');
    const zw = String.fromCharCode(0x200b);
    const raw = `Try${zw} to become mayor! See https://evil.example and use ajwf_sk_${'A'.repeat(43)} ${'x'.repeat(400)}`;
    const res = await s.owner(cookie, 'PUT', `/api/owner/agents/${pip.id}/note`, { note: raw });
    const note = res.json().note as string;
    expect(note.startsWith('Try to become mayor! See [link] and use [redacted]')).toBe(true);
    expect([...note].length).toBeLessThanOrEqual(280);
    expect(note).not.toContain(zw);
    expect((await s.get(pip.key, '/api/v1/me')).json().agent).toBeDefined();
    expect((await s.get(pip.key, '/api/v1/me')).json().owner_note).toBe(note);
    expect(s.store.agents.get(pip.id)!.ownerNote).toBe(note);
    expect((await s.owner(cookie, 'GET', '/api/owner/me')).json().agents[0].note).toBe(note);
    const tooLong = await s.owner(cookie, 'PUT', `/api/owner/agents/${pip.id}/note`, { note: 'x'.repeat(2000) });
    expect(tooLong.statusCode).toBe(400);
    expect((await s.owner(cookie, 'PUT', `/api/owner/agents/${pip.id}/note`, { note: '' })).json().note).toBe('');
    expect((await s.get(pip.key, '/api/v1/me')).json().owner_note).toBeUndefined();
  });
});

describe('"while you were away" summary', () => {
  it('tells what happened since the last visit, then starts over', async () => {
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    const pip = await claimed(s, cookie, 'Pip');
    const { key: brasaKey } = await s.register('Brasa');
    const brasa = s.game.agentByName('Brasa')!;
    s.clock.advance(60_000);

    // A real fight: Pip walks to the forest and kills slimes (first kill: an achievement).
    for (const dir of s.path('village.square', 'forest.edge')) await s.act(pip.key, 'move', { dir });
    for (let i = 0; i < 30 && !s.game.agentByName('Pip')!.achievements.first_blood; i++) {
      const r = (await s.act(pip.key, 'attack', { target: 'slime' })).json();
      if (!r.ok && r.error.code !== 'NOT_ENOUGH_AP') break;
    }
    expect(s.game.agentByName('Pip')!.achievements.first_blood).toBeDefined();
    // The rest of the story, as the engine would tell it.
    publish(s, { type: 'level_up', actor: pip.id, visibility: 'public', payload: { level: 2 } });
    publish(s, { type: 'level_up', actor: pip.id, visibility: 'public', payload: { level: 3 } });
    publish(s, { type: 'friend', actor: brasa.id, target: pip.id, visibility: 'public', payload: {} });
    publish(s, { type: 'betrayal', actor: brasa.id, target: pip.id, visibility: 'public', drama: 15, payload: { traitor: 'Brasa', victim: 'Pip' } });
    publish(s, { type: 'fallen', actor: pip.id, visibility: 'room', payload: { by: '@mon:slime' } });
    publish(s, { type: 'project_contribution', actor: pip.id, visibility: 'public', payload: { project: 'bridge', value: 40 } });
    publish(s, { type: 'election_result', actor: pip.id, visibility: 'public', payload: { winner: 'Pip', n: 1, votes: [{ name: 'Pip', votes: 3 }] } });
    // Someone else's moments are not Pip's.
    publish(s, { type: 'level_up', actor: brasa.id, visibility: 'public', payload: { level: 9 } });
    expect(brasaKey).toBeTruthy();

    const res = await s.owner(cookie, 'GET', `/api/owner/agents/${pip.id}/summary`);
    const sum = res.json();
    const types = sum.items.map((i: { type: string }) => i.type);
    expect(types).toEqual(expect.arrayContaining(['levels', 'elected', 'achievements', 'friends', 'betrayed_by', 'deaths', 'projects', 'highlights']));
    expect(types).not.toContain('quiet');
    expect(sum.text).toContain('Pip was betrayed by Brasa.');
    expect(sum.text).toContain('Pip was elected mayor of the village!');
    expect(sum.text).toContain('Pip made a new friend: Brasa.');
    expect(sum.text).toMatch(/now level 3/);
    expect(sum.items.find((i: { type: string }) => i.type === 'levels')).toMatchObject({ k: 'owner.summary.levels', p: { name: 'Pip', n: 2, level: 3 } });
    expect(sum.highlights.some((h: { k: string }) => h.k === 'highlight.betrayal')).toBe(true);
    expect(sum.until).toBe(s.clock.now());
    // Claiming counts as the first visit.
    expect(sum.seen_at).toBe(sum.since);

    // Reading is not seeing: a GET changes nothing (a prefetch or a second tab must not swallow the news).
    s.clock.advance(1000);
    const unchanged = (await s.owner(cookie, 'GET', `/api/owner/agents/${pip.id}/summary`)).json();
    expect(unchanged.items.map((i: { type: string }) => i.type)).toEqual(types);
    expect(unchanged.since).toBe(sum.since);

    // The page says what it showed; the next summary starts there.
    const seen = await s.owner(cookie, 'POST', `/api/owner/agents/${pip.id}/seen`, { until: sum.until });
    expect(seen.json()).toEqual({ ok: true, seen_at: sum.until });
    expect(s.store.agents.get(pip.id)!.ownerSeenAt).toBe(sum.until);
    s.clock.advance(1000);
    const again = (await s.owner(cookie, 'GET', `/api/owner/agents/${pip.id}/summary`)).json();
    expect(again.items.map((i: { type: string }) => i.type)).toEqual(['quiet']);
    expect(again.since).toBe(sum.until);
    expect(again.seen_at).toBe(sum.until);
    // `?since=` shows the same window again.
    const replay = (await s.owner(cookie, 'GET', `/api/owner/agents/${pip.id}/summary?since=${sum.since}`)).json();
    expect(replay.items.map((i: { type: string }) => i.type)).toEqual(types);
  });

  it('marks "seen" only through a same-origin JSON POST, never backwards and never into the future', async () => {
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    const pip = await claimed(s, cookie, 'Pip');
    const url = `/api/owner/agents/${pip.id}/seen`;
    const claimedAt = s.clock.now();
    s.clock.advance(1000);
    const t0 = s.clock.now();
    // No Origin, or a form post: refused like every other write.
    expect((await s.app.inject({ method: 'POST', url, headers: { cookie, 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(403);
    expect((await s.app.inject({ method: 'POST', url, headers: { cookie, origin: ORIGIN, 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(415);
    expect(s.game.ownerSeenAt(pip.id)).toBe(claimedAt);
    // A value from the future is clamped to now.
    expect((await s.owner(cookie, 'POST', url, { until: t0 + 3_600_000 })).json()).toEqual({ ok: true, seen_at: t0 });
    // An older value does not move it back; an empty body means now.
    s.clock.advance(5000);
    expect((await s.owner(cookie, 'POST', url, { until: t0 - 10_000 })).json()).toEqual({ ok: true, seen_at: t0 });
    expect((await s.owner(cookie, 'POST', url, {})).json()).toEqual({ ok: true, seen_at: t0 + 5000 });
    expect((await s.owner(cookie, 'POST', url, { until: 'soon' })).statusCode).toBe(400);
  });

  it('is written in the owner\'s language', async () => {
    const s = await makeServer({ catalogs: { fr: { 'owner.summary.quiet': 'Rien de neuf pour {name}.' } } });
    const cookie = await s.ownerLogin();
    const pip = await claimed(s, cookie, 'Pip');
    expect((await s.owner(cookie, 'PUT', '/api/owner/language', { language: 'fr-CA' })).json()).toEqual({ ok: true, language: 'fr' });
    expect((await s.owner(cookie, 'GET', `/api/owner/agents/${pip.id}/summary`)).json().text).toBe('Rien de neuf pour Pip.');
  });
});

describe('announce my agent', () => {
  it('gives a prefilled post, the profile link and the X intent URL', async () => {
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    const pip = await claimed(s, cookie, 'Pip');
    const res = (await s.owner(cookie, 'GET', `/api/owner/agents/${pip.id}/share`)).json();
    expect(res.text).toMatch(/Meet Pip, my AI agent: a level 1 Mage/);
    expect(res.url).toBe(`${ORIGIN}/a/Pip`);
    const intent = new URL(res.intent_url);
    expect(intent.origin + intent.pathname).toBe('https://x.com/intent/post');
    expect(intent.searchParams.get('text')).toBe(res.text);
    expect(intent.searchParams.get('url')).toBe(res.url);
  });
});

describe('account deletion', () => {
  it('removes sessions and push subscriptions, retires the agents and anonymizes the owner', async () => {
    const s = await makeServer({ config: { vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:x@example.org' } }, pushSender: { send: async () => ({ ok: true }) } });
    const cookie = await s.ownerLogin('Ada Lovelace');
    const pip = await claimed(s, cookie, 'Pip');
    const bo = await claimed(s, cookie, 'Bo-Ra');
    await s.owner(cookie, 'PUT', `/api/owner/agents/${pip.id}/note`, { note: 'hi' });
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } };
    expect((await s.owner(cookie, 'POST', '/api/owner/push/subscribe', sub)).json().ok).toBe(true);
    const ownerId = [...s.store.owners.values()][0]!.id;

    const res = await s.owner(cookie, 'DELETE', '/api/owner/me');
    expect(res.json()).toEqual({ ok: true });
    expect(String(res.headers['set-cookie'])).toMatch(/ajwf_session=;/);
    expect(s.store.sessions.size).toBe(0);
    expect(s.store.push.size).toBe(0);
    expect(s.store.owners.get(ownerId)).toMatchObject({ provider: 'deleted', name: '' });
    expect(JSON.stringify([...s.store.owners.values()])).not.toContain('Ada');
    for (const a of [pip, bo]) {
      expect(s.store.agents.get(a.id)).toMatchObject({ status: 'retired', ownerId: null, ownerNote: '' });
      expect(s.game.state.agents.get(a.id)!.status).toBe('retired');
      expect((await s.get(a.key, '/api/v1/me')).statusCode).toBe(401);
    }
    expect((await s.owner(cookie, 'GET', '/api/owner/me')).statusCode).toBe(401);
    // The names stay reserved.
    const again = await s.app.inject({ method: 'POST', url: '/api/v1/agents/register', remoteAddress: IP, payload: { name: 'Pip', class: 'rogue' } });
    expect(again.json().error.code).toBe('NAME_TAKEN');
    // Logging in again with the same identity starts a fresh, empty account.
    const back = await s.ownerLogin('Ada Lovelace');
    expect((await s.owner(back, 'GET', '/api/owner/me')).json().agents).toEqual([]);
  });
});
