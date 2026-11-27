import { BALANCE } from '@ajwf/engine';
import type { GameEvent, GazetteEdition, Highlight, Leaderboard, SecretConversation, SpectatorServerMsg, TimelineEntry, VillageFull, WorldFull } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import type { SpectatorSocket } from '../spectate/broadcaster';
import { estimateTokens, makeServer, T0, type TestServer } from '../test-helpers';

class FakeSocket implements SpectatorSocket {
  bufferedAmount = 0;
  sent: Buffer[] = [];
  send(data: Buffer): void {
    this.sent.push(data);
  }
  close(): void {}
  terminate(): void {}
  msgs(): SpectatorServerMsg[] {
    return this.sent.map((b) => JSON.parse(b.toString('utf8')) as SpectatorServerMsg);
  }
  text(): string {
    return this.sent.map((b) => b.toString('utf8')).join('\n');
  }
}
type Batch = Extract<SpectatorServerMsg, { t: 'batch' }>;
const batches = (s: FakeSocket, topic: string) => s.msgs().filter((m): m is Batch => m.t === 'batch' && m.topic === topic);

function viewer(s: TestServer, ...topics: string[]) {
  const sock = new FakeSocket();
  const conn = s.spectators.attach(sock, '203.0.113.9');
  s.spectators.handleMessage(conn, JSON.stringify({ op: 'sub', topics }));
  return sock;
}

const DAY = 86_400_000;
const pub = (s: TestServer, url: string) => s.app.inject({ method: 'GET', url: `/api/public${url}` });

/** Walks an agent (by key) to a room. */
async function walk(s: TestServer, key: string, name: string, to: string) {
  const a = s.game.agentByName(name)!;
  for (const dir of s.path(a.room, to)) expect((await s.act(key, 'move', { dir })).json().ok).toBe(true);
}

/** Gives an agent what a project still needs and has it contribute everything at the town hall. */
async function build(s: TestServer, key: string, name: string, project: string) {
  const a = s.game.agentByName(name)!;
  const p = s.game.content.projects.get(project)!;
  await walk(s, key, name, 'village.town_hall');
  a.gold += p.cost.gold;
  const items: Record<string, number> = {};
  for (const x of p.cost.items) {
    items[x.item] = x.qty;
    a.inv[x.item] = (a.inv[x.item] ?? 0) + x.qty;
  }
  const res = (await s.act(key, 'contribute', { project, gold: p.cost.gold, items })).json();
  expect(res.ok, JSON.stringify(res)).toBe(true);
}

/** Runs the clock forward, firing the engine timers (the election) on the way. */
function advance(s: TestServer, ms: number) {
  s.clock.advance(ms);
  s.game.tick();
}

async function elect(s: TestServer, key: string, name: string, voterKey: string) {
  const a = s.game.agentByName(name)!;
  a.level = BALANCE.election.runLevel;
  await walk(s, key, name, 'village.town_hall');
  expect((await s.act(key, 'run_for_mayor', { platform: 'Bridges for everyone, and a statue for the cat.' })).json().ok).toBe(true);
  const e = s.game.state.village.election;
  advance(s, e.voteAt - s.clock.now());
  expect(s.game.state.village.election.phase).toBe('voting');
  expect((await s.act(voterKey, 'vote', { candidate: name })).json().ok).toBe(true);
  advance(s, s.game.state.village.election.end - s.clock.now());
}

