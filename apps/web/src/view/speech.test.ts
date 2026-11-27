import { describe, expect, it } from 'vitest';
import {
  characterVoice,
  narratorVoice,
  nearlyDone,
  PRIORITY,
  SPEECH,
  type SpeechItem,
  SpeechQueue,
  speakable,
  speechLang,
  type VoiceInfo,
  voicesFor,
} from './speech';

const v = (name: string, lang: string, extra: Partial<VoiceInfo> = {}): VoiceInfo => ({
  name,
  lang,
  voiceURI: `${name}|${lang}`,
  default: false,
  localService: true,
  ...extra,
});

const VOICES: VoiceInfo[] = [
  v('Samantha', 'en-US', { default: true }),
  v('Daniel', 'en-GB'),
  v('Google US English', 'en-US', { localService: false }),
  v('Bells', 'en-US'),
  v('Zarvox', 'en-US'),
  v('Luciana', 'pt-BR'),
  v('Felipe', 'pt_BR'),
  v('Joana', 'pt-PT'),
  v('Monica', 'es-ES'),
  v('Kyoko', 'ja-JP'),
];

describe('speech languages', () => {
  it('speaks English and Portuguese only, from any regional tag', () => {
    for (const t of ['en', 'en-US', 'EN-gb', 'en_AU']) expect(speechLang(t)).toBe('en');
    for (const t of ['pt', 'pt-BR', 'pt_PT', 'PT-br']) expect(speechLang(t)).toBe('pt');
    for (const t of [
      'es',
      'fr',
      'ja',
      'zh-CN',
      '',
      'english',
      '<en>',
      'en-US-x-very-long-tag-here',
      null,
      undefined,
    ])
      expect(speechLang(t)).toBeNull();
  });
});

describe('speakable text', () => {
  it('removes anything an engine could read as markup, and control characters', () => {
    expect(speakable('<b>free loot</b> at the square')).toBe('free loot at the square');
    const ssml = speakable('<?xml version="1.0"?><speak>hi<break time="9s"/></speak>');
    expect(ssml).not.toMatch(/[<>]/);
    expect(ssml).toContain('hi');
    expect(speakable('a < b > c')).toBe('a b c');
    expect(speakable('line\u0000one\u202Etwo\u200bthree\nfour')).toBe('line one two three four');
  });

  it('caps a line at about 160 characters, cut at a word', () => {
    const long = 'word '.repeat(60);
    const s = speakable(long);
    expect(s.length).toBeLessThanOrEqual(SPEECH.maxChars);
    expect(s.endsWith('word')).toBe(true);
    // one endless word is cut hard
    expect(speakable('x'.repeat(400)).length).toBe(SPEECH.maxChars);
    expect(speakable('Hello, world.')).toBe('Hello, world.');
  });
});

