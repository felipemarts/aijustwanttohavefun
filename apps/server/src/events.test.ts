import { BALANCE } from '@ajwf/engine';
import type { GameEvent } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { createI18n, loadCatalogs } from './i18n';
import { Renderer } from './render';
import { EVENTS_PAGE } from './routes/agent';
import { makeServer } from './test-helpers';

type Entry = { kind: string; n?: number; text?: string; id: string };

describe('GET /events', () => {
  it('pages 50 events at a time and summarizes repeats of the same type and actor', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    const brasa = await s.register('Brasa');
    const emote = [...s.game.content.emotes.keys()][0]!;
    for (let i = 0; i < 60; i++) {
      // One emote per sender per interval reaches other inboxes.
      s.clock.advance(BALANCE.chat.emoteInboxMs);
      expect((await s.act(brasa.key, 'emote', { emote })).json().ok).toBe(true);
    }

    const page1 = (await s.get(key, '/api/v1/events?since=0')).json();
    expect(page1.more).toBe(true);
    const kinds1 = (page1.events as Entry[]).map((e) => e.kind);
    expect(kinds1).toEqual(['arrival', 'arrival', 'emote']);
    const emotes1 = (page1.events as Entry[])[2]!;
    expect(emotes1.n).toBe(EVENTS_PAGE - 2);
    expect(emotes1.text).toMatch(/\(×48\)$/);
    expect(emotes1.id).toBe(page1.cursor);

    const page2 = (await s.get(key, `/api/v1/events?since=${page1.cursor}`)).json();
    expect(page2.more).toBeUndefined();
    expect(page2.events).toHaveLength(1);
    expect(page2.events[0].n).toBe(12);

    const empty = (await s.get(key, `/api/v1/events?since=${page2.cursor}`)).json();
    expect(empty).toEqual({ ok: true, events: [], cursor: page2.cursor });
    // What /events delivered is not repeated by the next /look.
    expect((await s.get(key, '/api/v1/look')).json().messages).toBeUndefined();
  });

  it('never merges text written by agents', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    const brasa = await s.register('Brasa');
    for (const text of ['one', 'two']) {
      await s.act(brasa.key, 'say', { text });
      s.clock.advance(5000);
    }
    const events = (await s.get(key, '/api/v1/events?since=0')).json().events as { kind: string; untrusted_text?: string }[];
    expect(events.filter((e) => e.kind === 'say').map((e) => e.untrusted_text)).toEqual(['one', 'two']);
  });

  it('rejects a malformed cursor with INVALID_PARAMS', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    const res = await s.get(key, '/api/v1/events?since=abc');
    expect(res.statusCode).toBe(200);
    expect(res.json().error.code).toBe('INVALID_PARAMS');
  });
});

describe('event summaries', () => {
  it('adds up damage: "You were hit 4 times for 37 total damage."', async () => {
    const s = await makeServer();
    const r = new Renderer(createI18n(loadCatalogs(), () => undefined), s.game.state);
    const hit = (id: number, dmg: number): GameEvent => ({
      id: String(id),
      ts: 0,
      type: 'hit',
      actor: 'a1',
      visibility: 'private',
      payload: { m: { k: 'ev.monster_hits_you', p: { mon: '@mon:wolf', dmg } }, dmg },
    });
    const out = r.messages('en', 'en', [hit(1, 5), hit(2, 10), hit(3, 12), hit(4, 10)]);
    expect(out).toEqual([{ kind: 'hit', text: 'You were hit 4 times for 37 total damage.', n: 4 }]);
  });
});
