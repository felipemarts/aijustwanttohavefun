import { loadContent } from '@ajwf/content/node';
import { createWorld, villageView } from '@ajwf/engine';
import { I18n } from '@ajwf/i18n';
import { loadLocales } from '@ajwf/i18n/node';
import type { GameEvent, Highlight } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { buildGazette, GAZETTE_SLOTS, type GazetteInput } from './gazette';
import { HIGHLIGHT_KEYS } from './highlights';
import { dailyStats, DayTally } from './stats';

const content = loadContent();
const en = loadLocales().en!;
const i18n = new I18n({ en });
const T = Date.UTC(2026, 10, 26, 15);

function hl(type: string, params: Highlight['params'], drama = 5, n = 1): Highlight {
  return { id: `h${n}`, type, ts: T + n, titleKey: `highlight.${type}`, params, agents: [String(params.name ?? '')].filter(Boolean), drama };
}

function input(date: string, highlights: Highlight[], events: Partial<GameEvent>[] = []): GazetteInput {
  const s = createWorld(content, T);
  const tally = new DayTally(date);
  let id = 0;
  for (const e of events) tally.consume({ id: String(++id), ts: T, visibility: 'public', payload: {}, type: 'x', ...e }, (x) => ({ a1: 'Pip', a2: 'Brasa' })[x]);
  const stats = dailyStats({ population: 12, onlinePeak: 5, projectsDone: 0, goldInCirculation: 1000, tally });
  return { date, seed: 42, templates: content.gazetteTemplates, highlights, village: villageView(s, T), stats, tally, final: true };
}

const busy = () => [
  hl('project_completed', { proj: '@proj:bridge', name: 'Brasa', by: 'agent' }, 9, 1),
  hl('betrayal', { name: 'Pip', victim: 'Brasa' }, 15, 2),
  hl('guild_founded', { name: 'Mira', guild: 'Iron Owls' }, 6, 3),
  hl('best_friends', { name: 'Pip', other: 'Mira' }, 7, 4),
  hl('boss_kill', { name: 'Mira', mon: '@mon:the_hollow_regent', n: 3 }, 10, 5),
];
const busyEvents: Partial<GameEvent>[] = [
  { type: 'arrival', actor: 'a1' },
  { type: 'arrival', actor: 'a2' },
  { type: 'market_trade', payload: { item: 'wood', qty: 10, price: 3 } },
  { type: 'market_trade', payload: { item: 'wood', qty: 5, price: 4 } },
  { type: 'steal', payload: { gold: 12 } },
  { type: 'level_up' },
  { type: 'board_post', payload: { tag: 'rumor' } },
];

/** Every key with its params renders to real text (no key echoed back, no ICU error). */
function expectRenders(e: ReturnType<typeof buildGazette>) {
  const all = [e.headline, ...e.sections.map((s) => ({ k: s.k, p: s.p })), ...e.sections.flatMap((s) => s.items)];
  for (const m of all) {
    expect(en[m.k], m.k).toBeTypeOf('string');
    const text = i18n.t('en', m.k, m.p);
    expect(text, m.k).not.toBe(m.k);
    expect(text, m.k).not.toMatch(/[{}]/);
  }
}

