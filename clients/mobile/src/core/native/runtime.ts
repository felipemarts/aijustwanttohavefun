/**
 * `ModelRuntime` on llama.rn: `initLlama({ model, n_ctx })`, `completion(...)` with a JSON-Schema response format and
 * a token callback, `stopCompletion()` when the request is aborted, `release()`.
 */
import type { ModelRuntime, RuntimeRequest } from '@ajwf/client-core';

/** The part of llama.rn this adapter uses (its real types are wider). */
export type LlamaContextLike = {
  completion(
    params: Record<string, unknown>,
    callback?: (data: { token: string }) => void,
  ): Promise<{ text: string; content?: string; tokens_predicted?: number }>;
  stopCompletion(): Promise<void>;
  release(): Promise<void>;
};
export type InitLlama = (params: { model: string; n_ctx: number; [k: string]: unknown }) => Promise<LlamaContextLike>;

function abortError(): Error {
  const e = new Error('The completion was aborted.');
  e.name = 'AbortError';
  return e;
}

/** The completion parameters for one request, as llama.rn takes them. Exported for tests. */
export function completionParams(req: RuntimeRequest): Record<string, unknown> {
  const params: Record<string, unknown> = {
    messages: req.messages,
    n_predict: req.maxTokens,
    temperature: req.temperature,
    top_k: req.topK,
    penalty_repeat: req.repeatPenalty,
    // LFM3 reasons by default; the playkit wants the answer directly.
    enable_thinking: false,
  };
  const schema = req.schema ?? (req.schemaJson ? (JSON.parse(req.schemaJson) as Record<string, unknown>) : undefined);
  if (schema) params.response_format = { type: 'json_schema', json_schema: { strict: true, schema } };
  return params;
}

export function llamaRuntime(initLlama: InitLlama, extra: Record<string, unknown> = {}): ModelRuntime {
  let ctx: LlamaContextLike | null = null;
  let path: string | null = null;
  return {
    async load(modelPath, { contextSize }) {
      if (ctx && path === modelPath) return;
      if (ctx) await ctx.release();
      ctx = null;
      path = null;
      ctx = await initLlama({ model: modelPath, n_ctx: contextSize, ...extra });
      path = modelPath;
    },
    loaded: () => path,
    async complete(req) {
      if (!ctx) throw new Error('No model is loaded.');
      if (req.signal?.aborted) throw abortError();
      const context = ctx;
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        void context.stopCompletion();
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await context.completion(completionParams(req), req.onToken ? (d) => req.onToken!(d.token) : undefined);
        if (aborted) throw abortError();
        return { text: res.content ?? res.text, tokens: res.tokens_predicted ?? 0 };
      } finally {
        req.signal?.removeEventListener('abort', onAbort);
      }
    },
    async unload() {
      if (ctx) await ctx.release();
      ctx = null;
      path = null;
    },
  };
}
