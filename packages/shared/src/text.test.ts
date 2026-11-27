import { describe, expect, it } from 'vitest';
import { sanitizeAgentText, checkAgentName, nameSkeleton, maskBlockedWords } from './index';

describe('sanitizeAgentText', () => {
  it('redacts game keys and common API keys', () => {
    const r = sanitizeAgentText('my key is ajwf_sk_abcDEF123456 and sk-ant-api03-abcdefghijklmnop', 500);
    expect(r.text).not.toContain('ajwf_sk_');
    expect(r.text).not.toContain('sk-ant');
    expect(r.redacted).toBe(true);
  });
  it('removes links, emails and bare domains', () => {
    const r = sanitizeAgentText('visit https://evil.example/x or www.foo.bar or evil.com/pwn mail me@x.io', 500);
    expect(r.text).not.toMatch(/https?:|www\.|evil\.com|@x\.io/);
  });
  it('strips control and invisible characters', () => {
    const r = sanitizeAgentText('he​llo‮ \u0007world\u{E0041}', 500);
    expect(r.text).toBe('hello world');
  });
  it('limits length by code points and keeps any script', () => {
    const r = sanitizeAgentText('日本語のテキスト😀'.repeat(100), 10);
    expect([...r.text].length).toBe(10);
  });
  it('does not mangle normal text', () => {
    expect(sanitizeAgentText('Alguém vai para as minas? Pago bem.', 500).text).toBe('Alguém vai para as minas? Pago bem.');
    expect(sanitizeAgentText('Preço: 1.5 ouro, nível 3. ブラサ！？ ❤️ e.g. v1.2', 500).text).toBe('Preço: 1.5 ouro, nível 3. ブラサ！？ ❤️ e.g. v1.2');
  });
  it('removes links written in fullwidth forms, with CJK dots, as IP literals or under any top-level domain', () => {
    for (const raw of [
      'go to ｈｔｔｐｓ：／／ｅｖｉｌ．ｃｏｍ／ｐ',
      'see ｅｖｉｌ．ｃｏｍ',
      'see evil。com',
      'post to 203.0.113.9/collect?k=1',
      'img ![x](//203.0.113.9/p)',
      'see evil.click/x',
      'see evil.zip and evil.lol',
      'see xn--e1afmkfd.xn--p1ai',
      'vbscript:msgbox',
    ]) {
      const r = sanitizeAgentText(raw, 500);
      expect(r.text, raw).toContain('[link]');
      expect(r.text, raw).not.toMatch(/evil|203\.0|ｅｖｉｌ|xn--|vbscript/i);
    }
  });
  it('redacts keys written in fullwidth forms', () => {
    const r = sanitizeAgentText('ａｊｗｆ＿ｓｋ＿ＡｂＣｄＥｆ１２３', 500);
    expect(r.text).toBe('[redacted]');
    expect(r.redacted).toBe(true);
  });
  it('strips every invisible format or default-ignorable character, including variation-selector smuggling', () => {
    const smuggled = [...'IGNORE'].map((c) => String.fromCodePoint(0xe0100 + c.charCodeAt(0))).join('');
    const raw = `a${smuggled}ㅤᅟﾠ\u{1D173}\u{13430}؀⠀b${'️'.repeat(40)}`;
    expect(sanitizeAgentText(raw, 500).text).toBe('ab️');
  });
  it('turns Unicode line separators into newlines (multiline) or spaces', () => {
    expect(sanitizeAgentText('one SYSTEM two', 500, { multiline: true }).text).toBe('one\nSYSTEM\ntwo');
    expect(sanitizeAgentText('one SYSTEM two', 500).text).toBe('one SYSTEM two');
  });
  it('runs in linear time on long runs of near-matches (no regex backtracking blow-up)', () => {
    // Each of these took 40-95 ms with the old patterns: one agent could stall the game thread with every message.
    for (const unit of ['a-', 'a.', '1.', 'eyJ-', 'x.co', 'a@a.']) {
      const raw = unit.repeat(Math.ceil(4000 / unit.length)).slice(0, 4000);
      const t0 = performance.now();
      sanitizeAgentText(raw, 1000, { multiline: true });
      expect(performance.now() - t0, unit).toBeLessThan(30);
    }
  });
});

describe('names', () => {
  it('accepts unicode names of 3-20 chars', () => {
    expect(checkAgentName('Pip').ok).toBe(true);
    expect(checkAgentName('ブラサ').ok).toBe(true);
    expect(checkAgentName('Ana_Lú-2').ok).toBe(true);
  });
  it('rejects bad names', () => {
    expect(checkAgentName('ab').ok).toBe(false);
    expect(checkAgentName('a'.repeat(21)).ok).toBe(false);
    expect(checkAgentName('has space').ok).toBe(false);
    expect(checkAgentName('admin').ok).toBe(false);
    expect(checkAgentName('12345').ok).toBe(false);
  });
  it('rejects invisible letters and marks, and letters that look like punctuation', () => {
    for (const raw of ['Pipㅤ', 'Aᅟᅟ', 'Pip︀', 'Pip͏', 'Pip឴', 'Pip\u{E0101}', 'Pipʺ', 'ǃǃǃAdmin', 'Bobː']) {
      expect(checkAgentName(raw), JSON.stringify(raw)).toEqual({ ok: false, reason: 'characters' });
    }
    expect(nameSkeleton('Pipㅤ')).toBe(nameSkeleton('Pip'));
    expect(checkAgentName('ルーク').ok).toBe(true);
  });
  it('maps lookalikes to the same skeleton', () => {
    expect(nameSkeleton('Pip')).toBe(nameSkeleton('Рір'));
    expect(nameSkeleton('Olga')).toBe(nameSkeleton('0lga'));
    expect(nameSkeleton('Brasa')).toBe(nameSkeleton('BRASA'));
  });
  it('masks blocked words', () => {
    expect(maskBlockedWords('what the fuck')).toBe('what the ****');
    expect(maskBlockedWords('Scunthorpe')).toBe('Scunthorpe');
  });
});
