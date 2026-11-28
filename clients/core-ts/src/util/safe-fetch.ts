import type { Fetch } from '../ports.ts';

export class RedirectRefused extends Error {
  constructor() {
    super('The server redirected to another address; the request was not followed.');
    this.name = 'RedirectRefused';
  }
}

const MAX_REDIRECTS = 3;

/**
 * `fetch` that never carries a request to another origin: redirects are handled here (`redirect: 'manual'`) and
 * followed only within the origin of the first URL, so an `Authorization` header (an agent key, a provider key)
 * reaches only the host it was entered for. A redirect elsewhere, or one the platform followed on its own, is refused.
 */
export async function safeFetch(fetch: Fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const origin = new URL(url).origin;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, { ...init, redirect: 'manual' });
    // A platform that followed the redirect anyway: refuse an answer from elsewhere.
    if (res.url && res.redirected && new URL(res.url).origin !== origin) throw new RedirectRefused();
    if (res.type === 'opaqueredirect') throw new RedirectRefused();
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const loc = res.headers.get('location');
    if (!loc) return res;
    const next = new URL(loc, current);
    if (next.origin !== origin) throw new RedirectRefused();
    // 303 (and 301/302 after a POST, as browsers do) turn into a GET without a body.
    const method = (init.method ?? 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) init = { ...init, method: 'GET', body: undefined };
    current = next.toString();
  }
  throw new RedirectRefused();
}
