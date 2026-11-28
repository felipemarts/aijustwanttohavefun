import { RedirectRefused, safeFetch } from '../util/safe-fetch.ts';
import type { Clock, Fetch } from '../ports.ts';
import { deadline } from '../util/async.ts';
import { sameOrigin } from '../util/url.ts';
import { fromPlain, write, type JV } from '../playkit/jv.ts';
import { EngineError } from './types.ts';

/** A provider key and the address it was entered for: it is sent there and nowhere else. */
export type BoundKey = { origin: string; key: string };

export type HttpDeps = {
  fetch: Fetch;
  clock: Clock;
  /** Read at call time from the vault. */
  apiKey?: () => Promise<BoundKey | null>;
  /** For a whole completion (a slow phone-hosted model can take a while). */
  timeoutMs?: number;
  /** For listing models and probing (default 5 s). */
  probeTimeoutMs?: number;
};

export type HttpAnswer = { status: number; res: Response; text?: string };

/**
 * One request to a local AI server. The key goes only to the origin it was entered for; redirects to elsewhere
 * are refused. With `stream`, the body is left unread for the caller.
 */
export async function request(
  deps: HttpDeps,
  url: string,
  init: { method: 'GET' | 'POST'; body?: JV; signal?: AbortSignal; timeoutMs?: number; stream?: boolean },
  run: (answer: HttpAnswer) => Promise<void> = async () => {},
): Promise<HttpAnswer> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const bound = deps.apiKey ? await deps.apiKey() : null;
  if (bound && sameOrigin(bound.origin, url)) headers.authorization = `Bearer ${bound.key}`;
  const d = deadline(deps.clock, init.timeoutMs ?? deps.timeoutMs ?? 180_000, init.signal);
  try {
    let res: Response;
    try {
      res = await safeFetch(deps.fetch, url, {
        method: init.method,
        headers,
        // Written with the playkit's writer: member order kept (schemas), valid JSON.
        body: init.body === undefined ? undefined : write(init.body),
        signal: d.signal,
      });
    } catch (e) {
      if (e instanceof RedirectRefused) throw new EngineError('redirect', 'The AI server redirected to another address; nothing was sent there.');
      throw fail(d, init.signal);
    }
    const answer: HttpAnswer = { status: res.status, res };
    if (!init.stream || res.status >= 300) {
      try {
        answer.text = await res.text();
      } catch {
        throw fail(d, init.signal);
      }
    } else {
      try {
        await run(answer);
      } catch (e) {
        if (e instanceof EngineError) throw e;
        throw fail(d, init.signal);
      }
    }
    return answer;
  } finally {
    d.done();
  }
}

function fail(d: { timedOut: () => boolean }, signal?: AbortSignal): EngineError {
  if (signal?.aborted) return new EngineError('aborted', 'Cancelled.');
  if (d.timedOut()) return new EngineError('timeout', 'The AI server did not answer in time.');
  return new EngineError('unreachable', 'The AI server cannot be reached.');
}

export function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return undefined;
  }
}

/**
 * Calls `onLine` for each line of a streamed body (NDJSON, or SSE `data:` lines). Falls back to reading the whole
 * body when the platform's fetch cannot stream (older React Native fetch), so streaming degrades to one burst.
 */
export async function readLines(res: Response, onLine: (line: string) => void): Promise<void> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== 'function') {
    for (const line of (await res.text()).split(/\r?\n/)) if (line.trim()) onLine(line);
    return;
  }
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  }
  buf += dec.decode();
  if (buf.trim()) onLine(buf);
}

/** A request body: plain parts plus JSON values (a schema) kept as they are. */
export function body(parts: Record<string, unknown>): JV {
  const out = new Map<string, JV>();
  for (const [k, v] of Object.entries(parts)) {
    if (v === undefined) continue;
    out.set(k, v instanceof Map ? (v as JV) : fromPlain(v));
  }
  return out;
}

/** An error text from a server answer, for deciding whether a feature was refused. Never shown with secrets. */
export function errorText(answer: HttpAnswer): string {
  const j = parseJson(answer.text) as { error?: unknown; message?: unknown } | undefined;
  const e = j?.error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  if (typeof j?.message === 'string') return j.message;
  return (answer.text ?? '').slice(0, 300);
}

/** Maps an HTTP failure to an EngineError (401/403: key; 404: model or route; others: refused). */
export function httpFailure(answer: HttpAnswer, what: string): EngineError {
  if (answer.status === 401 || answer.status === 403) return new EngineError('unauthorized', `${what} refused the key (HTTP ${answer.status}).`, answer.status);
  if (answer.status === 404) return new EngineError('no_model', `${what} does not know this model or route (HTTP 404).`, 404);
  return new EngineError('refused', `${what} refused the request (HTTP ${answer.status}).`, answer.status);
}
