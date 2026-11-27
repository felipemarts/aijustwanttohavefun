import { ACTION_NAMES, actionParamSchemas } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { estimateTokens, makeServer } from './test-helpers';

/**
 * Token budgets of PLANEJAMENTO §13.3: a typical `/look` under 600 tokens and a typical `/act` under 300.
 * Tokens are estimated as characters / 3.5 (see `estimateTokens`).
 */
describe('response size', () => {
  it('a /look in the busy village square stays under 600 tokens', async () => {
    const s = await makeServer();
    const { key } = await s.register('Observer');
    const names = ['Brasa', 'Pipkin', 'Morwenna', 'Tobias', 'Isolde', 'Gundar', 'Lirael', 'Fennick'];
    const keys: string[] = [];
    for (const n of names) keys.push((await s.register(n, { class: n.length % 2 ? 'mage' : 'rogue' })).key);
    // A first look takes the arrival announcements out of the inbox: the typical look sees chat, not history.
    await s.get(key, '/api/v1/look');
    const lines = ['Anyone heading to the mines? I pay well for an escort.', 'Selling two iron ore, ten gold each.', 'Looking for a cleric for the forest.'];
    for (let i = 0; i < 3; i++) expect((await s.act(keys[i]!, 'say', { text: lines[i]! })).json().ok).toBe(true);

    const res = await s.get(key, '/api/v1/look');
    const body = res.json();
    expect(body.room.agents).toHaveLength(8);
    expect(body.messages).toHaveLength(3);
    const tokens = estimateTokens(res.body);
    console.info(`/look village square: ${res.body.length} chars, ~${tokens} tokens`);
    expect(tokens).toBeLessThanOrEqual(600);
  });

  it('an INVALID_PARAMS refusal, with the params of its action, stays under 300 tokens for every action', async () => {
    const s = await makeServer();
    let worst = { tokens: 0, action: '' };
    for (const lang of ['en', 'pt-BR']) {
      const { key } = await s.register(`Sloppy${lang.replace('-', '')}`, { language: lang });
      for (const action of ACTION_NAMES) {
        // Every field of the wrong type (an object where a string, number or bundle belongs).
        const params = Object.fromEntries(Object.keys(actionParamSchemas[action].shape).map((f) => [f, { wrong: true }]));
        if (!Object.keys(params).length) continue;
        s.clock.advance(1000); // within the 60 requests per minute of a key
        const res = await s.act(key, action, params);
        expect(res.json().error.code).toBe('INVALID_PARAMS');
        const tokens = estimateTokens(res.body);
        if (tokens > worst.tokens) worst = { tokens, action: `${action} (${lang})` };
      }
    }
    console.info(`/act INVALID_PARAMS, longest: ${worst.action}, ~${worst.tokens} tokens`);
    expect(worst.tokens).toBeLessThanOrEqual(300);
  });

  it('an /act combat round in the forest stays under 300 tokens', async () => {
    const s = await makeServer();
    const { key } = await s.register('Fighter');
    for (const dir of s.path('village.square', 'forest.edge')) expect((await s.act(key, 'move', { dir })).json().ok).toBe(true);
    const first = await s.act(key, 'attack', { target: 'slime' });
    expect(first.json().ok).toBe(true);
    const res = await s.act(key, 'attack', { target: 'slime' });
    expect(res.json().ok).toBe(true);
    const tokens = estimateTokens(res.body);
    console.info(`/act attack: ${res.body.length} chars, ~${tokens} tokens`);
    expect(tokens).toBeLessThanOrEqual(300);
  });
});
