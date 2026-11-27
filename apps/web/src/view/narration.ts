/**
 * Spoken director mode: which moments become speech, in which voice and with what priority. Pure, apart from the
 * small memory of the "now" narrator, which takes the clock as a parameter.
 *
 * Agent words (a say, a wish) are spoken in the speaker's voice, only when the line's own language tag is English
 * or Portuguese. Narration reuses the strings the star card and the banners show, in the interface language.
 */
import type { SpectatorEvent } from '@ajwf/shared';
import type { Translator } from '../i18n/translator';
import type { Activity } from './activity';
import { type Line, PRIORITY, SPEECH, type SpeechItem, speakable, speechLang } from './speech';

/** "Now" lines worth narrating besides any of danger tone: never walking, gathering or idling. */
const NOTABLE = new Set([
  'level_up',
  'achievement',
  'world_first',
  'rare_drop',
  'fallen',
  'revive',
  'revived',
  'trade',
  'party_join',
  'party_form',
  'boss_kill',
]);
/** Spoken by other paths: the words themselves are heard (a say, a wish), or a banner reads the moment. */
const NOT_NARRATED = new Set(['say', 'talk_with', 'wish', 'jackpot']);

export function isNotable(a: Activity): boolean {
  if (NOT_NARRATED.has(a.key)) return false;
  return a.tone === 'danger' || NOTABLE.has(a.key);
}

/** Narration in the interface language, or null when the text is empty. */
function narration(tr: Translator, text: string, big = false): Line | null {
  const s = speakable(text);
  return s ? { text: s, lang: tr.lang, speaker: null, ...(big ? { big } : {}) } : null;
}

/** Agent words as a line in the speaker's voice, or null when not English or Portuguese (skipped silently). */
function agentLine(ev: SpectatorEvent, cls: string | undefined): Line | null {
  if (!ev.actor || typeof ev.text !== 'string' || !speechLang(ev.lang)) return null;
  const s = speakable(ev.text);
  return s ? { text: s, lang: ev.lang!, speaker: ev.actor, ...(cls ? { cls } : {}) } : null;
}

export type StarInfo = { name: string; cls: string; level: number | null; room: string };

/** A change of star: one short line, who they are and where ("Following Pip in the Square. Warrior, Level 4."). */
export function introItem(tr: Translator, s: StarInfo): SpeechItem | null {
  const parts = [tr.t('ui.director.caption.following', { actor: s.name, room: `@room:${s.room}` })];
  const who = [
    s.cls ? tr.name('class', s.cls) : '',
    s.level !== null ? tr.t('ui.agent.level', { level: s.level }) : '',
  ]
    .filter(Boolean)
    .join(', ');
  if (who) parts.push(who);
  const line = narration(tr, parts.map((p) => p.replace(/[.!…]+$/, '')).join('. ') + '.');
  return line ? { lines: [line], priority: PRIORITY.intro, big: false, key: `intro:${s.name}` } : null;
}

/** A big-moment banner, read by the narrator a little faster and brighter; it jumps the queue. */
export function bannerItem(
  tr: Translator,
  key: string,
  params: Record<string, string | number>,
  id: string,
): SpeechItem | null {
  const line = narration(tr, tr.t(`ui.director.banner.${key}`, params), true);
  return line ? { lines: [line], priority: PRIORITY.banner, big: true, key: `banner:${id}` } : null;
}

/**
 * Events as they reach the screen: what the star says, what others say in the star's room (so a conversation is
 * heard from both sides), and the star's wish (the narrator's "now" line, then the wish in the star's voice).
 */
export function eventItems(
  tr: Translator,
  events: readonly SpectatorEvent[],
  ctx: { star: string; room: string; clsOf: (name: string) => string | undefined },
): SpeechItem[] {
  const out: SpeechItem[] = [];
  for (const ev of events) {
    if (!ev.actor || (ev.room && ev.room !== ctx.room)) continue;
    if (ev.type === 'say') {
      const line = agentLine(ev, ctx.clsOf(ev.actor));
      if (line)
        out.push({
          lines: [line],
          priority: ev.actor === ctx.star ? PRIORITY.starSay : PRIORITY.roomSay,
          big: false,
          key: `ev:${ev.id}`,
        });
    } else if (ev.type === 'wish' && ev.actor === ctx.star) {
      const lead = narration(tr, `${ctx.star}: ${tr.t('ui.director.now.wish')}`);
      const words = agentLine(ev, ctx.clsOf(ev.actor));
      const lines = [lead, words].filter((l): l is Line => !!l);
      if (lines.length) out.push({ lines, priority: PRIORITY.wish, big: false, key: `ev:${ev.id}` });
    }
  }
  return out;
}

/**
 * Memory of the "now" narrator: it speaks a change of the star's "now" line only when notable, not twice the same
 * line within `repeatMs`, not a moment a banner already read, and at most once every `routineGapMs`. The line a new
 * star already has when the camera arrives is not a change (the introduction covers them).
 */
export class NowNarrator {
  /** The line last seen (key, params and time of its event). */
  private seen = '';
  /** The line last spoken (key and params) and when. */
  private spoken = { line: '', at: -Infinity };
  private baseline = true;
  private bannered = new Set<number>();

  /** A new star: the next line seen is their starting point, not news. */
  reset(): void {
    this.baseline = true;
    this.seen = '';
    this.bannered.clear();
  }

  /** A banner read the moment of the event at server time `ts`: its "now" line is not narrated again. */
  markBanner(ts: number): void {
    this.bannered.add(ts);
    if (this.bannered.size > 20) this.bannered.delete(this.bannered.values().next().value!);
  }

  /** The star's "now" line as shown at local time `now`: an item to say, or null. */
  update(tr: Translator, star: string, a: Activity | null, now: number): SpeechItem | null {
    if (!a) return null;
    const what = `${a.key}|${JSON.stringify(a.params)}`;
    const sig = `${what}|${a.ts}`;
    if (sig === this.seen) return null;
    this.seen = sig;
    if (this.baseline) {
      this.baseline = false;
      return null;
    }
    if (!isNotable(a) || this.bannered.has(a.ts)) return null;
    if (now - this.spoken.at < SPEECH.routineGapMs) return null;
    if (what === this.spoken.line && now - this.spoken.at < SPEECH.repeatMs) return null;
    const line = narration(tr, `${star}: ${tr.t(`ui.director.now.${a.key}`, a.params)}`);
    if (!line) return null;
    this.spoken = { line: what, at: now };
    return { lines: [line], priority: PRIORITY.now, big: false, key: `now:${sig}` };
  }
}
