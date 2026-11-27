import type { AgentFull, GameEvent, RoomFull, SpectatorEvent, SpectatorServerMsg, WorldFull } from '@ajwf/shared';
import { xpToNext } from '@ajwf/engine';
import { describe, expect, it, vi } from 'vitest';
import { makeServer, type TestServer } from '../test-helpers';
import type { SpectatorSocket } from './broadcaster';
import { CLOSE, SPECTATE } from './constants';

class FakeSocket implements SpectatorSocket {
  bufferedAmount = 0;
  sent: Buffer[] = [];
  closed: { code: number; reason?: string } | null = null;
  terminated = false;
  send(data: Buffer): void {
    this.sent.push(data);
  }
  close(code: number, reason?: string): void {
    this.closed = { code, reason };
  }
  terminate(): void {
    this.terminated = true;
  }
  msgs(): SpectatorServerMsg[] {
    return this.sent.map((b) => JSON.parse(b.toString('utf8')) as SpectatorServerMsg);
  }
  text(): string {
    return this.sent.map((b) => b.toString('utf8')).join('\n');
  }
  clear(): void {
    this.sent = [];
  }
}

type Batch = Extract<SpectatorServerMsg, { t: 'batch' }>;
type Full = Extract<SpectatorServerMsg, { t: 'full' }>;
type ErrorMsg = Extract<SpectatorServerMsg, { t: 'error' }>;

function batches(sock: FakeSocket, topic?: string): Batch[] {
  return sock.msgs().filter((m): m is Batch => m.t === 'batch' && (!topic || m.topic === topic));
}
function fulls(sock: FakeSocket, topic?: string): Full[] {
  return sock.msgs().filter((m): m is Full => m.t === 'full' && (!topic || m.topic === topic));
}
function errors(sock: FakeSocket): ErrorMsg[] {
  return sock.msgs().filter((m): m is ErrorMsg => m.t === 'error');
}
const eventsOf = (bs: Batch[]): SpectatorEvent[] => bs.flatMap((b) => b.events);

function viewer(s: TestServer, ip = '203.0.113.1') {
  const sock = new FakeSocket();
  const conn = s.spectators.attach(sock, ip);
  const send = (msg: unknown) => s.spectators.handleMessage(conn, typeof msg === 'string' ? msg : JSON.stringify(msg));
  const sub = (...topics: string[]) => send({ op: 'sub', topics });
  return { sock, conn, send, sub };
}

/** Synthetic engine events, for routing tests that need exact drama and visibility. */
function event(s: TestServer, o: Partial<GameEvent>): GameEvent {
  return { id: String(++s.game.state.meta.eventSeq), ts: s.clock.now(), type: 'emote', visibility: 'room', payload: {}, ...o };
}

async function twoAgents() {
  const s = await makeServer();
  const pip = await s.register('Pip');
  const brasa = await s.register('Brasa');
  const ids = { pip: s.game.agentByName('Pip')!.id, brasa: s.game.agentByName('Brasa')!.id };
  s.spectators.flush();
  return { s, pip, brasa, ids };
}

const SQUARE = 'room:village.square';