describe('chronicle consumers', () => {
  it('write highlights, trades, board posts, journal, achievements and elections through the store', async () => {
    const s = await makeServer();
    const pip = await s.register('Pip');
    const brasa = await s.register('Brasa');
    await build(s, pip.key, 'Pip', 'bridge');
    expect((await s.act(brasa.key, 'board_post', { text: 'I saw a dragon', tag: 'rumor' })).json().ok).toBe(true);
    s.clock.advance(5000);
    expect((await s.act(pip.key, 'journal', { text: 'Built a bridge today.' })).json().ok).toBe(true);
    // A market trade.
    await walk(s, brasa.key, 'Brasa', 'village.market');
    await walk(s, pip.key, 'Pip', 'village.market');
    s.game.agentByName('Brasa')!.inv.wood = 5;
    const order = (await s.act(brasa.key, 'market_sell', { item: 'wood', qty: 5, price: 4 })).json().data.order as string;
    s.game.agentByName('Pip')!.gold += 100;
    expect((await s.act(pip.key, 'market_buy', { order })).json().ok).toBe(true);
    const voter = await s.register('Voter');
    s.game.agentByName('Voter')!.level = BALANCE.election.voteLevel;
    await walk(s, voter.key, 'Voter', 'village.town_hall');
    await elect(s, pip.key, 'Pip', voter.key);

    await s.chronicle.flush();
    const st = s.store;
    expect([...st.highlights.values()].map((h) => h.type)).toEqual(expect.arrayContaining(['project_completed', 'mayor_elected']));
    expect([...st.trades.values()]).toEqual([expect.objectContaining({ item: 'wood', qty: 5, price: 4 })]);
    expect([...st.posts.values()]).toEqual([expect.objectContaining({ tag: 'rumor', text: 'I saw a dragon', parentId: null })]);
    expect([...st.journal.values()]).toEqual([expect.objectContaining({ text: 'Built a bridge today.' })]);
    expect(st.achievements.size).toBeGreaterThan(0);
    expect([...st.elections.values()]).toEqual([expect.objectContaining({ id: '1', winner: 'Pip', candidates: [{ name: 'Pip', votes: 1 }] })]);
    // The days passed: their editions and stats rows are stored.
    expect(st.gazettes.get('2026-01-01')).toMatchObject({ final: true, headline: { k: expect.stringMatching(/^gazette\.headline\.project_completed\./) } });
    expect(st.stats.get('2026-01-01')).toMatchObject({ projectsToday: 1, trades: 1, avgPrices: { wood: 4 } });
    expect(st.timeline.size).toBeGreaterThan(0);

    // A failed write is retried with nothing lost.
    expect((await s.act(pip.key, 'journal', { text: 'Second entry.' })).json().ok).toBe(true);
    st.failNext = new Error('db down');
    await s.chronicle.flush();
    expect(s.chronicle.buffered).toBeGreaterThan(0);
    await s.chronicle.flush();
    expect(s.chronicle.buffered).toBe(0);
    expect(st.journal.size).toBe(2);
  });

  it('a restarted server serves the same highlights and timeline from the store', async () => {
    const first = await makeServer();
    const pip = await first.register('Pip');
    await build(first, pip.key, 'Pip', 'bridge');
    await first.persistence.stop();
    await first.chronicle.stop();
    const second = await makeServer({ store: first.store });
    const hs = (await pub(second, '/highlights')).json().highlights as Highlight[];
    expect(hs.map((h) => h.type)).toContain('project_completed');
    expect(((await pub(second, '/timeline')).json().entries as TimelineEntry[]).map((e) => e.type)).toContain('project_completed');
  });
});

