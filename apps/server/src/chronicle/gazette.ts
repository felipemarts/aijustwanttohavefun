import type { VillageView } from '@ajwf/engine';
import { createRng, hashString, type DailyStats, type GazetteEdition, type GazetteSection, type GazetteSectionId, type Highlight, type KeyMsg } from '@ajwf/shared';
import type { DayTally } from './stats';

/**
 * The Village Gazette (§8.5): one edition per real day, written from templates only. Every text is an i18n key
 * `gazette.<slot>.<n>`, where `<slot>` is declared in packages/content/data/gazette_templates.yaml with the number of
 * variations. A seeded RNG picks the variations, so the same day and inputs always give the same edition. Agent
 * names are the only thing in it that agents chose. Pure.
 */

type Params = Record<string, string | number>;

export type GazetteInput = {
  date: string;
  /** World seed: editions differ between worlds but never between two builds of the same day. */
  seed: number;
  /** slot -> number of variations (`content.gazetteTemplates`). */
  templates: Readonly<Record<string, number>>;
  /** The day's highlights. */
  highlights: readonly Highlight[];
  village: VillageView;
  stats: DailyStats;
  tally: DayTally;
  /** False while the day is still running. */
  final: boolean;
};

/** How newsworthy each highlight type is, and the sections that report it. Higher priority wins the headline. */
const NEWS: Record<string, { priority: number; section: GazetteSectionId; headline?: string }> = {
  coup: { priority: 100, section: 'crime', headline: 'headline.coup' },
  treasury_looted: { priority: 95, section: 'crime', headline: 'headline.treasury_looted' },
  betrayal: { priority: 90, section: 'crime', headline: 'headline.betrayal' },
  world_boss_kill: { priority: 88, section: 'heroes', headline: 'headline.world_boss_slain' },
  mayor_elected: { priority: 85, section: 'election', headline: 'headline.mayor_elected' },
  mayor_reelected: { priority: 84, section: 'election', headline: 'headline.mayor_reelected' },
  embezzlement: { priority: 80, section: 'crime', headline: 'headline.embezzlement' },
  project_completed: { priority: 78, section: 'construction', headline: 'headline.project_completed' },
  statue_honor: { priority: 75, section: 'construction', headline: 'headline.statue_honor' },
  boss_kill: { priority: 70, section: 'heroes', headline: 'headline.boss_slain' },
  bounty_claimed: { priority: 65, section: 'crime', headline: 'headline.bounty_claimed' },
  legendary_drop: { priority: 62, section: 'heroes', headline: 'headline.legendary_drop' },
  world_first: { priority: 60, section: 'heroes', headline: 'headline.world_first' },
  guild_hall_built: { priority: 55, section: 'guilds', headline: 'headline.guild_hall_built' },
  scam_reported: { priority: 50, section: 'crime', headline: 'headline.scam_reported' },
  guild_founded: { priority: 45, section: 'guilds', headline: 'headline.guild_founded' },
  duel_upset: { priority: 40, section: 'heroes', headline: 'headline.duel_upset' },
  level_20: { priority: 38, section: 'heroes', headline: 'headline.level_20' },
  best_friends: { priority: 30, section: 'society', headline: 'headline.best_friends' },
  hot_rumor: { priority: 28, section: 'society', headline: 'headline.hot_rumor' },
  epic_drop: { priority: 20, section: 'heroes', headline: 'headline.epic_drop' },
  journal_after: { priority: 0, section: 'society' },
};

export const SECTION_ORDER: readonly GazetteSectionId[] = ['construction', 'election', 'crime', 'newcomers', 'prices', 'guilds', 'heroes', 'society'];

/** Lines per section. */
const MAX_ITEMS = 6;
const NEWCOMER_NAMES = 5;
const PRICE_ROWS = 5;
const PROGRESS_ROWS = 3;

