/**
 * A scripted stand-in for a model behind an OpenAI-compatible server (`/v1/models`, `/v1/chat/completions`), for
 * end-to-end runs without a real model. It answers with a valid decision chosen from the schema in the request
 * (or, when asked without a schema, from the "Actions you can take now" lines of the prompt), and injects faults on
 * chosen request numbers so the core's retry, fallback and engine-failure paths run for real over HTTP.
 *
 * Used by test/e2e-stub.test.ts and by the harness (`--stub`).
 */
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';

export type Fault =
  /** Prose without JSON. */
  | 'garbage'
  /** A well-formed decision for an action that is not on the menu. */
  | 'off-menu'
  /** HTTP 400 naming the grammar (not response_format): the engine refuses the schema itself. */
  | 'refuse-schema'
  /** No answer for `hangMs`. */
  | 'timeout'
  /** HTTP 429 with Retry-After. */
  | '429';

export type StubEntry = { n: number; kind: 'decision' | 'notes' | 'greeting' | 'chat'; constrained: boolean; fault?: Fault; action?: string };

export type StubOptions = {
  /** Request number (1-based, every completion counts) -> fault. */
  faults?: Record<number, Fault>;
  /** How long a `timeout` fault hangs. */
  hangMs?: number;
  /** Actions preferred when offered (otherwise a random one). */
  prefer?: string[];
  /** Probability of a random menu action instead of the preferred one. */
  wander?: number;
  seed?: number;
};

type Node = { type?: string | string[]; enum?: unknown[]; minimum?: number; properties?: Record<string, Node>; required?: string[]; anyOf?: Node[]; const?: unknown };

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export async function startModelStub(opts: StubOptions = {}) {
  const rand = rng(opts.seed ?? 7);
  const pickOf = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const prefer = opts.prefer ?? ['quest_accept', 'quest_turn_in', 'attack', 'talk', 'gather', 'take', 'move'];
  const wander = opts.wander ?? 0.35;
  const log: StubEntry[] = [];
  const sockets = new Set<Socket>();
  let n = 0;

  /** Free-text values a sensible player would take from the prompt (the quest the next step names). */
  let hints: Record<string, string> = {};
  const sample = (node: Node | undefined, key = ''): unknown => {
    if (!node) return hints[key] ?? 'hello';
    if (node.anyOf?.length) return sample(pickOf(node.anyOf));
    if (node.enum?.length) return pickOf(node.enum);
    const t = Array.isArray(node.type) ? node.type[0] : node.type;
    if (t === 'integer' || t === 'number') return node.minimum ?? 1;
    if (t === 'boolean') return false;
    if (t === 'array') return [];
    if (t === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of node.required ?? []) out[k] = sample(node.properties?.[k], k);
      return out;
    }
    return hints[key] ?? 'hello';
  };

  const choose = (names: string[]): string => {
    // Quest actions only when the prompt names a quest to accept or turn in.
    const preferred = prefer.find((p) => names.includes(p) && (!p.startsWith('quest_') || hints.quest !== undefined));
    return preferred && rand() > wander ? preferred : pickOf(names);
  };

  /** From the schema: one branch per menu action. */
  const fromSchema = (branches: Node[]): { action: string; params: unknown } => {
    const byName = new Map(branches.map((b) => [b.properties?.action?.const as string, b]));
    const action = choose([...byName.keys()]);
    return { action, params: sample(byName.get(action)?.properties?.params) };
  };

  /** Without a schema: from the prompt's signature lines (`move {"dir": "north|south"} (1 AP)`). */
  const fromPrompt = (prompt: string): { action: string; params: unknown } | null => {
    const lines = prompt.split('\n');
    const start = lines.indexOf('Actions you can take now (params, AP cost):');
    if (start < 0) return null;
    const sigs: { name: string; sig: string }[] = [];
    for (const l of lines.slice(start + 1)) {
      const m = /^(\w+) (.*) \(\d+ AP\)$/.exec(l);
      if (!m) break;
      sigs.push({ name: m[1]!, sig: m[2]! });
    }
    if (!sigs.length) return null;
    const action = choose(sigs.map((s) => s.name));
    const sig = sigs.find((s) => s.name === action)!.sig;
    const params: Record<string, unknown> = {};
    for (const m of sig.matchAll(/"(\w+)"(\?)?: ("([^"]*)"|<\w+>|\[[^\]]*\]|\{[^}]*\})/g)) {
      if (m[2]) continue; // optional
      const v = m[4];
      if (v === undefined) params[m[1]!] = m[3]!.startsWith('[') ? [] : m[3]!.startsWith('{') ? {} : 1;
      else if (v.startsWith('<') || v === '#rrggbb') params[m[1]!] = v === '#rrggbb' ? '#336699' : (hints[m[1]!] ?? 'hello');
      else params[m[1]!] = pickOf(v.split('|'));
    }
    return { action, params };
  };

  const answer = (res: ServerResponse, content: string, stream: boolean) => {
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of content.match(/.{1,6}/gs) ?? []) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: Math.ceil(content.length / 4) } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { completion_tokens: Math.ceil(content.length / 4) } }));
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'scripted-stub' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[]; stream?: boolean; response_format?: { json_schema?: { schema?: { anyOf?: Node[]; properties?: Record<string, unknown> } } } };
      const schema = body.response_format?.json_schema?.schema;
      const constrained = !!body.response_format;
      n++;
      const fault = opts.faults?.[n];
      const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
      const kind: StubEntry['kind'] = schema?.properties && 'notes' in schema.properties ? 'notes' : schema?.properties && 'greeting' in schema.properties ? 'greeting' : schema?.anyOf || user.includes('Actions you can take now') ? 'decision' : 'chat';
      const entry: StubEntry = { n, kind, constrained, ...(fault ? { fault } : {}) };
      log.push(entry);
      if (fault === 'refuse-schema' && constrained) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'failed to parse grammar: unsupported keyword', type: 'invalid_request_error' } }));
        return;
      }
      if (fault === '429') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify({ error: { message: 'busy' } }));
        return;
      }
      if (fault === 'timeout') {
        setTimeout(() => answer(res, '{}', false), opts.hangMs ?? 10_000).unref();
        return;
      }
      if (fault === 'garbage') return answer(res, 'Sure! I will walk north and say hello to everyone.', !!body.stream);
      if (fault === 'off-menu') return answer(res, '{"thought":"teleport home","action":"teleport","params":{},"note":""}', !!body.stream);
      if (kind === 'notes') return answer(res, JSON.stringify({ notes: ['Olga gives quests in the square.', 'Boars roam the hills.'] }), false);
      if (kind === 'greeting') return answer(res, JSON.stringify({ greeting: 'Ready when you are.', ready: true }), false);
      if (kind === 'chat') return answer(res, 'I am exploring Mistvale and looking for my next quest.', !!body.stream);
      const quest = /Next step: .*?quest_(?:accept|turn_in) ([a-z0-9_]+)/.exec(user)?.[1];
      hints = quest ? { quest } : {};
      const d = schema?.anyOf ? fromSchema(schema.anyOf) : fromPrompt(user);
      if (!d) return answer(res, '{}', false);
      entry.action = d.action;
      answer(res, JSON.stringify({ thought: `I will ${d.action}.`, action: d.action, params: d.params, note: '' }), !!body.stream);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    log,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