describe('GET /api/v1/village', () => {
  it('is compact and complete: projects, mayor, election, treasury, tax, prices, world boss, gazette in the agent language', async () => {
    const s = await makeServer();
    const pip = await s.register('Pip', { language: 'pt-BR' });
    const names = ['Brasa', 'Mira', 'Tobias'];
    const keys: string[] = [];
    for (const n of names) keys.push((await s.register(n)).key);
    // Some contributions to three projects.
    await walk(s, pip.key, 'Pip', 'village.town_hall');
    const a = s.game.agentByName('Pip')!;
    a.gold += 1000;
    a.inv.wood = 30;
    for (const project of ['bridge', 'watchtower', 'inn_expansion']) expect((await s.act(pip.key, 'contribute', { project, gold: 100, items: { wood: 10 } })).json().ok).toBe(true);
    // Three candidates with long platforms, voting open.
    for (let i = 0; i < 3; i++) {
      const c = s.game.agentByName(names[i]!)!;
      c.level = BALANCE.election.runLevel;
      await walk(s, keys[i]!, names[i]!, 'village.town_hall');
      expect((await s.act(keys[i]!, 'run_for_mayor', { platform: `${names[i]} promises `.padEnd(500, 'roads and bridges ') })).json().ok).toBe(true);
    }
    advance(s, s.game.state.village.election.voteAt - s.clock.now());
    // Eight items traded recently.
    const now = s.clock.now();
    for (const item of ['wood', 'stone', 'iron_ore', 'iron_ingot', 'linen', 'bread', 'crystal', 'minor_potion']) {
      s.game.state.market.history.push({ item, qty: 3, price: 7, buyer: a.id, seller: a.id, ts: now - 1000 });
    }

    const res = await s.get(pip.key, '/api/v1/village');
    const body = res.json();
    expect(body).toMatchObject({ ok: true, population: 4, mayor: null, treasury: 0, tax_pct: 0, priority: null, election: { n: 1, phase: 'voting', voters: 0 } });
    expect(body.projects.open).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'bridge', site: 'village.river_bank', pct: expect.any(Number), need: expect.objectContaining({ gold: 400, wood: 50 }) })]));
    expect(body.projects.locked).toContain('library');
    expect(body.election.candidates).toHaveLength(3);
    expect(body.election.candidates[0].platform.untrusted_text.length).toBeLessThanOrEqual(161);
    expect(Object.keys(body.prices)).toHaveLength(8);
    expect(body.prices.bread).toMatchObject({ avg: 7, npc_sells: 8 });
    expect(body.world_boss).toMatchObject({ id: 'ancient_colossus', room: 'hills.pass' });
    // The gazette headline, in Portuguese when it exists there, English otherwise; never a raw key.
    expect(body.gazette).toBeTypeOf('string');
    expect(body.gazette).not.toMatch(/^gazette\./);
    // Public: the same answer without a key, language from ?lang=.
    const anon = (await s.app.inject({ method: 'GET', url: '/api/v1/village?lang=en' })).json();
    expect(anon.projects).toEqual(body.projects);
    expect(res.body).not.toMatch(/"a\d[0-9a-z]*"/);

    const tokens = estimateTokens(res.body);
    console.info(`/village: ${res.body.length} chars, ~${tokens} tokens`);
    expect(tokens).toBeLessThanOrEqual(500);
  });

  it('agent profiles carry the public reputation', async () => {
    const s = await makeServer();
    const pip = await s.register('Pip');
    await s.register('Brasa');
    const p = (await s.get(pip.key, '/api/v1/agents/Brasa')).json().agent;
    expect(p.reputation).toMatchObject({ trades: 0, betrayals: 0, honor: expect.any(Number), infamy: 0, wanted: false });
  });
});

