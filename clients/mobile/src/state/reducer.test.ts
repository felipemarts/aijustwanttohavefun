import { describe, expect, it } from 'vitest';
import type { CharacterSummary, CoreState, LogEntry } from '../core/types';
import { initialState, mergeEntries, reduce, type Action, type AppState } from './reducer';

function char(id: string, over: Partial<CharacterSummary> = {}): CharacterSummary {
  return {
    id,
    name: id.toUpperCase(),
    class: 'mage',
    level: 3,
    xp: [10, 520],
    hp: [50, 100],
    mp: [20, 80],
    ap: [100, 240],
    gold: 30,
    room: { id: 'village.square', name: 'Square' },
    sprite: null,
    title: null,
    status: 'playing',
    activity: 'Walking',
    claimed: true,
    claimPending: false,
    watchUrl: 'https://game.example/agents/x',
    ...over,
  };
}

function coreState(chars: CharacterSummary[]): CoreState {
  return {
    version: '1',
    playkit: '1',
    platform: 'desktop',
    settings: { serverUrl: 'https://game.example', language: 'en' },
    engine: { choice: { kind: 'builtin' }, status: 'ready' },
    characters: chars,
    server: { reachable: true },
  };
}

const entry = (id: string, ts = Number(id)): LogEntry => ({ id, ts, kind: 'action', text: `e${id}` });
const run = (s: AppState, ...actions: Action[]) => actions.reduce(reduce, s);

describe('reduce', () => {
  it('loads the core state', () => {
    const s = run(initialState, { t: 'loaded', state: coreState([char('a'), char('b')]) });
    expect(s.phase).toBe('ready');
    expect(s.characters.map((c) => c.id)).toEqual(['a', 'b']);
    expect(s.core?.engine.status).toBe('ready');
  });

  it('a later load drops characters that are gone and keeps the core order', () => {
    const s = run(
      initialState,
      { t: 'loaded', state: coreState([char('a'), char('b'), char('c')]) },
      { t: 'loaded', state: coreState([char('c'), char('a')]) },
    );
    expect(s.characters.map((c) => c.id)).toEqual(['c', 'a']);
  });

  it('a load failure before the first load is an error; after it, the screen stays', () => {
    expect(run(initialState, { t: 'failed', code: 'network', message: '' }).phase).toBe('error');
    const s = run(initialState, { t: 'loaded', state: coreState([]) }, { t: 'failed', code: 'network', message: '' });
    expect(s.phase).toBe('ready');
    expect(s.error?.code).toBe('network');
  });

  it('celebrates a level going up, and only up', () => {
    let s = run(initialState, { t: 'loaded', state: coreState([char('a', { level: 3 })]) });
    s = reduce(s, { t: 'event', ev: { type: 'character', character: char('a', { level: 3, gold: 99 }) }, now: 1 });
    expect(s.celebrations).toEqual({});
    s = reduce(s, { t: 'event', ev: { type: 'character', character: char('a', { level: 4 }) }, now: 5 });
    expect(s.celebrations.a).toEqual({ level: 4, at: 5 });
    s = reduce(s, { t: 'clearCelebration', id: 'a' });
    expect(s.celebrations).toEqual({});
  });

  it('a new character appends; removed forgets everything about it', () => {
    let s = run(initialState, { t: 'loaded', state: coreState([char('a')]) });
    s = reduce(s, { t: 'event', ev: { type: 'character', character: char('b') }, now: 1 });
    s = reduce(s, { t: 'logPage', id: 'b', entries: [entry('1')], older: false, limit: 40 });
    s = reduce(s, { t: 'chatMessage', id: 'b', message: { id: 'm', ts: 1, from: 'owner', text: 'hi' } });
    s = reduce(s, { t: 'event', ev: { type: 'removed', id: 'b' }, now: 2 });
    expect(s.characters.map((c) => c.id)).toEqual(['a']);
    expect(s.logs.b).toBeUndefined();
    expect(s.chats.b).toBeUndefined();
  });

  it('live log entries go to open logs only, newest first, without duplicates', () => {
    let s = run(initialState, { t: 'loaded', state: coreState([char('a'), char('b')]) });
    s = reduce(s, { t: 'event', ev: { type: 'log', id: 'b', entry: entry('5') }, now: 0 });
    expect(s.logs.b).toBeUndefined();
    s = reduce(s, { t: 'logPage', id: 'a', entries: [entry('3'), entry('2')], older: false, limit: 2 });
    s = reduce(s, { t: 'event', ev: { type: 'log', id: 'a', entry: entry('4') }, now: 0 });
    s = reduce(s, { t: 'event', ev: { type: 'log', id: 'a', entry: entry('4') }, now: 0 });
    expect(s.logs.a!.entries.map((e) => e.id)).toEqual(['4', '3', '2']);
  });

  it('an older page shorter than the limit marks the log exhausted', () => {
    let s = reduce(initialState, { t: 'logPage', id: 'a', entries: [entry('9'), entry('8')], older: false, limit: 2 });
    expect(s.logs.a!.exhausted).toBe(false);
    s = reduce(s, { t: 'logLoading', id: 'a' });
    expect(s.logs.a!.loading).toBe(true);
    s = reduce(s, { t: 'logPage', id: 'a', entries: [entry('7')], older: true, limit: 2 });
    expect(s.logs.a).toMatchObject({ loading: false, exhausted: true });
    expect(s.logs.a!.entries.map((e) => e.id)).toEqual(['9', '8', '7']);
  });

  it('a first page shorter than the limit means there is nothing older', () => {
    const s = reduce(initialState, { t: 'logPage', id: 'a', entries: [entry('1')], older: false, limit: 40 });
    expect(s.logs.a!.exhausted).toBe(true);
  });

  it('caps the log', () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(String(100 + i)));
    expect(mergeEntries(many, [], 10).map((e) => e.id)).toEqual(many.slice(-10).reverse().map((e) => e.id));
  });

  it('streams chat tokens into one message, then files it', () => {
    let s = initialState;
    for (const token of ['Hel', 'lo ', 'there']) s = reduce(s, { t: 'event', ev: { type: 'chat', id: 'a', messageId: 'm1', token }, now: 1 });
    expect(s.streams.a).toEqual({ messageId: 'm1', text: 'Hello there' });
    s = reduce(s, { t: 'event', ev: { type: 'chat', id: 'a', messageId: 'm1', token: '!', done: true }, now: 2 });
    expect(s.streams.a).toBeUndefined();
    expect(s.chats.a).toEqual([{ id: 'm1', ts: 2, from: 'character', text: 'Hello there!' }]);
    // The POST answer with the same id replaces, never duplicates.
    s = reduce(s, { t: 'chatMessage', id: 'a', message: { id: 'm1', ts: 3, from: 'character', text: 'Hello there!' } });
    expect(s.chats.a).toHaveLength(1);
  });

  it('a new message id restarts the stream', () => {
    let s = reduce(initialState, { t: 'event', ev: { type: 'chat', id: 'a', messageId: 'm1', token: 'old' }, now: 1 });
    s = reduce(s, { t: 'event', ev: { type: 'chat', id: 'a', messageId: 'm2', token: 'new' }, now: 1 });
    expect(s.streams.a).toEqual({ messageId: 'm2', text: 'new' });
  });

  it('chat history merges with lines already shown', () => {
    let s = reduce(initialState, { t: 'chatMessage', id: 'a', message: { id: 'local-1', ts: 5, from: 'owner', text: 'hi' } });
    s = reduce(s, { t: 'chatHistory', id: 'a', messages: [{ id: 'x', ts: 1, from: 'character', text: 'before' }] });
    expect(s.chats.a!.map((m) => m.id)).toEqual(['x', 'local-1']);
  });

  it('engine, server and settings updates land in the core state', () => {
    let s = run(initialState, { t: 'loaded', state: coreState([]) });
    s = reduce(s, { t: 'event', ev: { type: 'engine', engine: { choice: { kind: 'ollama' }, status: 'unreachable' } }, now: 0 });
    s = reduce(s, { t: 'event', ev: { type: 'server', server: { reachable: false } }, now: 0 });
    s = reduce(s, { t: 'settings', settings: { serverUrl: 'https://x.example', language: 'pt-BR' } });
    expect(s.core?.engine.status).toBe('unreachable');
    expect(s.core?.server.reachable).toBe(false);
    expect(s.core?.settings.language).toBe('pt-BR');
  });

  it('a detail refresh also refreshes the summary, and summaries refresh the detail', () => {
    let s = run(initialState, { t: 'loaded', state: coreState([char('a', { away: { since: 1, actions: 3, levels: 0, xp: 0, gold: 0, kills: 0, deaths: 0, highlights: [] } })]) });
    s = reduce(s, {
      t: 'detail',
      detail: { ...char('a'), bio: '', stats: [], inventory: [], quests: [], achievements: [], party: null, guild: null, memory: [], directives: { persona: '', wish: '', pace: 'normal', allowPvp: false } },
    });
    expect(s.characters[0]!.away).toBeUndefined();
    expect('bio' in s.characters[0]!).toBe(false);
    s = reduce(s, { t: 'event', ev: { type: 'character', character: char('a', { gold: 77 }) }, now: 0 });
    expect(s.details.a!.gold).toBe(77);
  });
});

