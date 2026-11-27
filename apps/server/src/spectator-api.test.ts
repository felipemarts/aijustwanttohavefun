import type { I18nBundle, PublicStats, RoomFull, WorldFull } from '@ajwf/shared';
import { xpToNext } from '@ajwf/engine';
import { describe, expect, it } from 'vitest';
import { loadCatalogs } from './i18n';
import { npcAppearance } from './sprites';
import { ADMIN, makeServer } from './test-helpers';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('/api/public', () => {
  it('serves the world and rooms in the WebSocket shapes, readable from any origin, briefly cacheable', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    await s.act(key, 'say', { text: 'hi all' });
    const world = await s.app.inject({ method: 'GET', url: '/api/public/world' });
    expect(world.statusCode).toBe(200);
    expect(world.headers['access-control-allow-origin']).toBe('*');
    expect(world.headers['cache-control']).toBe('public, max-age=2');
    const w = world.json() as WorldFull;
    expect(w.rooms.length).toBe(s.game.content.rooms.size);
    expect(w.agents).toEqual([expect.objectContaining({ n: 'Pip', r: 'village.square' })]);
    expect(w.drama['village.square']).toBeGreaterThan(0);

    const room = (await s.app.inject({ method: 'GET', url: '/api/public/rooms/village.square' })).json() as RoomFull;
    expect(room.log.map((e) => e.type)).toEqual(['arrival', 'say']);
    expect(room.log[1]).toMatchObject({ actor: 'Pip', text: 'hi all' });
    const missing = await s.app.inject({ method: 'GET', url: '/api/public/rooms/nowhere' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
  });

  it('reuses the public profile for agents, plus where they stand', async () => {
    const s = await makeServer();
    await s.register('Pip', { bio: 'I like turnips' });
    s.game.agentByName('Pip')!.ownerNote = 'secret plan';
    const res = await s.app.inject({ method: 'GET', url: '/api/public/agents/pip?lang=pt-BR' });
    expect(res.statusCode).toBe(200);
    const a = res.json().agent;
    expect(a).toMatchObject({ name: 'Pip', class: 'warrior', lvl: 1, bio: { untrusted_text: 'I like turnips' }, room: 'village.square', sprite_hash: expect.stringMatching(/^[0-9a-f]{14}$/) });
    expect(a.look).toMatch(/^um /);
    // Spectators see the profession, the XP bar (into this level, needed for the next) and the bio's language.
    expect(a).toMatchObject({ profession: null, xp: [0, xpToNext(1)], bio_lang: 'en' });
    expect(res.body).not.toMatch(/secret plan|gold|inventory/);
    expect((await s.app.inject({ method: 'GET', url: '/api/public/agents/Nobody' })).statusCode).toBe(404);
  });

  it("names an agent's party (size, leader, a few members), as public as the party_join event", async () => {
    const s = await makeServer();
    const { key: pip } = await s.register('Pip');
    const { key: bob } = await s.register('Bob');
    const { key: cy } = await s.register('Cyra');
    const profile = async (name: string) => (await s.app.inject({ method: 'GET', url: `/api/public/agents/${name}` })).json().agent;
    expect((await profile('Pip')).party).toBeUndefined();
    for (const k of [bob, cy]) {
      expect((await s.act(pip, 'party_invite', { agent: k === bob ? 'Bob' : 'Cyra' })).json().ok).toBe(true);
      expect((await s.act(k, 'party_accept', { agent: 'Pip' })).json().ok).toBe(true);
    }
    expect((await profile('Bob')).party).toEqual({ n: 3, leader: 'Pip', members: ['Pip', 'Cyra'] });
    expect((await profile('Pip')).party).toEqual({ n: 3, leader: 'Pip', members: ['Bob', 'Cyra'] });
    // The join itself was a room event, in the square's public log.
    const room = (await s.app.inject({ method: 'GET', url: '/api/public/rooms/village.square' })).json() as RoomFull;
    expect(room.log.map((e) => e.type)).toContain('party_join');
  });

  it('reports population, online agents, classes and the time of day', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    await s.register('Mira', { class: 'mage' });
    await s.get(key, '/api/v1/look');
    const res = await s.app.inject({ method: 'GET', url: '/api/public/stats' });
    expect(res.headers['cache-control']).toBe('public, max-age=10');
    const st = res.json() as PublicStats;
    expect(st).toMatchObject({ population: 2, online: 1, byClass: { warrior: 1, mage: 1 }, spectators: 0, day: { phase: expect.any(String) } });
  });

  it('rate-limits each IP', async () => {
    const s = await makeServer();
    let last = 200;
    for (let i = 0; i < 241 && last === 200; i++) {
      last = (await s.app.inject({ method: 'GET', url: '/api/public/stats', remoteAddress: '198.51.100.77' })).statusCode;
    }
    expect(last).toBe(429);
    expect((await s.app.inject({ method: 'GET', url: '/api/public/stats', remoteAddress: '198.51.100.78' })).statusCode).toBe(200);
  });
});

