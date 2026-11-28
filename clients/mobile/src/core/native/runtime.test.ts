import { describe, expect, it, vi } from 'vitest';
import { completionParams, llamaRuntime, type InitLlama, type LlamaContextLike } from './runtime';

const request = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 300,
  temperature: 0.1,
  topK: 50,
  repeatPenalty: 1.1,
  thinking: false as const,
};

function fakeLlama(answer = '{"action":"move"}') {
  const calls: { init: unknown[]; completion: Record<string, unknown>[]; stopped: number; released: number } = { init: [], completion: [], stopped: 0, released: 0 };
  let finish: (() => void) | null = null;
  const ctx: LlamaContextLike = {
    async completion(params, cb) {
      calls.completion.push(params);
      for (const t of ['{"act', 'ion":', '"move"}']) cb?.({ token: t });
      if (params.n_predict === 999) await new Promise<void>((r) => (finish = r)); // a long one, to abort
      return { text: answer, content: answer, tokens_predicted: 7 };
    },
    async stopCompletion() {
      calls.stopped++;
      finish?.();
    },
    async release() {
      calls.released++;
    },
  };
  const init: InitLlama = async (p) => {
    calls.init.push(p);
    return ctx;
  };
  return { init, calls };
}

describe('llamaRuntime', () => {
  it('loads once per path, releases on change and on unload', async () => {
    const { init, calls } = fakeLlama();
    const rt = llamaRuntime(init);
    expect(rt.loaded()).toBeNull();
    await rt.load('/m/a.gguf', { contextSize: 8192 });
    await rt.load('/m/a.gguf', { contextSize: 8192 });
    expect(calls.init).toEqual([{ model: '/m/a.gguf', n_ctx: 8192 }]);
    await rt.load('/m/b.gguf', { contextSize: 4096 });
    expect(calls.released).toBe(1);
    expect(rt.loaded()).toBe('/m/b.gguf');
    await rt.unload();
    expect(calls.released).toBe(2);
    expect(rt.loaded()).toBeNull();
  });

  it('maps a request to llama.rn parameters, with the schema as a JSON-Schema response format and no thinking', () => {
    const schema = { type: 'object', properties: { action: { const: 'move' } } };
    expect(completionParams({ ...request, schema })).toEqual({
      messages: request.messages,
      n_predict: 300,
      temperature: 0.1,
      top_k: 50,
      penalty_repeat: 1.1,
      enable_thinking: false,
      response_format: { type: 'json_schema', json_schema: { strict: true, schema } },
    });
    expect(completionParams({ ...request, schemaJson: JSON.stringify(schema) }).response_format).toEqual({ type: 'json_schema', json_schema: { strict: true, schema } });
    expect(completionParams(request).response_format).toBeUndefined();
  });

  it('streams tokens and returns the text and token count', async () => {
    const { init } = fakeLlama();
    const rt = llamaRuntime(init);
    await rt.load('/m/a.gguf', { contextSize: 8192 });
    const tokens: string[] = [];
    const out = await rt.complete({ ...request, onToken: (t) => tokens.push(t) });
    expect(tokens.join('')).toBe('{"action":"move"}');
    expect(out).toEqual({ text: '{"action":"move"}', tokens: 7 });
  });

  it('stops the native completion when the request is aborted, and rejects with AbortError', async () => {
    const { init, calls } = fakeLlama();
    const rt = llamaRuntime(init);
    await rt.load('/m/a.gguf', { contextSize: 8192 });
    const ctl = new AbortController();
    const p = rt.complete({ ...request, maxTokens: 999, signal: ctl.signal });
    await vi.waitFor(() => expect(calls.completion).toHaveLength(1));
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.stopped).toBe(1);
    const pre = new AbortController();
    pre.abort();
    await expect(rt.complete({ ...request, signal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses to complete with no model loaded', async () => {
    await expect(llamaRuntime(fakeLlama().init).complete(request)).rejects.toThrow('No model');
  });
});
