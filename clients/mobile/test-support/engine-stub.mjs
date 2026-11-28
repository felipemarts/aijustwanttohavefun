#!/usr/bin/env node
// A scripted "AI engine" for testing the player client without a model: an OpenAI-compatible server on 127.0.0.1.
//
//   node clients/mobile/test-support/engine-stub.mjs [--port 8797] [--delay 1000] [--host 127.0.0.1]
//
// - GET  /v1/models            -> one model, "scripted-decider"
// - POST /v1/chat/completions  -> with a JSON Schema in response_format: a valid instance of it, rotating through the
//                                 branches of a top-level anyOf (one branch per allowed action), so turns show variety;
//                                 without a schema (chat): a short line. Streams (SSE) when the request asks for it.
// - POST /stub/mode {"mode":"ok"|"stall"|"error","delay":ms}  -> switch behaviour at run time:
//     ok: answer after `delay` ms (default 1000); stall: never answer (the client times out); error: HTTP 500.
// - GET  /stub/stats            -> counters.
// Loopback by default (--host 0.0.0.0 or a LAN address to reach it from a phone, on a trusted network only).
// No dependencies. Test tool, not shipped.
import { createServer } from 'node:http';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg('port', '8797'));
const HOST = arg('host', '127.0.0.1');
let mode = 'ok';
let delay = Number(arg('delay', '1000'));
let turn = 0;
const stats = { decisions: 0, chats: 0, errors: 0, stalled: 0, actions: {} };

/** Builds a value that satisfies a (JSON Schema) node; `pick` chooses among alternatives. */
function instance(schema, path, pick) {
  if (!schema || typeof schema !== 'object') return null;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[pick(schema.enum.length, path)];
  const alts = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alts) && alts.length) {
    const usable = alts.filter((a) => a && a.type !== 'null');
    const base = { ...schema };
    delete base.anyOf;
    delete base.oneOf;
    const chosen = usable.length ? usable[pick(usable.length, path)] : alts[0];
    return instance({ ...base, ...chosen }, path, pick);
  }
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') ?? 'null';
  switch (type) {
    case 'object': {
      const out = {};
      const props = schema.properties ?? {};
      for (const key of Object.keys(props)) out[key] = instance(props[key], `${path}.${key}`, pick);
      return out;
    }
    case 'array': {
      const n = Math.max(0, schema.minItems ?? 0);
      return Array.from({ length: n }, (_, i) => instance(schema.items ?? {}, `${path}[${i}]`, pick));
    }
    case 'string': {
      const text = path.endsWith('.thought')
        ? `Scripted turn ${turn}: trying something new.`
        : path.endsWith('.note')
          ? ''
          : 'ok';
      let s = text;
      if (schema.minLength && s.length < schema.minLength) s = s.padEnd(schema.minLength, '.');
      if (schema.maxLength !== undefined && s.length > schema.maxLength) s = s.slice(0, schema.maxLength);
      return s;
    }
    case 'integer':
    case 'number':
      return Math.max(schema.minimum ?? 1, Math.min(schema.maximum ?? 1, 1));
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return null;
  }
}

/** Rotates the top-level choice (the action) by turn; nested choices take the first option. */
function decide(schema) {
  turn++;
  const pick = (n, path) => (path === '$' ? (turn - 1) % n : 0);
  const value = instance(schema, '$', pick);
  if (value && typeof value === 'object' && typeof value.action === 'string') {
    stats.actions[value.action] = (stats.actions[value.action] ?? 0) + 1;
  }
  return JSON.stringify(value);
}

const CHAT_LINES = [
  'All good here. The road is muddy but the people are kind.',
  'I am following my quests, one step at a time.',
  'Tell me what you want me to try next.',
];

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function answer(req, res, body) {
  const schema = body?.response_format?.json_schema?.schema;
  const content = schema ? decide(schema) : CHAT_LINES[stats.chats++ % CHAT_LINES.length];
  if (schema) stats.decisions++;
  const tokens = Math.max(1, Math.round(content.length / 4));
  const usage = { prompt_tokens: 500, completion_tokens: tokens, total_tokens: 500 + tokens };
  const timings = { predicted_per_second: Math.round((tokens / Math.max(delay, 1)) * 1000 * 10) / 10 || 25 };
  if (!body?.stream) {
    send(res, 200, { id: `stub-${turn}`, object: 'chat.completion', model: 'scripted-decider', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage, timings });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  const parts = content.match(/.{1,12}/gs) ?? [content];
  let i = 0;
  const next = () => {
    if (i < parts.length) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: parts[i++] } }] })}\n\n`);
      setTimeout(next, 30);
      return;
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage, timings })}\n\n`);
    res.end('data: [DONE]\n\n');
  };
  next();
}

createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    return send(res, 400, { error: { message: 'invalid JSON' } });
  }
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/stub/mode' && req.method === 'POST') {
    if (['ok', 'stall', 'error'].includes(body?.mode)) mode = body.mode;
    if (Number.isFinite(body?.delay)) delay = body.delay;
    return send(res, 200, { mode, delay });
  }
  if (url.pathname === '/stub/stats') return send(res, 200, { mode, delay, turn, ...stats });
  if (url.pathname === '/v1/models') return send(res, 200, { object: 'list', data: [{ id: 'scripted-decider', object: 'model', owned_by: 'stub' }] });
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (mode === 'stall') {
      stats.stalled++;
      req.on('close', () => {});
      return; // never answer
    }
    if (mode === 'error') {
      stats.errors++;
      return setTimeout(() => send(res, 500, { error: { message: 'scripted engine failure (stub error mode)' } }), 200);
    }
    return setTimeout(() => answer(req, res, body), delay);
  }
  send(res, 404, { error: { message: `no route ${url.pathname}` } });
}).listen(PORT, HOST, () => console.log(`engine stub on http://${HOST}:${PORT} (mode ${mode}, delay ${delay} ms)`));
