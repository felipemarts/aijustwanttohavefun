import { body, httpFailure, parseJson, readLines, request, type HttpDeps } from './http.ts';
import { estimateTokens } from './openai.ts';
import { EngineError, type Completion, type CompleteOptions, type Engine, type LlmMessage, type Probe } from './types.ts';

type ChatLine = { message?: { content?: unknown }; done?: unknown; eval_count?: unknown; error?: unknown };

/**
 * Ollama's native API (README 4.2): `POST /api/chat` with `think: false`, `options` (temperature, top_k,
 * repeat_penalty, num_predict) and `format` set to the JSON Schema; NDJSON when streaming. `GET /api/tags` for models.
 * A refused schema is the core's business (it asks once without it and validates the answer anyway).
 */
export class OllamaEngine implements Engine {
  readonly kind = 'ollama' as const;
  private readonly base: string;
  private model: string | undefined;
  private readonly deps: HttpDeps;

  constructor(baseUrl: string, model: string | undefined, deps: HttpDeps) {
    this.base = baseUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    this.model = model || undefined;
    this.deps = deps;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const a = await request(this.deps, `${this.base}/api/tags`, { method: 'GET', signal, timeoutMs: this.deps.probeTimeoutMs ?? 5_000 });
    if (a.status !== 200) throw httpFailure(a, 'Ollama');
    const j = parseJson(a.text) as { models?: { name?: unknown; model?: unknown }[] } | undefined;
    if (!Array.isArray(j?.models)) throw new EngineError('bad_response', 'Ollama sent an unexpected model list.');
    return j.models.flatMap((m) => (typeof m.name === 'string' ? [m.name] : typeof m.model === 'string' ? [m.model] : []));
  }

  async probe(signal?: AbortSignal): Promise<Probe> {
    try {
      return { reachable: true, models: await this.listModels(signal) };
    } catch (e) {
      const code = e instanceof EngineError ? e.code : 'unreachable';
      return { reachable: code !== 'unreachable' && code !== 'timeout' && code !== 'redirect', models: [], message: e instanceof Error ? e.message : undefined };
    }
  }

  async complete(messages: LlmMessage[], opts: CompleteOptions = {}): Promise<Completion> {
    if (!this.model) {
      const first = (await this.listModels(opts.signal))[0];
      if (!first) throw new EngineError('no_model', 'Ollama has no model installed.');
      this.model = first;
    }
    const stream = !!opts.onToken;
    const parts: Record<string, unknown> = {
      model: this.model,
      messages,
      stream,
      think: false,
      options: { temperature: opts.temperature ?? 0.1, top_k: opts.topK, repeat_penalty: opts.repeatPenalty, num_predict: opts.maxTokens ?? 320 },
      format: opts.schema,
    };
    const started = this.deps.clock.now();
    let text = '';
    let tokens = 0;
    let evalCount: number | undefined;
    let streamError: string | undefined;
    const onLine = (line: string) => {
      const j = parseJson(line) as ChatLine | undefined;
      if (!j) return;
      if (typeof j.error === 'string') streamError = j.error;
      const piece = j.message?.content;
      if (typeof piece === 'string' && piece) {
        text += piece;
        tokens++;
        opts.onToken?.(piece);
      }
      if (j.done === true && typeof j.eval_count === 'number') evalCount = j.eval_count;
    };
    const answer = await request(this.deps, `${this.base}/api/chat`, { method: 'POST', body: body(parts), signal: opts.signal, stream }, async ({ res }) => readLines(res, onLine));
    if (answer.status >= 400) throw httpFailure(answer, 'Ollama');
    if (!stream) onLine(answer.text ?? '');
    if (streamError !== undefined) throw new EngineError('refused', 'Ollama stopped with an error.');
    if (!stream && typeof (parseJson(answer.text) as ChatLine | undefined)?.message?.content !== 'string') throw new EngineError('bad_response', 'Ollama sent an answer without text.');
    return { text, tokens: evalCount ?? (tokens || estimateTokens(text)), ms: Math.max(1, this.deps.clock.now() - started), mode: opts.schema === undefined ? 'none' : 'schema' };
  }
}
