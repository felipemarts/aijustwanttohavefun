import { afterEach, describe, expect, it } from 'vitest';
import { HANDLERS } from '@ajwf/engine';
import { ADMIN, makeServer } from './test-helpers';

const original = HANDLERS.emote;

describe('internal errors in actions', () => {
  afterEach(() => {
    HANDLERS.emote = original;
  });

  it('answer INTERNAL, change nothing, are logged without agent text and are counted', async () => {
    const lines: string[] = [];
    const s = await makeServer({ logStream: { write: (line: string) => void lines.push(line) } });
    const { key } = await s.register('Pip');
    const a = s.game.agentByName('Pip')!;
    const before = JSON.stringify(a);
    // A bug in a handler: it throws, carrying text the agent wrote in its message.
    HANDLERS.emote = (_run, _a, p) => {
      throw new TypeError(`cannot read ${String(p.target)}`);
    };
    const res = await s.act(key, 'emote', { emote: 'wave', target: 'SECRET-AGENT-TEXT' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(a)).toBe(before);
    // The server keeps going.
    HANDLERS.emote = original;
    expect((await s.act(key, 'emote', { emote: 'wave' })).json().ok).toBe(true);

    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'internal error in an action; refused with INTERNAL');
    expect(logged).toMatchObject({ agent: a.id, action: 'emote', error: 'TypeError' });
    expect((logged!.stack as string[]).length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('SECRET-AGENT-TEXT');

    const text = (await s.app.inject({ method: 'GET', url: '/metrics', headers: { 'x-admin-token': ADMIN } })).body;
    expect(text).toMatch(/^ajwf_action_internal_errors_total\{action="emote"\} 1$/m);
    expect(text).toMatch(/^ajwf_errors_total\{code="INTERNAL"\} 1$/m);
  });
});
