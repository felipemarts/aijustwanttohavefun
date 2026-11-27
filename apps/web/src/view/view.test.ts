import type { GazetteEdition, Highlight, SecretConversation, TimelineEntry } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { parseEdition, parseSecrets, parseTimeline } from '../data/api';
import { Translator } from '../i18n/translator';
import { siteState } from '../map/sites';
import { loadCatalog, loadStaticWorld } from '../test/fixtures';
import { extent, indexTicks, linearScale, niceStep, niceTicks } from './chart';
import { editionNumber, gazetteView } from './gazette';
import { highlightView } from './highlights';
import { layoutProjectTree } from './projectTree';
import { mergeSecretPages, participants, threadOf } from './secrets';
import { replaySpan, replayUntil, sortTimeline } from './timelapse';

const en = loadCatalog('en');
const pt = loadCatalog('pt-BR');
const trEn = new Translator('en', en, en);
const trPt = new Translator('pt-BR', pt, en);

describe('project tree layout', () => {
  const projects = [
    { id: 'bridge', requires: [] },
    { id: 'watchtower', requires: [] },
    { id: 'inn_expansion', requires: [] },
    { id: 'library', requires: ['watchtower'] },
    { id: 'covered_market', requires: ['inn_expansion'] },
    { id: 'arena', requires: ['bridge'] },
    { id: 'wall', requires: ['arena', 'watchtower'] },
    { id: 'statue', requires: ['bridge', 'watchtower', 'inn_expansion'] },
  ];

  it('puts each project one column after the deepest thing it needs', () => {
    const l = layoutProjectTree(projects);
    const col = Object.fromEntries(l.nodes.map((n) => [n.item.id, n.col]));
    expect(col).toMatchObject({ bridge: 0, watchtower: 0, inn_expansion: 0, library: 1, arena: 1, statue: 1, covered_market: 1, wall: 2 });
    expect(l.cols).toBe(3);
    expect(l.edges).toContainEqual({ from: 'arena', to: 'wall' });
    expect(l.edges).toHaveLength(8);
  });

  it('never stacks two projects in the same cell and keeps children near their parents', () => {
    const l = layoutProjectTree(projects);
    const cells = new Set(l.nodes.map((n) => `${n.col}:${n.row}`));
    expect(cells.size).toBe(projects.length);
    const row = Object.fromEntries(l.nodes.map((n) => [n.item.id, n.row]));
    expect(row.arena).toBeLessThanOrEqual(row.library!);
    expect(l.rows).toBeGreaterThanOrEqual(4);
  });

  it('survives cycles and unknown requirements', () => {
    const l = layoutProjectTree([
      { id: 'a', requires: ['b'] },
      { id: 'b', requires: ['a', 'ghost'] },
    ]);
    expect(l.nodes).toHaveLength(2);
    expect(l.edges.every((e) => e.from !== 'ghost')).toBe(true);
    expect(layoutProjectTree([])).toMatchObject({ nodes: [], cols: 0, rows: 0 });
  });
});

describe('chart scales', () => {
  it('maps a domain to a range, flat domains to the middle', () => {
    const s = linearScale([0, 10], [100, 0]);
    expect(s(0)).toBe(100);
    expect(s(5)).toBe(50);
    expect(s(10)).toBe(0);
    expect(linearScale([3, 3], [0, 10])(3)).toBe(5);
  });

  it('nice ticks are round, cover the data and keep integers integer', () => {
    expect(niceStep(97, 4)).toBe(25);
    const t = niceTicks(0, 237, 4, true);
    expect(t.ticks[0]).toBe(0);
    expect(t.ticks[t.ticks.length - 1]).toBeGreaterThanOrEqual(237);
    expect(t.ticks.every((v) => Number.isInteger(v))).toBe(true);
    expect(t.domain).toEqual([t.ticks[0], t.ticks[t.ticks.length - 1]]);
    const small = niceTicks(0, 3, 4, true);
    expect(small.ticks).toEqual([0, 1, 2, 3]);
    const flat = niceTicks(5, 5, 4);
    expect(flat.domain[0]).toBeLessThan(5);
    expect(flat.domain[1]).toBeGreaterThan(5);
    expect(niceTicks(Number.NaN, 1).ticks).toEqual([0, 1]);
  });

  it('index ticks always include both ends and never repeat', () => {
    expect(indexTicks(30, 4)).toEqual([0, 10, 19, 29]);
    expect(indexTicks(2, 6)).toEqual([0, 1]);
    expect(indexTicks(1, 6)).toEqual([0]);
    expect(indexTicks(0, 6)).toEqual([]);
    expect(extent([3, Number.NaN, -1, 8])).toEqual([-1, 8]);
  });
});

