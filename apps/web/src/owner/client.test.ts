import { describe, expect, it, vi } from 'vitest';
import { type FetchFn, OwnerClient } from './client';

type Call = { url: string; init: RequestInit };

function recorder(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = vi.fn<FetchFn>(async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return answer(call);
  });
  return { calls, fetchFn, client: new OwnerClient(fetchFn) };
}

const ok = (body: Record<string, unknown> = {}) => Response.json({ ok: true, ...body });
const apiError = (status: number, code: string, message = 'msg', extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  Response.json({ ok: false, error: { code, message, ...extra } }, { status, headers });
const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe('owner client: request shape', () => {
  it('GETs carry the same-origin cookie, ask for JSON and send no body', async () => {
    const r = recorder(() => ok({ owner: null }));
    await r.client.session();
    await r.client.me();
    await r.client.summary('a1b', 1234.9);
    await r.client.share('a1b');
    expect(r.calls.map((c) => c.url)).toEqual(['/api/owner/session', '/api/owner/me', '/api/owner/agents/a1b/summary?since=1234', '/api/owner/agents/a1b/share']);
    for (const { init } of r.calls) {
      expect(init.method).toBe('GET');
      expect(init.credentials).toBe('same-origin');
      expect(init.body).toBeUndefined();
      expect(headersOf(init)).toEqual({ accept: 'application/json' });
      expect(init.cache).toBe('no-store');
      // Not `no-referrer`: that turns `Origin` into "null" on writes, which the CSRF check refuses.
      expect(init.referrerPolicy).toBe('strict-origin');
    }
  });

  it('every write sends JSON with a JSON body, even when there is nothing to say', async () => {
    const r = recorder(() => ok());
    const token = 'T'.repeat(43);
    await r.client.claim(token);
    await r.client.setNote('a1b', 'be kind');
    await r.client.markSeen('a1b', 99.5);
    await r.client.regenerateKey('a1b');
    await r.client.retire('a1b');
    await r.client.setLanguage('pt-BR');
    await r.client.logout();
    await r.client.deleteAccount();
    await r.client.pushUnsubscribe('https://push.example/abc');
    const seen = r.calls.map((c) => [c.init.method, c.url, c.init.body]);
    expect(seen).toEqual([
      ['POST', `/api/owner/claim/${token}`, '{}'],
      ['PUT', '/api/owner/agents/a1b/note', '{"note":"be kind"}'],
      ['POST', '/api/owner/agents/a1b/seen', '{"until":99}'],
      ['POST', '/api/owner/agents/a1b/regenerate-key', '{}'],
      ['POST', '/api/owner/agents/a1b/retire', '{}'],
      ['PUT', '/api/owner/language', '{"language":"pt-BR"}'],
      ['POST', '/api/owner/logout', '{}'],
      ['DELETE', '/api/owner/me', '{}'],
      ['DELETE', '/api/owner/push/subscribe', '{"endpoint":"https://push.example/abc"}'],
    ]);
    for (const { init } of r.calls) {
      expect(init.credentials).toBe('same-origin');
      expect(headersOf(init)['content-type']).toBe('application/json');
    }
  });

  it('encodes path segments and builds login links with a relative next', async () => {
    const r = recorder(() => ok());
    await r.client.summary('../../admin');
    expect(r.calls[0]!.url).toBe('/api/owner/agents/..%2F..%2Fadmin/summary');
    expect(OwnerClient.loginUrl('github', `/claim/${'A'.repeat(43)}`)).toBe(`/api/owner/login/github?next=%2Fclaim%2F${'A'.repeat(43)}`);
  });
});

describe('owner client: answers', () => {
  it('passes the data of an ok answer through', async () => {
    const r = recorder(() => ok({ note: 'hi' }));
    expect(await r.client.setNote('a1b', 'hi')).toEqual({ ok: true, data: { ok: true, note: 'hi' } });
  });

  it('maps the server error body to a typed error, hint included', async () => {
    const r = recorder(() => apiError(409, 'AGENT_LIMIT', 'You already have 3 agents.', { hint: 'Retire one.' }));
    expect(await r.client.claim('x'.repeat(43))).toEqual({
      ok: false,
      error: { code: 'AGENT_LIMIT', message: 'You already have 3 agents.', hint: 'Retire one.', status: 409, retryAfter: null },
    });
  });

  it('reads Retry-After on 429, even when the body is not JSON', async () => {
    const r = recorder(() => apiError(429, 'RATE_LIMITED', 'Slow down.', {}, { 'retry-after': '1800' }));
    expect(await r.client.claimPreview('x'.repeat(43), 'en')).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', retryAfter: 1800, status: 429 } });
    const html = recorder(() => new Response('<html>Too Many</html>', { status: 429, headers: { 'retry-after': '60' } }));
    expect(await html.client.me()).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', retryAfter: 60 } });
  });

  it('a proxy page, a truncated body or a junk code are BAD_RESPONSE; no answer at all is NETWORK', async () => {
    expect(await recorder(() => new Response('<html>502</html>', { status: 502 })).client.me()).toMatchObject({ ok: false, error: { code: 'BAD_RESPONSE', status: 502 } });
    expect(await recorder(() => new Response('{"ok":tr', { status: 200 })).client.me()).toMatchObject({ ok: false, error: { code: 'BAD_RESPONSE' } });
    expect(await recorder(() => Response.json([1, 2])).client.me()).toMatchObject({ ok: false, error: { code: 'BAD_RESPONSE' } });
    expect(await recorder(() => apiError(400, '<script>')).client.me()).toMatchObject({ ok: false, error: { code: 'BAD_RESPONSE', message: 'msg' } });
    // `ok: true` on an error status is not trusted.
    expect(await recorder(() => Response.json({ ok: true }, { status: 500 })).client.me()).toMatchObject({ ok: false });
    const down = recorder(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await down.client.me()).toEqual({ ok: false, error: { code: 'NETWORK', message: '', hint: null, status: 0, retryAfter: null } });
  });

  it('never retries a write: one call per click, whatever went wrong', async () => {
    for (const answer of [
      () => {
        throw new TypeError('network down');
      },
      () => apiError(500, 'INTERNAL', 'oops'),
      () => apiError(429, 'RATE_LIMITED', 'slow', {}, { 'retry-after': '5' }),
      () => new Response('gateway timeout', { status: 504 }),
    ]) {
      const r = recorder(answer);
      const res = await r.client.regenerateKey('a1b');
      expect(res.ok).toBe(false);
      expect(r.fetchFn).toHaveBeenCalledTimes(1);
      await r.client.retire('a1b');
      await r.client.setNote('a1b', 'x');
      expect(r.fetchFn).toHaveBeenCalledTimes(3);
    }
  });
});
