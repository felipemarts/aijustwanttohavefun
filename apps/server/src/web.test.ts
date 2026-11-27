import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameEvent } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { PNG_SIGNATURE } from './og/raster';
import { makeServer, ORIGIN, type TestServer } from './test-helpers';

function pngSize(buf: Buffer): { w: number; h: number } {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function publish(s: TestServer, e: Omit<GameEvent, 'id' | 'ts'>) {
  s.game.publish([{ id: String(++s.game.state.meta.eventSeq), ts: s.clock.now(), ...e }]);
}

const get = (s: TestServer, url: string, headers: Record<string, string> = {}) => s.app.inject({ method: 'GET', url, headers });

describe('share cards (/og)', () => {
  it('agent card: 1200x630 PNG, ETag, long cache with ?v=, 304, 404 for unknown', async () => {
    const s = await makeServer();
    await s.register('Pip');
    const res = await get(s, '/og/agent/Pip.png?lang=en');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(pngSize(res.rawPayload)).toEqual({ w: 1200, h: 630 });
    const etag = res.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{24}"$/);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    const versioned = await get(s, `/og/agent/Pip.png?lang=en&v=${etag.slice(1, -1)}`);
    expect(versioned.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get(s, '/og/agent/Pip.png?lang=en', { 'if-none-match': etag })).statusCode).toBe(304);
    for (const url of ['/og/agent/Nobody.png', '/og/agent/Pip.gif', '/og/highlight/h999.png', '/og/highlight/x.png', '/og/gazette/1999-01-01.png', '/og/gazette/today.png']) {
      expect((await get(s, url)).statusCode, url).toBe(404);
    }
  });

  it('renders Chinese and Japanese names and texts without throwing', async () => {
    const s = await makeServer();
    await s.register('小龙王', { bio: '日本語のテキスト' });
    await s.register('さくら');
    for (const [name, lang] of [['小龙王', 'zh-CN'], ['さくら', 'ja'], ['小龙王', 'fr'], ['さくら', 'pt-BR'], ['小龙王', 'es']] as const) {
      const res = await get(s, `/og/agent/${encodeURIComponent(name)}.png?lang=${lang}`);
      expect(res.statusCode, `${name} ${lang}`).toBe(200);
      expect(pngSize(res.rawPayload)).toEqual({ w: 1200, h: 630 });
    }
  });

  it('highlight and gazette cards, cached by content', async () => {
    const s = await makeServer();
    await s.register('Pip');
    await s.register('Brasa');
    const pip = s.game.agentByName('Pip')!;
    const brasa = s.game.agentByName('Brasa')!;
    publish(s, { type: 'betrayal', actor: brasa.id, target: pip.id, visibility: 'public', drama: 15, payload: { traitor: 'Brasa', victim: 'Pip' } });
    const h = (await s.chronicle.highlights(null, 1))[0]!;
    const card = await get(s, `/og/highlight/${h.id}.png?lang=zh-CN`);
    expect(card.statusCode).toBe(200);
    expect(pngSize(card.rawPayload)).toEqual({ w: 1200, h: 630 });
    expect(card.headers['cache-control']).toBe('public, max-age=86400');
    const today = new Date(s.clock.now()).toISOString().slice(0, 10);
    const gz = await get(s, `/og/gazette/${today}.png?lang=ja`);
    expect(gz.statusCode).toBe(200);
    expect(gz.headers['cache-control']).toBe('public, max-age=600');
    // Same content, same bytes: served from the cache.
    expect((await get(s, `/og/gazette/${today}.png?lang=ja`)).rawPayload.equals(gz.rawPayload)).toBe(true);
  });
});

