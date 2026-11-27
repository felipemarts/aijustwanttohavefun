/** View model of a highlight card: icon, tone, localized title, agents, room and the quoted agent text. Pure. */
import type { Highlight } from '@ajwf/shared';
import { safeLang } from '../data/parse';
import type { Translator } from '../i18n/translator';

export type HighlightIcon =
  | 'crown'
  | 'hammer'
  | 'dagger'
  | 'coin'
  | 'skull'
  | 'star'
  | 'gem'
  | 'banner'
  | 'heart'
  | 'scroll'
  | 'swords'
  | 'scales'
  | 'statue';

export type HighlightTone = 'gold' | 'danger' | 'teal' | 'plain';

const ICONS: Record<string, [HighlightIcon, HighlightTone]> = {
  world_first: ['star', 'gold'],
  level_20: ['star', 'gold'],
  epic_drop: ['gem', 'gold'],
  legendary_drop: ['gem', 'gold'],
  guild_founded: ['banner', 'teal'],
  guild_hall_built: ['banner', 'teal'],
  betrayal: ['dagger', 'danger'],
  scam_reported: ['scales', 'danger'],
  treasury_looted: ['coin', 'danger'],
  coup: ['dagger', 'danger'],
  mayor_elected: ['crown', 'gold'],
  mayor_reelected: ['crown', 'gold'],
  embezzlement: ['coin', 'danger'],
  project_completed: ['hammer', 'teal'],
  statue_honor: ['statue', 'gold'],
  bounty_claimed: ['coin', 'gold'],
  duel_upset: ['swords', 'plain'],
  best_friends: ['heart', 'teal'],
  hot_rumor: ['scroll', 'plain'],
  journal_after: ['scroll', 'plain'],
  boss_kill: ['skull', 'danger'],
  world_boss_kill: ['skull', 'gold'],
};

export function highlightIcon(type: string): [HighlightIcon, HighlightTone] {
  return ICONS[type] ?? ['star', 'plain'];
}

export type HighlightView = {
  id: string;
  type: string;
  icon: HighlightIcon;
  tone: HighlightTone;
  title: string;
  agents: string[];
  room: string | null;
  ts: number;
  quote: { text: string; lang: string | null } | null;
  guild: string | null;
};

export function highlightView(h: Highlight, tr: Translator): HighlightView {
  const [icon, tone] = highlightIcon(h.type);
  const title = tr.has(h.titleKey) ? tr.t(h.titleKey, h.params) : tr.t('ui.ticker.untitled', { type: h.type });
  return {
    id: h.id,
    type: h.type,
    icon,
    tone,
    title,
    agents: h.agents,
    room: h.room ?? null,
    ts: h.ts,
    quote: h.quote ? { text: h.quote.text, lang: safeLang(h.quote.lang) } : null,
    guild: typeof h.params.guild === 'string' ? h.params.guild : null,
  };
}

/** Pixel icons, 9x9, one string per row ('#' ink, 'o' fill, '.' empty). Drawn as SVG rects. */
export const ICON_PIXELS: Record<HighlightIcon, string[]> = {
  crown: ['.........', '#...#...#', '##.###.##', '#o#ooo#o#', '#ooooooo#', '#ooooooo#', '#########', '.........', '.........'],
  hammer: ['.#####...', '#ooooo#..', '#ooooo#..', '.##o##...', '...o#....', '...o#....', '...o#....', '...o#....', '...##....'],
  dagger: ['.......#.', '......#o#', '.....#o#.', '....#o#..', '.#.#o#...', '..#o#....', '.#o##....', '#o#..#...', '.#.......'],
  coin: ['..#####..', '.#ooooo#.', '#oo#oo#o#', '#o#ooooo#', '#oo#ooo.#', '#oooo#oo#', '#o#oo#oo#', '.#ooooo#.', '..#####..'],
  skull: ['..#####..', '.#ooooo#.', '#ooooooo#', '#o##o##o#', '#o##o##o#', '#ooo#ooo#', '.#ooooo#.', '..#o#o#..', '..#####..'],
  star: ['....#....', '...#o#...', '...#o#...', '####o####', '#ooooooo#', '.#ooooo#.', '.#oo#oo#.', '#oo#.#oo#', '###...###'],
  gem: ['.........', '..#####..', '.#ooooo#.', '#ooooooo#', '.#ooooo#.', '..#ooo#..', '...#o#...', '....#....', '.........'],
  banner: ['#........', '########.', '#oooooo#.', '#oo##oo#.', '#oooooo#.', '#oo##oo#.', '#oooooo#.', '#o#..#o#.', '#........'],
  heart: ['.........', '.##...##.', '#oo#.#oo#', '#ooo#ooo#', '#ooooooo#', '.#ooooo#.', '..#ooo#..', '...#o#...', '....#....'],
  scroll: ['.#######.', '#ooooooo#', '.#ooooo#.', '.#o###o#.', '.#ooooo#.', '.#o###o#.', '.#ooooo#.', '#ooooooo#', '.#######.'],
  swords: ['#.......#', '.#.....#.', '..#...#..', '...#.#...', '....#....', '...#.#...', '.##...##.', '.#.....#.', '#.......#'],
  scales: ['....#....', '#########', '#...#...#', '#...#...#', 'o#..#..o#', 'oo#.#.oo#', '....#....', '..#####..', '.........'],
  statue: ['...###...', '...#o#...', '..#ooo#..', '..#ooo#..', '...#o#...', '..#o.o#..', '.#######.', '.#ooooo#.', '#########'],
};
