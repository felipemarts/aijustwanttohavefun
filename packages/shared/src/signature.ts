import { z } from 'zod';
import { actionParamSchemas, type ActionName } from './schemas';

type Json = Record<string, unknown>;

/** Params that take another agent's name. */
const AGENT_FIELDS = new Set(['agent', 'to', 'candidate']);

const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

/** One JSON Schema node (as zod emits it) as a placeholder: `"<field>"`, `<qty>`, `"a|b"`, `{...}`, `[...]`. */
function shape(node: unknown, field: string): string {
  if (!isObj(node)) return `<${field}>`;
  const variants = Array.isArray(node.anyOf) ? node.anyOf.filter(isObj) : null;
  if (variants) {
    // Nullable: the value or null. Other unions (item bundles): the first, simplest form.
    const nonNull = variants.filter((v) => v.type !== 'null');
    const first = shape(nonNull[0], field);
    return nonNull.length < variants.length ? `${first}|null` : first;
  }
  if (Array.isArray(node.enum)) return `"${node.enum.join('|')}"`;
  switch (node.type) {
    case 'string':
      if (typeof node.pattern === 'string' && node.pattern.includes('[0-9a-fA-F]{6}')) return '"#rrggbb"';
      return `"<${AGENT_FIELDS.has(field) ? 'name' : field}>"`;
    case 'integer':
    case 'number':
      return `<${field}>`;
    case 'array': {
      if (Array.isArray(node.prefixItems)) return `[${node.prefixItems.map((x) => shape(x, field)).join(', ')}]`;
      return `[${shape(node.items, field)}]`;
    }
    case 'object': {
      // A map such as items: { "<item>": <qty> }.
      if (!isObj(node.properties) && isObj(node.additionalProperties)) return `{"<item>": ${shape(node.additionalProperties, 'qty')}}`;
      const props = isObj(node.properties) ? node.properties : {};
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      const fields = Object.entries(props).map(([k, v]) => `"${k}"${required.has(k) ? '' : '?'}: ${shape(v, k)}`);
      return `{${fields.join(', ')}}`;
    }
    default:
      return `<${field}>`;
  }
}

const cache = new Map<ActionName, string>();

/**
 * An action's params on one line, generated from the same schema the server validates with, for hints:
 * `party_accept {"agent": "<name>"}`, `cast {"skill": "<skill>", "target"?: "<target>"}` (`?` marks optional fields).
 */
export function paramSignature(action: ActionName): string {
  let sig = cache.get(action);
  if (sig === undefined) {
    sig = `${action} ${shape(z.toJSONSchema(actionParamSchemas[action], { io: 'input', unrepresentable: 'any' }), 'params')}`;
    cache.set(action, sig);
  }
  return sig;
}