describe('HTML shells for crawlers', () => {
  const tag = (html: string, attr: string, key: string) => new RegExp(`<meta ${attr}="${key.replace(/[:]/g, '\\$&')}" content="([^"]*)"`).exec(html)?.[1];

  it('agent page: title, description, Open Graph and Twitter tags, lang, all escaped', async () => {
    const s = await makeServer();
    await s.register('Pip', { bio: '"><script>alert(1)</script><img src=x onerror=alert(2)> & more' });
    const res = await get(s, '/a/Pip?lang=en-GB');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const html = res.body;
    expect(html).toMatch(/<html lang="en">/);
    expect((await get(s, '/a/Pip', { 'accept-language': 'pt-BR,pt;q=0.9' })).body).toMatch(/<html lang="pt-BR">/);
    expect(html).toMatch(/<title>Pip, level 1 Warrior<\/title>/);
    expect(tag(html, 'property', 'og:title')).toBe('Pip, level 1 Warrior');
    expect(tag(html, 'property', 'og:url')).toBe(`${ORIGIN}/a/Pip`);
    expect(tag(html, 'property', 'og:image')).toMatch(new RegExp(`^${ORIGIN}/og/agent/Pip\\.png\\?lang=en&amp;v=[0-9a-f]{24}$`));
    expect(tag(html, 'name', 'twitter:card')).toBe('summary_large_image');
    expect(tag(html, 'property', 'og:description')).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toMatch(/content="[^"]*"[^>]*onerror/);
    // The image the tags point to exists.
    const img = tag(html, 'property', 'og:image')!.replace(/&amp;/g, '&').replace(ORIGIN, '');
    expect((await get(s, img)).headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('highlight, gazette, guild, home and claim pages; unknown ones are 404 pages', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    const { key: k2 } = await s.register('Brasa');
    expect(k2).toBeTruthy();
    publish(s, { type: 'betrayal', actor: s.game.agentByName('Brasa')!.id, target: s.game.agentByName('Pip')!.id, visibility: 'public', payload: {} });
    const h = (await s.chronicle.highlights(null, 1))[0]!;
    const hl = (await get(s, `/h/${h.id}`)).body;
    expect(hl).toMatch(/<title>[^<]*Brasa[^<]*<\/title>/);
    expect(tag(hl, 'property', 'og:image')).toContain(`/og/highlight/${h.id}.png`);
    const today = new Date(s.clock.now()).toISOString().slice(0, 10);
    const gz = (await get(s, `/gazette/${today}`, { 'accept-language': 'ja,en;q=0.5' })).body;
    expect(gz).toMatch(/<html lang="ja">/);
    expect(tag(gz, 'property', 'og:image')).toContain(`/og/gazette/${today}.png?lang=ja`);
    expect((await get(s, '/')).body).toMatch(/<title>AI Just Want to Have Fun<\/title>/);

    const hall = [...s.game.content.rooms.values()].find((r) => r.flags.includes('guild_hall'))!.id;
    for (const dir of s.path('village.square', hall)) await s.act(key, 'move', { dir });
    s.game.agentByName('Pip')!.gold = 10_000;
    expect((await s.act(key, 'guild_create', { name: 'Night Owls', motto: '<b>bold</b> & proud' })).json().ok).toBe(true);
    const guild = (await get(s, '/g/Night%20Owls')).body;
    expect(guild).toMatch(/<title>Night Owls, a guild of AI agents<\/title>/);
    expect(guild).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; proud');
    expect(guild).not.toContain('<b>bold</b>');

    const token = 'T'.repeat(43);
    const claim = await get(s, `/claim/${token}`);
    expect(claim.statusCode).toBe(200);
    expect(claim.headers['referrer-policy']).toBe('no-referrer');
    expect(tag(claim.body, 'name', 'robots')).toBe('noindex, nofollow');
    expect(claim.body).not.toContain(token);

    for (const url of ['/a/Nobody', `/h/h99999`, '/gazette/1999-01-01', '/g/Nope']) {
      const res = await get(s, url);
      expect(res.statusCode, url).toBe(404);
      expect(res.body).toMatch(/<title>AI Just Want to Have Fun<\/title>/);
    }
  });

  it('serves the built web app: index.html with injected tags, hashed assets immutable, SPA fallback', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'ajwf-web-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(
      join(dist, 'index.html'),
      '<!doctype html>\n<html lang="en" dir="ltr">\n  <head>\n    <meta charset="UTF-8" />\n    <title>AI Just Want to Have Fun</title>\n    <meta name="description" content="Old" />\n    <script type="module" crossorigin src="/assets/index-abc123.js"></script>\n  </head>\n  <body><div id="root"></div></body>\n</html>\n',
    );
    writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
    writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const s = await makeServer({ config: { webDist: dist } });
    await s.register('Pip');

    const page = await get(s, '/a/Pip', { accept: 'text/html' });
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(page.body).toContain('<script type="module" crossorigin src="/assets/index-abc123.js"></script>');
    expect(page.body).toMatch(/<html lang="en" dir="ltr">/);
    expect(page.body.match(/<title>/g)).toHaveLength(1);
    expect(page.body).not.toContain('content="Old"');
    expect(page.body).toContain('og:image');

    const js = await get(s, '/assets/index-abc123.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get(s, '/favicon.svg')).headers['cache-control']).toBe('public, max-age=3600');

    const spa = await get(s, '/village', { accept: 'text/html,application/xhtml+xml' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('/assets/index-abc123.js');
    const api = await get(s, '/api/nowhere', { accept: 'text/html' });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('NOT_FOUND');
    expect((await get(s, '/index.html')).statusCode).toBe(404);
  });

  it('sets a strict Content-Security-Policy and the other security headers', async () => {
    const s = await makeServer();
    const res = await get(s, '/');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("connect-src 'self' ws://test.local wss://test.local");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['permissions-policy']).toMatch(/camera=\(\)/);
    expect(res.headers['strict-transport-security']).toBeUndefined();
    const prod = await makeServer({ devLogin: false, config: { production: true, publicUrl: 'https://game.example' } });
    const p = await get(prod, '/');
    expect(p.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(p.headers['content-security-policy']).toContain("connect-src 'self' wss://game.example;");
  });
});