describe('recent entries for Home', () => {
  it('keep the last few entries of every character from live events, opened or not', () => {
    let s = reduce(initialState, { t: 'event', ev: { type: 'log', id: 'b', entry: entry('005') }, now: 0 });
    s = reduce(s, { t: 'event', ev: { type: 'log', id: 'b', entry: entry('006') }, now: 0 });
    expect(s.recent.b!.map((e) => e.id)).toEqual(['006', '005']);
    expect(s.logs.b).toBeUndefined();
    for (let i = 10; i < 40; i++) s = reduce(s, { t: 'event', ev: { type: 'log', id: 'b', entry: entry(String(i).padStart(3, '0')) }, now: 0 });
    expect(s.recent.b).toHaveLength(16);
    expect(s.recent.b![0]!.id).toBe('039');
    s = reduce(s, { t: 'event', ev: { type: 'removed', id: 'b' }, now: 0 });
    expect(s.recent.b).toBeUndefined();
  });

  it('merge a fetched page with what arrived live', () => {
    let s = reduce(initialState, { t: 'event', ev: { type: 'log', id: 'a', entry: entry('009') }, now: 0 });
    s = reduce(s, { t: 'recent', id: 'a', entries: [entry('008'), entry('007')] });
    expect(s.recent.a!.map((e) => e.id)).toEqual(['009', '008', '007']);
  });
});

describe('status since', () => {
  it('records when a character entered its status, and keeps it while the status stays', () => {
    let s = reduce(initialState, { t: 'character', character: char('a', { status: 'playing' }), now: 100 });
    expect(s.statusSince.a).toBe(100);
    s = reduce(s, { t: 'event', ev: { type: 'character', character: char('a', { status: 'thinking' }) }, now: 200 });
    s = reduce(s, { t: 'event', ev: { type: 'character', character: char('a', { status: 'thinking', gold: 5 }) }, now: 300 });
    expect(s.statusSince.a).toBe(200);
  });
});
