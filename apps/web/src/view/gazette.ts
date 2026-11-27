/**
 * View model of a Village Gazette edition: every line rendered from the catalog, sections in reading order with a
 * lead story, the day's numbers. Pure; the page only lays it out.
 */
import type { GazetteEdition, GazetteSectionId, KeyMsg } from '@ajwf/shared';
import type { Translator } from '../i18n/translator';

/** Front-page order when the server's order does not say otherwise: what people talk about first. */
const PRIORITY: GazetteSectionId[] = [
  'construction',
  'election',
  'crime',
  'heroes',
  'guilds',
  'society',
  'newcomers',
  'prices',
];

export type GazetteSectionView = {
  id: GazetteSectionId;
  title: string;
  lede: string;
  items: string[];
};

export type GazetteView = {
  date: string;
  headline: string;
  final: boolean;
  lead: GazetteSectionView | null;
  sections: GazetteSectionView[];
  stats: { key: string; value: number }[];
};

const line = (tr: Translator, m: KeyMsg) => (tr.has(m.k) ? tr.t(m.k, m.p) : '');

export function gazetteView(e: GazetteEdition, tr: Translator): GazetteView {
  const sections = e.sections
    .map((s) => ({
      id: s.id,
      title: tr.t(`ui.gazette.section.${s.id}`),
      lede: line(tr, { k: s.k, p: s.p }),
      items: s.items.map((i) => line(tr, i)).filter((x) => x.length > 0),
    }))
    .filter((s) => s.lede || s.items.length)
    .sort((a, b) => PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id));
  const [lead = null, ...rest] = sections;
  const st = e.stats;
  return {
    date: e.date,
    headline: line(tr, e.headline) || tr.t('ui.gazette.no_headline'),
    final: e.final,
    lead,
    sections: rest,
    stats: [
      { key: 'population', value: st.population },
      { key: 'newcomers', value: st.newcomers },
      { key: 'online_peak', value: st.onlinePeak },
      { key: 'trades', value: st.trades },
      { key: 'projects', value: st.projects },
      { key: 'gold', value: st.goldInCirculation },
    ],
  };
}

/** Edition number: days since the first edition, counting from 1. */
export function editionNumber(date: string, first: string): number {
  const a = Date.parse(`${first}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}
