export { ApiError, createClient, type ActOptions, type ApiErrorCode, type Client, type ClientOptions, type FetchLike, type LookOptions, type ResponseInfo } from './client';
export type * from './types';
export type { ActionName } from '@ajwf/shared';

/** True when a result is the game's refusal (`{ ok: false, error }`). */
export function isRefusal<T extends { ok: boolean }>(r: T): r is Extract<T, { ok: false }> {
  return r.ok === false;
}
