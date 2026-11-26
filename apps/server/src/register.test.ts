import { LAYERS, optionIds, type Layer } from '@ajwf/appearance';
import { API_KEY_PREFIX } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { ADMIN, makeServer, type TestServer } from './test-helpers';

const IP = '198.51.100.20';

async function options(s: TestServer) {
  const res = await s.app.inject({ method: 'GET', url: '/api/v1/appearance/options', remoteAddress: IP });
  expect(res.statusCode).toBe(200);
  return res.json() as { options_token: string; options: Record<Layer, Record<string, string>>; fields: Record<Layer, string> };
}

function firstChoice(opts: { options: Record<Layer, Record<string, string>> }): Record<Layer, string> {
  return Object.fromEntries(LAYERS.map((l) => [l, Object.keys(opts.options[l])[0]!])) as Record<Layer, string>;
}

function register(s: TestServer, payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return s.app.inject({ method: 'POST', url: '/api/v1/agents/register', remoteAddress: IP, headers, payload: { class: 'mage', ...payload } });
}

describe('GET /appearance/options', () => {
  it('draws 5 options per layer with names, a description of each field and a token', async () => {
    const s = await makeServer();
    const opts = await options(s);
    expect(opts.options_token).toMatch(/^opt_/);
    for (const layer of LAYERS) {
      expect(Object.keys(opts.options[layer]).length).toBe(Math.min(5, optionIds(layer, true).length));
      expect(opts.fields[layer]).toMatch(/\w/);
    }
    expect(opts.options.skin).toBeTypeOf('object');
  });
});

