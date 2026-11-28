import type { Clock, ModelFiles, ModelRuntime } from '../ports.ts';
import { isAbort } from '../util/errors.ts';
import { toPlain, write } from '../playkit/jv.ts';
import type { BuiltinModel } from './model.ts';
import { EngineError, type Completion, type CompleteOptions, type Engine, type LlmMessage, type Probe } from './types.ts';

/**
 * The model the client downloads and runs itself (`ModelFiles` + `ModelRuntime`). The schema is enforced by the
 * runtime's grammar. The file path never leaves this class except into the runtime.
 */
export class BuiltinEngine implements Engine {
  readonly kind = 'builtin' as const;
  private readonly model: BuiltinModel;
  private readonly files: ModelFiles;
  private readonly runtime: ModelRuntime;
  private readonly clock: Clock;
  private loading: Promise<void> | null = null;
  /** Told the file path when it is first read, so it can be scrubbed from anything emitted. */
  private readonly onPath: (path: string) => void;

  constructor(model: BuiltinModel, files: ModelFiles, runtime: ModelRuntime, clock: Clock, onPath: (path: string) => void = () => {}) {
    this.model = model;
    this.files = files;
    this.runtime = runtime;
    this.clock = clock;
    this.onPath = onPath;
  }

  async installed(): Promise<boolean> {
    const s = await this.files.stat(this.model.file);
    return !!s?.complete;
  }

  async listModels(): Promise<string[]> {
    return (await this.installed()) ? [this.model.name] : [];
  }

  async probe(): Promise<Probe> {
    const ok = await this.installed();
    return { reachable: ok, models: ok ? [this.model.name] : [], ...(ok ? {} : { message: 'The built-in model is not downloaded yet.' }) };
  }

  /** Loads the model if it is not loaded yet (once, even with concurrent callers). */
  async ensureLoaded(): Promise<void> {
    const path = await this.files.path(this.model.file);
    if (!path) throw new EngineError('not_installed', 'The built-in model is not downloaded yet.');
    this.onPath(path);
    if (this.runtime.loaded() === path) return;
    this.loading ??= this.runtime.load(path, { contextSize: this.model.contextSize }).finally(() => {
      this.loading = null;
    });
    try {
      await this.loading;
    } catch {
      throw new EngineError('refused', 'The built-in model could not be loaded (not enough memory?).');
    }
  }

  async complete(messages: LlmMessage[], opts: CompleteOptions = {}): Promise<Completion> {
    await this.ensureLoaded();
    const started = this.clock.now();
    try {
      const r = await this.runtime.complete({
        messages,
        ...(opts.schema !== undefined ? { schema: toPlain(opts.schema) as Record<string, unknown>, schemaJson: write(opts.schema) } : {}),
        maxTokens: opts.maxTokens ?? 320,
        temperature: opts.temperature ?? 0.1,
        topK: opts.topK ?? 50,
        repeatPenalty: opts.repeatPenalty ?? 1.1,
        thinking: false,
        ...(opts.onToken ? { onToken: opts.onToken } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      return { text: r.text, tokens: r.tokens, ms: Math.max(1, this.clock.now() - started), mode: opts.schema !== undefined ? 'schema' : 'none' };
    } catch (e) {
      if (isAbort(e) || opts.signal?.aborted) throw new EngineError('aborted', 'Cancelled.');
      throw new EngineError('refused', 'The built-in model failed to answer.');
    }
  }

  async unload(): Promise<void> {
    await this.runtime.unload();
  }
}
