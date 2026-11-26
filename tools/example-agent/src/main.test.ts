import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '@ajwf/sdk';
import { makeServer } from '@ajwf/server/src/test-helpers';
import { describe, expect, it } from 'vitest';
import { main, parseChoice } from './main';

/** A `fetch` served by the in-process app (no sockets, no network). Each call takes a second of game time. */
async function inProcessFetch() {
  const s = await makeServer();
  const fetch: FetchLike = async (url, init) => {
    s.clock.advance(1_000);
    const res = await s.app.inject({
      method: (init.method ?? 'GET') as 'GET' | 'POST',
      url: new URL(url).pathname + new URL(url).search,
      headers: init.headers as Record<string, string>,
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
    });
    return new Response(res.body, { status: res.statusCode, headers: res.headers as Record<string, string> });
  };
  return { s, fetch };
}

describe('example agent', () => {
  it('explains how to set the API key and exits cleanly without one', async () => {
    const out: string[] = [];
    await main(['node', 'main.ts'], {}, (l: string) => out.push(l));
    expect(out.join('\n')).toMatch(/ANTHROPIC_API_KEY/);
    expect(out.join('\n')).toMatch(/--dry-run/);
  });

  it('plays 40 scripted steps in --dry-run and saves its key privately', async () => {
    const { s, fetch } = await inProcessFetch();
    const keyFile = join(mkdtempSync(join(tmpdir(), 'ajwf-agent-')), 'key.json');
    const env = { AJWF_URL: 'http://game.test', AJWF_KEY_FILE: keyFile, AGENT_NAME: 'Dryrunner' };
    const out: string[] = [];
    await main(['node', 'main.ts', '--dry-run'], env, (l: string) => out.push(l), fetch);
    expect(out.at(-1)).toBe('Done: 40 actions.');
    expect(out.filter((l) => / move /.test(l)).length).toBeGreaterThan(10);
    const saved = JSON.parse(readFileSync(keyFile, 'utf8')) as { name: string; api_key: string };
    expect(saved.name).toBe('Dryrunner');
    expect(statSync(keyFile).mode & 0o077).toBe(0);
    // The key is never printed.
    expect(out.join('\n')).not.toContain(saved.api_key);
    const agent = s.game.agentByName('Dryrunner')!;
    expect(agent.ap).toBeLessThan(240);

    // A second run reuses the saved key instead of registering again.
    const again: string[] = [];
    await main(['node', 'main.ts', '--dry-run'], env, (l: string) => again.push(l), fetch);
    expect(again[0]).toMatch(/Playing as Dryrunner/);
    expect(s.game.state.agents.size).toBe(1);
  });

  it('reads one action from a model reply', () => {
    expect(parseChoice('Sure! {"action":"move","params":{"dir":"north"}} Good luck.')).toEqual({ action: 'move', params: { dir: 'north' } });
    expect(parseChoice('{"action":"rest"}')).toEqual({ action: 'rest', params: {} });
    expect(parseChoice('I would rather not.')).toBeNull();
    expect(parseChoice('{"params":{}}')).toBeNull();
    expect(parseChoice('{"action": "move", "params": [1]')).toBeNull();
  });
});
