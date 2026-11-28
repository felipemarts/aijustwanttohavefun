import type { ProviderKind } from '../api.ts';
import { body, errorText, httpFailure, parseJson, readLines, request, type HttpAnswer, type HttpDeps } from './http.ts';
import { EngineError, type Completion, type CompleteOptions, type ConstraintMode, type Engine, type LlmMessage, type Probe } from './types.ts';

const LEVELS: ConstraintMode[] = ['schema', 'json', 'none'];

/**
 * LM Studio and any server speaking OpenAI's chat completions API (README 4.2). The schema goes in
 * `response_format: json_schema`; an HTTP 400 that names `response_format` moves down to `json_object`, then to no
 * constraint, and the downgrade is remembered. The prompt is never changed (it must stay byte-identical across cores);
 * the answer is validated by the playkit whatever the mode. LM Studio also gets `top_k` and `repeat_penalty`; other
 * servers get the standard fields only.
 */
export class OpenAiEngine implements Engine {
  readonly kind: ProviderKind;
  private readonly base: string;
  private model: string | undefined;
  private readonly deps: HttpDeps;
  /** The strongest constraint this server accepted; starts optimistic. */
  mode: ConstraintMode;

  constructor(kind: 'openai' | 'lmstudio', baseUrl: string, model: string | undefined, deps: HttpDeps, mode: ConstraintMode = 'schema') {
    this.kind = kind;
    this.base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.model = model || undefined;
    this.deps = deps;
    this.mode = mode;
  }

  private get label(): string {
    return this.kind === 'lmstudio' ? 'LM Studio' : 'The AI server';
  }

  private get probeTimeout(): number {
    return this.deps.probeTimeoutMs ?? 5_000;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (this.kind === 'lmstudio') {
      // LM Studio's own API lists downloaded models and their type; the OpenAI route lists only what it serves.
      const native = await request(this.deps, `${this.base}/api/v1/models`, { method: 'GET', signal, timeoutMs: this.probeTimeout }).catch(() => null);
      const j = native && native.status === 200 ? (parseJson(native.text) as { models?: { key?: unknown; type?: unknown }[] }) : undefined;
      if (Array.isArray(j?.models)) return j.models.filter((m) => m.type === 'llm' && typeof m.key === 'string').map((m) => m.key as string);
    }
    const a = await request(this.deps, `${this.base}/v1/models`, { method: 'GET', signal, timeoutMs: this.probeTimeout });
    if (a.status !== 200) throw httpFailure(a, this.label);
    const j = parseJson(a.text) as { data?: { id?: unknown }[] } | undefined;
    if (!Array.isArray(j?.data)) throw new EngineError('bad_response', `${this.label} sent an unexpected model list.`);
    return j.data.flatMap((m) => (typeof m.id === 'string' ? [m.id] : []));
  }

  async probe(signal?: AbortSignal): Promise<Probe> {
    try {
      return { reachable: true, models: await this.listModels(signal) };
    } catch (e) {
      const code = e instanceof EngineError ? e.code : 'unreachable';
      if (code === 'unauthorized') return { reachable: true, models: [], message: 'The server asks for a key.' };
      return { reachable: code !== 'unreachable' && code !== 'timeout' && code !== 'redirect', models: [], message: e instanceof Error ? e.message : undefined };
    }
  }

  private async pickModel(signal?: AbortSignal): Promise<string | undefined> {
    if (this.model) return this.model;
    // A server with one model (llama-server) needs none named; ask once and use the first when there is a list.
    const list = await this.listModels(signal).catch(() => [] as string[]);
    this.model = list[0];
    return this.model;
  }

  async complete(messages: LlmMessage[], opts: CompleteOptions = {}): Promise<Completion> {
    const model = await this.pickModel(opts.signal);
    for (;;) {
      const level = opts.schema === undefined ? 'none' : this.mode;
      const r = await this.attempt(model, messages, opts, level);
      if ('completion' in r) return r.completion;
      const next = LEVELS[LEVELS.indexOf(level) + 1];
      if (r.downgrade && next && opts.schema !== undefined) {
        this.mode = next;
        continue;
      }
      throw r.error;
    }
  }

  private async attempt(model: string | undefined, messages: LlmMessage[], opts: CompleteOptions, mode: ConstraintMode): Promise<{ completion: Completion } | { error: EngineError; downgrade: boolean }> {
    const stream = !!opts.onToken;
    const parts: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature ?? 0.1,
      max_tokens: opts.maxTokens ?? 320,
      stream,
    };
    if (this.kind === 'lmstudio') {
      parts.top_k = opts.topK;
      parts.repeat_penalty = opts.repeatPenalty;
    }
    if (opts.schema !== undefined && mode === 'schema') parts.response_format = new Map<string, unknown>([['type', 'json_schema'], ['json_schema', new Map<string, unknown>([['name', 'decision'], ['strict', true], ['schema', opts.schema]])]]);
    if (opts.schema !== undefined && mode === 'json') parts.response_format = { type: 'json_object' };
    if (stream) parts.stream_options = { include_usage: true };
    const started = this.deps.clock.now();
    let text = '';
    let tokens = 0;
    let usage: number | undefined;
    const answer: HttpAnswer = await request(this.deps, `${this.base}/v1/chat/completions`, { method: 'POST', body: body(parts), signal: opts.signal, stream }, async ({ res }) => {
      // A server that ignores `stream` answers one JSON object: take it whole, as one token.
      if ((res.headers.get('content-type') ?? '').includes('application/json')) {
        const j = parseJson(await res.text()) as { choices?: { message?: { content?: unknown } }[]; usage?: { completion_tokens?: unknown } } | undefined;
        const content = j?.choices?.[0]?.message?.content;
        if (typeof content === 'string' && content) {
          text = content;
          opts.onToken?.(content);
        }
        if (typeof j?.usage?.completion_tokens === 'number') usage = j.usage.completion_tokens;
        return;
      }
      await readLines(res, (line) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        const j = parseJson(data) as { choices?: { delta?: { content?: unknown } }[]; usage?: { completion_tokens?: unknown } } | undefined;
        const piece = j?.choices?.[0]?.delta?.content;
        if (typeof piece === 'string' && piece) {
          text += piece;
          tokens++;
          opts.onToken?.(piece);
        }
        if (typeof j?.usage?.completion_tokens === 'number') usage = j.usage.completion_tokens;
      });
    });
    if (answer.status >= 400) {
      // README 4.2: only an HTTP 400 that names response_format means "this constraint is not supported".
      const downgrade = answer.status === 400 && mode !== 'none' && errorText(answer).toLowerCase().includes('response_format');
      return { error: httpFailure(answer, this.label), downgrade };
    }
    if (answer.status !== 200) return { error: new EngineError('bad_response', `${this.label} answered HTTP ${answer.status}.`, answer.status), downgrade: false };
    if (!stream) {
      const j = parseJson(answer.text) as { choices?: { message?: { content?: unknown } }[]; usage?: { completion_tokens?: unknown } } | undefined;
      const content = j?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') return { error: new EngineError('bad_response', `${this.label} sent an answer without text.`), downgrade: false };
      text = content;
      usage = typeof j?.usage?.completion_tokens === 'number' ? j.usage.completion_tokens : undefined;
    }
    return { completion: { text, tokens: usage ?? (tokens || estimateTokens(text)), ms: Math.max(1, this.deps.clock.now() - started), mode } };
  }
}

/** About four characters per token, for servers that report no usage. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