describe('/api/public civic routes', () => {
  it('village, history, timeline, highlights, gazette, board, leaderboard, guilds and profiles', async () => {
    const s = await makeServer();
    const pip = await s.register('Pip');
    const brasa = await s.register('Brasa');
    await build(s, pip.key, 'Pip', 'bridge');
    s.game.agentByName('Brasa')!.gold += 1000;
    await walk(s, brasa.key, 'Brasa', 'village.guild_hall');
    expect((await s.act(brasa.key, 'guild_create', { name: 'Iron Owls', motto: 'Hoot', colors: ['#112233', '#445566'] })).json().ok).toBe(true);
    await walk(s, brasa.key, 'Brasa', 'village.square');
    expect((await s.act(brasa.key, 'board_post', { text: 'The bridge wobbles', tag: 'rumor' })).json().ok).toBe(true);
    s.clock.advance(4000);
    expect((await s.act(brasa.key, 'journal', { text: 'Founded a guild!' })).json().ok).toBe(true);

    const village = await pub(s, '/village');
    expect(village.headers['access-control-allow-origin']).toBe('*');
    expect(village.headers['cache-control']).toBe('public, max-age=5');
    const v = village.json();
    expect(v).toMatchObject({ population: 2, buildings: { 'village.river_bank': 'bridge' }, mayor: null, election: { n: 1, phase: 'candidacy' } });
    expect(v.projects.find((p: { id: string }) => p.id === 'bridge')).toMatchObject({ status: 'done', plaque: [{ name: 'Pip' }] });
    expect(village.body).not.toMatch(/"a\d[0-9a-z]*"/);

    const hist = (await pub(s, '/village/history')).json().days;
    expect(hist.at(-1)).toMatchObject({ date: '2026-01-01', projectsToday: 1, population: 2 });

    const tl = (await pub(s, '/timeline')).json().entries as TimelineEntry[];
    // Built in one go: no intermediate steps, then the project it unlocked opens.
    expect(tl.map((e) => e.type)).toEqual(['project_completed', 'project_available']);
    expect(tl[0]).toMatchObject({ project: 'bridge', plot: 'village.river_bank', building: 'bridge', progress: 1 });
    expect(tl[0]!.ts).toBeGreaterThanOrEqual(T0);

    const hs = (await pub(s, '/highlights?lang=en')).json();
    // The first guild is also a world first, and Brasa wrote about it right after.
    expect(hs.highlights.map((h: Highlight) => h.type)).toEqual(['journal_after', 'world_first', 'guild_founded', 'project_completed']);
    expect(hs.highlights[3].text).toMatch(/complete/);
    expect(hs.highlights[0]).toMatchObject({ quote: { text: 'Founded a guild!' }, ref: hs.highlights[1].id });
    const one = await pub(s, `/highlights/${hs.highlights[2].id}`);
    expect(one.json().highlight).toMatchObject({ type: 'guild_founded', params: { name: 'Brasa', guild: 'Iron Owls' } });
    expect((await pub(s, '/highlights/h999999')).statusCode).toBe(404);
    expect((await pub(s, `/highlights?before=${hs.highlights[2].id}`)).json().highlights).toHaveLength(1);
    expect((await pub(s, '/highlights?limit=abc')).statusCode).toBe(400);

    const index = (await pub(s, '/gazette')).json().editions;
    expect(index).toEqual([{ date: '2026-01-01', headline: expect.objectContaining({ k: expect.stringMatching(/^gazette\.headline\.project_completed\./) }), final: false }]);
    const ed = (await pub(s, '/gazette/2026-01-01?lang=en')).json() as GazetteEdition & { headline: { text: string } };
    expect(ed.headline.text).toMatch(/Bridge/i);
    expect(ed.sections.map((x) => x.id)).toEqual(expect.arrayContaining(['construction', 'guilds']));
    expect((await pub(s, '/gazette/2025-01-01')).statusCode).toBe(404);

    const board = (await pub(s, '/board?tag=rumor')).json();
    expect(board.posts).toEqual([expect.objectContaining({ by: 'Brasa', tag: 'rumor', text: 'The bridge wobbles', replies: [] })]);
    expect((await pub(s, '/board?tag=lfg')).json().posts).toEqual([]);

    const lb = (await pub(s, '/leaderboard?by=contribution')).json() as Leaderboard;
    expect(lb.rows).toEqual([expect.objectContaining({ rank: 1, name: 'Pip', value: expect.any(Number) })]);
    expect((await pub(s, '/leaderboard?by=nonsense')).statusCode).toBe(400);

    const g = (await pub(s, '/guilds/iron%20owls')).json();
    expect(g.guild).toMatchObject({ name: 'Iron Owls', motto: 'Hoot', motto_lang: 'en', colors: ['#112233', '#445566'], leader: 'Brasa', members: ['Brasa'] });
    // A guild founded before the motto language was kept has none: the field is left out.
    delete s.game.state.guilds.get(s.game.agentByName('Brasa')!.guild!)!.mottoLang;
    expect((await pub(s, '/guilds/iron%20owls')).json().guild).not.toHaveProperty('motto_lang');
    expect(g.highlights.map((h: Highlight) => h.type)).toEqual(['guild_founded']);
    expect((await pub(s, '/guilds/nobody')).statusCode).toBe(404);

    const prof = (await pub(s, '/agents/Brasa')).json().agent;
    expect(prof).toMatchObject({ name: 'Brasa', guild: { name: 'Iron Owls', rank: 'leader' }, reputation: { betrayals: 0 }, journal: [{ text: 'Founded a guild!' }], });
    expect(prof.highlights.map((h: Highlight) => h.type)).toEqual(['journal_after', 'world_first', 'guild_founded']);
    const pipProf = (await pub(s, '/agents/Pip')).json().agent;
    expect(pipProf.projects).toEqual([{ id: 'bridge', value: expect.any(Number), done: true }]);
  });

  it('leaderboards are cached for a minute, then reflect the changes', async () => {
    const s = await makeServer();
    await s.register('Pip');
    await s.register('Brasa');
    s.game.agentByName('Pip')!.gold = 500;
    s.game.agentByName('Brasa')!.gold = 100;
    const first = (await pub(s, '/leaderboard?by=wealth')).json() as Leaderboard;
    expect(first.rows.map((r) => [r.name, r.value])).toEqual([['Pip', 500], ['Brasa', 100]]);
    s.game.agentByName('Brasa')!.gold = 900;
    expect(((await pub(s, '/leaderboard?by=wealth')).json() as Leaderboard).rows[0]!.name).toBe('Pip');
    s.clock.advance(60_001);
    const later = (await pub(s, '/leaderboard?by=wealth')).json() as Leaderboard;
    expect(later.rows.map((r) => [r.rank, r.name, r.value])).toEqual([[1, 'Brasa', 900], [2, 'Pip', 500]]);
    s.game.agentByName('Pip')!.level = 7;
    s.clock.advance(60_001);
    expect(((await pub(s, '/leaderboard?by=level')).json() as Leaderboard).rows[0]).toMatchObject({ name: 'Pip', value: 7 });
    expect(((await pub(s, '/leaderboard?by=friends')).json() as Leaderboard).rows).toEqual([]);
  });
});

