import { describe, expect, it } from 'vitest';
import type { Core, CoreEvent } from '../src/api.ts';
import { CoreFault } from '../src/util/errors.ts';
import { validateSchema } from '../src/playkit/decide.ts';
import { fromPlain } from '../src/playkit/jv.ts';

type JsonSchema = Record<string, unknown>;
import type { Fetch } from '../src/ports.ts';
import { FakeClock, FakeGame, MemoryModelFiles } from '../src/testing/index.ts';
import { drive, makeRig, newChar, TEST_MODEL } from './helpers.ts';

// Strict runtime schemas of `core-api.ts` (no extra fields allowed), to check every object the core hands out.
const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const gauge = { type: 'array', items: num, minItems: 2, maxItems: 2 };
const obj = (properties: Record<string, unknown>, required: string[]): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const status = { enum: ['playing', 'thinking', 'resting', 'paused', 'fallen', 'blocked'] };
const away = obj({ since: num, actions: num, levels: num, xp: num, gold: num, kills: num, deaths: num, highlights: { type: 'array', items: str, maxItems: 5 } }, ['since', 'actions', 'levels', 'xp', 'gold', 'kills', 'deaths', 'highlights']);
const summaryProps = {
  id: str,
  name: str,
  class: { enum: ['warrior', 'mage', 'rogue', 'cleric'] },
  level: num,
  xp: gauge,
  hp: gauge,
  mp: gauge,
  ap: gauge,
  gold: num,
  room: obj({ id: str, name: str }, ['id', 'name']),
  sprite: { type: ['string', 'null'] },
  title: { type: ['string', 'null'] },
  status,
  activity: str,
  nextActionAt: num,
  problem: str,
  claimed: bool,
  claimPending: bool,
  watchUrl: str,
  away,
};
const summaryReq = ['id', 'name', 'class', 'level', 'xp', 'hp', 'mp', 'ap', 'gold', 'room', 'sprite', 'title', 'status', 'activity', 'claimed', 'claimPending', 'watchUrl'];
const Summary = obj(summaryProps, summaryReq);
const EventSummary = Summary;
const Directives = obj({ persona: str, wish: str, pace: { enum: ['relaxed', 'normal', 'active'] }, allowPvp: bool }, ['persona', 'wish', 'pace', 'allowPvp']);
const Detail = obj(
  {
    ...summaryProps,
    bio: str,
    stats: { type: 'array', items: obj({ id: str, name: str, value: num }, ['id', 'name', 'value']) },
    inventory: { type: 'array', items: obj({ id: str, name: str, qty: num, slot: obj({ id: str, name: str }, ['id', 'name']) }, ['id', 'name', 'qty']) },
    quests: { type: 'array', items: obj({ id: str, name: str, steps: { type: 'array', items: obj({ text: str, have: num, need: num }, ['text', 'have', 'need']) }, ready: bool }, ['id', 'name', 'steps', 'ready']) },
    achievements: { type: 'array', items: str },
    party: { anyOf: [{ type: 'null' }, obj({ members: { type: 'array', items: str } }, ['members'])] },
    guild: { type: ['string', 'null'] },
    directives: Directives,
    memory: { type: 'array', items: str },
  },
  [...summaryReq, 'bio', 'stats', 'inventory', 'quests', 'achievements', 'party', 'guild', 'directives', 'memory'],
);
const LogEntry = obj(
  {
    id: str,
    ts: num,
    kind: { enum: ['action', 'refused', 'event', 'system'] },
    text: str,
    action: str,
    thought: str,
    quote: obj({ from: str, text: str }, ['from', 'text']),
    delta: obj({ xp: num, gold: num, hp: num, level: num }, []),
    big: bool,
  },
  ['id', 'ts', 'kind', 'text'],
);
const ChatMessage = obj({ id: str, ts: num, from: { enum: ['owner', 'character'] }, text: str }, ['id', 'ts', 'from', 'text']);
const kind = { enum: ['builtin', 'ollama', 'lmstudio', 'openai'] };
const EngineState = obj(
  {
    choice: obj({ kind, url: str, model: str, hasApiKey: bool }, ['kind']),
    status: { enum: ['not_installed', 'downloading', 'starting', 'ready', 'unreachable', 'error'] },
    builtin: obj({ model: str, file: str, licenseName: str, licenseUrl: str, bytesTotal: num, bytesDone: num }, ['model', 'file', 'licenseName', 'licenseUrl', 'bytesTotal', 'bytesDone']),
    message: str,
    tokensPerSecond: num,
  },
  ['choice', 'status'],
);
const ProviderInfo = obj({ kind, label: str, url: str, reachable: bool, models: { type: 'array', items: str } }, ['kind', 'label', 'reachable', 'models']);
const EngineTest = obj({ ok: bool, tokensPerSecond: num, validJson: bool, sample: str, message: str }, ['ok', 'tokensPerSecond', 'validJson', 'sample']);
const Settings = obj({ serverUrl: str, language: str, keepAwake: bool }, ['serverUrl', 'language']);
const Server = obj({ reachable: bool, skillVersion: str }, ['reachable']);
const CoreState = obj(
  { version: str, playkit: str, platform: { enum: ['desktop', 'mobile'] }, settings: Settings, engine: EngineState, characters: { type: 'array', items: Summary }, server: Server },
  ['version', 'playkit', 'platform', 'settings', 'engine', 'characters', 'server'],
);
const AppearanceOptions = obj({ optionsToken: str, expiresIn: num, options: { type: 'object', additionalProperties: { type: 'object', additionalProperties: str } } }, ['optionsToken', 'expiresIn', 'options']);
const CoreEventSchema: JsonSchema = {
  anyOf: [
    obj({ type: { const: 'character' }, character: EventSummary }, ['type', 'character']),
    obj({ type: { const: 'removed' }, id: str }, ['type', 'id']),
    obj({ type: { const: 'log' }, id: str, entry: LogEntry }, ['type', 'id', 'entry']),
    obj({ type: { const: 'engine' }, engine: EngineState }, ['type', 'engine']),
    obj({ type: { const: 'chat' }, id: str, messageId: str, token: str, done: bool }, ['type', 'id', 'messageId', 'token']),
    obj({ type: { const: 'server' }, server: Server }, ['type', 'server']),
  ],
};

