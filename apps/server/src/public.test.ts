import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apCost, HANDLERS } from '@ajwf/engine';
import { API_VERSION, ERROR_CODES, SKILL_VERSION, type ActionName } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { makeServer } from './test-helpers';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('GET /help', () => {
  it('lists every implemented action with its AP cost and a JSON Schema of its params, and the error codes', async () => {
    const s = await makeServer();
    const help = (await s.app.inject({ method: 'GET', url: '/api/v1/help' })).json();
    expect(help).toMatchObject({ ok: true, api_version: API_VERSION, skill_version: SKILL_VERSION });
    const byName = new Map((help.actions as { name: string; ap: number; params: { type: string } }[]).map((a) => [a.name, a]));
    for (const name of Object.keys(HANDLERS) as ActionName[]) {
      expect(byName.get(name), name).toMatchObject({ ap: apCost(name), params: { type: 'object' } });
    }
    expect(byName.size).toBe(Object.keys(HANDLERS).length);
    expect(byName.get('move')!.params).toMatchObject({ properties: { dir: { type: 'string' } }, required: ['dir'] });
    for (const code of ERROR_CODES) expect(help.errors).toContain(code);
  });
});

describe('GET /sprites/:hash.png', () => {
  it('composes the sprite of a worn look, cached forever; unknown looks are 404', async () => {
    const s = await makeServer();
    await s.register('Pip');
    const hash = s.game.agentByName('Pip')!.lookHash;
    for (let i = 0; i < 2; i++) {
      const res = await s.app.inject({ method: 'GET', url: `/sprites/${hash}.png` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.rawPayload.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    }
    for (const url of ['/sprites/0123456789abcd.png', '/sprites/nothex.png', `/sprites/${hash}.gif`]) {
      expect((await s.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
  });
});

describe('agent docs', () => {
  it('serves skill.md with the base URL filled in, falling back to English for missing translations', async () => {
    const docsDir = mkdtempSync(join(tmpdir(), 'ajwf-docs-'));
    writeFileSync(join(docsDir, 'skill.md'), '# Skill\nRegister at {{BASE_URL}}/api/v1/agents/register\n');
    writeFileSync(join(docsDir, 'skill.pt-BR.md'), '# Habilidade {{BASE_URL}}\n');
    const s = await makeServer({ docsDir });
    const en = await s.app.inject({ method: 'GET', url: '/skill.md' });
    expect(en.statusCode).toBe(200);
    expect(en.headers['content-type']).toMatch(/^text\/markdown/);
    expect(en.body).toContain('http://test.local/api/v1/agents/register');
    expect((await s.app.inject({ method: 'GET', url: '/skill.pt-BR.md' })).body).toBe('# Habilidade http://test.local\n');
    expect((await s.app.inject({ method: 'GET', url: '/skill.pt.md' })).body).toBe('# Habilidade http://test.local\n');
    expect((await s.app.inject({ method: 'GET', url: '/skill.ja.md' })).body).toContain('# Skill');
    expect((await s.app.inject({ method: 'GET', url: '/skill.../../etc.md' })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: '/heartbeat.md' })).statusCode).toBe(404);
  });
});

describe('public views', () => {
  it('shows a public profile with the bio as untrusted_text and nothing private', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip', { bio: 'Visit https://spam.example.com now', bot: true });
    s.game.agentByName('Pip')!.ownerNote = 'secret plan';
    const res = await s.app.inject({ method: 'GET', url: '/api/v1/agents/pip' });
    const p = res.json().agent;
    expect(p).toMatchObject({ name: 'Pip', class: 'warrior', lvl: 1, claimed: true, bot: true, bio: { untrusted_text: 'Visit [link] now' } });
    expect(p.look).toMatch(/\w/);
    expect(res.body).not.toMatch(/secret plan|gold|inventory|ajwf_sk_/);
    expect(res.body).not.toContain(key);
    const missing = await s.app.inject({ method: 'GET', url: '/api/v1/agents/Nobody' });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().error.code).toBe('NOT_FOUND');
  });

  it('reports the village population and who is online', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    await s.register('Brasa');
    await s.get(key, '/api/v1/look');
    const v = (await s.app.inject({ method: 'GET', url: '/api/v1/village' })).json();
    expect(v).toMatchObject({ ok: true, population: 2, online: 1, time: expect.any(String) });
  });

  it('answers /healthz', async () => {
    const s = await makeServer();
    expect((await s.app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({ ok: true, store: 'memory' });
  });
});

describe('config', () => {
  it('turns DEV_LOGIN off in production, and production needs a session secret and an https PUBLIC_URL', () => {
    const prod = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), PUBLIC_URL: 'https://example.org' };
    expect(loadConfig({ ...prod, DEV_LOGIN: '1' }).devLogin).toBe(false);
    expect(loadConfig({ DEV_LOGIN: '1' }).devLogin).toBe(true);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...prod, PUBLIC_URL: 'http://example.org' })).toThrow(/https/);
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ ADMIN_TOKEN: '' }).adminToken).toBeUndefined();
  });

  it('offers only OAuth providers with both id and secret, and push only with both VAPID keys', () => {
    const c = loadConfig({ OAUTH_GITHUB_ID: 'id', OAUTH_GITHUB_SECRET: 'secret', OAUTH_GOOGLE_ID: 'only-id' });
    expect(Object.keys(c.oauth)).toEqual(['github']);
    expect(c.vapid).toBeNull();
    expect(loadConfig({ VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b' }).vapid).toMatchObject({ publicKey: 'a', subject: 'mailto:owner@localhost' });
    expect(loadConfig({ DEV_WEB_ORIGIN: 'http://localhost:5710' }).extraOrigins).toEqual(['http://localhost:5710']);
    const prod = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), PUBLIC_URL: 'https://example.org' };
    expect(loadConfig({ ...prod, DEV_WEB_ORIGIN: 'http://localhost:5710' }).extraOrigins).toEqual([]);
  });
});
