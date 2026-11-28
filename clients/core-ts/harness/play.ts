/**
 * Runs `LocalCore` in Node: file-backed ports, an AI server (OpenAI-compatible, LM Studio or Ollama) as the engine, one
 * character created on a game server, playing for a while. Proof without a phone.
 *
 *   node --experimental-strip-types harness/play.ts --server http://localhost:8731 --engine http://127.0.0.1:1234 [--kind openai|lmstudio|ollama] [--model NAME] [--engine-key-file FILE]
 *   node --experimental-strip-types harness/play.ts --server http://localhost:8731 --stub   (the scripted model stub of test/fixtures, with faults)
 *
 * Options: --name Pip --class mage --language en --turns 30 --minutes 5 --pace active --data <dir> --pvp
 * Writes a JSON report to <dir>/report.json.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { LocalCore } from '../src/core/local-core.ts';
import type { CoreEvent, LogEntry, ProviderKind } from '../src/api.ts';
import { FileKeyVault, FileStorage, NodeModelFiles, UnavailableRuntime, nodeFetch, nodeRandom, systemClock } from '../src/node/index.ts';
import { startModelStub, type Fault } from '../test/fixtures/model-stub.ts';

const { values: a } = parseArgs({
  options: {
    server: { type: 'string', default: 'http://localhost:8731' },
    engine: { type: 'string' },
    kind: { type: 'string', default: 'openai' },
    model: { type: 'string' },
    'engine-key-file': { type: 'string' },
    'engine-timeout': { type: 'string', default: '60000' },
    stub: { type: 'boolean', default: false },
    name: { type: 'string' },
    class: { type: 'string', default: 'mage' },
    language: { type: 'string', default: 'en' },
    turns: { type: 'string', default: '30' },
    minutes: { type: 'string', default: '5' },
    pace: { type: 'string', default: 'active' },
    pvp: { type: 'boolean', default: false },
    data: { type: 'string' },
  },
});

/** The stub's faults on a long run: every path of README 4.3 and the engine failures, a few times. */
const STUB_FAULTS: Record<number, Fault> = { 3: 'garbage', 7: 'off-menu', 8: 'garbage', 12: 'refuse-schema', 16: '429', 20: 'timeout', 26: 'garbage', 31: 'off-menu', 32: 'off-menu', 37: 'refuse-schema' };

async function main(): Promise<void> {
  const dataDir = a.data ?? join(tmpdir(), `ajwf-harness-${Date.now()}`);
  await mkdir(dataDir, { recursive: true });
  const stub = a.stub ? await startModelStub({ faults: STUB_FAULTS, hangMs: 8_000, seed: Date.now() % 100_000 }) : null;
  const engineUrl = stub?.url ?? a.engine;
  if (!engineUrl) throw new Error('Pass --engine <url> or --stub.');
  const apiKey = a['engine-key-file'] ? (await readFile(a['engine-key-file'], 'utf8')).trim() : undefined;

  const core = await LocalCore.create({
    ports: {
      vault: new FileKeyVault(dataDir),
      storage: new FileStorage(join(dataDir, 'store')),
      files: new NodeModelFiles(join(dataDir, 'models')),
      runtime: new UnavailableRuntime(),
      clock: systemClock,
      fetch: nodeFetch,
      random: nodeRandom,
    },
    platform: 'desktop',
    defaults: { serverUrl: a.server!, language: a.language! },
    engineTimeoutMs: stub ? 3_000 : Number(a['engine-timeout']),
  });
  const events: CoreEvent[] = [];
  core.subscribe((ev) => {
    events.push(ev);
    if (ev.type === 'log') {
      const e: LogEntry = ev.entry;
      const extra = e.quote ? ` «${e.quote.from}: ${e.quote.text}» (untrusted)` : '';
      console.log(`[${new Date(e.ts).toISOString().slice(11, 19)}] ${e.kind.padEnd(7)} ${e.action ? `${e.action}: ` : ''}${e.text}${e.thought ? ` — ${e.thought}` : ''}${extra}`);
    }
  });

  const kind = (stub ? 'openai' : a.kind) as Exclude<ProviderKind, 'builtin'>;
  const engine = await core.setEngine({ kind, url: engineUrl, ...(a.model ? { model: a.model } : {}), ...(apiKey ? { apiKey } : {}) });
  console.log(`engine: ${engine.choice.kind} ${engine.choice.url} -> ${engine.status}${engine.message ? ` (${engine.message})` : ''}`);
  const test = await core.testEngine();
  console.log(`engine test: ok=${test.ok} validJson=${test.validJson} ${test.tokensPerSecond} tok/s${test.message ? ` (${test.message})` : ''}`);

  const name = a.name ?? `Harness${Math.floor(Math.random() * 1e6)}`;
  const c = await core.createCharacter({
    name,
    class: a.class as 'mage',
    language: a.language!,
    persona: 'A cheerful explorer who wants to see every corner of Mistvale and make friends.',
    wish: 'level up and make friends',
    pace: a.pace as 'active',
    allowPvp: !!a.pvp,
    appearance: 'surprise_me',
  });
  console.log(`created ${c.name} (${c.class}), watch at ${c.watchUrl}; claim link pending: ${c.claimPending}`);

  const started = Date.now();
  const wantTurns = Number(a.turns);
  const deadline = started + Number(a.minutes) * 60_000;
  while (Date.now() < deadline && (await core.stats(c.id)).turns < wantTurns) await new Promise((r) => setTimeout(r, 500));
  const wall = (Date.now() - started) / 1000;
  await core.control(c.id, false);
  const chat = await core.chat(c.id, 'How was your day?').catch((e: Error) => ({ text: `(chat failed: ${e.message})` }));
  const detail = await core.character(c.id);
  const st = await core.stats(c.id);
  const log = await core.log(c.id, { limit: 200 });
  await core.close();
  await stub?.close();

  const count = (k: LogEntry['kind']) => log.filter((e) => e.kind === k).length;
  const report = {
    character: { name: detail.name, level: detail.level, xp: detail.xp, gold: detail.gold, room: detail.room, status: detail.status, quests: detail.quests.length, inventory: detail.inventory.length, notes: detail.memory },
    stats: st,
    rates: {
      acceptedByGame: st.turns ? +(st.accepted / st.turns).toFixed(3) : 0,
      validFirst: st.turns ? +(st.firstValid / st.turns).toFixed(3) : 0,
      secondsPerTurn: st.turns ? +(st.turnMs / st.turns / 1000).toFixed(2) : 0,
      inferenceSecondsPerTurn: st.turns ? +(st.inferMs / st.turns / 1000).toFixed(2) : 0,
      wallSeconds: +wall.toFixed(1),
    },
    log: { actions: count('action'), refused: count('refused'), events: count('event'), system: count('system') },
    actionsByName: log.filter((e) => e.action).reduce<Record<string, number>>((m, e) => ({ ...m, [e.action!]: (m[e.action!] ?? 0) + 1 }), {}),
    refusals: log.filter((e) => e.kind === 'refused').map((e) => `${e.action}: ${e.text}`).slice(0, 12),
    system: log.filter((e) => e.kind === 'system').map((e) => e.text).slice(0, 20),
    stubFaults: stub ? stub.log.filter((e) => e.fault).map((e) => `#${e.n} ${e.fault}`) : undefined,
    stubUnconstrained: stub ? stub.log.filter((e) => !e.constrained && e.kind === 'decision').length : undefined,
    eventsEmitted: events.length,
    chatReply: chat.text,
    engineTest: test,
  };
  await writeFile(join(dataDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`report: ${join(dataDir, 'report.json')}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
