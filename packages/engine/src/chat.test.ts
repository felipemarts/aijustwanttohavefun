import { describe, expect, it } from 'vitest';
import { BALANCE } from './balance';
import { REVEAL_AFTER_MS } from './actions/chat';
import { eventsSince } from './observe';
import { errCode, errKey, HOUR, keys, makeKit, MIN, SEC } from './testkit';

describe('say', () => {
  it('speaks to the room with sanitized text', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'warrior');
    const cursor = k.s.meta.eventSeq;
    const r = k.ok(a, 'say', { text: '  hi​ there,\n see https://evil.example/x and ajwf_sk_secret123  ' });
    expect(keys(r)).toEqual(['n.say']);
    const ev = r.events.find((e) => e.type === 'say')!;
    expect(ev.payload.text).toBe('hi there, see [link] and [redacted]');
    expect(ev.lang).toBe('en');
    expect(ev.visibility).toBe('room');
    expect(eventsSince(k.s, b.id, cursor).events).toEqual([ev]);
    expect(a.stats.says).toBe(1);
    expect(a.ap).toBe(BALANCE.ap.max);
  });

  it('masks blocked words and truncates long text', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const r = k.ok(a, 'say', { text: 'well shit happens ' + 'a'.repeat(900) });
    const text = r.events.find((e) => e.type === 'say')!.payload.text as string;
    expect(text).not.toContain('shit');
    expect([...text].length).toBe(500);
  });

  it('has a cooldown shared with whispers', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    k.add('Bob', 'warrior');
    k.step = SEC;
    k.ok(a, 'say', { text: 'one' });
    const r = k.act(a, 'say', { text: 'two' });
    expect(errCode(r)).toBe('COOLDOWN');
    expect(errKey(r)).toBe('err.chat_cooldown');
    expect(k.err(a, 'whisper', { to: 'Bob', text: 'psst' })).toBe('COOLDOWN');
    k.advance(BALANCE.chat.sayCooldownMs);
    k.ok(a, 'whisper', { to: 'Bob', text: 'psst' });
  });

  it('errors: empty after cleaning, unclaimed, muted; fallen agents can still talk', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    expect(errKey(k.act(a, 'say', { text: '​​ ' }))).toBe('err.empty_text');
    const wild = k.add('Wild', 'warrior', { claimed: false });
    expect(k.err(wild, 'say', { text: 'hello' })).toBe('UNCLAIMED_LIMIT');
    expect(k.err(wild, 'whisper', { to: 'Pip', text: 'hello' })).toBe('UNCLAIMED_LIMIT');
    k.ok(wild, 'emote', { emote: 'wave' });
    a.mutedUntil = k.now + 10 * MIN;
    expect(k.err(a, 'say', { text: 'hello' })).toBe('MUTED');
    expect(k.err(a, 'whisper', { to: 'Wild', text: 'hello' })).toBe('MUTED');
    k.ok(a, 'emote', { emote: 'cry' });
    const f = k.add('Fallen', 'warrior');
    f.hp = 0;
    f.fallen = { at: k.now, until: k.now + 10 * MIN };
    k.ok(f, 'say', { text: 'help!' });
    expect(k.err(f, 'emote', { emote: 'cry' })).toBe('DEAD');
  });
});

describe('whisper', () => {
  it('reaches the target anywhere, and becomes public 24 hours later', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'warrior', { room: 'forest.edge' });
    const r = k.ok(a, 'whisper', { to: 'bob', text: 'meet me at the tavern' });
    const ev = r.events.find((e) => e.type === 'whisper')!;
    expect(ev.visibility).toBe('delayed');
    expect(ev.revealAt).toBe(k.now + REVEAL_AFTER_MS);
    expect(REVEAL_AFTER_MS).toBe(24 * HOUR);
    expect(ev.target).toBe(b.id);
    expect(eventsSince(k.s, b.id, 0).events).toContain(ev);
    expect(a.stats.whispers).toBe(1);
  });

  it('errors: unknown agent, yourself', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    expect(errKey(k.act(a, 'whisper', { to: 'Ghost', text: 'boo' }))).toBe('err.agent_unknown');
    expect(errKey(k.act(a, 'whisper', { to: 'PIP', text: 'me' }))).toBe('err.not_yourself');
  });
});

describe('emote', () => {
  it('plays alone or at someone in the room', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    const b = k.add('Bob', 'warrior');
    const solo = k.ok(a, 'emote', { emote: 'Wave' });
    expect(solo.result.ok && solo.result.narration).toEqual([{ k: 'content.emote.wave.solo', p: { actor: 'Pip' } }]);
    const at = k.ok(a, 'emote', { emote: 'bow', target: 'Bob' });
    expect(at.result.ok && at.result.narration[0]).toEqual({ k: 'content.emote.bow.at', p: { actor: 'Pip', target: 'Bob' } });
    expect(at.events[0]!.target).toBe(b.id);
    const r = k.act(a, 'emote', { emote: 'moonwalk' });
    expect(errCode(r)).toBe('TARGET_NOT_FOUND');
    expect(errKey(r)).toBe('err.emote_unknown');
    k.place(b, 'village.tavern');
    expect(errKey(k.act(a, 'emote', { emote: 'bow', target: 'Bob' }))).toBe('err.agent_not_here');
  });

  it('set_language changes the language of later messages', () => {
    const k = makeKit();
    const a = k.add('Pip', 'warrior');
    k.ok(a, 'set_language', { language: 'pt-BR' });
    expect(a.lang).toBe('pt-BR');
    expect(k.err(a, 'set_language', { language: 'not a language!' })).toBe('INVALID_PARAMS');
    const r = k.ok(a, 'say', { text: 'olá' });
    expect(r.events[0]!.lang).toBe('pt-BR');
  });
});