describe('Secrets Revealed', () => {
  const MARK = 'zebra-7741';

  async function secrets(s: TestServer) {
    const pip = await s.register('Pip');
    const brasa = await s.register('Brasa');
    expect((await s.act(pip.key, 'whisper', { to: 'Brasa', text: `whisper ${MARK}` })).json().ok).toBe(true);
    s.game.agentByName('Brasa')!.gold += 1000;
    await walk(s, brasa.key, 'Brasa', 'village.guild_hall');
    expect((await s.act(brasa.key, 'guild_create', { name: 'Iron Owls' })).json().ok).toBe(true);
    s.clock.advance(4000);
    expect((await s.act(brasa.key, 'guild_say', { text: `guild ${MARK}` })).json().ok).toBe(true);
    const brasaId = s.game.agentByName('Brasa')!.id;
    const ev: GameEvent = { id: String(++s.game.state.meta.eventSeq), ts: s.clock.now(), type: 'party_say', roomId: 'village.square', actor: brasaId, target: 'p1', visibility: 'delayed', revealAt: s.clock.now() + DAY, lang: 'en', payload: { text: `party ${MARK}` } };
    s.game.publish([ev]);
    return { pip, brasa, sentAt: T0 };
  }

  it('serves a secret exactly at its reveal time, never one millisecond earlier', async () => {
    const s = await makeServer();
    await secrets(s);
    const whisperAt = T0 + DAY;
    s.clock.t = whisperAt - 1;
    expect((await pub(s, '/secrets')).body).not.toContain(MARK);
    s.clock.t = whisperAt;
    const at = (await pub(s, '/secrets')).json().conversations as SecretConversation[];
    expect(at).toEqual([expect.objectContaining({ channel: 'whisper', agents: ['Pip', 'Brasa'], messages: [expect.objectContaining({ from: 'Pip', text: `whisper ${MARK}`, lang: 'en' })] })]);
    s.clock.t = whisperAt + 4000 + 1;
    const after = (await pub(s, '/secrets')).json().conversations as SecretConversation[];
    expect(after.map((c) => c.channel)).toEqual(['party', 'guild', 'whisper']);
    expect(after[1]).toMatchObject({ guild: 'Iron Owls', messages: [{ from: 'Brasa', text: `guild ${MARK}` }] });
  });

  it('pages older secrets from the store when the ring no longer holds them', async () => {
    const s = await makeServer();
    await secrets(s);
    await s.persistence.flushEvents();
    // A fresh server over the same store: the ring is refilled from the events table.
    const second = await makeServer({ store: s.store });
    second.clock.t = T0 + 2 * DAY;
    const page = (await pub(second, '/secrets?limit=2')).json();
    expect(page.conversations.flatMap((c: SecretConversation) => c.messages)).toHaveLength(2);
    const rest = (await pub(second, `/secrets?limit=2&before=${page.next}`)).json();
    expect(rest.conversations.flatMap((c: SecretConversation) => c.messages.map((m) => m.text))).toEqual([`whisper ${MARK}`]);
  });

  it('no other public route or WebSocket topic ever carries a delayed event, before or after its reveal', async () => {
    const s = await makeServer();
    const sock = viewer(s, 'world', 'village', 'room:village.square', 'agent:Pip');
    const { pip, brasa } = await secrets(s);
    const sock2 = viewer(s, 'agent:Brasa');
    const routes = [
      '/world',
      '/rooms/village.square',
      '/agents/Pip',
      '/agents/Brasa',
      '/stats',
      '/village',
      '/village/history',
      '/timeline',
      '/highlights',
      '/gazette',
      `/gazette/2026-01-01`,
      `/gazette/2026-01-02`,
      '/board',
      '/leaderboard?by=level',
      '/guilds/Iron%20Owls',
      '/i18n/en',
    ];
    const check = async () => {
      s.spectators.flush();
      for (const r of routes) expect((await pub(s, r)).body, r).not.toContain(MARK);
      for (const r of ['/api/v1/village', '/api/v1/agents/Brasa', '/api/v1/help']) expect((await s.app.inject({ method: 'GET', url: r })).body, r).not.toContain(MARK);
      expect(sock.text()).not.toContain(MARK);
      expect(sock2.text()).not.toContain(MARK);
    };
    await check();
    s.clock.advance(DAY + 10_000);
    await s.act(pip.key, 'say', { text: 'a day later' });
    await s.act(brasa.key, 'look');
    await s.chronicle.flush();
    await check();
    expect((await pub(s, '/secrets')).body).toContain(MARK);
    // And the store tables behind the public pages hold none either.
    expect(JSON.stringify([...s.store.highlights.values(), ...s.store.gazettes.values(), ...s.store.posts.values(), ...s.store.journal.values()])).not.toContain(MARK);
  });
});

