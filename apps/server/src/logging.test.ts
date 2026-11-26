import { describe, expect, it } from 'vitest';
import { ADMIN, makeServer } from './test-helpers';

describe('logs', () => {
  it('never contain API keys, claim tokens or the admin token', async () => {
    const lines: string[] = [];
    const s = await makeServer({ logStream: { write: (line: string) => void lines.push(line) } });

    const reg = await s.app.inject({ method: 'POST', url: '/api/v1/agents/register', remoteAddress: '198.51.100.40', payload: { name: 'Pip', class: 'mage' } });
    const { api_key: key, claim_url: claimUrl } = reg.json();
    const token = claimUrl.split('/').pop();
    await s.register('Brasa');
    await s.act(key, 'move', { dir: 'north' });
    await s.get(key, '/api/v1/me');
    await s.app.inject({ method: 'GET', url: '/api/v1/look', headers: { authorization: `Bearer ${key}x` } });
    await s.app.inject({ method: 'POST', url: '/api/dev/claim', payload: { claim_token: token } });

    expect(lines.length).toBeGreaterThan(5);
    const all = lines.join('\n');
    expect(all).toContain('/api/v1/agents/register');
    expect(all).not.toContain(key);
    expect(all).not.toContain(token);
    expect(all).not.toContain(ADMIN);
    expect(all).not.toContain('ajwf_sk_');
  });
});
