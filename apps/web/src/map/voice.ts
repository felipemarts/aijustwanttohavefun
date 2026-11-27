/**
 * Spoken director mode: the star's words in their own voice and a narrator for what they do, through the browser's
 * own speech synthesis (nothing is sent anywhere). Off by default, one toggle beside the director control, remembered
 * per viewer. It speaks only while the director is on, the tab is visible and the interface is in English or
 * Portuguese; pausing the director, leaving the page or hiding the tab silences it at once.
 *
 * The decisions are pure (`view/speech.ts`, `view/narration.ts`); `browserEngine` is the only code that touches
 * `speechSynthesis`. The scene calls in with events as they reach the screen (on the director's delayed clock).
 */
import type { AgentPos, SpectatorEvent } from '@ajwf/shared';
import { useSyncExternalStore } from 'react';
import { i18n } from '../i18n/store';
import type { Translator } from '../i18n/translator';
import type { Activity } from '../view/activity';
import { bannerItem, eventItems, introItem, NowNarrator, type StarInfo } from '../view/narration';
import {
  characterVoice,
  type Line,
  lineMs,
  narratorTone,
  narratorVoice,
  nearlyDone,
  type SpeechItem,
  SpeechQueue,
  speechLang,
  type VoiceChoice,
  type VoiceInfo,
} from '../view/speech';
import { controller } from './controller';

/** What the director voice needs of a speech engine. */
export interface SpeechEngine {
  voices(): VoiceInfo[];
  /** Speaks one plain-text line; `done` is called once, when it ends or fails. */
  speak(line: { text: string; lang: string }, choice: VoiceChoice, done: () => void): void;
  cancel(): void;
  /** `cb` runs when the list of voices changes (some browsers load it late). Returns the unsubscribe. */
  onVoicesChanged(cb: () => void): () => void;
  /** Speaks nothing, inside the click that turns sound on: some browsers want the first speech in a user gesture. */
  unlock(): void;
}

/** The browser's speech synthesis, or null where there is none. The only code that touches `speechSynthesis`. */
export function browserEngine(): SpeechEngine | null {
  if (
    typeof window === 'undefined' ||
    !window.speechSynthesis ||
    typeof window.SpeechSynthesisUtterance !== 'function'
  )
    return null;
  const synth = window.speechSynthesis;
  const byUri = new Map<string, SpeechSynthesisVoice>();
  // Held until it ends: Chrome may never fire the end event of an utterance that was garbage-collected.
  let current: SpeechSynthesisUtterance | null = null;
  return {
    voices() {
      let list: SpeechSynthesisVoice[] = [];
      try {
        list = synth.getVoices();
      } catch {
        // no voices
      }
      byUri.clear();
      return list.map((v) => {
        byUri.set(v.voiceURI, v);
        return {
          name: v.name,
          lang: v.lang,
          voiceURI: v.voiceURI,
          default: v.default,
          localService: v.localService,
        };
      });
    },
    speak(line, choice, done) {
      let fired = false;
      const end = () => {
        if (fired) return;
        fired = true;
        if (current === u) current = null;
        done();
      };
      // Plain text only: `speakable` has already removed anything an engine could read as markup.
      const u = new window.SpeechSynthesisUtterance(line.text);
      const v = byUri.get(choice.voice.voiceURI);
      if (v) u.voice = v;
      u.lang = choice.voice.lang || line.lang;
      u.pitch = choice.pitch;
      u.rate = choice.rate;
      u.onend = end;
      u.onerror = end;
      current = u;
      try {
        if (synth.paused) synth.resume();
        synth.speak(u);
      } catch {
        end();
      }
    },
    cancel() {
      current = null;
      try {
        synth.cancel();
      } catch {
        // nothing to cancel
      }
    },
    onVoicesChanged(cb) {
      if (typeof synth.addEventListener !== 'function') return () => {};
      synth.addEventListener('voiceschanged', cb);
      return () => synth.removeEventListener('voiceschanged', cb);
    },
    unlock() {
      try {
        const u = new window.SpeechSynthesisUtterance('');
        u.volume = 0;
        synth.speak(u);
      } catch {
        // speaking will simply not start
      }
    },
  };
}

/** What the toggle shows: whether it is offered at all, and whether sound is on. */
export type VoiceUi = { available: boolean; on: boolean };

