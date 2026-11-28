import type { CoreError } from '../api.ts';

/**
 * Codes `LocalCore` throws with (as `CoreError`). The interface localizes the contract's codes; for the others the
 * message is shown. A message never carries a key, a claim link, a file path or a provider key (see `Redactor`).
 * Game refusals the contract does not name keep the game's own code (`INVALID_PARAMS`, ...) and its text.
 */
export const FAULT = {
  // Codes the contract names (the interface localizes them).
  network: 'network',
  unauthorized: 'unauthorized',
  notAvailable: 'not_available',
  nameTaken: 'NAME_TAKEN',
  invalidName: 'INVALID_NAME',
  invalidUrl: 'INVALID_URL',
  optionsExpired: 'OPTIONS_EXPIRED',
  // The core's own codes; their messages are shown as they are.
  notFound: 'not_found',
  invalid: 'invalid',
  rateLimited: 'rate_limited',
  engine: 'engine',
  noSpace: 'no_space',
  badResponse: 'bad_response',
} as const;

export type FaultCode = (typeof FAULT)[keyof typeof FAULT];

/** The error every public `LocalCore` method rejects with: the contract's `CoreError`, as an `Error`. */
export class CoreFault extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoreFault';
    this.code = code;
  }

  toCoreError(): CoreError {
    return { error: { code: this.code, message: this.message } };
  }
}

export function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