const EDITION: GazetteEdition = {
  date: '2026-11-26',
  headline: { k: 'gazette.headline.project_completed.1', p: { proj: '@proj:library' } },
  sections: [
    { id: 'prices', k: 'gazette.section.prices.2', p: { trades: 4 }, items: [{ k: 'gazette.item.price.2', p: { item: '@item:wood', avg: 3 } }] },
    { id: 'construction', k: 'gazette.section.construction.1', p: { done: 1, total: 3 }, items: [{ k: 'gazette.item.project_completed.2', p: { proj: '@proj:library' } }, { k: 'gazette.item.no_such_key', p: {} }] },
    { id: 'crime', k: 'gazette.section.crime.1', p: { n: 1 }, items: [] },
  ],
  highlights: [],
  stats: { date: '2026-11-26', population: 40, onlinePeak: 12, projects: 3, projectsToday: 1, goldInCirculation: 5000, avgPrices: {}, trades: 4, newcomers: 2 },
  final: true,
};

describe('gazette view model', () => {
  it('renders every line from the catalog, building news first, and drops unknown keys', () => {
    const v = gazetteView(EDITION, trEn);
    expect(v.headline).toContain(en['content.proj.library.name']!);
    expect(v.lead?.id).toBe('construction');
    expect(v.lead?.items).toHaveLength(1);
    expect(v.sections.map((s) => s.id)).toEqual(['crime', 'prices']);
    expect(v.sections[1]!.items[0]).toContain(en['content.item.wood.name']!);
    expect(v.stats.find((s) => s.key === 'population')?.value).toBe(40);
    expect(v.sections[0]!.title).toBe(en['ui.gazette.section.crime']);
  });

  it('localizes section titles and falls back to English for missing gazette keys', () => {
    const v = gazetteView(EDITION, trPt);
    expect(v.lead?.title).toBe(pt['ui.gazette.section.construction']);
    expect(v.headline.length).toBeGreaterThan(3);
  });

  it('parses an edition defensively and numbers editions by day', () => {
    expect(parseEdition({ date: '2026-11-26', headline: { k: 'x' }, sections: [{ id: 'evil', k: 'y' }, { id: 'crime', k: 'z', items: [{ k: 1 }] }] })?.sections).toEqual([
      { id: 'crime', k: 'z', p: {}, items: [] },
    ]);
    expect(parseEdition({ date: 'x' })).toBeNull();
    expect(editionNumber('2026-11-27', '2026-11-21')).toBe(7);
    expect(editionNumber('2026-11-21', '2026-11-21')).toBe(1);
  });
});

const conv = (id: string, to: number, msgs: [string, string, number][], channel: SecretConversation['channel'] = 'whisper'): SecretConversation => ({
  id,
  channel,
  agents: [...new Set(msgs.map((m) => m[1]))],
  from: msgs[0]![2],
  to,
  messages: msgs.map(([mid, from, ts]) => ({ id: mid, from, ts, text: `${from} says hi`, lang: 'en' })),
});

