/**
 * Spoken director mode, the pure part: which languages are spoken, how text is made safe to speak, which voice each
 * speaker gets, and the queue that keeps speech with the picture. Nothing here touches `speechSynthesis`; the thin
 * adapter in `map/voice.ts` does.
 */
import { hash32 } from '../util/rng';

export const SPEECH = {
  /** Items waiting to be spoken, at most. */
  maxQueue: 3,
  /** An item that waited longer than this is about something no longer on screen: dropped. */
  maxWaitMs: 8_000,
  /** Longest spoken line (characters), cut at a word. */
  maxChars: 160,
  /** At most one routine narration (a change of the "now" line) this often. */
  routineGapMs: 8_000,
  /** The same "now" line is not narrated again within this window. */
  repeatMs: 20_000,
  /** On a change of star, the line being spoken may finish when no more than this is left of it. */
  nearlyDoneMs: 1_500,
  /** Rough speaking speed at rate 1, to estimate how long a line lasts. */
  charsPerSecond: 14,
};

/** Languages spoken at all (base language). */
export type SpeechLang = 'en' | 'pt';

/** The spoken base language of a BCP-47 tag (`en`, `en-GB`, `pt`, `pt_BR`...), or null for any other language. */
export function speechLang(tag: string | null | undefined): SpeechLang | null {
  if (typeof tag !== 'string' || !/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,2}$/.test(tag)) return null;
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return base === 'en' || base === 'pt' ? base : null;
}

/**
 * Agent-written text, made plain for a synthesizer: no tag-like runs or angle brackets (an engine may read a string
 * that looks like an SSML document as markup), no control or bidi-override characters, whitespace collapsed, and at
 * most `max` characters, cut at a word.
 */
export function speakable(text: string, max = SPEECH.maxChars): string {
  let s = text
    .replace(/<[/?!]?[A-Za-z?][^<>]{0,200}>/g, ' ')
    .replace(/[<>]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    const at = cut.lastIndexOf(' ');
    s = (at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:–—-]+$/, '');
  }
  return s;
}

// ── Voices ───────────────────────────────────────────────────────────────────

/** What the adapter reports of a system voice (a `SpeechSynthesisVoice`, copied). */
export type VoiceInfo = {
  name: string;
  lang: string;
  voiceURI: string;
  default: boolean;
  localService: boolean;
};

/** A voice ready to use: the system voice and the pitch and rate to speak with (both 1 = the voice's own). */
export type VoiceChoice = { voice: VoiceInfo; pitch: number; rate: number };

/**
 * Novelty voices of Apple systems (also listed by Chrome and Firefox on macOS): they sing, bubble or whisper, so no
 * character is given one. macOS localizes a few of the names to the system language (Chrome on a Portuguese Mac
 * lists Bubbles as "Bolhas"), so the known translations are listed too (from Readium's novelty filter, plus the ones
 * seen on a Portuguese system).
 */
const NOVELTY = new Set(
  [
    'Albert',
    'Bad News',
    'Mauvaises nouvelles',
    'Malas noticias',
    'Brutte notizie',
    'Bahh',
    'Bells',
    'Cloches',
    'Campanas',
    'Campane',
    'Boing',
    'Bubbles',
    'Bulles',
    'Burbujas',
    'Bollicine',
    'Bolhas',
    'Cellos',
    'Violoncelles',
    'Violonchelos',
    'Violoncelli',
    'Deranged',
    'Good News',
    'Bonnes nouvelles',
    'Buenas noticias',
    'Buone notizie',
    'Hysterical',
    'Jester',
    'Bouffon',
    'Bufón',
    'Giullare',
    'Organ',
    'Orgue',
    'Órgano',
    'Organo',
    'Pipe Organ',
    'Superstar',
    'Superestrella',
    'Trinoids',
    'Trinoïdes',
    'Whisper',
    'Murmure',
    'Susurro',
    'Sussurro',
    'Wobble',
    'Zarvox',
  ].map((n) => n.toLowerCase()),
);

