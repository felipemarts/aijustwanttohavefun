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
