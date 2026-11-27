/**
 * The director voice with a fake engine and a fake clock: nothing is spoken before the toggle, pausing silences it,
 * a cut clears the queue, a stuck engine is given up on. The real `speechSynthesis` is never touched.
 */
import type { SpectatorEvent } from '@ajwf/shared';
import { describe, expect, it, vi } from 'vitest';
import { Translator } from '../i18n/translator';
import { loadCatalog } from '../test/fixtures';
import type { VoiceChoice, VoiceInfo } from '../view/speech';
import type { SpeechEngine } from './voice';

const en = loadCatalog('en');
const pt = loadCatalog('pt-BR');

vi.mock('../i18n/store', () => ({
  i18n: { tr: null, subscribe: () => () => undefined },
}));

const { DirectorVoice } = await import('./voice');
type Engine = SpeechEngine;

const v = (name: string, lang: string, extra: Partial<VoiceInfo> = {}): VoiceInfo => ({
  name,
  lang,
  voiceURI: name,
  default: false,
  localService: true,
  ...extra,
});

function setup(opts: { voices?: VoiceInfo[]; lang?: 'en' | 'pt-BR' | 'es'; on?: boolean } = {}) {
  let clock = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  const spoken: { text: string; lang: string; voice: string; pitch: number; rate: number }[] = [];
  let pending: (() => void) | null = null;
  const engine: Engine & { cancels: number; unlocks: number } = {
    cancels: 0,
    unlocks: 0,
    voices: () =>
      opts.voices ?? [
        v('Samantha', 'en-US', { default: true }),
        v('Alex', 'en-US'),
        v('Luciana', 'pt-BR'),
        v('Felipe', 'pt-BR'),
      ],
    speak(line, choice: VoiceChoice, done) {
      spoken.push({
        text: line.text,
        lang: line.lang,
        voice: choice.voice.name,
        pitch: choice.pitch,
        rate: choice.rate,
      });
      pending = done;
    },
    cancel() {
      engine.cancels++;
      pending = null;
    },
    onVoicesChanged: () => () => undefined,
    unlock() {
      engine.unlocks++;
    },
  };
  const lang = opts.lang ?? 'en';
  const tr = new Translator(lang, lang === 'pt-BR' ? pt : en, en);
  const state = { director: true, hidden: false, saved: opts.on ?? false };
  const voice = new DirectorVoice(engine, {
    now: () => clock,
    tr: () => tr,
    directorOn: () => state.director,
    hidden: () => state.hidden,
    activated: () => true,
    load: () => state.saved,
    save: (on) => {
      state.saved = on;
    },
    setTimer: (fn, ms) => {
      const t = { at: clock + ms, fn, id: ++ids };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  voice.refresh();
  return {
    voice,
    engine,
    spoken,
    state,
    /** The engine finishes the line being spoken. */
    end() {
      const p = pending;
      pending = null;
      p?.();
    },
    advance(ms: number) {
      clock += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at > clock) continue;
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

let seq = 0;
const say = (actor: string, text: string, lang = 'en', room = 'village.square'): SpectatorEvent => ({
  id: String(++seq),
  ts: seq,
  type: 'say',
  room,
  actor,
  text,
  lang,
});
const agents = new Map([
  ['Pip', { c: 'rogue' }],
  ['Bram', { c: 'warrior' }],
  ['Odessa', { c: 'cleric' }],
]);
const STAR = { name: 'Pip', cls: 'rogue', level: 3, room: 'village.square' };

describe('director voice', () => {
  it('is offered only with a narrator voice for an English or Portuguese interface', () => {
    expect(setup().voice.snapshot).toEqual({ available: true, on: false });
    expect(setup({ lang: 'pt-BR' }).voice.snapshot.available).toBe(true);
    expect(setup({ lang: 'es' }).voice.snapshot.available).toBe(false);
    expect(setup({ lang: 'pt-BR', voices: [v('Samantha', 'en-US')] }).voice.snapshot.available).toBe(false);
    expect(setup({ voices: [] }).voice.snapshot.available).toBe(false);
    const none = new DirectorVoice(null, {
      now: () => 0,
      tr: () => new Translator('en', en),
      directorOn: () => true,
      hidden: () => false,
      activated: () => true,
      load: () => true,
      save: () => undefined,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    none.refresh();
    expect(none.snapshot.available).toBe(false);
  });

  it('says nothing until the viewer turns it on, then remembers the choice', () => {
    const t = setup();
    t.voice.newStar(STAR);
    t.voice.events([say('Pip', 'Hello there')], 'Pip', 'village.square', agents);
    expect(t.spoken).toEqual([]);
    t.voice.toggle();
    expect(t.engine.unlocks).toBe(1);
    expect(t.state.saved).toBe(true);
    t.voice.events([say('Pip', 'Hello again')], 'Pip', 'village.square', agents);
    expect(t.spoken.map((s) => s.text)).toEqual(['Hello again']);
    expect(setup({ on: true }).voice.snapshot.on).toBe(true);
  });

  it('introduces the star in the narrator voice, then each speaker in their own voice', () => {
    const t = setup({ on: true });
    t.voice.newStar(STAR);
    t.voice.events(
      [say('Pip', 'Anyone up for the mines?'), say('Bram', 'Eu vou!', 'pt-BR'), say('Odessa', 'Count me in')],
      'Pip',
      'village.square',
      agents,
    );
    for (let i = 0; i < 4; i++) t.end();
    expect(t.spoken).toHaveLength(4);
    const [intro, pip, bram, odessa] = t.spoken;
    expect(intro!.voice).toBe('Samantha');
    expect(intro).toMatchObject({ pitch: 1, rate: 1 });
    expect(pip!.voice).not.toBe('Samantha');
    expect(bram!.voice).toMatch(/Luciana|Felipe/);
    expect(bram!.lang).toBe('pt-BR');
    expect(new Set([pip, odessa].map((s) => `${s!.voice}|${s!.pitch}|${s!.rate}`)).size).toBe(2);
  });

  it('skips lines in other languages and never queues more than three', () => {
    const t = setup({ on: true });
    t.voice.events([say('Pip', 'first')], 'Pip', 'village.square', agents);
    t.voice.events(
      [
        say('Bram', 'zwei', 'de'),
        say('Bram', '二', 'ja'),
        say('Odessa', 'a'),
        say('Bram', 'b'),
        say('Odessa', 'c'),
        say('Pip', 'd'),
      ],
      'Pip',
      'village.square',
      agents,
    );
    expect(t.voice.waiting.length).toBeLessThanOrEqual(3);
    for (let i = 0; i < 6; i++) t.end();
    expect(t.spoken.map((s) => s.text)).not.toContain('zwei');
    expect(t.spoken.map((s) => s.text)).not.toContain('二');
    expect(t.spoken.map((s) => s.text)).toContain('d');
  });

  it('stops at once when the director pauses or the tab hides', () => {
    const t = setup({ on: true });
    t.voice.events([say('Pip', 'one'), say('Pip', 'two')], 'Pip', 'village.square', agents);
    expect(t.spoken).toHaveLength(1);
    t.state.director = false;
    t.voice.stop();
    expect(t.engine.cancels).toBe(1);
    expect(t.voice.waiting).toEqual([]);
    t.end();
    t.voice.events([say('Pip', 'three')], 'Pip', 'village.square', agents);
    expect(t.spoken).toHaveLength(1);
    t.state.director = true;
    t.state.hidden = true;
    t.voice.events([say('Pip', 'four')], 'Pip', 'village.square', agents);
    expect(t.spoken).toHaveLength(1);
  });

  it('turning it off silences it', () => {
    const t = setup({ on: true });
    t.voice.events([say('Pip', 'one'), say('Pip', 'two')], 'Pip', 'village.square', agents);
    t.voice.toggle();
    expect(t.engine.cancels).toBe(1);
    expect(t.voice.waiting).toEqual([]);
    expect(t.state.saved).toBe(false);
  });

  it('a change of star clears the queue and cuts the line unless it is nearly done', () => {
    const t = setup({ on: true });
    t.voice.newStar(STAR);
    t.end();
    t.voice.events([say('Pip', 'x'.repeat(140)), say('Pip', 'queued')], 'Pip', 'village.square', agents);
    t.advance(1_000);
    t.voice.newStar({ ...STAR, name: 'Bram' });
    expect(t.engine.cancels).toBe(1);
    expect(t.spoken.at(-1)!.text).toContain('Bram');
    t.end();
    // nearly done: it may finish, then the intro follows; what waited is gone
    t.voice.events([say('Bram', 'y'.repeat(28)), say('Bram', 'dropped')], 'Bram', 'village.square', agents);
    t.advance(1_500);
    t.voice.newStar({ ...STAR, name: 'Odessa' });
    expect(t.engine.cancels).toBe(1);
    t.end();
    expect(t.spoken.at(-1)!.text).toContain('Odessa');
    expect(t.spoken.map((s) => s.text)).not.toContain('dropped');
    expect(t.spoken.map((s) => s.text)).not.toContain('queued');
  });

  it('a big moment jumps the queue, read brighter and faster', () => {
    const t = setup({ on: true });
    t.voice.events([say('Pip', 'one'), say('Pip', 'two')], 'Pip', 'village.square', agents);
    t.voice.banner('pvp_kill', { actor: 'Pip', name: 'Bram' }, 'b1');
    t.end();
    expect(t.spoken[1]).toMatchObject({ text: 'Pip defeats Bram!', voice: 'Samantha' });
    expect(t.spoken[1]!.pitch).toBeGreaterThan(1);
    expect(t.spoken[1]!.rate).toBeGreaterThan(1);
  });

  it('drops what waited more than 8 seconds, and gives up on a stuck engine', () => {
    const t = setup({ on: true });
    t.voice.events([say('Pip', 'short'), say('Pip', 'stale')], 'Pip', 'village.square', agents);
    t.advance(9_000); // the engine never ended "short": the watchdog moves on, and "stale" is too old by then
    expect(t.engine.cancels).toBe(1);
    expect(t.spoken.map((s) => s.text)).toEqual(['short']);
  });

  it('keeps an agent voice for the session even when more voices load', () => {
    const t = setup({ on: true });
    t.voice.events([say('Pip', 'one')], 'Pip', 'village.square', agents);
    t.end();
    const first = t.spoken[0]!;
    t.voice.events([say('Pip', 'two')], 'Pip', 'village.square', agents);
    t.end();
    expect(t.spoken[1]).toMatchObject({ voice: first.voice, pitch: first.pitch, rate: first.rate });
  });
});