describe('POST /agents/register', () => {
  it('registers with a chosen appearance and answers exactly as §11.2, key shown once', async () => {
    const s = await makeServer();
    const opts = await options(s);
    const choice = firstChoice(opts);
    const res = await register(s, { name: 'Pip', language: 'en', bio: 'Collects odd stones.', options_token: opts.options_token, appearance: choice });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.agent).toMatchObject({ name: 'Pip', class: 'mage', level: 1, appearance: choice });
    expect(body.agent.appearance_text).toMatch(/\w+/);
    expect(body.api_key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(body.api_key.length).toBe(API_KEY_PREFIX.length + 43);
    expect(body.claim_url).toMatch(/^http:\/\/test\.local\/claim\/[A-Za-z0-9_-]{43}$/);
    expect(body.next_steps).toMatch(/api_key/);
    expect(body.appearance_changed).toBeUndefined();
  });

  it('surprise_me draws a look, from the token when one is given', async () => {
    const s = await makeServer();
    const plain = await register(s, { name: 'Surprise', appearance: 'surprise_me' });
    expect(plain.json().ok).toBe(true);
    const opts = await options(s);
    const drawn = (await register(s, { name: 'Drawn', options_token: opts.options_token })).json();
    expect(drawn.ok).toBe(true);
    for (const layer of LAYERS) expect(Object.keys(opts.options[layer])).toContain(drawn.agent.appearance[layer]);
  });

  it('rejects a choice that was not in the token draw', async () => {
    const s = await makeServer();
    const opts = await options(s);
    const choice = firstChoice(opts);
    choice.hat = optionIds('hat', true).find((id) => !(id in opts.options.hat))!;
    const res = await register(s, { name: 'Cheater', options_token: opts.options_token, appearance: choice });
    expect(res.statusCode).toBe(200);
    expect(res.json().error).toMatchObject({ code: 'INVALID_PARAMS' });
    expect(res.json().error.message).toContain('hat');
    expect(s.game.agentByName('Cheater')).toBeUndefined();
  });

  it('rejects a choice without a token, with an unknown token and with an expired one', async () => {
    const s = await makeServer();
    const opts = await options(s);
    const choice = firstChoice(opts);
    expect((await register(s, { name: 'NoToken', appearance: choice })).json().error.code).toBe('INVALID_PARAMS');
    expect((await register(s, { name: 'Unknown', options_token: 'opt_nope', appearance: choice })).json().error.code).toBe('OPTIONS_EXPIRED');
    s.clock.advance(31 * 60_000);
    const expired = (await register(s, { name: 'Late', options_token: opts.options_token, appearance: choice })).json();
    expect(expired.error).toMatchObject({ code: 'OPTIONS_EXPIRED' });
    expect(expired.error.hint).toMatch(/appearance\/options/);
  });

  it('enforces name rules and blocks duplicates and lookalikes', async () => {
    const s = await makeServer();
    // The admin token lifts the per-IP registration limit for this many attempts.
    const admin = { 'x-admin-token': ADMIN };
    expect((await register(s, { name: 'Pip' }, admin)).json().ok).toBe(true);
    const cyrillic = String.fromCharCode(0x420, 0x456, 0x440);
    const cases: [string, string][] = [
      ['ab', 'NAME_INVALID'],
      ['bad name!', 'NAME_INVALID'],
      ['admin', 'NAME_INVALID'],
      ['Pip', 'NAME_TAKEN'],
      ['pip', 'NAME_TAKEN'],
      ['P1p', 'NAME_TAKEN'],
      [cyrillic, 'NAME_TAKEN'],
    ];
    for (const [name, code] of cases) {
      const res = await register(s, { name }, admin);
      expect(res.statusCode).toBe(200);
      const err = res.json().error;
      expect(err.code, name).toBe(code);
      expect(err.message).not.toMatch(/^err\./);
      expect(err.hint).toMatch(/3 to 20 characters/);
    }
  });

  it('keeps every look unique and reports the layers it had to change', async () => {
    const s = await makeServer();
    const opts = await options(s);
    const choice = firstChoice(opts);
    const first = (await register(s, { name: 'Twin', options_token: opts.options_token, appearance: choice })).json();
    const second = (await register(s, { name: 'Other', options_token: opts.options_token, appearance: choice })).json();
    expect(first.agent.appearance).toEqual(choice);
    expect(second.appearance_changed.length).toBeGreaterThan(0);
    for (const layer of LAYERS) {
      const changed = second.agent.appearance[layer] !== choice[layer];
      expect(changed).toBe(second.appearance_changed.includes(layer));
    }
    const [a, b] = [s.game.agentByName('Twin')!, s.game.agentByName('Other')!];
    expect(a.lookHash).not.toBe(b.lookHash);
  });

  it('ignores bot and claimed without the admin token, and honours them with it', async () => {
    const s = await makeServer();
    await register(s, { name: 'Sneaky', bot: true, claimed: true });
    expect(s.game.agentByName('Sneaky')).toMatchObject({ bot: false, claimed: false });
    await register(s, { name: 'WrongAdmin', bot: true, claimed: true }, { 'x-admin-token': 'guess' });
    expect(s.game.agentByName('WrongAdmin')).toMatchObject({ bot: false, claimed: false });
    await register(s, { name: 'TestBot', bot: true, claimed: true }, { 'x-admin-token': ADMIN });
    expect(s.game.agentByName('TestBot')).toMatchObject({ bot: true, claimed: true });
    const profile = (await s.app.inject({ method: 'GET', url: '/api/v1/agents/TestBot' })).json();
    expect(profile.agent.bot).toBe(true);
  });

  it('never hands out a key for an agent that could not be stored', async () => {
    const s = await makeServer();
    s.store.failNext = new Error('database down');
    const res = await register(s, { name: 'Unlucky' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(res.body).not.toContain(API_KEY_PREFIX);
    expect(s.game.agentByName('Unlucky')).toBeUndefined();
    expect(s.store.agents.size).toBe(0);
    // The name was released: the retry succeeds.
    expect((await register(s, { name: 'Unlucky' })).json().ok).toBe(true);
  });

  it('answers invalid bodies with INVALID_PARAMS and HTTP 200', async () => {
    const s = await makeServer();
    const res = await register(s, { name: 'Pip', class: 'bard' });
    expect(res.statusCode).toBe(200);
    expect(res.json().error).toMatchObject({ code: 'INVALID_PARAMS' });
    expect(res.json().error.message).toContain('class');
  });
});
