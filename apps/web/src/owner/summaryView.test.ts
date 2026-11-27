import { describe, expect, it } from 'vitest';
import { Translator } from '../i18n/translator';
import { loadCatalog } from '../test/fixtures';
import { parseMe, parseShare, parseSummary, safeIntentUrl, ogAgentPath } from './parse';
import { storyIcon, summaryView, windowText } from './summaryView';

const en = loadCatalog('en');
const pt = loadCatalog('pt-BR');
const tr = new Translator('en', en, en);
const trPt = new Translator('pt-BR', pt, en);

/** Local time, like the owner's clock. */
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
// Thursday, 26 Nov 2026, 18:00.
const NOW = at(2026, 11, 26, 18);

const body = {
  ok: true,
  agent: { id: 'a1b', name: 'Pip' },
  since: at(2026, 11, 24, 14),
  until: NOW,
  items: [
    { type: 'levels', k: 'owner.summary.levels', p: {}, text: 'Pip gained 2 levels and is now level 7.' },
    { type: 'betrayed_by', k: 'owner.summary.betrayed_by', p: {}, text: 'Pip was betrayed by Vex.' },
    { type: 'mystery', text: 'Something new.' },
    { type: 'broken' },
  ],
  highlights: [
    { id: 'h1042', k: 'highlight.betrayal', p: {}, text: 'Vex betrays Pip!', ts: NOW - 3_600_000 },
    { id: 'javascript:alert(1)', text: 'nope', ts: 1 },
    { id: 'h1/../../x', text: 'nope', ts: 1 },
  ],
  text: '…',
};

describe('"while you were away" view model', () => {
  it('turns the summary into a story feed with icons and highlight links', () => {
    const s = parseSummary(body)!;
    const v = summaryView(tr, s, NOW);
    expect(v.lines.map((l) => [l.type, l.icon, l.tone])).toEqual([
      ['levels', 'star', 'gold'],
      ['betrayed_by', 'dagger', 'danger'],
      ['mystery', 'scroll', 'plain'],
    ]);
    expect(v.lines[0]!.text).toBe('Pip gained 2 levels and is now level 7.');
    expect(new Set(v.lines.map((l) => l.key)).size).toBe(3);
    // Only well-formed highlight ids become links.
    expect(v.highlights).toEqual([{ id: 'h1042', href: '/h/h1042', text: 'Vex betrays Pip!', ts: NOW - 3_600_000 }]);
    expect(v.quiet).toBe(false);
    expect(v.window).toMatch(/^Since Tuesday, (14:00|02:00 PM)$/);
  });

  it('says when the window started the way people say it', () => {
    expect(windowText(tr, at(2026, 11, 26, 9, 5), NOW)).toMatch(/^Since (09:05|09:05 AM) today$/);
    expect(windowText(tr, at(2026, 11, 20, 23, 30), NOW)).toMatch(/^Since Friday, (23:30|11:30 PM)$/);
    expect(windowText(tr, at(2026, 11, 3, 14), NOW)).toMatch(/^Since Nov 3, (14:00|02:00 PM)$/);
    expect(windowText(trPt, at(2026, 11, 24, 14), NOW)).toBe('Desde terça-feira, 14:00');
    expect(windowText(trPt, at(2026, 11, 26, 9, 5), NOW)).toBe('Desde hoje às 09:05');
  });

  it('a quiet stretch is flagged as quiet', () => {
    const s = parseSummary({ since: 1, until: 2, items: [{ type: 'quiet', text: 'A quiet stretch for Pip.' }], highlights: [] })!;
    expect(summaryView(tr, s, NOW).quiet).toBe(true);
    expect(storyIcon('quiet')).toEqual(['scroll', 'plain']);
  });

  it('refuses a summary without its window', () => {
    expect(parseSummary({ items: [] })).toBeNull();
  });
});

describe('owner parsers', () => {
  it('keeps only valid agent ids and sprite hashes, and the card as a path on this site', () => {
    const me = parseMe({
      owner: { id: 'o1', name: 'Ada', provider: 'github', language: 'en' },
      limits: { max_agents: 3, note_max: 280 },
      agents: [
        { id: 'a1b', name: 'Pip', class: 'mage', level: 3, status: 'active', sprite_hash: 'abc123', card_url: 'http://localhost:8710/og/agent/Pip.png?lang=en' },
        { id: '../x', name: 'Bad' },
        { id: 'a2c', name: 'Bo', sprite_hash: 'javascript:1', card_url: 'https://evil.example/steal.png', status: 'god' },
      ],
      push: { enabled: true, subscriptions: 1 },
    })!;
    expect(me.agents.map((a) => a.id)).toEqual(['a1b', 'a2c']);
    expect(me.agents[0]!.cardPath).toBe('/og/agent/Pip.png?lang=en');
    expect(me.agents[1]).toMatchObject({ spriteHash: '', status: 'active', cardPath: '/og/agent/Bo.png?lang=en' });
    expect(ogAgentPath('/og/agent/../../api/owner/me.png')).toBeNull();
  });

  it('opens only X intent links from the share answer', () => {
    expect(safeIntentUrl('https://x.com/intent/post?text=hi')).toBe('https://x.com/intent/post?text=hi');
    for (const bad of ['javascript:alert(1)', 'http://x.com/intent/post', 'https://x.com.evil.example/intent/post', 'https://evil.example/?https://x.com/intent/', 'data:text/html,hi'])
      expect(safeIntentUrl(bad), bad).toBeNull();
    expect(parseShare({ text: 't', url: 'u', intent_url: 'javascript:alert(1)' })).toBeNull();
  });
});