/** What the director voice reads of the page; injected so tests can drive it. */
export type VoiceEnv = {
  now: () => number;
  tr: () => Translator;
  /** The director is on and following someone (not paused, not following an agent by hand). */
  directorOn: () => boolean;
  hidden: () => boolean;
  /** The page has had a user gesture (browsers refuse to speak before one). */
  activated: () => boolean;
  load: () => boolean;
  save: (on: boolean) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
};

const STORAGE_KEY = 'ajwf.director.sound';
/** A line whose end never comes (a stuck engine) is given up after its expected length times two, plus this. */
const STUCK_EXTRA_MS = 4_000;

type Speaking = { item: SpeechItem; index: number; rate: number; startedAt: number };

export class DirectorVoice {
  private ui: VoiceUi;
  private listeners = new Set<() => void>();
  private queue = new SpeechQueue();
  private nowNarrator = new NowNarrator();
  private voices: VoiceInfo[] = [];
  private narrator: VoiceChoice | null = null;
  /** Character voices given this session, by `name|lang`: an agent keeps theirs even when more voices load. */
  private assigned = new Map<string, VoiceChoice>();
  private speaking: Speaking | null = null;
  private token = 0;
  private watchdog: unknown = null;
  private lang = '';

  constructor(
    private readonly engine: SpeechEngine | null,
    private readonly env: VoiceEnv,
  ) {
    this.ui = { available: false, on: env.load() };
  }

