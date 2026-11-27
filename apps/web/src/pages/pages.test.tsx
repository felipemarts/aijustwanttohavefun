/**
 * Every page: its route matches, it renders its empty state, and agent-written text on it is only ever text.
 * Server-side rendering (react-dom/server) in Node: no browser, no jsdom.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { matchRoutes, MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { parseFullProfile, parseGuild, parseVillage } from '../data/api';
import type { DataSource } from '../data/source';
import { Translator } from '../i18n/translator';
import { loadCatalog, loadStaticWorld } from '../test/fixtures';
import { AppContext } from '../ui/context';

const en = loadCatalog('en');
const tr = new Translator('en', en, en);

// The real i18n store reads Vite's virtual catalog module; the pages only need `useT()`.
vi.mock('../i18n/store', () => ({
  useT: () => tr,
  i18n: { tr, lang: 'en', subscribe: () => () => undefined, setLang: async () => undefined },
}));

vi.mock('../ui/pageStrings', () => ({}));

const { PAGE_ROUTES } = await import('../ui/routes');
const { VillageView } = await import('./VillagePage');
const { GazetteIndexPage, FrontPage } = await import('./GazettePage');
const { SecretsView } = await import('./SecretsPage');
const { HighlightFeedView, HighlightOneView } = await import('./HighlightsPage');
const { LeaderboardView } = await import('./LeaderboardPage');
const { BoardView } = await import('./BoardPage');
const { AgentProfileView } = await import('./AgentProfilePage');
const { GuildView } = await import('./GuildPage');
const { TimelapseView } = await import('./TimelapsePage');

const source: DataSource = {
  kind: 'mock',
  connect: () => undefined,
  setTopics: () => undefined,
  close: () => undefined,
  getJson: async () => null,
  spriteImage: async () => null,
  npcSpriteImage: async () => null,
};
const world = loadStaticWorld();

function html(node: ReactNode): string {
  return renderToStaticMarkup(
    <AppContext.Provider value={{ source, world }}>
      <MemoryRouter>{node}</MemoryRouter>
    </AppContext.Provider>,
  );
}

const ready = <T,>(data: T) => ({ status: 'ready' as const, data });
const T = (k: string) => en[k]!.replace(/’/g, '&#x27;').replace(/'/g, '&#x27;');
const has = (out: string, key: string) => {
  const text = en[key];
  expect(text, key).toBeTruthy();
  // compare on a stretch without characters React escapes
  expect(out).toContain(text!.split(/[’'&<>"]/)[0]!.slice(0, 24));
};

const XSS = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
const noMarkup = (out: string) => {
  expect(out).not.toMatch(/<img|<script/i);
  expect(out).toContain('&lt;img');
  expect(out).toContain('&lt;script&gt;');
};

describe('routes', () => {
  const paths: [string, string][] = [
    ['/', '/'],
    ['/village', '/village'],
    ['/gazette', '/gazette'],
    ['/gazette/2026-11-26', '/gazette/:date'],
    ['/secrets', '/secrets'],
    ['/highlights', '/highlights'],
    ['/h/h123', '/h/:id'],
    ['/leaderboard', '/leaderboard'],
    ['/board', '/board'],
    ['/a/Pip', '/a/:name'],
    ['/g/Iron%20Lanterns', '/g/:name'],
    ['/timelapse', '/timelapse'],
    ['/owner', '/owner'],
    [`/claim/${'A'.repeat(43)}`, '/claim/:token'],
    ['/nowhere/at/all', '*'],
  ];
  it.each(paths)('%s is served by %s', (path, route) => {
    const m = matchRoutes(PAGE_ROUTES, path);
    expect(m?.[m.length - 1]?.route.path).toBe(route);
  });
});

describe('empty states', () => {
  it('/village with a brand new village', () => {
    const v = parseVillage({ now: 1, population: 0, online: 0, projects: [], election: null })!;
    const out = html(<VillageView village={ready(v)} history={ready([])} timeline={ready([])} now={1} />);
    has(out, 'ui.village.no_projects');
    has(out, 'ui.village.no_history');
    has(out, 'ui.village.no_timeline');
    has(out, 'ui.village.no_mayor');
  });

  it('/gazette before the first edition', () => {
    has(html(<GazetteIndexPage index={ready([])} />), 'ui.gazette.empty');
  });

  it('/secrets with nothing revealed yet still explains the 24-hour rule', () => {
    const out = html(<SecretsView state={{ list: [], next: null, status: 'ready', more: false }} onMore={() => undefined} />);
    has(out, 'ui.secrets.empty');
    has(out, 'ui.secrets.rule_title');
  });

  it('/highlights and /h/:id', () => {
    has(html(<HighlightFeedView state={{ list: [], next: null, status: 'ready', more: false }} onMore={() => undefined} />), 'ui.highlights.empty');
    has(html(<HighlightOneView state={{ status: 'error' }} />), 'ui.highlights.not_found');
  });

  it('/leaderboard and /board', () => {
    const lb = html(<LeaderboardView by="honor" state={ready([])} onTab={() => undefined} />);
    has(lb, 'ui.leaderboard.empty');
    has(lb, 'ui.leaderboard.tab.contribution');
    has(html(<BoardView state={{ posts: [], next: null, status: 'ready', more: false }} tag={null} onTag={() => undefined} onMore={() => undefined} />), 'ui.board.empty');
  });

  it('/a/:name and /g/:name for names nobody has', () => {
    has(html(<AgentProfileView name="Nobody" state={{ status: 'error' }} />), 'ui.agent.not_found');
    has(html(<GuildView name="Nobody" state={{ status: 'error' }} />), 'ui.guild.not_found');
  });

  it('/timelapse before anything was built', () => {
    has(html(<TimelapseView state={ready([])} />), 'ui.timelapse.empty');
  });

  it('every page shows a loading state while it waits', () => {
    const loading = { status: 'loading' as const };
    for (const out of [
      html(<VillageView village={loading} history={loading} timeline={loading} now={1} />),
      html(<GazetteIndexPage index={loading} />),
      html(<SecretsView state={{ list: [], next: null, status: 'loading', more: false }} onMore={() => undefined} />),
      html(<LeaderboardView by="level" state={loading} onTab={() => undefined} />),
      html(<AgentProfileView name="Pip" state={loading} />),
      html(<TimelapseView state={loading} />),
    ])
      expect(out).toContain(T('ui.common.loading'));
  });
});

describe('agent text is never interpreted as markup', () => {
  it('secrets', () => {
    const out = html(
      <SecretsView
        state={{
          list: [{ id: 'c', channel: 'whisper', agents: ['A', 'B'], from: 1, to: 2, messages: [{ id: '1', ts: 1, from: 'A', text: XSS, lang: 'pt-BR' }] }],
          next: null,
          status: 'ready',
          more: false,
        }}
        onMore={() => undefined}
      />,
    );
    noMarkup(out);
    expect(out).toContain('lang="pt-BR"');
    expect(out).toContain('class="lang-chip"');
  });

  it('board posts and replies', () => {
    const out = html(
      <BoardView
        state={{ posts: [{ id: 'p', by: 'A', tag: 'rumor', text: XSS, lang: 'es', ts: 1, replies: [{ by: 'B', text: XSS, lang: 'fr', ts: 2 }] }], next: null, status: 'ready', more: false }}
        tag={null}
        onTag={() => undefined}
        onMore={() => undefined}
      />,
    );
    noMarkup(out);
    expect(out).toContain('lang="es"');
    expect(out).toContain('lang="fr"');
  });

  it('highlight quotes', () => {
    const out = html(
      <HighlightFeedView
        state={{
          list: [{ id: 'h1', type: 'hot_rumor', ts: 1, titleKey: 'highlight.hot_rumor', params: { name: XSS, n: 3 }, agents: [XSS], drama: 5, quote: { text: XSS, lang: 'ja' } }],
          next: null,
          status: 'ready',
          more: false,
        }}
        onMore={() => undefined}
      />,
    );
    noMarkup(out);
    expect(out).toContain('lang="ja"');
  });

  it('candidate platforms on the village page', () => {
    const v = parseVillage({
      now: 1,
      projects: [],
      election: { n: 1, phase: 'voting', voteAt: 0, end: 10, voters: 1, candidates: [{ name: 'Pip', votes: 1, platform: XSS, lang: 'zh-CN', active: true }] },
    })!;
    const out = html(<VillageView village={ready(v)} history={ready([])} timeline={ready([])} now={1} />);
    noMarkup(out);
    expect(out).toContain('lang="zh-CN"');
  });

  it('profile bio and journal, guild motto', () => {
    const p = parseFullProfile({ agent: { name: 'Pip', class: 'mage', lvl: 3, profession: 'smith', xp: [40, 120], bio: { untrusted_text: XSS }, bio_lang: 'pt-BR', journal: [{ ts: 1, text: XSS, lang: 'fr' }], achievements: [] } })!;
    expect(p).toMatchObject({ profession: 'smith', xp: { cur: 40, next: 120 }, bio: { text: XSS, lang: 'pt-BR' } });
    const out = html(<AgentProfileView name="Pip" state={ready(p)} />);
    noMarkup(out);
    expect(out).toContain('lang="fr"');
    expect(out).toContain('lang="pt-BR"');
    const g = parseGuild({ guild: { name: 'G', motto: XSS, motto_lang: 'es', colors: ['#ff0000', 'url(javascript:x)'], leader: 'Pip', officers: [], members: ['Pip'] } })!;
    expect(g.motto).toEqual({ text: XSS, lang: 'es' });
    const gout = html(<GuildView name="G" state={ready(g)} />);
    noMarkup(gout);
    expect(gout).not.toContain('javascript');
    expect(gout).toContain('lang="es"');
  });

  it('the gazette front page has no agent text at all, only catalog lines', () => {
    const out = html(
      <FrontPage
        number={1}
        edition={{
          date: '2026-11-26',
          headline: { k: 'gazette.headline.betrayal.1', p: { name: XSS, victim: 'B' } },
          sections: [],
          highlights: [],
          stats: { date: '2026-11-26', population: 1, onlinePeak: 1, projects: 0, projectsToday: 0, goldInCirculation: 0, avgPrices: {}, trades: 0, newcomers: 0 },
          final: true,
        }}
      />,
    );
    noMarkup(out);
  });
});
