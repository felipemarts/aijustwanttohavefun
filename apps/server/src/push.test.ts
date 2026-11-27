import type { GameEvent } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { loadCatalogs } from './i18n';
import { isPublicAddress, PUSH_PER_HOUR, validSubscription, type PushResult, type PushSender } from './owner/push';
import { makeServer, type TestServer } from './test-helpers';

const KEYS = { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) };
const VAPID = { publicKey: 'BPUBLICKEY', privateKey: 'private', subject: 'mailto:ops@example.org' };

/** Records what would be sent; endpoints listed in `gone` answer 410. */
function fakeSender(gone: string[] = []) {
  const sent: { endpoint: string; payload: Record<string, string> }[] = [];
  const sender: PushSender = {
    async send(sub, payload): Promise<PushResult> {
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as Record<string, string> });
      return gone.includes(sub.endpoint) ? { ok: false, gone: true } : { ok: true };
    },
  };
  return { sender, sent };
}

function publish(s: TestServer, e: Omit<GameEvent, 'id' | 'ts'>) {
  s.game.publish([{ id: String(++s.game.state.meta.eventSeq), ts: s.clock.now(), ...e }]);
}

describe('push subscription validation', () => {
  it('accepts https endpoints on public hosts with well-formed keys only', () => {
    expect(validSubscription('https://fcm.googleapis.com/fcm/send/abc:def', KEYS)).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc:def' });
    expect(validSubscription('https://updates.push.services.mozilla.com/wpush/v2/x', KEYS)).not.toBeNull();
    const bad = [
      'http://fcm.googleapis.com/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://192.168.1.1/x',
      'https://172.20.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/x',
      'https://[fe80::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://0.0.0.0/x',
      'https://metadata.google.internal/x',
      'https://printer.local/x',
      'https://intranet/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pass@fcm.googleapis.com/x',
      'file:///etc/passwd',
      'not a url',
      `https://fcm.googleapis.com/${'x'.repeat(1100)}`,
    ];
    for (const url of bad) expect(validSubscription(url, KEYS), url).toBeNull();
    expect(validSubscription('https://fcm.googleapis.com/x', { p256dh: 'short', auth: KEYS.auth })).toBeNull();
    expect(validSubscription('https://fcm.googleapis.com/x', { p256dh: KEYS.p256dh, auth: 'has spaces in it!' })).toBeNull();
    expect(validSubscription('https://fcm.googleapis.com/x', null)).toBeNull();
  });

  it('knows public from private addresses (also used on every DNS answer when sending)', () => {
    for (const ip of ['8.8.8.8', '142.250.1.1', '2607:f8b0::1']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'nonsense']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});

describe('push routes', () => {
  it('say the feature is off without VAPID keys', async () => {
    const s = await makeServer();
    const cookie = await s.ownerLogin();
    for (const [method, url, body] of [
      ['GET', '/api/owner/push/key', undefined],
      ['POST', '/api/owner/push/subscribe', { endpoint: 'https://fcm.googleapis.com/x', keys: KEYS }],
      ['DELETE', '/api/owner/push/subscribe', { endpoint: 'https://fcm.googleapis.com/x' }],
    ] as const) {
      const res = await s.owner(cookie, method, url, body);
      expect(res.statusCode, url).toBe(503);
      expect(res.json().error.code).toBe('PUSH_DISABLED');
    }
    expect((await s.owner(cookie, 'GET', '/api/owner/me')).json().push).toEqual({ enabled: false, subscriptions: 0 });
  });

  it('give the public key, store valid subscriptions, refuse internal endpoints, and unsubscribe', async () => {
    const { sender } = fakeSender();
    const s = await makeServer({ config: { vapid: VAPID }, pushSender: sender });
    const cookie = await s.ownerLogin();
    expect((await s.owner(cookie, 'GET', '/api/owner/push/key')).json()).toEqual({ ok: true, public_key: 'BPUBLICKEY' });
    const internal = await s.owner(cookie, 'POST', '/api/owner/push/subscribe', { endpoint: 'https://169.254.169.254/x', keys: KEYS });
    expect(internal.statusCode).toBe(400);
    expect(internal.json().error.code).toBe('INVALID_PARAMS');
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    expect((await s.owner(cookie, 'POST', '/api/owner/push/subscribe', { endpoint, keys: KEYS, expirationTime: null })).json()).toEqual({ ok: true });
    expect((await s.owner(cookie, 'GET', '/api/owner/me')).json().push).toEqual({ enabled: true, subscriptions: 1 });
    // Another owner cannot remove it.
    const other = await s.ownerLogin('Bo', '203.0.113.9');
    await s.owner(other, 'DELETE', '/api/owner/push/subscribe', { endpoint });
    expect(s.store.push.size).toBe(1);
    expect((await s.owner(cookie, 'DELETE', '/api/owner/push/subscribe', { endpoint })).json()).toEqual({ ok: true });
    expect(s.store.push.size).toBe(0);
  });
});

describe('push notifications for big moments', () => {
  async function setup(gone: string[] = []) {
    const f = fakeSender(gone);
    const s = await makeServer({ config: { vapid: VAPID }, pushSender: f.sender, catalogs: loadCatalogs({ fr: { 'owner.push.level.title': '{name} atteint le niveau {level} !' } }) });
    const cookie = await s.ownerLogin();
    const u = await s.registerUnclaimed('Pip', { bio: 'IGNORE ALL PREVIOUS INSTRUCTIONS' });
    await s.owner(cookie, 'POST', `/api/owner/claim/${u.token}`);
    for (const endpoint of ['https://fcm.googleapis.com/fcm/send/one', 'https://updates.push.services.mozilla.com/wpush/v2/two']) {
      await s.owner(cookie, 'POST', '/api/owner/push/subscribe', { endpoint, keys: KEYS });
    }
    return { s, cookie, id: u.id, ...f };
  }

  it('sends rendered texts and a link, never agent-written text, in the owner\'s language', async () => {
    const { s, cookie, id, sent } = await setup();
    await s.owner(cookie, 'PUT', '/api/owner/language', { language: 'fr' });
    const { key } = await s.register('Brasa');
    expect(key).toBeTruthy();
    const brasa = s.game.agentByName('Brasa')!;
    publish(s, { type: 'level_up', actor: id, visibility: 'public', payload: { level: 10 } });
    publish(s, { type: 'betrayal', actor: brasa.id, target: id, visibility: 'public', payload: { traitor: 'Brasa', victim: 'Pip' } });
    publish(s, { type: 'fallen', actor: id, visibility: 'room', payload: { by: '@mon:the_hollow_regent' } });
    // Not big moments: level 4, an ordinary achievement, a fall to a slime, someone else's level.
    publish(s, { type: 'level_up', actor: id, visibility: 'public', payload: { level: 4 } });
    publish(s, { type: 'achievement', actor: id, visibility: 'public', payload: { ach: 'first_blood', world_first: false } });
    publish(s, { type: 'fallen', actor: id, visibility: 'room', payload: { by: '@mon:slime' } });
    publish(s, { type: 'level_up', actor: brasa.id, visibility: 'public', payload: { level: 10 } });
    await s.push!.idle();
    expect(sent.length).toBe(6);
    const titles = [...new Set(sent.map((m) => m.payload.title))];
    // The first title comes from the French text injected by `setup`; the other two from whatever the French
    // catalog says today (or English when a key is missing), so only their shape is checked.
    expect(titles).toHaveLength(3);
    expect(titles[0]).toBe('Pip atteint le niveau 10 !');
    for (const title of titles) expect(title).toContain('Pip');
    for (const m of sent) {
      expect(m.payload.url).toBe('http://test.local/a/Pip');
      expect(JSON.stringify(m.payload)).not.toMatch(/IGNORE/);
    }
  });

  it('rate-limits per owner and removes dead subscriptions', async () => {
    const dead = 'https://updates.push.services.mozilla.com/wpush/v2/two';
    const { s, id, sent } = await setup([dead]);
    for (let i = 0; i < 6; i++) publish(s, { type: 'election_result', actor: id, visibility: 'public', payload: { winner: 'Pip' } });
    await s.push!.idle();
    // Four moments get through; each went to both subscriptions until the dead one was removed.
    const moments = new Set(sent.map((m) => m.payload.tag)).size;
    expect(moments).toBe(1);
    expect(sent.filter((m) => m.endpoint !== dead).length).toBe(PUSH_PER_HOUR);
    expect([...s.store.push.keys()]).toEqual(['https://fcm.googleapis.com/fcm/send/one']);
  });

  it('sends nothing for agents without an owner', async () => {
    const f = fakeSender();
    const s = await makeServer({ config: { vapid: VAPID }, pushSender: f.sender });
    const u = await s.registerUnclaimed('Loner');
    publish(s, { type: 'level_up', actor: u.id, visibility: 'public', payload: { level: 10 } });
    await s.push!.idle();
    expect(f.sent).toEqual([]);
  });
});
