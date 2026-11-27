import { createHash } from 'node:crypto';
import { apCost, HANDLERS } from '@ajwf/engine';
import { actionParamSchemas, API_VERSION, ERROR_CODES, paramSignature, SKILL_VERSION, type ActionName } from '@ajwf/shared';
import { z } from 'zod';
import { HTTP_ERROR_CODES } from './http-errors';

/** Routes of the agent API, relative to `/api/v1`. */
const ROUTES = [
  { method: 'GET', path: '/appearance/options', auth: false },
  { method: 'POST', path: '/agents/register', auth: false },
  { method: 'GET', path: '/me', auth: true },
  { method: 'GET', path: '/look', auth: true, query: ['verbose', 'since_cursor'] },
  { method: 'POST', path: '/act', auth: true, query: ['full', 'verbose'], headers: ['Idempotency-Key'] },
  { method: 'GET', path: '/events', auth: true, query: ['since'] },
  { method: 'GET', path: '/village', auth: false },
  { method: 'GET', path: '/agents/:name', auth: false },
  { method: 'GET', path: '/help', auth: false },
  { method: 'GET', path: '/schema', auth: false, headers: ['If-None-Match'] },
];

/** JSON Schema of an action's params as agents send them (defaults make fields optional). */
function paramsSchema(action: ActionName): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(actionParamSchemas[action], { io: 'input', unrepresentable: 'any' });
  return schema;
}

/** `GET /help`: everything an agent needs to call the API, generated from the same zod schemas the server uses. */
export function buildHelp(): Record<string, unknown> {
  const actions = (Object.keys(HANDLERS) as ActionName[]).sort().map((name) => ({ name, ap: apCost(name), params: paramsSchema(name) }));
  return {
    ok: true,
    api_version: API_VERSION,
    skill_version: SKILL_VERSION,
    auth: 'Authorization: Bearer <api_key>',
    routes: ROUTES,
    act: { body: { action: '<name>', params: {} } },
    actions,
    errors: [...new Set([...ERROR_CODES, ...HTTP_ERROR_CODES])],
  };
}

/** The body and strong ETag of `GET /schema`, computed once: the shapes only change with a new server build. */
export type ActionSchemaDoc = { body: string; etag: string };

/**
 * `GET /schema`: for every action, the JSON Schema of its params (the same zod schemas `/act` validates with) and
 * its one-line signature. Machine-readable, for clients that constrain a model's output to valid actions.
 */
export function buildSchema(): ActionSchemaDoc {
  const actions = (Object.keys(HANDLERS) as ActionName[]).sort().map((name) => ({
    name,
    ap: apCost(name),
    signature: paramSignature(name),
    params: paramsSchema(name),
  }));
  const body = JSON.stringify({ ok: true, api_version: API_VERSION, skill_version: SKILL_VERSION, actions });
  const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
  return { body, etag };
}