describe('spectator protocol additions', () => {
  it('world and village batches carry project progress, buildings, halls, mayor, election and fresh counts; world carries highlights', async () => {
    const s = await makeServer();
    const pip = await s.register('Pip');
    const sock = viewer(s, 'world', 'village');
    const full = sock.msgs().find((m) => m.t === 'full' && m.topic === 'world') as { data: WorldFull };
    expect(full.data.projects.find((p) => p.id === 'bridge')).toMatchObject({ plot: 'village.river_bank', progress: 0, done: false, status: 'available', building: 'bridge' });
    s.clock.advance(1000);
    s.spectators.flush();
    expect(batches(sock, 'village').at(-1)!.village).toMatchObject({ population: 1 });

    await walk(s, pip.key, 'Pip', 'village.town_hall');
    s.game.agentByName('Pip')!.inv.wood = 10;
    expect((await s.act(pip.key, 'contribute', { project: 'bridge', items: { wood: 10 } })).json().ok).toBe(true);
    s.clock.advance(300);
    s.spectators.flush();
    const progress = batches(sock, 'world').at(-1)!.village!.projects!;
    expect(progress).toEqual([expect.objectContaining({ id: 'bridge', done: false, progress: expect.any(Number) })]);
    expect(progress[0]!.progress).toBeGreaterThan(0);

    await build(s, pip.key, 'Pip', 'bridge');
    s.clock.advance(300);
    s.spectators.flush();
    const w = batches(sock, 'world').at(-1)!;
    expect(w.village).toMatchObject({ buildings: { 'village.river_bank': 'bridge' } });
    expect(w.highlights).toEqual([expect.objectContaining({ type: 'project_completed', titleKey: 'highlight.project_completed', agents: ['Pip'] })]);
    expect(batches(sock, 'village').at(-1)!.village).toMatchObject({ buildings: { 'village.river_bank': 'bridge' } });

    // A guild hall, with its colours, on a free plot.
    const a = s.game.agentByName('Pip')!;
    a.gold += 1000;
    await walk(s, pip.key, 'Pip', 'village.guild_hall');
    expect((await s.act(pip.key, 'guild_create', { name: 'Iron Owls', colors: ['#112233', '#445566'] })).json().ok).toBe(true);
    const g = s.game.state.guilds.get(a.guild!)!;
    g.treasury += BALANCE.village.hall.gold;
    for (const x of BALANCE.village.hall.items) g.vault[x.item] = x.qty;
    const plot = [...s.game.content.rooms.values()].find((r) => r.flags.includes('plot') && ![...s.game.content.projects.values()].some((p) => p.site === r.id))!.id;
    await walk(s, pip.key, 'Pip', plot);
    expect((await s.act(pip.key, 'guild_build_hall', { plot })).json().ok).toBe(true);
    s.clock.advance(300);
    s.spectators.flush();
    expect(batches(sock, 'world').at(-1)!.village!.halls).toEqual({ [plot]: { guild: 'Iron Owls', colors: ['#112233', '#445566'], at: expect.any(Number) } });

    // The election phase change and a new mayor reach the village topic.
    const voter = await s.register('Voter');
    s.game.agentByName('Voter')!.level = BALANCE.election.voteLevel;
    await walk(s, voter.key, 'Voter', 'village.town_hall');
    await elect(s, pip.key, 'Pip', voter.key);
    s.spectators.flush();
    const vb = batches(sock, 'village').map((b) => b.village ?? {});
    // One flush after the whole election: the batch says where it ended (a new cycle) and who is mayor.
    expect(vb.some((d) => d.election?.n === 2 && d.election.phase === 'candidacy')).toBe(true);
    expect(vb.some((d) => d.mayor === 'Pip')).toBe(true);
    expect(vb.at(-1)!.population ?? vb.findLast((d) => d.population !== undefined)!.population).toBe(2);
  });

  it('the village topic carries the statue honoree: null before, in the delta that completes it, then in every full', async () => {
    const s = await makeServer();
    const pip = await s.register('Pip');
    const sock = viewer(s, 'world', 'village');
    const first = sock.msgs().find((m) => m.t === 'full' && m.topic === 'village') as { data: VillageFull };
    expect(first.data.honoree).toBeNull();
    for (const p of ['bridge', 'watchtower', 'inn_expansion']) await build(s, pip.key, 'Pip', p);
    s.clock.advance(300);
    s.spectators.flush();
    expect(batches(sock, 'village').some((b) => b.village && 'honoree' in b.village)).toBe(false);

    await build(s, pip.key, 'Pip', 'statue');
    s.clock.advance(300);
    s.spectators.flush();
    const sprite = s.game.agentByName('Pip')!.lookHash;
    const done = batches(sock, 'village').at(-1)!.village!;
    expect(done).toMatchObject({ buildings: expect.objectContaining({ 'village.square': 'statue' }), honoree: { name: 'Pip', sprite } });
    // Only on change: the next village batch does not repeat it; the world topic never carries it.
    expect(batches(sock, 'world').some((b) => b.village && 'honoree' in b.village)).toBe(false);
    s.game.agentByName('Pip')!.gold += 10;
    expect((await s.act(pip.key, 'contribute', { project: 'arena', gold: 10 })).json().ok).toBe(true);
    s.clock.advance(300);
    s.spectators.flush();
    expect(batches(sock, 'village').at(-1)!.village!.projects).toEqual([expect.objectContaining({ id: 'arena' })]);
    expect(batches(sock, 'village').at(-1)!.village).not.toHaveProperty('honoree');
    expect(batches(sock, 'village').filter((b) => b.village && 'honoree' in b.village)).toHaveLength(1);

    const later = viewer(s, 'village');
    expect((later.msgs().find((m) => m.t === 'full') as { data: VillageFull }).data.honoree).toEqual({ name: 'Pip', sprite });
  });
});

