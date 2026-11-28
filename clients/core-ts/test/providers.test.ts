import { afterEach, describe, expect, it } from 'vitest';
import { BuiltinEngine } from '../src/engine/builtin.ts';
import type { BoundKey, HttpDeps } from '../src/engine/http.ts';
import { OllamaEngine } from '../src/engine/ollama.ts';
import { OpenAiEngine } from '../src/engine/openai.ts';
import type { EngineError } from '../src/engine/types.ts';
import { nodeFetch, systemClock } from '../src/node/index.ts';
import { FakeClock, FakeRuntime, MemoryModelFiles } from '../src/testing/index.ts';
import { httpServer, sendJson, TEST_MODEL } from './helpers.ts';
import { fromPlain, obj } from '../src/playkit/jv.ts';

const PLAIN_SCHEMA = { type: 'object', properties: { action: { type: 'string', enum: ['move'] } }, required: ['action'], additionalProperties: false };
const SCHEMA = fromPlain(PLAIN_SCHEMA);
const MSGS = [
  { role: 'system' as const, content: 'You are a test.' },
  { role: 'user' as const, content: 'Go.' },
];
const PROVIDER_KEY = 'sk-PROVIDERKEY0123456789abcdef';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function deps(key?: BoundKey): HttpDeps {
  return { fetch: nodeFetch, clock: systemClock, ...(key ? { apiKey: async () => key } : {}) };
}

async function server(h: Parameters<typeof httpServer>[0]) {
  const s = await httpServer(h);
  closers.push(s.close);
  return s;
}