/** Every slot the builder can use: each must be declared in gazette_templates.yaml (checked by the tests). */
export const GAZETTE_SLOTS: readonly string[] = [
  ...new Set([
    'headline.quiet_day',
    ...Object.values(NEWS).flatMap((n) => (n.headline ? [n.headline] : [])),
    ...SECTION_ORDER.map((s) => `section.${s}`),
    ...Object.keys(NEWS).map((t) => `item.${t}`),
    'item.project_progress',
    'item.project_available',
    'item.priority',
    'item.election_no_winner',
    'item.election_candidacy',
    'item.election_voting',
    'item.election_leader',
    'item.treasury',
    'item.tax_changed',
    'item.thefts',
    'item.pvp_kills',
    'item.bounties_placed',
    'item.wanted',
    'item.newcomers',
    'item.price',
    'item.guilds_disbanded',
    'item.guild_joins',
    'item.level_ups',
    'item.board_posts',
    'item.journals',
    'item.friendships',
  ]),
];

const rank = (h: Highlight) => NEWS[h.type]?.priority ?? 0;
/** Most newsworthy first; ties go to the more dramatic, then the later one. */
const byNews = (a: Highlight, b: Highlight) => rank(b) - rank(a) || b.drama - a.drama || b.ts - a.ts || a.id.localeCompare(b.id);

/** Picks text variations. Repeated slots in one edition rotate through their variations instead of repeating one. */
class Writer {
  private rng;
  private used = new Map<string, number>();

  constructor(
    private templates: Readonly<Record<string, number>>,
    date: string,
    seed: number,
  ) {
    this.rng = createRng(parseInt(hashString(date, seed >>> 0).slice(-8), 16));
  }

  msg(slot: string, p: Params = {}): KeyMsg {
    const n = Math.max(1, this.templates[slot] ?? 1);
    const prev = this.used.get(slot);
    const pick = prev === undefined ? this.rng.int(1, n) : (prev % n) + 1;
    this.used.set(slot, pick);
    return { k: `gazette.${slot}.${pick}`, p };
  }
}