function ok(schema: JsonSchema, v: unknown, what: string): void {
  const p = validateSchema(fromPlain(v), fromPlain(schema), '$');
  const problem = p === '' ? null : p;
  expect(problem, `${what}: ${problem} in ${JSON.stringify(v).slice(0, 400)}`).toBeNull();
}

async function fault(p: Promise<unknown>): Promise<CoreFault> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(CoreFault);
  return e as CoreFault;
}

describe('the Core contract', () => {
  it('every method works and every returned or emitted object matches the types', async () => {
    const clock = new FakeClock();
    const game = new FakeGame(clock);
    const ai: Fetch = async (url) =>
      url.endsWith('/api/tags')
        ? new Response(JSON.stringify({ models: [{ name: 'lfm3' }] }), { status: 200 })
        : new Response(JSON.stringify({ message: { content: '{"greeting":"hi","ready":true}' }, done: true, eval_count: 4 }), { status: 200 });
    const fetch: Fetch = (url, init) => (url.startsWith('http://192.168.1.20:11434') ? ai(url, init) : game.fetch(url, init));
    const files = new MemoryModelFiles();
    const rig = await makeRig({ clock, game, fetch, files });
    const core: Core = rig.core; // compile-time conformance
    const seen: CoreEvent[] = [];
    const stop = core.subscribe((e) => seen.push(e));

    ok(CoreState, await core.state(), 'state');
    ok(Settings, await core.settings(), 'settings');
    ok(AppearanceOptions, await core.appearanceOptions(), 'appearanceOptions');
    ok(EngineState, await core.engine(), 'engine');
    for (const p of await core.providers()) ok(ProviderInfo, p, 'provider');

    // Built-in download: start, progress, finish.
    files.present.delete(TEST_MODEL.file);
    files.gate = () => new Promise((r) => setTimeout(r, 0));
    const started = await core.startDownload();
    ok(EngineState, started, 'startDownload');
    expect(started.status).toBe('downloading');
    await rig.core.downloadSettled();
    const done = await core.engine();
    expect(done.status).toBe('ready');
    expect(done.builtin?.bytesDone).toBe(TEST_MODEL.bytes);
    ok(EngineTest, await core.testEngine(), 'testEngine');

    // Characters.
    const a = await core.createCharacter(newChar('Ana'));
    ok(Summary, a, 'createCharacter');
    expect(a.claimPending).toBe(true);
    expect(await core.claimLink(a.id)).toContain('/claim/');
    expect(JSON.stringify(await core.state())).not.toContain('/claim/');
    expect(a.watchUrl).toBe(`${game.base}/a/Ana`);
    expect(a.sprite).toBe(`${game.base}/sprites/ana.png`);
    const opts = await core.appearanceOptions();
    const b = await core.createCharacter({ ...newChar('Bea'), class: 'rogue', bio: 'A quiet rogue.', wish: 'get rich', pace: 'active', allowPvp: true, appearance: { optionsToken: opts.optionsToken, choice: { species: 'elf', hat: 'cap' } } });
    const bd = await core.character(b.id);
    expect(bd.directives).toEqual({ persona: newChar().persona, wish: 'get rich', pace: 'active', allowPvp: true });
    expect(bd.bio).toBe('A quiet rogue.');
    // The public bio went to the game; the private persona did not.
    const reg = game.requests.filter((q) => q.path === '/api/v1/agents/register').map((q) => q.body as Record<string, unknown>);
    expect(reg.find((x) => x.name === 'Bea')?.bio).toBe('A quiet rogue.');
    expect(JSON.stringify(reg)).not.toContain(newChar().persona);
    expect((await fault(core.createCharacter({ ...newChar('Long'), bio: 'x'.repeat(301) }))).code).toBe('invalid');
    ok(Summary, b, 'createCharacter (choice)');
    expect((await fault(core.createCharacter(newChar('Ana')))).code).toBe('NAME_TAKEN');
    expect((await fault(core.createCharacter({ ...newChar('x'), name: 'x' }))).code).toBe('INVALID_NAME');
    expect((await fault(core.createCharacter({ ...newChar('Zed'), class: 'bard' as never }))).code).toBe('invalid');

    await clock.advance(3 * 60_000);
    const d = await core.character(a.id);
    ok(Detail, d, 'character');
    expect(d.inventory.find((i) => i.slot?.id === 'weapon')?.slot?.name).toBe('Weapon');
    expect(d.stats.find((x) => x.id === 'int')).toEqual({ id: 'int', name: 'Intellect', value: 12 });
    // Opening the detail does not clear "while you were away"; `seen` does.
    expect(d.away?.actions).toBeGreaterThan(0);
    expect((await core.character(a.id)).away?.actions).toBeGreaterThan(0);
    ok(Summary, await core.seen(a.id), 'seen');
    expect((await core.character(a.id)).away).toBeUndefined();
    expect((await fault(core.seen('nope'))).code).toBe('not_found');
    expect(d.quests[0]?.steps[0]?.need).toBe(1);
    expect(d.achievements).toEqual(['first_steps']);
    expect((await fault(core.character('nope'))).code).toBe('not_found');

    // The log pages newest first, without overlap.
    const page1 = await core.log(a.id, { limit: 5 });
    const page2 = await core.log(a.id, { before: page1.at(-1)!.id, limit: 5 });
    for (const e of [...page1, ...page2]) ok(LogEntry, e, 'log');
    expect(page1.length).toBe(5);
    expect(page2[0]!.id < page1.at(-1)!.id).toBe(true);
    expect([...page1, ...page2].map((e) => e.id)).toEqual([...page1, ...page2].map((e) => e.id).sort().reverse());
    expect(page1.some((e) => e.kind === 'action' && e.thought)).toBe(true);

    ok(Summary, await core.control(a.id, false), 'control(false)');
    expect((await core.control(a.id, false)).status).toBe('paused');
    ok(Summary, await core.control(a.id, true), 'control(true)');
    ok(Directives, await core.setDirectives(a.id, { persona: 'Brave.', wish: 'Get rich', pace: 'active', allowPvp: true }), 'setDirectives');
    expect((await fault(core.setDirectives(a.id, { persona: '', wish: '', pace: 'turbo' as never, allowPvp: false }))).code).toBe('invalid');
    await core.command(a.id, 'Find Olga');
    expect((await fault(core.command(a.id, '   '))).code).toBe('invalid');

    const reply = await drive(clock, core.chat(a.id, 'How are you?'), 50);
    ok(ChatMessage, reply, 'chat');
    expect(seen.some((e) => e.type === 'chat' && e.messageId === reply.id && !e.done && e.token)).toBe(true);
    expect(seen.some((e) => e.type === 'chat' && e.messageId === reply.id && e.done)).toBe(true);
    const hist = await core.chatHistory(a.id);
    for (const m of hist) ok(ChatMessage, m, 'chatHistory');
    expect(hist.map((m) => m.from)).toEqual(['owner', 'character']);

    ok(Settings, await core.setSettings({ language: 'pt-BR', keepAwake: true }), 'setSettings');
    expect((await core.state()).characters.find((c) => c.id === b.id)!.activity).not.toBe('');
    expect((await fault(core.setSettings({ serverUrl: 'ftp://x' }))).code).toBe('INVALID_URL');
    expect((await fault(core.setSettings({ serverUrl: 'http://u:p@x.test' }))).code).toBe('INVALID_URL');
    expect((await fault(core.setSettings({ language: 'not a tag!' }))).code).toBe('invalid');

    // External engine on the home network.
    const ext = await core.setEngine({ kind: 'ollama', url: 'http://192.168.1.20:11434/', model: 'lfm3' });
    ok(EngineState, ext, 'setEngine');
    expect(ext.status).toBe('ready');
    expect(ext.choice.url).toBe('http://192.168.1.20:11434');
    expect((await fault(core.setEngine({ kind: 'ollama', url: 'javascript:alert(1)' }))).code).toBe('INVALID_URL');
    // One address the owner typed: what answers there.
    const one = await core.probeProvider('http://192.168.1.20:11434/');
    expect(one).toEqual({ kind: 'ollama', label: 'Ollama', url: 'http://192.168.1.20:11434', reachable: true, models: ['lfm3'] });
    const none = await core.probeProvider('http://10.9.9.9:1');
    expect(none.reachable).toBe(false);
    for (const p of [one, none]) ok(ProviderInfo, p, 'probeProvider');
    expect((await fault(core.probeProvider('file:///etc/passwd'))).code).toBe('INVALID_URL');
    expect((await fault(core.setEngine({ kind: 'nope' as never }))).code).toBe('invalid');
    const t = await core.testEngine();
    ok(EngineTest, t, 'testEngine (ollama)');
    expect(t.validJson).toBe(true);
    ok(EngineState, await core.setEngine({ kind: 'builtin' }), 'setEngine builtin');

    // Pause and cancel a download (the contract has cancel; pause is the proposed addition).
    files.present.delete(TEST_MODEL.file);
    let step: () => void = () => undefined;
    files.gate = () => new Promise<void>((r) => (step = r));
    await core.startDownload();
    step();
    await clock.settle();
    const paused = await core.pauseDownload();
    ok(EngineState, paused, 'pauseDownload');
    expect(paused.status).toBe('not_installed');
    expect(paused.builtin!.bytesDone).toBeGreaterThan(0);
    expect(paused.builtin!.bytesDone).toBeLessThan(paused.builtin!.bytesTotal);
    expect(files.present.get(TEST_MODEL.file)?.complete).toBe(false);
    files.gate = () => Promise.resolve();
    void core.startDownload();
    await clock.settle();
    const cancelled = await core.cancelDownload();
    ok(EngineState, cancelled, 'cancelDownload');

    await core.forget(b.id);
    expect(seen.some((e) => e.type === 'removed' && e.id === b.id)).toBe(true);
    expect((await core.state()).characters.map((c) => c.id)).toEqual([a.id]);
    expect([...rig.vault.data.keys()].some((k) => k.includes(b.id))).toBe(false);
    expect([...rig.storage.data.keys()].some((k) => k.includes(b.id))).toBe(false);

    for (const e of [...seen, ...rig.events]) ok(CoreEventSchema, e, `event ${e.type}`);
    const types = new Set([...seen, ...rig.events].map((e) => e.type));
    for (const tp of ['character', 'log', 'engine', 'chat', 'removed', 'server']) expect(types.has(tp as CoreEvent['type']), tp).toBe(true);
    stop();
    const n = seen.length;
    await clock.advance(10_000);
    expect(seen.length).toBe(n);
    await rig.core.close();
  });

  it('refuses a download the build has not pinned, and one that does not fit', async () => {
    const files = new MemoryModelFiles();
    const unpinned = await makeRig({ files, extra: { model: { ...TEST_MODEL, sha256: '' } } });
    expect((await fault(unpinned.core.startDownload())).code).toBe('engine');
    expect((await unpinned.core.engine()).message).toMatch(/not pinned/);
    await unpinned.core.close();
    const small = new MemoryModelFiles();
    small.free = 10;
    const tight = await makeRig({ files: small });
    expect((await fault(tight.core.startDownload())).code).toBe('no_space');
    await tight.core.close();
  });

  it('a failed download says so without the port\'s error text, and resumes from where it stopped', async () => {
    const files = new MemoryModelFiles();
    files.failAt = TEST_MODEL.bytes / 2;
    const rig = await makeRig({ files });
    await rig.core.startDownload();
    await rig.core.downloadSettled();
    const st = await rig.core.engine();
    expect(st.status).toBe('error');
    expect(st.message).not.toContain('/private');
    expect(st.builtin!.bytesDone).toBe(TEST_MODEL.bytes / 2);
    await rig.core.startDownload();
    await rig.core.downloadSettled();
    expect((await rig.core.engine()).status).toBe('ready');
    expect(files.requests.length).toBe(2);
    await rig.core.close();
  });

  it('keeps settings and characters across restarts', async () => {
    const rig = await makeRig();
    await rig.core.setSettings({ language: 'pt-BR' });
    const c = await rig.core.createCharacter(newChar());
    await rig.core.close();
    const again = await makeRig({ storage: rig.storage, vault: rig.vault, clock: rig.clock, game: rig.game, files: rig.files });
    const s = await again.core.state();
    expect(s.settings.language).toBe('pt-BR');
    expect(s.characters.map((x) => x.id)).toEqual([c.id]);
    expect(s.characters[0]!.claimPending).toBe(true);
    expect(await again.core.claimLink(c.id)).toContain('/claim/');
    // Once claimed on the site, the link is dropped.
    rig.game.agents.get('Pip')!.claimed = true;
    await again.clock.advance(31_000);
    const d = await again.core.character(c.id);
    expect(d.claimed).toBe(true);
    expect(d.claimPending).toBe(false);
    expect(await again.core.claimLink(c.id)).toBeNull();
    expect([...rig.vault.data.keys()].some((k) => k.endsWith('.claim'))).toBe(false);
    await again.core.close();
  });
});