describe('GET /api/public/i18n/:lang', () => {
  it('serves the catalog the spectator client needs, with English fallback, ETag and a 5-minute cache', async () => {
    const s = await makeServer({ catalogs: loadCatalogs({ en: { 'ui.only_in_english': 'Only in English' } }) });
    const res = await s.app.inject({ method: 'GET', url: '/api/public/i18n/pt-BR' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const etag = res.headers.etag as string;
    expect(etag).toMatch(/^".+"$/);
    const b = res.json() as I18nBundle;
    expect(b.lang).toBe('pt-BR');
    const m = b.messages;
    expect(m['ev.move']).toBeTypeOf('string');
    expect(m['ev.move']).not.toBe((await s.app.inject({ method: 'GET', url: '/api/public/i18n/en' })).json().messages['ev.move']);
    expect(m['ui.only_in_english']).toBe('Only in English');
    expect(m['content.room.village.square.name']).toBeTypeOf('string');
    expect(m['content.room.village.square.desc']).toBeTypeOf('string');
    expect(m['content.npc.olga.name']).toBeTypeOf('string');
    expect(m['content.emote.wave.solo']).toBeTypeOf('string');
    expect(m['appearance.dye.d0']).toBeTypeOf('string');
    expect(m['dir.north']).toBeTypeOf('string');
    for (const k of Object.keys(m)) {
      expect(k, k).toMatch(/^(ui|ev|dir|appearance|gazette|highlight)\.|^content\..+\.(name|desc)$|^content\.emote\./);
      expect(k).not.toMatch(/^content\.(quest|ach|item)\..+\.desc$/);
    }
    expect(Object.keys(m).some((k) => /^(api|err|hint|n)\./.test(k))).toBe(false);

    const again = await s.app.inject({ method: 'GET', url: '/api/public/i18n/pt-BR', headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    // Unknown and unsupported languages get English.
    expect((await s.app.inject({ method: 'GET', url: '/api/public/i18n/de-AT' })).json().lang).toBe('en');
    expect((await s.app.inject({ method: 'GET', url: '/api/public/i18n/pt' })).json().lang).toBe('pt-BR');
  });
});

describe('GET /sprites/npc/:id.png', () => {
  it('draws each NPC from its id: deterministic, distinct, cached', async () => {
    const a = await makeServer();
    const b = await makeServer();
    const get = (s: typeof a, url: string) => s.app.inject({ method: 'GET', url });
    const olga1 = await get(a, '/sprites/npc/olga.png');
    expect(olga1.statusCode).toBe(200);
    expect(olga1.headers['content-type']).toBe('image/png');
    expect(olga1.headers['cache-control']).toBe('public, max-age=86400');
    expect(olga1.rawPayload.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    const olga2 = await get(b, '/sprites/npc/olga.png');
    expect(olga2.rawPayload.equals(olga1.rawPayload)).toBe(true);
    expect((await get(a, '/sprites/npc/olga.png')).rawPayload.equals(olga1.rawPayload)).toBe(true);
    expect((await get(a, '/sprites/npc/gunnar.png')).rawPayload.equals(olga1.rawPayload)).toBe(false);
    expect(npcAppearance('olga')).toEqual(npcAppearance('olga'));
    const looks = new Set([...a.game.content.npcs.keys()].map((id) => JSON.stringify(npcAppearance(id))));
    expect(looks.size).toBe(a.game.content.npcs.size);
    for (const url of ['/sprites/npc/nobody.png', '/sprites/npc/olga.gif', '/sprites/npc/..%2Folga.png']) expect((await get(a, url)).statusCode).toBe(404);
  });
});

describe('GET /metrics', () => {
  it('needs the admin token when one is configured', async () => {
    const s = await makeServer();
    expect((await s.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    const ok = await s.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${ADMIN}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^text\/plain/);
    expect((await s.app.inject({ method: 'GET', url: '/metrics', headers: { 'x-admin-token': ADMIN } })).statusCode).toBe(200);
  });

  it('is open without a token outside production, and absent in production without one', async () => {
    const dev = await makeServer({ config: { adminToken: undefined } });
    expect((await dev.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
    const prod = await makeServer({ config: { adminToken: undefined, production: true } });
    expect((await prod.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
  });

  it('reports agents, actions, latency, errors, spectators and the process', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    await s.register('Brasa');
    await s.act(key, 'say', { text: 'counting' });
    await s.act(key, 'move', { dir: 'nowhere' });
    s.clock.advance(2000);
    const text = (await s.app.inject({ method: 'GET', url: '/metrics', headers: { 'x-admin-token': ADMIN } })).body;
    const value = (name: string) => Number(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\S+)$`, 'm').exec(text)?.[1]);
    expect(value('ajwf_agents_registered')).toBe(2);
    expect(value('ajwf_agents_online')).toBe(1);
    expect(value('ajwf_actions_total')).toBe(2);
    expect(value('ajwf_act_latency_seconds_count')).toBe(2);
    expect(value('ajwf_act_latency_seconds_bucket{le="+Inf"}')).toBe(2);
    expect(value('ajwf_errors_total{code="TARGET_NOT_FOUND"}')).toBe(1);
    expect(value('ajwf_spectators_connected')).toBe(0);
    for (const name of ['ajwf_actions_per_second', 'ajwf_ws_payload_bytes_total', 'ajwf_ws_wire_bytes_total', 'ajwf_ws_batches_total', 'ajwf_ws_batches_per_second', 'process_resident_memory_bytes', 'nodejs_heap_used_bytes', 'process_cpu_seconds_total']) {
      expect(value(name), name).toBeGreaterThanOrEqual(0);
    }
    expect(text).toMatch(/^ajwf_event_loop_lag_seconds\{stat="p99"\} /m);
  });
});