describe('secrets view model', () => {
  it('merges pages newest first and joins a conversation split across two pages', () => {
    const a = conv('c1', 300, [['3', 'Pip', 250], ['4', 'Bo', 300]]);
    const b = conv('c2', 200, [['2', 'Ann', 200]]);
    const older = conv('c1', 240, [['1', 'Pip', 240]]);
    const merged = mergeSecretPages(mergeSecretPages([], [a, b]), [older]);
    expect(merged.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(merged[0]!.messages.map((m) => m.id)).toEqual(['1', '3', '4']);
    expect(merged[0]!.from).toBe(240);
  });

  it('groups consecutive messages of a speaker; whispers put the second speaker on the other side', () => {
    const c = conv('c1', 400, [['1', 'Pip', 0], ['2', 'Pip', 60_000], ['3', 'Bo', 120_000], ['4', 'Pip', 180_000]]);
    const t = threadOf(c);
    expect(t.map((g) => [g.from, g.side, g.messages.length])).toEqual([
      ['Pip', 'start', 2],
      ['Bo', 'end', 1],
      ['Pip', 'start', 1],
    ]);
    const guild = threadOf(conv('c2', 1, [['1', 'A', 0], ['2', 'B', 1], ['3', 'C', 2]], 'guild'));
    expect(guild.every((g) => g.side === 'start')).toBe(true);
    expect(participants({ ...c, agents: ['Pip', 'Bo', 'Silent'] })).toEqual(['Pip', 'Bo', 'Silent']);
  });

  it('parses the page cursor and drops conversations without messages', () => {
    const p = parseSecrets({ conversations: [{ id: 'c', channel: 'evil', messages: [] }, { id: 'd', channel: 'party', messages: [{ id: '9', ts: 1, from: 'A', text: 'x', lang: 'en' }] }], next: 42 });
    expect(p.conversations.map((c) => [c.id, c.channel])).toEqual([['d', 'party']]);
    expect(p.next).toBe('42');
    expect(parseSecrets({ conversations: [], next: 'drop table' }).next).toBeNull();
  });
});

describe('highlight view model', () => {
  const h: Highlight = {
    id: 'h1',
    type: 'journal_after',
    ts: 5,
    titleKey: 'highlight.journal_after',
    params: { name: 'Pip', about: 'betrayal' },
    agents: ['Pip'],
    drama: 6,
    quote: { text: '<b>never again</b>', lang: 'pt-BR' },
  };

  it('picks an icon and tone by type and renders the title from its key', () => {
    const v = highlightView(h, trEn);
    expect(v.icon).toBe('scroll');
    expect(v.title).toContain('Pip');
    expect(v.quote).toEqual({ text: '<b>never again</b>', lang: 'pt-BR' });
    expect(highlightView({ ...h, type: 'betrayal', titleKey: 'highlight.betrayal', params: { name: 'A', victim: 'B' } }, trEn).tone).toBe('danger');
    expect(highlightView({ ...h, type: 'mayor_elected' }, trEn).icon).toBe('crown');
  });

  it('never shows a raw key and drops bad language tags', () => {
    const v = highlightView({ ...h, titleKey: 'highlight.from_the_future', quote: { text: 'x', lang: '"><script>' } }, trEn);
    expect(v.title).not.toContain('highlight.');
    expect(v.quote?.lang).toBeNull();
  });
});

describe('timelapse replay', () => {
  const raw: TimelineEntry[] = [
    { id: 't3', ts: 300, type: 'project_completed', plot: 'village.river_bank', project: 'bridge', building: 'bridge' },
    { id: 't1', ts: 100, type: 'project_available', plot: 'village.river_bank', project: 'bridge' },
    { id: 't10', ts: 200, type: 'project_progress', plot: 'village.river_bank', project: 'bridge', progress: 0.5 },
    { id: 't2', ts: 200, type: 'project_started', plot: 'village.river_bank', project: 'bridge', progress: 0.02 },
    { id: 't4', ts: 400, type: 'hall_built', plot: 'village.plot_far', guild: 'Iron Lanterns', colors: ['#d9534f', '#f2b84b'] },
    { id: 't5', ts: 500, type: 'statue_honor', name: 'Pip' },
    { id: 't6', ts: 600, type: 'hall_removed', plot: 'village.plot_far', guild: 'Iron Lanterns' },
  ];

  it('orders by time, then by the sequence in the id (t2 before t10)', () => {
    expect(sortTimeline(raw).map((e) => e.id)).toEqual(['t1', 't2', 't10', 't3', 't4', 't5', 't6']);
  });

  it('folds the entries into the state at any instant, progress never going back', () => {
    const sorted = sortTimeline(raw);
    expect(replayUntil(sorted, 50).projects.size).toBe(0);
    const mid = replayUntil(sorted, 250);
    expect(mid.projects.get('bridge')).toMatchObject({ progress: 0.5, done: false, available: true });
    expect(mid.last?.id).toBe('t10');
    const built = replayUntil(sorted, 450);
    expect(built.projects.get('bridge')).toMatchObject({ progress: 1, done: true });
    expect(built.halls.get('village.plot_far')?.guild).toBe('Iron Lanterns');
    const end = replayUntil(sorted, 1000);
    expect(end.honoree).toBe('Pip');
    expect(end.halls.size).toBe(0);
    expect(end.applied).toBe(7);
    const [a, b] = replaySpan(sorted);
    expect(a).toBeLessThan(100);
    expect(b).toBeGreaterThan(600);
  });

  it('parses only known entry types and validates colours', () => {
    const list = parseTimeline({ entries: [{ id: 'x', ts: 1, type: 'project_exploded' }, { id: 'y', ts: 2, type: 'hall_built', guild: 'G', colors: ['red', '#00ff00'] }] });
    expect(list.map((e) => e.id)).toEqual(['y']);
    expect(list[0]!.colors![0]).toMatch(/^#[0-9a-f]{6}$/);
    expect(list[0]!.colors![1]).toBe('#00ff00');
  });
});

describe('map sites from live data', () => {
  const world = loadStaticWorld();
  const p = (id: string, plot: string, progress: number, done = false) => ({ id, plot, progress, done, status: (done ? 'done' : 'available') as 'done' | 'available' });

  it('an open project with nothing given yet is an empty lot, not scaffolding', () => {
    expect(siteState('village.plot_nw', 'plot', { projects: [p('library', 'village.plot_nw', 0)], buildings: {}, halls: {} }, world).mode).toBe('lot');
    expect(siteState('village.plot_nw', 'plot', { projects: [p('library', 'village.plot_nw', 0.3)], buildings: {}, halls: {} }, world)).toMatchObject({ mode: 'work', progress: 0.3 });
  });

  it('a rebuilt room keeps its own look until the project is done, then swaps to the new one', () => {
    const base = siteState('village.tavern', 'variant', { projects: [p('inn_expansion', 'village.tavern', 0)], buildings: {}, halls: {} }, world);
    expect(base.mode).toBe('base');
    const done = siteState('village.tavern', 'variant', { projects: [p('inn_expansion', 'village.tavern', 1, true)], buildings: {}, halls: {} }, world);
    expect(done).toMatchObject({ mode: 'done', building: 'inn' });
  });

  it('a guild hall wins over the plot', () => {
    const s = siteState('village.plot_far', 'plot', { projects: [], buildings: {}, halls: { 'village.plot_far': { guild: 'G', colors: ['#000000', '#ffffff'], at: 1 } } }, world);
    expect(s.mode).toBe('hall');
  });
});
