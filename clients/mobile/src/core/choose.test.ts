import { describe, expect, it } from 'vitest';
import { chooseCore } from './choose';
import { readToken, takeSessionToken } from './session';

describe('chooseCore', () => {
  it('web talks to the desktop program, with or without a fragment (the cookie may already be there)', () => {
    expect(chooseCore({ os: 'web', search: '' })).toBe('remote');
    expect(chooseCore({ os: 'web', search: '?other=1' })).toBe('remote');
  });
  it('?mock=1 and ?mock=empty pick the mock on the web', () => {
    expect(chooseCore({ os: 'web', search: '?mock=1' })).toBe('mock');
    expect(chooseCore({ os: 'web', search: '?mock=empty' })).toBe('mock-empty');
  });
  it('phones use the local core, unless built with the mock flag', () => {
    expect(chooseCore({ os: 'android', search: '' })).toBe('local');
    expect(chooseCore({ os: 'ios', search: '?mock=1' })).toBe('local');
    expect(chooseCore({ os: 'ios', search: '', flag: 'mock' })).toBe('mock');
  });
});

describe('session token', () => {
  it('reads token from the fragment (and nothing else)', () => {
    expect(readToken('#t=old-style')).toBeNull();
    expect(readToken('#token=abc.DEF-123_~')).toBe('abc.DEF-123_~');
    expect(readToken('#x=1&token=tok')).toBe('tok');
    expect(readToken('')).toBeNull();
    expect(readToken('#token=')).toBeNull();
    expect(readToken('#token=has space')).toBeNull();
    expect(readToken(`#token=${'a'.repeat(600)}`)).toBeNull();
  });

  it('scrubs the fragment from the address bar', () => {
    const urls: string[] = [];
    const tok = takeSessionToken({ hash: '#token=secret', pathname: '/', search: '?x=1' }, (u) => urls.push(u));
    expect(tok).toBe('secret');
    expect(urls).toEqual(['/?x=1']);
    expect(urls.join()).not.toContain('secret');
  });

  it('leaves a clean address alone', () => {
    const urls: string[] = [];
    expect(takeSessionToken({ hash: '', pathname: '/', search: '' }, (u) => urls.push(u))).toBeNull();
    expect(urls).toEqual([]);
  });
});
