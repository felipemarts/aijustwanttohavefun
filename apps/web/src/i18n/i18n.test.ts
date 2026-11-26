import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../test/fixtures';
import { LogLine } from '../ui/LogLine';
import { detectLang, matchLang } from './languages';
import { formatEvent, Translator } from './translator';

const en = loadCatalog('en');
const pt = loadCatalog('pt-BR');

describe('event line localization', () => {
  it('resolves @kind:id params to localized content names', () => {
    const tr = new Translator('en', en, en);
    const line = formatEvent(tr, {
      id: '1',
      ts: 0,
      type: 'attack',
      k: 'ev.attack',
      p: { actor: 'Pip', target: '@mon:wolf', dmg: 12 },
    });
    expect(line).toMatchObject({ kind: 'line', text: expect.stringContaining('12') });
    if (line.kind === 'line') {
      expect(line.text).toContain(en['content.mon.wolf.name']!);
      expect(line.text).not.toContain('@mon');
    }
  });

  it('renders in the viewer language, with English fallback for missing keys', () => {
    const tr = new Translator('pt-BR', pt, en);
    const line = formatEvent(tr, {
      id: '1',
      ts: 0,
      type: 'move',
      k: 'ev.move',
      p: { actor: 'Pip', room: '@room:village.square' },
    });
    expect(line.kind === 'line' && line.text).toContain(pt['content.room.village.square.name']!);
    expect(tr.t('ui.only.english', {})).toBe('ui.only.english');
    const fallback = new Translator('pt-BR', { 'ui.a': 'A' }, { 'ui.b': 'B' });
    expect(fallback.t('ui.b')).toBe('B');
  });

  it('resolves @dir:x to dir.x', () => {
    const tr = new Translator('en', { 'dir.north': 'north', 'ui.x': 'Go {d}' });
    expect(tr.t('ui.x', { d: '@dir:north' })).toBe('Go north');
  });

  it('applies plural rules per language', () => {
    const e = new Translator('en', en);
    const p = new Translator('pt-BR', pt, en);
    expect(e.t('ui.room.agents', { n: 0 })).toBe('Nobody here');
    expect(e.t('ui.room.agents', { n: 1 })).toBe('1 agent here');
    expect(e.t('ui.room.agents', { n: 3 })).toBe('3 agents here');
    expect(p.t('ui.room.agents', { n: 1 })).toBe('1 agente aqui');
    expect(p.t('ui.room.agents', { n: 2 })).toBe('2 agentes aqui');
  });

  it('unknown event keys become a generic line, never a crash', () => {
    const tr = new Translator('en', en);
    const line = formatEvent(tr, { id: '1', ts: 0, type: 'mystery_thing', k: 'ev.not_a_key', actor: 'Pip' });
    expect(line.kind).toBe('line');
  });
});

describe('agent text', () => {
  it('is kept apart from narration and never interpreted as markup', () => {
    const tr = new Translator('en', en);
    const ev = {
      id: '9',
      ts: 0,
      type: 'say',
      actor: 'Pip<i>',
      lang: 'en',
      text: '<img src=x onerror=alert(1)><b>loot</b> {name} {0}',
    };
    const line = formatEvent(tr, ev);
    expect(line).toMatchObject({ kind: 'speech', text: ev.text });
    const html = renderToStaticMarkup(createElement(LogLine, { ev, tr, time: '12:00' }));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&lt;b&gt;loot&lt;/b&gt; {name} {0}');
    expect(html).toContain('Pip&lt;i&gt;');
    expect(html).toContain('lang="en"');
  });

  it('drops language tags that are not language tags', () => {
    const tr = new Translator('en', en);
    const html = renderToStaticMarkup(
      createElement(LogLine, {
        ev: { id: '1', ts: 0, type: 'say', actor: 'P', lang: 'en" onclick="x', text: 'hi' },
        tr,
        time: '',
      }),
    );
    expect(html).not.toContain('onclick');
  });
});

describe('language detection', () => {
  it('prefers the stored choice, then the browser list, then English', () => {
    expect(detectLang('fr', ['pt-BR'])).toBe('fr');
    expect(detectLang(null, ['de-DE', 'pt-PT', 'en'])).toBe('pt-BR');
    expect(detectLang('xx', ['zh-TW'])).toBe('zh-CN');
    expect(detectLang(null, ['ko'])).toBe('en');
    expect(matchLang('JA-jp')).toBe('ja');
  });
});