describe('Village Gazette', () => {
  it('is deterministic: same day, inputs and seed give the same edition', () => {
    const a = buildGazette(input('2026-11-26', busy(), busyEvents));
    const b = buildGazette(input('2026-11-26', busy(), busyEvents));
    expect(a).toEqual(b);
    expect(a.headline.k).toMatch(/^gazette\.headline\.betrayal\.\d$/);
    expect(a.sections.map((s) => s.id)).toEqual(['construction', 'election', 'crime', 'newcomers', 'prices', 'guilds', 'heroes', 'society']);
    expect(a.highlights).toHaveLength(5);
    const prices = a.sections.find((s) => s.id === 'prices')!;
    expect(prices.items[0]!.p).toMatchObject({ item: '@item:wood', avg: 3.3, qty: 15 });
    expectRenders(a);
  });

  it('varies from day to day', () => {
    const heads = new Set<string>();
    const ledes = new Set<string>();
    for (let d = 1; d <= 10; d++) {
      const e = buildGazette(input(`2026-12-${String(d).padStart(2, '0')}`, busy(), busyEvents));
      heads.add(e.headline.k);
      ledes.add(e.sections.map((s) => s.k).join('|'));
    }
    expect(heads.size).toBeGreaterThan(1);
    expect(ledes.size).toBeGreaterThan(1);
  });

  it('a quiet day gets the quiet headline and only the standing sections', () => {
    const e = buildGazette(input('2026-11-27', []));
    expect(e.headline.k).toMatch(/^gazette\.headline\.quiet_day\.[1-3]$/);
    expect(e.headline.p).toEqual({ population: 12, online: 5 });
    expect(e.sections.map((s) => s.id)).toEqual(['election']);
    expectRenders(e);
  });

  it('never carries agent-written text: only keys and the params it was given', () => {
    const e = buildGazette(input('2026-11-26', [{ ...hl('journal_after', { name: 'Pip', about: 'betrayal' }), quote: { text: 'SECRET DIARY', lang: 'en' } }]));
    expect(JSON.stringify(e)).not.toContain('SECRET DIARY');
  });

  it('every slot it uses is declared, and every declared slot has exactly that many English texts', () => {
    const t = content.gazetteTemplates;
    for (const slot of GAZETTE_SLOTS) expect(t[slot], slot).toBeGreaterThanOrEqual(1);
    for (const [slot, n] of Object.entries(t)) {
      for (let i = 1; i <= n; i++) expect(en[`gazette.${slot}.${i}`], `gazette.${slot}.${i}`).toBeTypeOf('string');
      expect(en[`gazette.${slot}.${n + 1}`], `gazette.${slot}.${n + 1}`).toBeUndefined();
    }
    const declared = new Set(Object.entries(t).flatMap(([slot, n]) => Array.from({ length: n }, (_, i) => `gazette.${slot}.${i + 1}`)));
    for (const k of Object.keys(en).filter((k) => k.startsWith('gazette.'))) expect(declared.has(k), k).toBe(true);
  });

  it('every highlight title key exists in English', () => {
    for (const k of HIGHLIGHT_KEYS) expect(en[k], k).toBeTypeOf('string');
    for (const k of Object.keys(en).filter((k) => k.startsWith('highlight.'))) expect(HIGHLIGHT_KEYS, k).toContain(k);
  });

  it('renders every slot with every variation without leaving placeholders', () => {
    const p = { name: 'Pip', victim: 'Brasa', other: 'Mira', old: 'Brasa', guild: 'Owls', reason: 'vote', proj: 'Bridge', by: 'agent', mon: 'Slime', item: 'Wood', ach: 'First', room: 'Plot', loser: 'Brasa', target: 'Mira', accused: 'Mira', about: 'betrayal', office: 'held', mayor: 'Pip', phase: 'voting' };
    const nums = ['n', 'votes', 'gold', 'value', 'pct', 'rounds', 'level', 'days', 'hours', 'voters', 'failed', 'more', 'population', 'online', 'done', 'total', 'rising', 'trades', 'items', 'avg', 'qty', 'rumors'];
    const params = { ...p, ...Object.fromEntries(nums.map((k) => [k, 2])), names: 'A, B' };
    for (const [slot, n] of Object.entries(content.gazetteTemplates)) {
      for (let i = 1; i <= n; i++) expect(i18n.t('en', `gazette.${slot}.${i}`, params), slot).not.toMatch(/[{}]|gazette\./);
    }
    for (const k of HIGHLIGHT_KEYS) expect(i18n.t('en', k, params), k).not.toMatch(/[{}]|highlight\./);
  });
});