describe('Ollama', () => {
  it('sends the schema as `format`, think false and the playkit sampling, streams NDJSON, and reads eval_count', async () => {
    const s = await server((req, res) => {
      if (req.url === '/api/tags') return sendJson(res, 200, { models: [{ name: 'lfm3:1.7b', model: 'lfm3:1.7b' }] });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: '{"action":' }, done: false })}\n`);
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: '"move"}' }, done: false })}\n`);
      res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, eval_count: 7, eval_duration: 1000 })}\n`);
    });
    const e = new OllamaEngine(s.url, undefined, deps());
    const tokens: string[] = [];
    const r = await e.complete(MSGS, { schema: SCHEMA, onToken: (t) => tokens.push(t), temperature: 0.1, topK: 50, repeatPenalty: 1.1, maxTokens: 320 });
    expect(r.text).toBe('{"action":"move"}');
    expect(tokens).toEqual(['{"action":', '"move"}']);
    expect(r.tokens).toBe(7);
    expect(r.mode).toBe('schema');
    const chat = s.hits.find((h) => h.url === '/api/chat')!;
    const body = JSON.parse(chat.body);
    expect(body.format).toEqual(PLAIN_SCHEMA);
    expect(body.think).toBe(false);
    expect(body.options).toEqual({ temperature: 0.1, top_k: 50, repeat_penalty: 1.1, num_predict: 320 });
    expect(body.model).toBe('lfm3:1.7b');
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual(MSGS);
  });

  it('reports a refused schema as refused (the core then asks once without it), non-streaming', async () => {
    const s = await server((req, res) => {
      const b = JSON.parse(req.body || '{}');
      if (b.format !== undefined) return sendJson(res, 400, { error: 'invalid format' });
      sendJson(res, 200, { message: { content: '{"action":"move"}' }, done: true, eval_count: 3 });
    });
    const e = new OllamaEngine(s.url, 'm', deps());
    const err = (await e.complete(MSGS, { schema: SCHEMA }).catch((x: unknown) => x)) as EngineError;
    expect(err.code).toBe('refused');
    const r = await e.complete(MSGS);
    expect(r.mode).toBe('none');
    expect(r.text).toBe('{"action":"move"}');
    expect(JSON.parse(s.hits.at(-1)!.body).stream).toBe(false);
  });

  it('keeps schema member order exactly, integer-like keys included', async () => {
    const s = await server((_req, res) => sendJson(res, 200, { message: { content: '{}' }, done: true }));
    const ordered = obj(['type', 'object'], ['properties', obj(['z', obj(['type', 'string'])], ['10', obj(['type', 'string'])], ['a', obj(['type', 'string'])])]);
    await new OllamaEngine(s.url, 'm', deps()).complete(MSGS, { schema: ordered });
    expect(s.hits[0]!.body).toContain('"properties":{"z":{"type":"string"},"10":{"type":"string"},"a":{"type":"string"}}');
  });

  it('lists models and probes; an unreachable server is reported', async () => {
    const s = await server((_req, res) => sendJson(res, 200, { models: [{ name: 'a' }, { model: 'b' }] }));
    expect(await new OllamaEngine(s.url, undefined, deps()).listModels()).toEqual(['a', 'b']);
    const down = await httpServer(() => undefined);
    await down.close();
    const p = await new OllamaEngine(down.url, undefined, deps()).probe();
    expect(p.reachable).toBe(false);
  });
});

describe('OpenAI-compatible and LM Studio', () => {
  it('sends response_format json_schema and streams SSE', async () => {
    const s = await server((req, res) => {
      if (req.url === '/v1/models') return sendJson(res, 200, { data: [{ id: 'local-model' }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"action"' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ':"move"}' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    const e = new OpenAiEngine('openai', `${s.url}/v1`, undefined, deps());
    const tokens: string[] = [];
    const r = await e.complete(MSGS, { schema: SCHEMA, onToken: (t) => tokens.push(t) });
    expect(r.text).toBe('{"action":"move"}');
    expect(tokens.length).toBe(2);
    const body = JSON.parse(s.hits.find((h) => h.url === '/v1/chat/completions')!.body);
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'decision', strict: true, schema: PLAIN_SCHEMA } });
    expect(body.model).toBe('local-model');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    // Standard fields only for a generic server.
    expect(body.top_k).toBeUndefined();
  });

  it('falls back json_schema -> json_object -> no constraint on a 400 naming response_format, keeps the prompt, and remembers it', async () => {
    const s = await server((req, res) => {
      const b = JSON.parse(req.body || '{}');
      if (b.response_format?.type === 'json_schema') return sendJson(res, 400, { error: { message: "response_format 'json_schema' is not supported" } });
      if (b.response_format?.type === 'json_object') return sendJson(res, 400, { error: { message: 'Invalid value for response_format' } });
      sendJson(res, 200, { choices: [{ message: { content: 'Sure! {"action":"move"}' } }], usage: { completion_tokens: 5 } });
    });
    const e = new OpenAiEngine('openai', s.url, 'm', deps());
    const r = await e.complete(MSGS, { schema: SCHEMA });
    expect(r.mode).toBe('none');
    expect(r.tokens).toBe(5);
    expect(s.hits.map((h) => JSON.parse(h.body).response_format?.type ?? 'none')).toEqual(['json_schema', 'json_object', 'none']);
    // The prompt is never changed (byte-identical across cores); the playkit validates the answer whatever the mode.
    for (const h of s.hits) expect(JSON.parse(h.body).messages).toEqual(MSGS);
    expect(JSON.parse(s.hits[0]!.body).response_format).toEqual({ type: 'json_schema', json_schema: { name: 'decision', strict: true, schema: PLAIN_SCHEMA } });
    expect(e.mode).toBe('none');
    await e.complete(MSGS, { schema: SCHEMA });
    expect(s.hits.length).toBe(4); // went straight to plain text
  });

  it('does not downgrade on errors unrelated to the constraint', async () => {
    const s = await server((_req, res) => sendJson(res, 401, { error: { message: 'bad key' } }));
    const e = new OpenAiEngine('openai', s.url, 'm', deps());
    const err = (await e.complete(MSGS, { schema: SCHEMA }).catch((x: unknown) => x)) as EngineError;
    expect(err.code).toBe('unauthorized');
    expect(s.hits.length).toBe(1);
  });

  it('LM Studio gets top_k and repeat_penalty', async () => {
    const s = await server((_req, res) => sendJson(res, 200, { choices: [{ message: { content: '{}' } }] }));
    await new OpenAiEngine('lmstudio', s.url, 'm', deps()).complete(MSGS, { topK: 50, repeatPenalty: 1.1 });
    const b = JSON.parse(s.hits[0]!.body);
    expect([b.top_k, b.repeat_penalty]).toEqual([50, 1.1]);
  });

  it('does not downgrade on a 400 that does not name response_format', async () => {
    const s = await server((_req, res) => sendJson(res, 400, { error: { message: 'context too long' } }));
    const err = (await new OpenAiEngine('openai', s.url, 'm', deps()).complete(MSGS, { schema: SCHEMA }).catch((x: unknown) => x)) as EngineError;
    expect(err.code).toBe('refused');
    expect(s.hits.length).toBe(1);
  });

  it('LM Studio lists LLMs from its native API', async () => {
    const s = await server((req, res) =>
      req.url === '/api/v1/models'
        ? sendJson(res, 200, { models: [{ type: 'llm', key: 'lfm3' }, { type: 'embedding', key: 'nomic' }] })
        : sendJson(res, 200, { data: [{ id: 'x' }] }),
    );
    expect(await new OpenAiEngine('lmstudio', s.url, undefined, deps()).listModels()).toEqual(['lfm3']);
    expect(await new OpenAiEngine('openai', s.url, undefined, deps()).listModels()).toEqual(['x']);
  });

  it('sends the provider key only to the address it was entered for, and never across a redirect', async () => {
    const elsewhere = await server((_req, res) => sendJson(res, 200, { data: [{ id: 'evil' }] }));
    const s = await server((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(307, { location: `${elsewhere.url}/v1/models` });
        res.end();
        return;
      }
      sendJson(res, 200, { choices: [{ message: { content: '{}' } }] });
    });
    const bound = { origin: s.url, key: PROVIDER_KEY };
    const e = new OpenAiEngine('openai', s.url, 'm', deps(bound));
    await e.complete(MSGS);
    expect(s.hits.at(-1)!.headers.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
    const err = (await e.listModels().catch((x: unknown) => x)) as EngineError;
    expect(err.code).toBe('redirect');
    expect(elsewhere.hits.length).toBe(0);
    // Same key, another server: not sent.
    const other = await server((_req, res) => sendJson(res, 200, { choices: [{ message: { content: '{}' } }] }));
    await new OpenAiEngine('openai', other.url, 'm', deps(bound)).complete(MSGS);
    expect(other.hits[0]!.headers.authorization).toBeUndefined();
  });

  it('takes a plain JSON answer from a server that ignores `stream`', async () => {
    const s = await server((_req, res) => sendJson(res, 200, { choices: [{ message: { content: 'Fine, thanks.' } }], usage: { completion_tokens: 3 } }));
    const toks: string[] = [];
    const r = await new OpenAiEngine('openai', s.url, 'm', deps()).complete(MSGS, { onToken: (t) => toks.push(t) });
    expect(r.text).toBe('Fine, thanks.');
    expect(r.tokens).toBe(3);
    expect(toks).toEqual(['Fine, thanks.']);
  });

  it('reads a whole body when the platform cannot stream', async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\ndata: [DONE]\n\n`;
    const noStream: typeof fetch = async () => {
      const r = new Response(sse, { status: 200 });
      Object.defineProperty(r, 'body', { value: null });
      return r;
    };
    const e = new OpenAiEngine('openai', 'http://x.test', 'm', { fetch: noStream, clock: new FakeClock() });
    const toks: string[] = [];
    expect((await e.complete(MSGS, { onToken: (t) => toks.push(t) })).text).toBe('hi');
    expect(toks).toEqual(['hi']);
  });
});