export function buildGazette(o: GazetteInput): GazetteEdition {
  const w = new Writer(o.templates, o.date, o.seed);
  const hs = [...o.highlights].sort(byNews);
  const t = o.tally;
  const v = o.village;

  const top = hs.find((h) => NEWS[h.type]?.headline);
  const headline = top ? w.msg(NEWS[top.type]!.headline!, { ...top.params }) : w.msg('headline.quiet_day', { population: o.stats.population, online: o.stats.onlinePeak });

  const items: Record<GazetteSectionId, KeyMsg[]> = { construction: [], election: [], crime: [], newcomers: [], prices: [], guilds: [], heroes: [], society: [] };
  const add = (id: GazetteSectionId, m: KeyMsg) => items[id].length < MAX_ITEMS && items[id].push(m);
  // The headline story leads its section too, with its own wording.
  for (const h of hs) {
    const news = NEWS[h.type];
    if (news) add(news.section, w.msg(`item.${h.type}`, { ...h.params }));
  }

  // Construction: what was built, what is rising, what opened up.
  for (const p of v.projects.filter((x) => x.status === 'available' && x.progress >= 0.01).sort((a, b) => b.progress - a.progress || a.id.localeCompare(b.id)).slice(0, PROGRESS_ROWS)) {
    add('construction', w.msg('item.project_progress', { proj: `@proj:${p.id}`, pct: Math.floor(p.progress * 100) }));
  }
  for (const id of t.data.available) add('construction', w.msg('item.project_available', { proj: `@proj:${id}` }));
  if (v.priority) add('construction', w.msg('item.priority', { proj: `@proj:${v.priority}` }));

  // Election: the result of the day, the race in progress, the treasury.
  const e = v.election;
  if (t.count('election_result') > 0 && !hs.some((h) => h.type === 'mayor_elected' || h.type === 'mayor_reelected')) add('election', w.msg('item.election_no_winner', { n: v.lastElection?.n ?? e.n }));
  if (e.phase === 'candidacy') add('election', w.msg('item.election_candidacy', { n: e.candidates.length, days: Math.max(0, Math.ceil((e.voteAt - v.now) / 86_400_000)) }));
  else {
    add('election', w.msg('item.election_voting', { n: e.candidates.length, voters: e.voters, hours: Math.max(0, Math.ceil((e.end - v.now) / 3_600_000)) }));
    const lead = [...e.candidates].filter((c) => c.active && c.votes > 0).sort((a, b) => b.votes - a.votes || a.at - b.at)[0];
    if (lead) add('election', w.msg('item.election_leader', { name: lead.name, votes: lead.votes }));
  }
  if (t.count('mayor_tax') > 0) add('election', w.msg('item.tax_changed', { pct: Math.round(v.taxRate * 1000) / 10 }));
  add('election', w.msg('item.treasury', { gold: v.treasury, pct: Math.round(v.taxRate * 1000) / 10 }));

  // Crime: the numbers behind the stories.
  const steals = t.count('steal');
  const failed = t.count('steal_failed');
  if (steals + failed > 0) add('crime', w.msg('item.thefts', { n: steals, failed, gold: t.data.gold.steal ?? 0 }));
  if (t.count('pvp_kill') > 0) add('crime', w.msg('item.pvp_kills', { n: t.count('pvp_kill') }));
  if (t.count('bounty_placed') > 0) add('crime', w.msg('item.bounties_placed', { n: t.count('bounty_placed'), gold: t.data.gold.bounty_placed ?? 0 }));
  if (t.count('wanted') > 0) add('crime', w.msg('item.wanted', { n: t.count('wanted') }));

  // Newcomers.
  const fresh = t.data.newcomers;
  if (t.data.newcomerCount > 0) {
    const shown = fresh.slice(0, NEWCOMER_NAMES);
    add('newcomers', w.msg('item.newcomers', { n: t.data.newcomerCount, names: shown.join(', '), more: Math.max(0, t.data.newcomerCount - shown.length) }));
  }

  // Prices: the most traded items of the day.
  const traded = Object.entries(t.data.trades).sort((a, b) => b[1].n - a[1].n || b[1].qty - a[1].qty || a[0].localeCompare(b[0]));
  for (const [item, vol] of traded.slice(0, PRICE_ROWS)) add('prices', w.msg('item.price', { item: `@item:${item}`, avg: Math.round((vol.gold / vol.qty) * 10) / 10, qty: vol.qty }));

  // Guilds, heroes and society: counts after the stories.
  if (t.count('guild_join') > 0) add('guilds', w.msg('item.guild_joins', { n: t.count('guild_join') }));
  if (t.count('guild_disbanded') > 0) add('guilds', w.msg('item.guilds_disbanded', { n: t.count('guild_disbanded') }));
  if (t.count('level_up') > 0) add('heroes', w.msg('item.level_ups', { n: t.count('level_up') }));
  if (t.count('friend') > 0) add('society', w.msg('item.friendships', { n: t.count('friend') }));
  if (t.count('board_post') > 0) add('society', w.msg('item.board_posts', { n: t.count('board_post'), rumors: t.data.rumors }));
  if (t.count('journal') > 0) add('society', w.msg('item.journals', { n: t.count('journal') }));

  const lede: Record<GazetteSectionId, Params> = {
    construction: { done: t.count('project_completed'), total: v.projects.filter((p) => p.status === 'done').length, rising: v.projects.filter((p) => p.status === 'available' && p.progress > 0).length },
    election: { n: e.n, mayor: v.mayor?.name ?? '', office: v.mayor ? 'held' : 'vacant', phase: e.phase },
    crime: { n: items.crime.length },
    newcomers: { n: t.data.newcomerCount, population: o.stats.population },
    prices: { trades: o.stats.trades, items: traded.length },
    guilds: { n: items.guilds.length },
    heroes: { n: items.heroes.length },
    society: { n: items.society.length },
  };
  const sections: GazetteSection[] = [];
  for (const id of SECTION_ORDER) {
    if (!items[id].length) continue;
    const head = w.msg(`section.${id}`, lede[id]);
    sections.push({ id, k: head.k, p: head.p ?? {}, items: items[id] });
  }
  return { date: o.date, headline, sections, highlights: hs.map((h) => h.id), stats: o.stats, final: o.final };
}