describe('voices', () => {
  it('lists the voices of a language in a stable order, regional ones first, without novelty voices', () => {
    const en = voicesFor(VOICES, 'en').map((x) => x.name);
    expect(en).toEqual(['Daniel', 'Google US English', 'Samantha']);
    expect(voicesFor([...VOICES].reverse(), 'en').map((x) => x.name)).toEqual(en);
    expect(voicesFor(VOICES, 'pt-BR').map((x) => x.name)).toEqual(['Felipe', 'Luciana']);
    expect(voicesFor(VOICES, 'pt-PT').map((x) => x.name)).toEqual(['Joana']);
    expect(voicesFor(VOICES, 'pt').map((x) => x.name)).toEqual(['Felipe', 'Joana', 'Luciana']);
    // a region with no voice of its own falls back to the whole language
    expect(voicesFor(VOICES, 'en-AU').map((x) => x.name)).toEqual(en);
    expect(voicesFor(VOICES, 'es')).toEqual([]);
  });

  it('narrates with the browser default voice for the language, else a local one, else none', () => {
    expect(narratorVoice(VOICES, 'en')?.voice.name).toBe('Samantha');
    expect(narratorVoice(VOICES, 'pt-BR')?.voice.name).toBe('Felipe');
    expect(
      narratorVoice([v('Remote', 'pt-BR', { localService: false }), v('Local', 'pt-BR')], 'pt-BR')?.voice
        .name,
    ).toBe('Local');
    expect(
      narratorVoice(
        VOICES.filter((x) => !x.lang.startsWith('pt')),
        'pt-BR',
      ),
    ).toBeNull();
    expect(narratorVoice(VOICES, 'en')).toMatchObject({ pitch: 1, rate: 1 });
  });

  it('gives each agent the same voice every time, never the narrator when there is a choice', () => {
    const narrator = narratorVoice(VOICES, 'en')!.voice;
    const names = ['Pip', 'Bram', 'Odessa', 'Kael', 'Mirelle', 'Tamsin', 'Vex', 'Juniper'];
    const used = new Set<string>();
    for (const n of names) {
      const a = characterVoice(VOICES, n, 'en', { narrator })!;
      expect(a).toEqual(characterVoice(VOICES, n, 'en', { narrator }));
      expect(a.voice.voiceURI).not.toBe(narrator.voiceURI);
      expect(a.pitch).toBeGreaterThanOrEqual(0.7);
      expect(a.pitch).toBeLessThanOrEqual(1.35);
      expect(Math.abs(a.pitch - 1)).toBeGreaterThanOrEqual(0.05);
      expect(a.rate).toBeGreaterThanOrEqual(0.85);
      expect(a.rate).toBeLessThanOrEqual(1.15);
      used.add(a.voice.name);
    }
    expect(used.size).toBeGreaterThan(1);
    expect(characterVoice(VOICES, 'Pip', 'pt-BR')!.voice.lang.replace('_', '-')).toBe('pt-BR');
    expect(characterVoice(VOICES, 'Pip', 'es')).toBeNull();
  });

  it('makes agents sound different on a system with a single voice', () => {
    const one = [v('Only', 'en-US', { default: true })];
    const narrator = narratorVoice(one, 'en')!.voice;
    const sounds = new Set<string>();
    for (const n of ['Pip', 'Bram', 'Odessa', 'Kael', 'Mirelle', 'Tamsin']) {
      const a = characterVoice(one, n, 'en', { narrator })!;
      expect(a.voice.name).toBe('Only');
      sounds.add(`${a.pitch}|${a.rate}`);
    }
    expect(sounds.size).toBeGreaterThanOrEqual(5);
  });

  it('nudges pitch by class (a warrior sounds deeper than the same name as a cleric)', () => {
    const w = characterVoice(VOICES, 'Pip', 'en', { cls: 'warrior' })!;
    const c = characterVoice(VOICES, 'Pip', 'en', { cls: 'cleric' })!;
    expect(w.voice).toEqual(c.voice);
    expect(w.pitch).toBeLessThan(c.pitch);
  });
});

const item = (key: string, priority: number, big = false): SpeechItem => ({
  lines: [{ text: key, lang: 'en', speaker: null }],
  priority,
  big,
  key,
});

describe('speech queue', () => {
  it('keeps at most three items, dropping the lowest priority first', () => {
    const q = new SpeechQueue();
    q.push(item('a', PRIORITY.roomSay), 0);
    q.push(item('b', PRIORITY.now), 0);
    q.push(item('c', PRIORITY.roomSay), 0);
    expect(q.push(item('d', PRIORITY.starSay), 0)).toBe(true);
    expect(q.size).toBe(3);
    expect(q.peek().map((x) => x.key)).toEqual(['a', 'c', 'd']);
    // a newcomer ranking below everything waiting is the one dropped
    expect(q.push(item('e', PRIORITY.now), 0)).toBe(false);
    expect(q.peek().map((x) => x.key)).toEqual(['a', 'c', 'd']);
  });

  it('speaks in arrival order, but a big moment jumps ahead (and always gets in)', () => {
    const q = new SpeechQueue();
    q.push(item('a', PRIORITY.starSay), 0);
    q.push(item('b', PRIORITY.starSay), 0);
    q.push(item('c', PRIORITY.starSay), 0);
    expect(q.push(item('big1', PRIORITY.banner, true), 0)).toBe(true);
    expect(q.push(item('big2', PRIORITY.banner, true), 0)).toBe(true);
    expect(q.peek().map((x) => x.key)).toEqual(['big1', 'big2', 'c']);
    expect(q.next(0)?.key).toBe('big1');
  });

  it('drops what waited more than 8 seconds, and repeats of the same key', () => {
    const q = new SpeechQueue();
    q.push(item('old', PRIORITY.starSay), 0);
    expect(q.push(item('old', PRIORITY.starSay), 10)).toBe(false);
    q.push(item('fresh', PRIORITY.starSay), 5_000);
    expect(q.next(8_500)?.key).toBe('fresh');
    expect(q.next(8_500)).toBeNull();
    q.push(item('x', PRIORITY.now), 0);
    q.clear();
    expect(q.size).toBe(0);
  });

  it('knows when a line is nearly done', () => {
    const line = { text: 'x'.repeat(140), lang: 'en', speaker: null }; // about 10 s at rate 1
    expect(nearlyDone(line, 1, 0, 2_000)).toBe(false);
    expect(nearlyDone(line, 1, 0, 9_000)).toBe(true);
    expect(nearlyDone(line, 2, 0, 4_000)).toBe(true);
  });
});