describe('Built-in', () => {
  it('runs the runtime with the schema, loads once, and reports not installed', async () => {
    const files = new MemoryModelFiles();
    const runtime = new FakeRuntime(() => '{"action":"move"}');
    const paths: string[] = [];
    const e = new BuiltinEngine(TEST_MODEL, files, runtime, new FakeClock(), (p) => paths.push(p));
    expect((await e.probe()).reachable).toBe(false);
    expect(((await e.complete(MSGS).catch((x: unknown) => x)) as EngineError).code).toBe('not_installed');
    files.present.set(TEST_MODEL.file, { bytes: TEST_MODEL.bytes, complete: true });
    const toks: string[] = [];
    const r = await e.complete(MSGS, { schema: SCHEMA, onToken: (t) => toks.push(t) });
    await e.complete(MSGS, { schema: SCHEMA });
    expect(r.text).toBe('{"action":"move"}');
    expect(toks.join('')).toBe(r.text);
    expect(runtime.calls[0]!.schema).toEqual(PLAIN_SCHEMA);
    expect(runtime.calls[0]!.schemaJson).toBe(JSON.stringify(PLAIN_SCHEMA));
    expect(runtime.calls[0]!.thinking).toBe(false);
    expect(runtime.loads).toBe(1);
    expect(paths[0]).toContain('test.gguf');
    expect(await e.listModels()).toEqual([TEST_MODEL.name]);
  });
});