describe('spectator broadcast', () => {
  it('a whisper never reaches any topic, room log or public endpoint; a say does', async () => {
    const { s, pip, brasa } = await twoAgents();
    const v = viewer(s);
    v.sub('world', 'village', SQUARE, 'agent:Pip', 'agent:Brasa');
    expect((await s.act(pip.key, 'whisper', { to: 'Brasa', text: 'the vault code is 7741' })).json().ok).toBe(true);
    s.clock.advance(5000);
    expect((await s.act(brasa.key, 'say', { text: 'good morning, square' })).json().ok).toBe(true);
    // A delayed event published directly (e.g. party chat) is stopped too.
    s.game.publish([event(s, { type: 'party_say', actor: s.game.agentByName('Pip')!.id, roomId: 'village.square', visibility: 'delayed', payload: { text: 'party secret 7741' } })]);
    s.game.publish([event(s, { type: 'loot_share', actor: s.game.agentByName('Pip')!.id, roomId: 'village.square', visibility: 'private', payload: { m: { k: 'ev.loot_you', p: { qty: 7741 } } } })]);
    s.clock.advance(SPECTATE.batchMs);
    s.spectators.flush();

    const sent = v.sock.text();
    expect(sent).toContain('good morning, square');
    expect(sent).not.toContain('7741');
    expect(sent).not.toMatch(/whisper|party_say|loot_share/);
    expect(JSON.stringify(s.spectators.logs.list('village.square'))).not.toContain('7741');
    for (const url of ['/api/public/world', '/api/public/rooms/village.square', '/api/public/agents/Pip', '/api/public/agents/Brasa', '/api/public/stats']) {
      const res = await s.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain('7741');
      expect(res.body, url).not.toMatch(/"whisper"/);
    }
    // A late subscriber's full state has the say in the log and no whisper.
    const late = viewer(s);
    late.sub(SQUARE);
    const log = (fulls(late.sock, SQUARE)[0]!.data as { log: SpectatorEvent[] }).log;
    expect(log.map((e) => e.type)).toContain('say');
    expect(JSON.stringify(log)).not.toContain('7741');
  });

  it('text events carry text and lang, never a key; other events carry key and params', async () => {
    const { s, brasa, ids } = await twoAgents();
    const v = viewer(s);
    v.sub(SQUARE);
    await s.act(brasa.key, 'say', { text: 'hello <b>there</b>' });
    const emote = [...s.game.content.emotes.keys()][0]!;
    s.clock.advance(5000);
    await s.act(brasa.key, 'emote', { emote, target: 'Pip' });
    s.spectators.flush();
    const evs = eventsOf(batches(v.sock, SQUARE));
    const say = evs.find((e) => e.type === 'say')!;
    expect(say).toMatchObject({ actor: 'Brasa', text: 'hello <b>there</b>', lang: 'en', room: 'village.square' });
    expect(say.k).toBeUndefined();
    expect(say.p).toBeUndefined();
    const em = evs.find((e) => e.type === 'emote')!;
    expect(em).toMatchObject({ actor: 'Brasa', target: 'Pip', tk: 'agent', k: `content.emote.${emote}.at`, p: { actor: 'Brasa', target: 'Pip' } });
    expect(em.text).toBeUndefined();
    // Agent ids never leave the server.
    for (const id of Object.values(ids)) expect(v.sock.text()).not.toContain(`"${id}"`);
  });

  it('routes events to the room, the agents involved, the world (big events only) and the village', async () => {
    const { s, ids } = await twoAgents();
    const v = viewer(s);
    v.sub('world', 'village', SQUARE, 'room:village.tavern', 'agent:brasa');
    v.sock.clear();
    s.game.publish([
      event(s, { type: 'attack', actor: ids.pip, roomId: 'village.square', drama: 1, payload: { m: { k: 'ev.attack', p: { actor: 'Pip' } } } }),
      event(s, { type: 'kill', actor: ids.pip, roomId: 'village.square', drama: 10, visibility: 'public', payload: { m: { k: 'ev.kill', p: { actor: 'Pip' } } } }),
      event(s, { type: 'heal', actor: ids.pip, target: ids.brasa, roomId: 'village.square', drama: 1, payload: {} }),
      event(s, { type: 'day_phase', visibility: 'public', payload: { night: true } }),
    ]);
    s.clock.advance(SPECTATE.batchMs);
    s.spectators.flush();
    const types = (topic: string) => eventsOf(batches(v.sock, topic)).map((e) => e.type);
    expect(types(SQUARE)).toEqual(['attack', 'kill', 'heal']);
    expect(types('world')).toEqual(['kill', 'day_phase']);
    expect(types('village')).toEqual(['day_phase']);
    expect(types('agent:brasa')).toEqual(['heal']);
    expect(batches(v.sock, 'room:village.tavern')).toEqual([]);
    for (const e of eventsOf(batches(v.sock, 'world'))) expect(e.room === undefined || (e.drama ?? 0) >= SPECTATE.worldMinDrama).toBe(true);
    // The kill also heated up the square for director mode.
    // Two arrivals (2 each) plus attack, kill and heal (1 + 10 + 1), a quarter of a second ago.
    expect(batches(v.sock, 'world')[0]!.drama!['village.square']).toBeCloseTo(16, 0);
  });

  it('sends positions to the world, both rooms of a move and the agent topic', async () => {
    const { s, pip } = await twoAgents();
    const v = viewer(s);
    const dir = s.path('village.square', 'village.tavern')[0]!;
    const next = s.game.content.rooms.get('village.square')!.exits[dir]!;
    v.sub('world', SQUARE, `room:${next}`, 'agent:Pip');
    v.sock.clear();
    expect((await s.act(pip.key, 'move', { dir })).json().ok).toBe(true);
    s.clock.advance(SPECTATE.batchMs);
    s.spectators.flush();
    for (const topic of ['world', SQUARE, `room:${next}`, 'agent:Pip']) {
      const pos = batches(v.sock, topic).flatMap((b) => b.pos ?? []);
      expect(pos, topic).toEqual([expect.objectContaining({ n: 'Pip', r: next, l: 1, c: 'warrior' })]);
    }
    // The move event itself is logged in the destination room only.
    expect(eventsOf(batches(v.sock, `room:${next}`)).map((e) => e.type)).toEqual(['move']);
    expect(eventsOf(batches(v.sock, SQUARE))).toEqual([]);
  });

  it('serializes each topic batch once, whatever the number of subscribers', async () => {
    const { s, brasa } = await twoAgents();
    const viewers = Array.from({ length: 5 }, (_, i) => viewer(s, `198.51.100.${i}`));
    for (const v of viewers) v.sub(SQUARE, 'world');
    const encode = vi.spyOn(s.spectators, 'encode');
    await s.act(brasa.key, 'say', { text: 'one frame for all' });
    s.clock.advance(SPECTATE.batchMs);
    s.spectators.flush();
    const batchCalls = encode.mock.calls.filter(([m]) => m.t === 'batch');
    expect(batchCalls.filter(([m]) => m.t === 'batch' && m.topic === SQUARE)).toHaveLength(1);
    expect(batchCalls.filter(([m]) => m.t === 'batch' && m.topic === 'world')).toHaveLength(1);
    const frames = viewers.map((v) => v.sock.sent.find((b) => b.toString().startsWith(`{"t":"batch","topic":"${SQUARE}"`))!);
    // The very same buffer object went to every socket.
    for (const f of frames) expect(f).toBe(frames[0]);
    // Full states for subscribers arriving in the same period are shared too.
    encode.mockClear();
    for (const v of viewers) v.sub('room:village.tavern');
    expect(encode.mock.calls.filter(([m]) => m.t === 'full')).toHaveLength(1);
  });

  it('caps the world topic at 4 batches per second and sends it only big events', async () => {
    const { s, ids } = await twoAgents();
    const v = viewer(s);
    v.sub('world');
    v.sock.clear();
    const start = s.clock.now();
    for (let i = 0; i < 40; i++) {
      s.game.publish([
        event(s, { type: 'attack', actor: ids.pip, roomId: 'forest.edge', drama: 1, payload: {} }),
        event(s, { type: 'fallen', actor: ids.brasa, roomId: 'forest.edge', drama: 3, payload: {} }),
      ]);
      s.clock.advance(25);
      s.spectators.flush();
    }
    const world = batches(v.sock, 'world');
    const inFirstSecond = world.filter((b) => b.now - start < 1000);
    expect(inFirstSecond.length).toBeLessThanOrEqual(4);
    expect(inFirstSecond.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < world.length; i++) expect(world[i]!.now - world[i - 1]!.now).toBeGreaterThanOrEqual(SPECTATE.worldMinIntervalMs);
    const evs = eventsOf(world);
    expect(evs.every((e) => e.type === 'fallen')).toBe(true);
    // Nothing is lost by the cap: every big event arrives, merged into fewer batches.
    s.clock.advance(1000);
    s.spectators.flush();
    expect(eventsOf(batches(v.sock, 'world'))).toHaveLength(40);
  });

  it('pauses a slow socket over 1 MB, then sends full states instead of the missed batches', async () => {
    const { s, brasa } = await twoAgents();
    const slow = viewer(s);
    slow.sub(SQUARE, 'agent:Brasa');
    slow.sock.clear();
    slow.sock.bufferedAmount = 2 * 1024 * 1024;
    for (const text of ['missed one', 'missed two']) {
      await s.act(brasa.key, 'say', { text });
      s.clock.advance(SPECTATE.batchMs + 3000);
      s.spectators.flush();
    }
    expect(slow.sock.sent).toHaveLength(0);
    expect(s.metrics.wsBackpressure).toBe(1);

    slow.sock.bufferedAmount = 10;
    s.clock.advance(SPECTATE.batchMs);
    s.spectators.flush();
    const msgs = slow.sock.msgs();
    expect(msgs.map((m) => m.t)).toEqual(['full', 'full']);
    const room = fulls(slow.sock, SQUARE)[0]!.data as { log: SpectatorEvent[] };
    expect(room.log.filter((e) => e.type === 'say').map((e) => e.text)).toEqual(['missed one', 'missed two']);
    expect(fulls(slow.sock, 'agent:Brasa')).toHaveLength(1);

    // Back to normal batches afterwards.
    await s.act(brasa.key, 'say', { text: 'live again' });
    s.clock.advance(SPECTATE.batchMs);
    s.spectators.flush();
    expect(eventsOf(batches(slow.sock, SQUARE)).map((e) => e.text)).toEqual(['live again']);
  });

  it('drops a socket that stays stuck', async () => {
    const { s, brasa } = await twoAgents();
    const stuck = viewer(s);
    stuck.sub(SQUARE);
    stuck.sock.bufferedAmount = 5 * 1024 * 1024;
    await s.act(brasa.key, 'say', { text: 'anyone?' });
    s.spectators.flush();
    expect(s.spectators.connections).toBe(1);
    s.clock.advance(SPECTATE.stuckMs + 1);
    s.spectators.flush();
    expect(stuck.sock.terminated).toBe(true);
    expect(s.spectators.connections).toBe(0);
    expect(s.metrics.wsDropped).toBe(1);
  });

  it('limits connections overall and per IP', async () => {
    const s = await makeServer({ wsMaxConnections: 4, wsMaxPerIp: 2 });
    const b = s.spectators;
    expect(b.admit('10.0.0.1')).toEqual({ ok: true });
    viewer(s, '10.0.0.1');
    const second = viewer(s, '10.0.0.1');
    expect(b.admit('10.0.0.1')).toEqual({ ok: false, reason: 'ip_limit' });
    viewer(s, '10.0.0.2');
    viewer(s, '10.0.0.3');
    expect(b.admit('10.0.0.9')).toEqual({ ok: false, reason: 'server_full' });
    b.detach(second.conn);
    expect(b.admit('10.0.0.1')).toEqual({ ok: true });
  });

  it('allows at most 16 topics per connection', async () => {
    const s = await makeServer();
    const v = viewer(s);
    const rooms = [...s.game.content.rooms.keys()].slice(0, 17).map((id) => `room:${id}`);
    v.sub(...rooms.slice(0, 10));
    v.sub(...rooms.slice(10));
    expect(fulls(v.sock)).toHaveLength(16);
    expect(errors(v.sock)).toEqual([expect.objectContaining({ code: 'TOO_MANY_TOPICS', topic: rooms[16] })]);
    // Leaving one makes room for another.
    v.send({ op: 'unsub', topics: [rooms[0]] });
    v.sub(rooms[16]!);
    expect(fulls(v.sock)).toHaveLength(17);
  });

  it('answers malformed, unknown and oversized messages, and nothing a spectator sends changes the game', async () => {
    const { s } = await twoAgents();
    const before = JSON.stringify({ seq: s.game.state.meta.eventSeq, rooms: [...s.game.state.agents.values()].map((a) => [a.room, a.gold, a.hp]) });
    const v = viewer(s);
    v.sock.clear();
    v.send('not json at all');
    v.send({ op: 'dance' });
    v.send({ op: 'act', action: 'move', params: { dir: 'north' } });
    v.send({ op: 'sub', topics: 'world' });
    v.send({ op: 'sub', topics: [] });
    v.send([1, 2, 3]);
    v.sub('room:nowhere', 'agent:Nobody', 'agent:', 'secrets', 'world');
    s.spectators.handleMessage(v.conn, Buffer.from('{"op":"ping"}'), true);
    v.send({ op: 'ping' });
    expect(errors(v.sock).map((e) => e.code)).toEqual([
      'BAD_MESSAGE',
      'UNKNOWN_OP',
      'UNKNOWN_OP',
      'BAD_MESSAGE',
      'BAD_MESSAGE',
      'BAD_MESSAGE',
      'BAD_TOPIC',
      'BAD_TOPIC',
      'BAD_TOPIC',
      'BAD_TOPIC',
      'BAD_MESSAGE',
    ]);
    expect(errors(v.sock).every((e) => typeof e.message === 'string' && e.message.length > 0)).toBe(true);
    expect(fulls(v.sock, 'world')).toHaveLength(1);
    expect(v.sock.msgs().at(-1)).toEqual({ t: 'pong' });
    expect(v.sock.closed).toBeNull();

    v.send(JSON.stringify({ op: 'sub', topics: ['x'.repeat(SPECTATE.maxMessageBytes)] }));
    expect(errors(v.sock).at(-1)!.code).toBe('TOO_LARGE');
    expect(v.sock.closed).toEqual({ code: CLOSE.tooBig, reason: 'message too big' });
    expect(s.spectators.connections).toBe(0);

    const spam = viewer(s);
    for (let i = 0; i < SPECTATE.msgBurst + 5; i++) spam.send({ op: 'ping' });
    expect(errors(spam.sock).map((e) => e.code)).toEqual(['RATE_LIMITED']);
    expect(spam.sock.closed?.code).toBe(CLOSE.policy);

    s.spectators.flush();
    expect(JSON.stringify({ seq: s.game.state.meta.eventSeq, rooms: [...s.game.state.agents.values()].map((a) => [a.room, a.gold, a.hp]) })).toBe(before);
  });

  it('sends full states: world, room, agent and village', async () => {
    const { s, pip } = await twoAgents();
    await s.act(pip.key, 'say', { text: 'first words' });
    s.spectators.flush();
    const v = viewer(s);
    expect(v.sock.msgs()[0]).toMatchObject({ t: 'hello', day: { phase: expect.any(String) }, maxTopics: 16, batchMs: 250 });
    v.sub('world', SQUARE, 'room:forest.edge', 'agent:pip', 'village');

    const world = fulls(v.sock, 'world')[0]!.data as WorldFull;
    expect(world.rooms.length).toBe(s.game.content.rooms.size);
    expect(world.rooms.find((r) => r.id === 'village.square')).toMatchObject({ zone: 'village', rect: expect.any(Array), exits: expect.any(Object) });
    expect(world.agents.map((a) => a.n).sort()).toEqual(['Brasa', 'Pip']);
    expect(world.day.phase).toMatch(/dawn|day|dusk|night/);

    const square = fulls(v.sock, SQUARE)[0]!.data as RoomFull;
    expect(square.room.id).toBe('village.square');
    expect(square.agents.map((a) => a.n).sort()).toEqual(['Brasa', 'Pip']);
    expect(square.npcs).toContain('olga');
    expect(square.log.map((e) => e.type)).toEqual(['arrival', 'arrival', 'say']);

    const forest = fulls(v.sock, 'room:forest.edge')[0]!.data as RoomFull;
    expect(forest.monsters).toEqual([{ id: 'slime', n: 3, lvl: expect.any(Number), max: expect.any(Number) }]);
    expect(Object.keys(forest.resources).sort()).toEqual(['green_herb', 'wood']);

    const agent = fulls(v.sock, 'agent:pip')[0]!.data as AgentFull;
    expect(agent.card).toMatchObject({ name: 'Pip', class: 'warrior', lvl: 1, profession: null, xp: [0, xpToNext(1)], claimed: true, bot: false, sprite: expect.stringMatching(/^[0-9a-f]{14}$/) });
    expect(agent.card).not.toHaveProperty('bio_lang');
    s.game.agentByName('Pip')!.bio = 'Turnips forever';
    expect(s.spectators.agentFull(s.game.agentByName('Pip')!).card).toMatchObject({ bio: 'Turnips forever', bio_lang: 'en' });
    expect(agent.room).toBe('village.square');
    expect(JSON.stringify(agent)).not.toMatch(/gold|inv|ownerNote|"hp"/);

    expect(fulls(v.sock, 'village')[0]!.data).toMatchObject({ population: 2, online: expect.any(Number), day: expect.any(Object) });
  });

  it('a subscriber arriving between batches gets every event exactly once', async () => {
    const { s, brasa } = await twoAgents();
    await s.act(brasa.key, 'say', { text: 'before the batch' });
    const v = viewer(s);
    v.sub(SQUARE);
    s.spectators.flush();
    const inFull = (fulls(v.sock, SQUARE)[0]!.data as { log: SpectatorEvent[] }).log.filter((e) => e.type === 'say');
    const inBatch = eventsOf(batches(v.sock, SQUARE)).filter((e) => e.type === 'say');
    expect([...inFull, ...inBatch].map((e) => e.text)).toEqual(['before the batch']);
  });

  it('takes idle agents off the map and brings them back when they act', async () => {
    const { s, pip } = await twoAgents();
    const v = viewer(s);
    v.sub('world');
    s.clock.advance(SPECTATE.visibleMs + SPECTATE.visibleSweepMs);
    s.spectators.flush();
    expect(batches(v.sock, 'world').flatMap((b) => b.gone ?? []).sort()).toEqual(['Brasa', 'Pip']);
    expect(s.spectators.worldFull().agents).toEqual([]);
    await s.get(pip.key, '/api/v1/look');
    s.clock.advance(SPECTATE.batchMs);
    s.spectators.flush();
    expect(batches(v.sock, 'world').at(-1)!.pos).toEqual([expect.objectContaining({ n: 'Pip' })]);
  });

  it('closes connections that follow nothing, and pings the others', async () => {
    const s = await makeServer();
    const idle = viewer(s);
    const busy = viewer(s);
    const ping = vi.fn();
    Object.assign(busy.sock, { ping });
    busy.sub('world');
    s.clock.advance(SPECTATE.idleNoTopicsMs + 1);
    s.spectators.housekeeping();
    expect(idle.sock.closed?.code).toBe(CLOSE.idle);
    expect(busy.sock.closed).toBeNull();
    expect(ping).toHaveBeenCalledTimes(1);
    // No pong before the next round: dropped.
    s.clock.advance(SPECTATE.pingMs);
    s.spectators.housekeeping();
    expect(busy.sock.terminated).toBe(true);
  });
});
