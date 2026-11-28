import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LocalCore, type LocalCoreOptions } from '../src/core/local-core.ts';
import { builtinModel } from '../src/engine/model.ts';
import type { CoreEvent } from '../src/api.ts';
import type { LlmMessage } from '../src/engine/types.ts';
import type { Fetch, RuntimeRequest } from '../src/ports.ts';
import { FakeClock, FakeGame, FakeRuntime, MemoryKeyVault, MemoryModelFiles, MemoryStorage } from '../src/testing/index.ts';
import { nodeRandom } from '../src/node/index.ts';

export const TEST_MODEL = builtinModel({ repo: 'test/model', revision: 'a'.repeat(40), file: 'test.gguf', bytes: 1024 ** 3, sha256: 'b'.repeat(64) });

type Node = { type?: string | string[]; enum?: unknown[]; minimum?: number; properties?: Record<string, Node>; required?: string[]; anyOf?: Node[]; const?: unknown };

/** A value that satisfies a (narrowed) params node: the first enum value, or something of its type. */
function sample(n: Node | undefined): unknown {
  if (!n) return 'x';
  if (n.anyOf?.length) return sample(n.anyOf[0]);
  if (n.enum?.length) return n.enum[0];
  const t = Array.isArray(n.type) ? n.type[0] : n.type;
  if (t === 'integer' || t === 'number') return n.minimum ?? 1;
  if (t === 'boolean') return false;
  if (t === 'array') return [];
  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of n.required ?? []) out[k] = sample(n.properties?.[k]);
    return out;
  }
  return 'hello';
}

/**
 * A scripted model: for a decision it picks the first preferred action the schema offers and fills the required
 * params; for notes it returns notes; for the engine test a greeting; otherwise plain text.
 */
export function scripted(prefer: string[] = ['attack', 'move', 'talk']): (req: RuntimeRequest) => string {
  return (req) => {
    const s = req.schema as { anyOf?: Node[]; properties?: Record<string, unknown> } | undefined;
    if (s?.anyOf) {
      const branches = s.anyOf;
      const name = (b: Node) => b.properties?.action?.const as string;
      const pick = prefer.map((p) => branches.find((b) => name(b) === p)).find(Boolean) ?? branches[0]!;
      return JSON.stringify({ thought: `I choose ${name(pick)}.`, action: name(pick), params: sample(pick.properties?.params), note: '' });
    }
    if (s?.properties && 'notes' in s.properties) return JSON.stringify({ notes: ['Boars live east of the square.'] });
    if (s?.properties && 'greeting' in s.properties) return JSON.stringify({ greeting: 'Hello!', ready: true });
    return 'Hello, owner. The boars are fierce today.';
  };
}

export type Rig = Awaited<ReturnType<typeof makeRig>>;

export async function makeRig(o: { answer?: (req: RuntimeRequest) => string; installed?: boolean; storage?: MemoryStorage; vault?: MemoryKeyVault; clock?: FakeClock; game?: FakeGame; files?: MemoryModelFiles; fetch?: Fetch; extra?: Partial<LocalCoreOptions> } = {}) {
  const clock = o.clock ?? new FakeClock();
  const game = o.game ?? new FakeGame(clock);
  const storage = o.storage ?? new MemoryStorage();
  const vault = o.vault ?? new MemoryKeyVault();
  const files = o.files ?? new MemoryModelFiles();
  if (o.installed !== false && !o.files) files.present.set(TEST_MODEL.file, { bytes: TEST_MODEL.bytes, complete: true });
  const runtime = new FakeRuntime(o.answer ?? scripted());
  const events: CoreEvent[] = [];
  const prompts: LlmMessage[][] = [];
  const core = await LocalCore.create({
    ports: { vault, storage, files, runtime, clock, fetch: o.fetch ?? game.fetch, random: nodeRandom },
    model: TEST_MODEL,
    defaults: { serverUrl: game.base, language: 'en' },
    onPrompt: (m) => prompts.push(m),
    ...o.extra,
  });
  core.subscribe((ev) => events.push(ev));
  await clock.settle();
  return { core, clock, game, storage, vault, files, runtime, events, prompts };
}

export const newChar = (name = 'Pip') => ({ name, class: 'mage' as const, language: 'en', persona: 'A curious apprentice who collects stones.', appearance: 'surprise_me' as const });

/** Advances a fake clock in steps until the promise settles (for real I/O under a fake clock). */
export async function drive<T>(clock: FakeClock, p: Promise<T>, step = 250, max = 600_000): Promise<T> {
  let done = false;
  let out: { ok: true; v: T } | { ok: false; e: unknown } | undefined;
  p.then(
    (v) => {
      done = true;
      out = { ok: true, v };
    },
    (e: unknown) => {
      done = true;
      out = { ok: false, e };
    },
  );
  for (let t = 0; t < max && !done; t += step) {
    await new Promise((r) => setTimeout(r, 2));
    if (!done) await clock.advance(step);
  }
  await new Promise((r) => setTimeout(r, 2));
  if (!out) throw new Error('drive: promise did not settle');
  if (!out.ok) throw out.e;
  return out.v;
}

export type Handler = (req: IncomingMessage & { body: string }, res: ServerResponse) => unknown;

/** A real HTTP server on a random local port. */
export async function httpServer(handler: Handler): Promise<{ url: string; server: Server; hits: (IncomingMessage & { body: string })[]; close: () => Promise<void> }> {
  const hits: (IncomingMessage & { body: string })[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const r = Object.assign(req, { body });
      hits.push(r);
      void Promise.resolve(handler(r, res)).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
