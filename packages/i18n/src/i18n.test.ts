import { describe, expect, it } from 'vitest';
import { I18n, coverageReport, findInvalidMessages } from './index';
import { loadLocales } from './node';

const catalogs = loadLocales();
const i18n = new I18n(catalogs);

describe('i18n', () => {
  it('ships the 6 launch languages', () => {
    for (const l of ['en', 'pt-BR', 'es', 'zh-CN', 'ja', 'fr']) expect(catalogs[l]).toBeDefined();
  });
  it('renders plurals with ICU MessageFormat', () => {
    expect(i18n.t('en', 'ui.agents_online', { n: 1 })).toBe('1 agent online');
    expect(i18n.t('en', 'ui.agents_online', { n: 3 })).toBe('3 agents online');
    expect(i18n.t('pt-BR', 'ui.agents_online', { n: 2 })).toBe('2 agentes online');
  });
  it('resolves any BCP-47 tag to the closest language', () => {
    expect(i18n.resolveLang('pt')).toBe('pt-BR');
    expect(i18n.resolveLang('pt-PT')).toBe('pt-BR');
    expect(i18n.resolveLang('zh')).toBe('zh-CN');
    expect(i18n.resolveLang('de-AT')).toBe('en');
    expect(i18n.resolveLang('FR-ca')).toBe('fr');
  });
  it('never takes an Object.prototype member for a language', () => {
    for (const tag of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) expect(i18n.resolveLang(tag)).toBe('en');
  });
  it('falls back to English for missing keys, then to the key', () => {
    const local = new I18n({ en: { a: 'A {x}' }, fr: {} });
    expect(local.t('fr', 'a', { x: 1 })).toBe('A 1');
    expect(local.t('fr', 'missing.key')).toBe('missing.key');
  });
  it('resolves entity references in params', () => {
    const local = new I18n({ en: { 'content.room.r1.name': 'The Square', msg: 'You enter {room}.' } });
    expect(local.t('en', 'msg', { room: '@room:r1' })).toBe('You enter The Square.');
  });
  it('every message in every language parses', () => {
    for (const [lang, cat] of Object.entries(catalogs)) expect(findInvalidMessages(cat, lang)).toEqual([]);
  });
  it('produces a coverage report', () => {
    const rows = coverageReport(catalogs);
    expect(rows.find((r) => r.lang === 'en')?.percent).toBe(100);
  });
});