const normTag = (tag: string) => tag.replace(/_/g, '-').toLowerCase();
/** `Bells (English (US))` and `Bells` alike. */
const baseName = (name: string) =>
  name
    .replace(/\s*\(.*$/, '')
    .trim()
    .toLowerCase();

/**
 * Usable voices for a language, in a stable order: those of the exact region of `tag` when there are any (a
 * `pt-BR` line in a Brazilian voice), else every voice of the base language. Novelty voices are left out.
 */
export function voicesFor(voices: readonly VoiceInfo[], tag: string): VoiceInfo[] {
  const lang = speechLang(tag);
  if (!lang) return [];
  const all = voices
    .filter((v) => speechLang(normTag(v.lang)) === lang && !NOVELTY.has(baseName(v.name)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.voiceURI < b.voiceURI ? -1 : 1));
  const want = normTag(tag);
  const exact = want.includes('-') ? all.filter((v) => normTag(v.lang) === want) : [];
  return exact.length ? exact : all;
}

/**
 * The narrator for the interface language: the browser's default voice when it speaks that language, else the first
 * voice installed on the device (they start at once and work offline), else the first voice. Null with no voice.
 */
export function narratorVoice(voices: readonly VoiceInfo[], uiLang: string): VoiceChoice | null {
  const list = voicesFor(voices, uiLang);
  const voice = list.find((v) => v.default) ?? list.find((v) => v.localService) ?? list[0];
  return voice ? { voice, pitch: 1, rate: 1 } : null;
}

/** Small per-class nudges of pitch and rate: a deeper warrior, a quicker rogue, a gentler cleric. */
const CLASS_NUDGE: Record<string, { pitch: number; rate: number }> = {
  warrior: { pitch: -0.1, rate: -0.03 },
  mage: { pitch: 0.02, rate: -0.05 },
  rogue: { pitch: 0, rate: 0.06 },
  cleric: { pitch: 0.06, rate: -0.04 },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * A character's voice for a line in `tag`: a voice of that language picked by a hash of the agent's name (not the
 * narrator's when there is another), and its own pitch and rate from the same hash, nudged by class, so two agents
 * sound different even on a system with one voice. The same name always gets the same choice from the same list.
 */
export function characterVoice(
  voices: readonly VoiceInfo[],
  name: string,
  tag: string,
  opts: { cls?: string; narrator?: VoiceInfo | null } = {},
): VoiceChoice | null {
  let list = voicesFor(voices, tag);
  if (list.length > 1 && opts.narrator) {
    const others = list.filter((v) => v.voiceURI !== opts.narrator!.voiceURI);
    if (others.length) list = others;
  }
  if (!list.length) return null;
  const h = hash32(name, 0x5eed);
  const voice = list[h % list.length]!;
  const nudge = CLASS_NUDGE[opts.cls ?? ''] ?? { pitch: 0, rate: 0 };
  let pitch = 0.8 + (((h >>> 8) & 0xff) / 255) * 0.45 + nudge.pitch;
  // Never the narrator's own pitch: on a one-voice system it would be the narrator speaking.
  if (Math.abs(pitch - 1) < 0.06) pitch += pitch < 1 ? -0.06 : 0.06;
  const rate = 0.92 + (((h >>> 16) & 0xff) / 255) * 0.16 + nudge.rate;
  return { voice, pitch: round2(clamp(pitch, 0.7, 1.35)), rate: round2(clamp(rate, 0.85, 1.15)) };
}

// ── What is spoken ───────────────────────────────────────────────────────────

/** One spoken line: plain text, its language, and whose voice (null: the narrator). */
export type Line = {
  text: string;
  lang: string;
  speaker: string | null;
  /** The speaker's class, for the voice. */
  cls?: string;
  /** The narrator reading a big moment: a little faster and brighter. */
  big?: boolean;
};

/** Priorities, highest first in the order the design gives; a full queue drops the lowest. */
export const PRIORITY = { starSay: 7, wish: 6, banner: 5, roomSay: 4, intro: 3, now: 2 } as const;

/** Something to say: one or more lines spoken in a row (a wish: the narrator, then the words wished). */
export type SpeechItem = { lines: Line[]; priority: number; big: boolean; key: string };

/** Pitch and rate of the narrator for a line: brighter and a little faster for a big moment. */
export function narratorTone(line: Line): { pitch: number; rate: number } {
  return line.big ? { pitch: 1.12, rate: 1.1 } : { pitch: 1, rate: 1 };
}

/** About how long a line takes to speak at `rate`, ms. */
export function lineMs(line: Line, rate = 1): number {
  return (line.text.length / (SPEECH.charsPerSecond * rate)) * 1000;
}

/** Whether a line that started at `startedAt` is nearly done at `now` (a cut lets it finish). */
export function nearlyDone(line: Line, rate: number, startedAt: number, now: number): boolean {
  return lineMs(line, rate) - (now - startedAt) <= SPEECH.nearlyDoneMs;
}

/**
 * The waiting line. Kept short so speech stays with the picture: at most `maxQueue` items, none older than
 * `maxWaitMs` when its turn comes. First in, first out (a conversation is heard in order), except that a big moment
 * jumps ahead. When full, the lowest-priority item goes (the oldest of them), unless the newcomer ranks lower still
 * (a big moment always gets in).
 */
export class SpeechQueue {
  private items: { item: SpeechItem; at: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  /** The items waiting, first to speak first. */
  peek(): readonly SpeechItem[] {
    return this.items.map((x) => x.item);
  }

  /** Adds an item; returns whether it was kept. */
  push(item: SpeechItem, now: number): boolean {
    this.dropStale(now);
    if (this.items.some((x) => x.item.key === item.key)) return false;
    if (this.items.length >= SPEECH.maxQueue) {
      // The lowest priority goes, the oldest of them; a big moment waiting goes only when nothing else is left.
      const rank = (x: SpeechItem) => (x.big ? 1000 : 0) + x.priority;
      let low = 0;
      for (let i = 1; i < this.items.length; i++)
        if (rank(this.items[i]!.item) < rank(this.items[low]!.item)) low = i;
      // A big moment always gets in.
      if (!item.big && rank(this.items[low]!.item) > item.priority) return false;
      this.items.splice(low, 1);
    }
    const entry = { item, at: now };
    if (item.big) {
      // Ahead of everything but the big moments already waiting.
      let i = 0;
      while (i < this.items.length && this.items[i]!.item.big) i++;
      this.items.splice(i, 0, entry);
    } else this.items.push(entry);
    return true;
  }

  /** The next item to speak, skipping those that waited too long. */
  next(now: number): SpeechItem | null {
    this.dropStale(now);
    return this.items.shift()?.item ?? null;
  }

  clear(): void {
    this.items = [];
  }

  private dropStale(now: number): void {
    this.items = this.items.filter((x) => now - x.at <= SPEECH.maxWaitMs);
  }
}
