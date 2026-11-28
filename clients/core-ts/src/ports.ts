/**
 * Everything that touches the device comes in through these ports. The app implements them with native modules
 * (see the notes on each); tests and the Node harness use the implementations in `testing/` and `node/`.
 */
import type { RandomSource } from './util/ids.ts';

export type { RandomSource };

/** Secrets by name: agent API keys, claim links, a provider key. Phone: the OS keystore (expo-secure-store). */
export interface KeyVault {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/**
 * Durable ordered key-value storage (characters, logs, chats, directives, settings), values are JSON text.
 * Keys sort as plain strings; `list` is a range scan over one prefix, so a SQLite table with a primary-key index
 * (expo-sqlite) implements it directly.
 */
export interface Storage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Entries whose key starts with `prefix`, sorted by key. `before`/`after` bound the key (exclusive); `reverse`
   * returns the largest keys first; `limit` caps the count (after ordering).
   */
  list(prefix: string, opts?: { before?: string; after?: string; limit?: number; reverse?: boolean }): Promise<{ key: string; value: string }[]>;
}

export type DownloadRequest = {
  /** HTTPS URL of the file (the pinned Hugging Face revision). */
  url: string;
  /** File name inside the app's model directory. */
  name: string;
  /** Exact size; the download is complete only at this many bytes. */
  bytes: number;
  /** Lower-case hex SHA-256 the finished file must have; checked by the port (natively on a phone). Empty: unchecked. */
  sha256: string;
  onProgress?: (bytesDone: number, bytesTotal: number) => void;
  signal?: AbortSignal;
};

/**
 * Large files in app storage. Phone: expo-file-system (`File.createDownloadTask`, `Paths.availableDiskSpace`), or a
 * background downloader for downloads that must survive the app being killed.
 */
export interface ModelFiles {
  /** Bytes free on the volume that holds the model directory. */
  freeBytes(): Promise<number>;
  /** What is on disk for `name`: bytes present and whether it is the finished, verified file. Null when absent. */
  stat(name: string): Promise<{ bytes: number; complete: boolean } | null>;
  /**
   * Downloads `url` into `name`, resuming from a partial file when one exists (HTTP Range). Resolves with the local
   * path once the file is complete and verified; rejects with an AbortError when `signal` aborts (the partial file
   * stays for a later resume).
   */
  download(req: DownloadRequest): Promise<{ path: string }>;
  /** The local path of a complete file, or null. Never shown to the interface or the model. */
  path(name: string): Promise<string | null>;
  /** Deletes the file and any partial download of it. */
  remove(name: string): Promise<void>;
}

export type RuntimeMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type RuntimeRequest = {
  messages: RuntimeMessage[];
  /** JSON Schema the output must follow (the runtime turns it into a grammar), as a plain object... */
  schema?: Record<string, unknown>;
  /** ...and as exact JSON text, member order kept (prefer this one when the binding takes a string). */
  schemaJson?: string;
  maxTokens: number;
  temperature: number;
  topK: number;
  repeatPenalty: number;
  /** Always false: LFM3 reasons by default; the playkit wants a direct answer (llama.cpp `enable_thinking: false`). */
  thinking: false;
  onToken?: (token: string) => void;
  signal?: AbortSignal;
};

/**
 * An on-device model. Phone: llama.rn (`initLlama({ model, n_ctx })`; `context.completion({ messages,
 * response_format: { type: 'json_schema', json_schema: { strict: true, schema } }, n_predict, temperature, top_k,
 * penalty_repeat }, (data) => onToken(data.token))`; `stopCompletion()` on abort; `release()`).
 */
export interface ModelRuntime {
  load(path: string, opts: { contextSize: number }): Promise<void>;
  /** Path of the loaded model, or null. */
  loaded(): string | null;
  complete(req: RuntimeRequest): Promise<{ text: string; tokens: number }>;
  unload(): Promise<void>;
}

export type TimerHandle = { cancel(): void };

/** Time, so tests control it. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
}

/**
 * The network, so tests control it. The standard `fetch` signature; implementations must honour
 * `redirect: 'manual'` (return the 3xx answer instead of following it), which the core relies on to never carry a
 * credential to another host.
 */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type Ports = {
  vault: KeyVault;
  storage: Storage;
  files: ModelFiles;
  runtime: ModelRuntime;
  clock: Clock;
  fetch: Fetch;
  /** Random bytes; defaults to `globalThis.crypto` (absent in React Native: pass expo-crypto's). */
  random?: RandomSource;
};
