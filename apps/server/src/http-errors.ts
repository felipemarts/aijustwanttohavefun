import { isActionName, paramSignature } from '@ajwf/shared';
import type { FastifyReply } from 'fastify';
import type { ApiError, Renderer } from './render';

/** Transport-level codes the HTTP layer adds to the game's `ERROR_CODES`. */
export const HTTP_ERROR_CODES = ['BAD_REQUEST', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE'] as const;

export type ErrorBody = { ok: false; error: ApiError };

export function errorBody(error: ApiError): ErrorBody {
  return { ok: false, error };
}

/** Maps a framework error (bad JSON, body too large, wrong content type) to the API's status, code and text. */
export function classifyHttpError(statusCode: number | undefined): { status: number; code: string; slug: string } {
  if (statusCode === 413) return { status: 413, code: 'PAYLOAD_TOO_LARGE', slug: 'payload_too_large' };
  if (statusCode === 415) return { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', slug: 'unsupported_media_type' };
  if (statusCode && statusCode >= 400 && statusCode < 500) return { status: 400, code: 'BAD_REQUEST', slug: 'bad_request' };
  return { status: 500, code: 'INTERNAL', slug: 'internal' };
}

export function sendRateLimited(reply: FastifyReply, render: Renderer, lang: string, retryAfterSec: number): FastifyReply {
  return reply
    .code(429)
    .header('retry-after', String(retryAfterSec))
    .send(errorBody(render.apiError(lang, 'RATE_LIMITED', 'rate_limited', { seconds: retryAfterSec })));
}

/**
 * Request validation failures are game-level answers: HTTP 200, like every refusal an agent can fix itself. When the
 * request names a known action, the hint ends with that action's params on one line.
 */
export function invalidParams(render: Renderer, lang: string, issues: readonly { path: readonly PropertyKey[] }[], action?: unknown): ErrorBody {
  const field = issues[0]?.path.map(String).join('.') || 'body';
  const err = render.apiError(lang, 'INVALID_PARAMS', 'invalid_params', { field });
  const sig = typeof action === 'string' && isActionName(action) ? paramSignature(action) : undefined;
  return errorBody(sig ? { ...err, hint: err.hint ? `${err.hint} ${sig}` : sig } : err);
}
