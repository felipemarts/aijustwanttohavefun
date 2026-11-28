import type { ProviderKind } from '../api.ts';
import type { JV } from '../playkit/jv.ts';

export type LlmMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type CompleteOptions = {
  /** JSON Schema the answer must follow, member order kept (constrained decoders emit properties in schema order). */
  schema?: JV;
  /** Streams the answer token by token. */
  onToken?: (token: string) => void;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  repeatPenalty?: number;
};

/** How the output was constrained: by the schema, JSON mode only, or not at all (README 4.2). */
export type ConstraintMode = 'schema' | 'json' | 'none';

export type Completion = { text: string; tokens: number; ms: number; mode: ConstraintMode };

export type Probe = { reachable: boolean; models: string[]; message?: string };

/** One interface for every AI engine: the built-in model, Ollama, LM Studio and OpenAI-compatible servers. */
export interface Engine {
  readonly kind: ProviderKind;
  complete(messages: LlmMessage[], opts?: CompleteOptions): Promise<Completion>;
  listModels(signal?: AbortSignal): Promise<string[]>;
  probe(signal?: AbortSignal): Promise<Probe>;
}

export type EngineErrorCode = 'unreachable' | 'refused' | 'bad_response' | 'not_installed' | 'no_model' | 'timeout' | 'aborted' | 'unauthorized' | 'redirect';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly status: number;
  constructor(code: EngineErrorCode, message: string, status = 0) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.status = status;
  }
}

/** Errors where the engine itself refused the request (as opposed to not answering): worth one try without the schema. */
export function engineRefused(e: unknown): boolean {
  return e instanceof EngineError && (e.code === 'refused' || e.code === 'bad_response');
}