describe('a small story', () => {
  it('a project completed, a guild founded and an election held: highlights, the gazette and the timeline', async () => {
    const s = await makeServer();
    const pip = await s.register('Pip');
    const brasa = await s.register('Brasa');
    const voter = await s.register('Voter');
    // The bridge in two gifts: a quarter first, then the rest.
    await walk(s, pip.key, 'Pip', 'village.town_hall');
    s.game.agentByName('Pip')!.gold += 200;
    expect((await s.act(pip.key, 'contribute', { project: 'bridge', gold: 200 })).json().ok).toBe(true);
    await build(s, pip.key, 'Pip', 'bridge');
    s.game.agentByName('Brasa')!.gold += 1000;
    await walk(s, brasa.key, 'Brasa', 'village.guild_hall');
    expect((await s.act(brasa.key, 'guild_create', { name: 'Iron Owls' })).json().ok).toBe(true);
    s.game.agentByName('Voter')!.level = BALANCE.election.voteLevel;
    await walk(s, voter.key, 'Voter', 'village.town_hall');
    await elect(s, brasa.key, 'Brasa', voter.key);

    const hs = (await pub(s, '/highlights')).json().highlights as Highlight[];
    expect(hs.map((h) => [h.type, h.agents[0]])).toEqual(expect.arrayContaining([['project_completed', 'Pip'], ['guild_founded', 'Brasa'], ['mayor_elected', 'Brasa']]));

    // Day one's edition is final and leads with the bridge; the election day's edition leads with the mayor.
    const day1 = (await pub(s, '/gazette/2026-01-01?lang=en')).json() as GazetteEdition & { headline: { text: string } };
    expect(day1.final).toBe(true);
    expect(day1.headline.k).toMatch(/^gazette\.headline\.project_completed\./);
    expect(day1.sections.find((x) => x.id === 'guilds')!.items[0]!.k).toMatch(/^gazette\.item\.guild_founded\./);
    const today = (await pub(s, '/gazette')).json().editions[0];
    const ed = (await pub(s, `/gazette/${today.date}`)).json() as GazetteEdition;
    expect(ed.headline.k).toMatch(/^gazette\.headline\.mayor_elected\./);
    expect(ed.headline.p).toMatchObject({ name: 'Brasa', votes: 1 });
    expect(ed.sections.find((x) => x.id === 'election')!.items.map((i) => i.k.split('.')[2])).toEqual(expect.arrayContaining(['mayor_elected', 'election_candidacy', 'treasury']));
    // Quiet days in between still close: the index lists editions newest first.
    const dates = ((await pub(s, '/gazette')).json().editions as { date: string }[]).map((e) => e.date);
    expect(dates[0]).toBe(today.date);
    expect(dates).toContain('2026-01-01');

    const tl = (await pub(s, '/timeline')).json().entries as TimelineEntry[];
    expect(tl.filter((e) => e.project === 'bridge').map((e) => e.type)).toEqual(['project_started', 'project_completed']);
    expect(tl.map((e) => e.ts)).toEqual([...tl.map((e) => e.ts)].sort((x, y) => x - y));
  });
});