  get snapshot(): VoiceUi {
    return this.ui;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private setUi(ui: VoiceUi) {
    if (ui.available === this.ui.available && ui.on === this.ui.on) return;
    this.ui = ui;
    for (const l of this.listeners) l();
  }

  /** Re-reads the voices and the interface language: the toggle is offered only with a narrator voice for it. */
  refresh(): void {
    const tr = this.env.tr();
    this.voices = this.engine ? this.engine.voices() : [];
    const supported = tr.lang === 'en' || tr.lang === 'pt-BR';
    this.narrator = supported ? narratorVoice(this.voices, tr.lang) : null;
    if (tr.lang !== this.lang) {
      this.lang = tr.lang;
      this.stop();
    }
    const available = !!this.engine && !!this.narrator;
    if (!available) this.stop();
    this.setUi({ ...this.ui, available });
  }

  /** The viewer's click on the toggle (the user gesture browsers require before speaking). */
  toggle(): void {
    const on = !this.ui.on;
    this.env.save(on);
    if (on) this.engine?.unlock();
    else this.stop();
    this.setUi({ ...this.ui, on });
  }

  /** Speech may play now. */
  get active(): boolean {
    return (
      this.ui.on && this.ui.available && this.env.directorOn() && !this.env.hidden() && this.env.activated()
    );
  }

  /** Silences everything at once and empties the queue. */
  stop(): void {
    this.token++;
    this.clearWatchdog();
    const was = this.speaking;
    this.speaking = null;
    this.queue.clear();
    if (was) this.engine?.cancel();
  }

  /** Items waiting (tests and the debug HUD). */
  get waiting(): readonly SpeechItem[] {
    return this.queue.peek();
  }

  /** The director cut to a new star: the queue is cleared, then one line introduces them. */
  newStar(info: StarInfo): void {
    this.nowNarrator.reset();
    if (!this.active) return;
    this.queue.clear();
    const cur = this.speaking;
    if (cur) {
      const line = cur.item.lines[cur.index]!;
      if (nearlyDone(line, cur.rate, cur.startedAt, this.env.now())) {
        // Let the line finish, but not the rest of its item (the words of a wish about the previous star).
        cur.item = { ...cur.item, lines: cur.item.lines.slice(0, cur.index + 1) };
      } else this.stop();
    }
    const intro = introItem(this.env.tr(), info);
    if (intro) this.queue.push(intro, this.env.now());
    this.pump();
  }

  /** Events as they reach the screen: the star's words, others' in the star's room, the star's wishes. */
  events(
    events: readonly SpectatorEvent[],
    star: string,
    room: string,
    agents: ReadonlyMap<string, Pick<AgentPos, 'c'>>,
  ): void {
    if (!this.active || !events.length) return;
    const items = eventItems(this.env.tr(), events, { star, room, clsOf: (n) => agents.get(n)?.c });
    for (const item of items) this.queue.push(item, this.env.now());
    this.pump();
  }

  /** A star banner appeared: the narrator reads its headline, ahead of what waits. */
  banner(key: string, params: Record<string, string | number>, id: string): void {
    if (!this.active) return;
    const item = bannerItem(this.env.tr(), key, params, id);
    if (item) this.queue.push(item, this.env.now());
    this.pump();
  }

  /** The event at server time `ts` is a big moment of the star (its banner reads it, not the "now" narrator). */
  markBanner(ts: number): void {
    this.nowNarrator.markBanner(ts);
  }

  /** The star card's "now" line changed (or was refreshed). */
  now(star: string, a: Activity | null): void {
    const item = this.nowNarrator.update(this.env.tr(), star, a, this.env.now());
    if (!item || !this.active) return;
    this.queue.push(item, this.env.now());
    this.pump();
  }

  private voiceFor(line: Line): VoiceChoice | null {
    if (!line.speaker) {
      if (!this.narrator) return null;
      return { voice: this.narrator.voice, ...narratorTone(line) };
    }
    if (!speechLang(line.lang)) return null;
    const key = `${line.speaker}|${line.lang}`;
    const hit = this.assigned.get(key);
    if (hit) return hit;
    const choice = characterVoice(this.voices, line.speaker, line.lang, {
      cls: line.cls,
      narrator: this.narrator?.voice,
    });
    if (choice) this.assigned.set(key, choice);
    return choice;
  }

  private pump(): void {
    if (this.speaking || !this.active) return;
    const item = this.queue.next(this.env.now());
    if (item) this.speakLine(item, 0);
  }

  private speakLine(item: SpeechItem, index: number): void {
    const line = item.lines[index];
    if (!line || !this.engine) return this.pump();
    const choice = this.voiceFor(line);
    if (!choice) {
      // No voice for this line's language: skip it silently.
      if (index + 1 < item.lines.length) return this.speakLine(item, index + 1);
      return this.pump();
    }
    const token = ++this.token;
    this.speaking = { item, index, rate: choice.rate, startedAt: this.env.now() };
    this.watchdog = this.env.setTimer(
      () => this.finished(token, true),
      lineMs(line, choice.rate) * 2 + STUCK_EXTRA_MS,
    );
    this.engine.speak(line, choice, () => this.finished(token, false));
  }

  private finished(token: number, stuck: boolean): void {
    if (token !== this.token) return;
    this.token++;
    this.clearWatchdog();
    if (stuck) this.engine?.cancel();
    const was = this.speaking;
    this.speaking = null;
    if (was && was.index + 1 < was.item.lines.length && this.active) this.speakLine(was.item, was.index + 1);
    else this.pump();
  }

  private clearWatchdog() {
    if (this.watchdog !== null) this.env.clearTimer(this.watchdog);
    this.watchdog = null;
  }

  /**
   * Starts listening to the page (voices loading, language, director, tab visibility). Returns the detach, which
   * also silences everything: the live page calls it when it unmounts.
   */
  attach(): () => void {
    const offs: (() => void)[] = [];
    this.refresh();
    if (this.engine) offs.push(this.engine.onVoicesChanged(() => this.refresh()));
    // Some browsers list voices only a moment after the page loads, without telling.
    for (const ms of [300, 1500, 4000]) {
      const t = this.env.setTimer(() => this.refresh(), ms);
      offs.push(() => this.env.clearTimer(t));
    }
    offs.push(i18n.subscribe(() => this.refresh()));
    offs.push(
      controller.subscribe('director', () => {
        if (!this.env.directorOn()) this.stop();
      }),
    );
    offs.push(
      controller.subscribe('follow', () => {
        if (!this.env.directorOn()) this.stop();
      }),
    );
    if (typeof document !== 'undefined') {
      const onVis = () => {
        if (document.visibilityState === 'hidden') this.stop();
      };
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('pagehide', onVis);
      offs.push(() => {
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('pagehide', onVis);
      });
    }
    return () => {
      for (const off of offs) off();
      this.stop();
    };
  }
}

function browserEnv(): VoiceEnv {
  return {
    now: () => performance.now(),
    tr: () => i18n.tr,
    directorOn: () => controller.director.enabled && !controller.follow,
    hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    activated: () => {
      const ua =
        typeof navigator !== 'undefined'
          ? (navigator as { userActivation?: { hasBeenActive?: boolean } }).userActivation
          : undefined;
      return ua?.hasBeenActive ?? true;
    },
    load: () => {
      try {
        return localStorage.getItem(STORAGE_KEY) === '1';
      } catch {
        return false;
      }
    },
    save: (on) => {
      try {
        localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
      } catch {
        // private mode: the choice lasts for this page only
      }
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
}

export const directorVoice = new DirectorVoice(browserEngine(), browserEnv());

export function useDirectorVoice(): VoiceUi {
  return useSyncExternalStore(directorVoice.subscribe, () => directorVoice.snapshot);
}
