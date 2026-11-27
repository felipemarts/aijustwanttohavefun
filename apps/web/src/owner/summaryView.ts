/**
 * View model of "while you were away": the server's summary as a small story feed (an icon per kind of news, the
 * rendered sentence), links to the highlights it mentions, and the time window said the way people say it
 * ("since Tuesday, 14:00"). Pure.
 */
import type { Translator } from '../i18n/translator';
import type { HighlightIcon, HighlightTone } from '../view/highlights';
import type { OwnerSummary } from './parse';

export type StoryLine = { key: string; type: string; icon: HighlightIcon; tone: HighlightTone; text: string };
export type StoryHighlight = { id: string; href: string; text: string; ts: number };
export type SummaryView = { window: string; quiet: boolean; lines: StoryLine[]; highlights: StoryHighlight[] };

const ICONS: Record<string, [HighlightIcon, HighlightTone]> = {
  levels: ['star', 'gold'],
  elected: ['crown', 'gold'],
  achievements: ['star', 'gold'],
  items: ['gem', 'gold'],
  friends: ['heart', 'teal'],
  betrayed: ['dagger', 'danger'],
  betrayed_by: ['dagger', 'danger'],
  pvp_kills: ['swords', 'plain'],
  deaths: ['skull', 'danger'],
  projects: ['hammer', 'teal'],
  highlights: ['banner', 'gold'],
  quiet: ['scroll', 'plain'],
};

export function storyIcon(type: string): [HighlightIcon, HighlightTone] {
  return ICONS[type] ?? ['scroll', 'plain'];
}

const DAY = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * "Since 14:00 today", "Since Tuesday, 14:00" (within the last week), else "Since Nov 3, 14:00". Local time: the
 * owner reads it on their own clock.
 */
export function windowText(tr: Translator, since: number, now: number): string {
  const time = new Intl.DateTimeFormat(tr.lang, { hour: '2-digit', minute: '2-digit' }).format(since);
  if (since >= startOfDay(now)) return tr.t('ui.owner.letter.window_today', { time });
  if (since >= startOfDay(now) - 6 * DAY) {
    const day = new Intl.DateTimeFormat(tr.lang, { weekday: 'long' }).format(since);
    return tr.t('ui.owner.letter.window_week', { day, time });
  }
  const date = new Intl.DateTimeFormat(tr.lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(since);
  return tr.t('ui.owner.letter.window_date', { date });
}

export function summaryView(tr: Translator, s: OwnerSummary, now: number): SummaryView {
  const lines = s.items.map((i, n) => {
    const [icon, tone] = storyIcon(i.type);
    return { key: `${i.type}-${n}`, type: i.type, icon, tone, text: i.text };
  });
  return {
    window: windowText(tr, s.since, now),
    quiet: lines.length === 0 || lines.every((l) => l.type === 'quiet'),
    lines,
    highlights: s.highlights.map((h) => ({ id: h.id, href: `/h/${encodeURIComponent(h.id)}`, text: h.text, ts: h.ts })),
  };
}
