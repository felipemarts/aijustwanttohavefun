/**
 * `pnpm bench --ci`: a reduced benchmark that runs in seconds and fails on a regression above 20%.
 *
 * Absolute timings vary a lot between CI runners, so the compared metrics are of two kinds:
 *
 * - **Costs per operation divided by a calibration unit** (`lib/calibrate.ts`: a fixed workload of small objects,
 *   Map lookups, JSON and hashing timed on the same machine in the same run). A runner twice as slow doubles both,
 *   so the ratio stays put. Each is the best of 3 repetitions (noise from a busy machine only adds time).
 * - **Deterministic sizes** (bytes per agent snapshot, per `/act` answer, per spectator batch; events per action):
 *   the scenario runs on a seeded RNG and a simulated clock, so these do not vary at all between runs and catch
 *   payload bloat exactly.
 *
 * Every metric is "lower is better"; a value above 1.2 x the baseline fails. `--update-baseline` rewrites
 * `results/ci-baseline.json` from this machine.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hrtime } from 'node:process';
import type { Content } from '@ajwf/content';
import type { SpectatorSocket } from '@ajwf/server/src/spectate/broadcaster';
import { makeServer } from '@ajwf/server/src/test-helpers';
import { createRng } from '@ajwf/shared';
import { calibrate } from './lib/calibrate';
import { machine, RESULTS_DIR } from './lib/report';
import { cv, round } from './lib/stats';
import { freeName } from './lib/world';
import { runEngine } from './scenarios/engine';

export const BASELINE = join(RESULTS_DIR, 'ci-baseline.json');
const TOLERANCE = 1.2;
const REPS = 3;

type Metrics = Record<string, number>;
export type Baseline = { at: string; machine: ReturnType<typeof machine>; tolerance: number; metrics: Metrics; noise?: Record<string, number> };

/** A socket that only counts bytes (the broadcaster's side of the work is what is measured). */
class NullSocket implements SpectatorSocket {
  bufferedAmount = 0;
  bytes = 0;
  send(data: Buffer): void {
    this.bytes += data.length;
  }
  close(): void {}
  terminate(): void {}
}

/** The HTTP path in-process (`inject`, no sockets): `/act` cost and answer size, plus a spectator fan-out. */
async function serverPart(content: Content) {
  const s = await makeServer({ wsMaxConnections: 5000, wsMaxPerIp: 5000 });
  void content;
  const keys: string[] = [];
  const rng = createRng(5);
  for (let i = 0; i < 100; i++) keys.push((await s.register(freeName(s.game.state, rng))).key);
  const sockets: NullSocket[] = [];
  const rooms = [...s.game.content.rooms.keys()];
  for (let i = 0; i < 1000; i++) {
    const sock = new NullSocket();
    const c = s.spectators.attach(sock, `10.0.${i >> 8}.${i & 255}`);
    const topic = i % 10 < 8 ? 'world' : `room:${rooms[i % rooms.length]}`;
    s.spectators.handleMessage(c, JSON.stringify({ op: 'sub', topics: [topic] }));
    sockets.push(sock);
  }
  const actions: [string, Record<string, unknown>][] = [
    ['say', { text: 'hello there' }],
    ['emote', { emote: 'wave' }],
    ['move', { dir: 'north' }],
    ['move', { dir: 'south' }],
    ['look', {}],
  ];
  let bytes = 0;
  let n = 0;
  let actNs = 0n;
  let flushNs = 0n;
  let flushes = 0;
  let sent0 = 0;
  // The first rounds warm the JIT and are not measured.
  for (let round = 0; round < 36; round++) {
    const measured = round >= 6;
    if (round === 6) sent0 = sockets.reduce((a, x) => a + x.bytes, 0);
    for (let i = 0; i < keys.length; i++) {
      const [action, params] = actions[(round + i) % actions.length]!;
      s.clock.advance(5);
      const t0 = hrtime.bigint();
      const res = await s.act(keys[i]!, action, params);
      const dt = hrtime.bigint() - t0;
      if (!measured) continue;
      actNs += dt;
      bytes += res.body.length;
      n++;
      if (n % 25 === 0) {
        const f0 = hrtime.bigint();
        s.spectators.flush();
        flushNs += hrtime.bigint() - f0;
        flushes++;
      }
    }
  }
  const sent = sockets.reduce((a, x) => a + x.bytes, 0) - sent0;
  s.spectators.stop();
  await s.app.close();
  return {
    actUs: Number(actNs) / 1000 / n,
    actBytes: bytes / n,
    flushUs: Number(flushNs) / 1000 / flushes,
    spectatorBytesPerFlush: sent / flushes,
  };
}

async function once(content: Content): Promise<{ unitMs: number; raw: Metrics; sizes: Metrics; info: Metrics }> {
  const unitMs = calibrate();
  const e = (await runEngine(content, { agents: 500, actions: 20_000, rate: 200, seed: 7, heapTimers: [10_000] })).metrics;
  const sv = await serverPart(content);
  const timers = e.manyTimers[0] as { usPerDueTimer: number };
  const raw: Metrics = {
    'engine.applyAction_mean_us': e.applyActionUs.mean,
    'engine.observe_mean_us': e.observeUs.mean,
    'engine.snapshot_us_per_entity': e.snapshot.usPerDirtyEntity,
    'server.act_inject_us': sv.actUs,
    'server.spectator_flush_us': sv.flushUs,
  };
  const sizes: Metrics = {
    'size.agent_snapshot_bytes_mean': e.agentSnapshotBytes.mean,
    'size.events_per_action': e.eventsPerAction,
    'size.act_response_bytes_mean': round(sv.actBytes, 1),
    'size.spectator_bytes_per_flush': round(sv.spectatorBytesPerFlush, 0),
  };
  // Too small and too noisy to gate on (cv above 50% across runs): reported, not compared.
  const info: Metrics = { 'engine.tick_us_per_due_timer': timers.usPerDueTimer, 'engine.applyAction_p99_us': e.applyActionUs.p99 };
  return { unitMs, raw, sizes, info };
}

/**
 * Best of the repetitions: timings are microseconds per millisecond of calibration (each repetition divided by its
 * own unit), and the minimum is kept, since noise from a busy machine only ever adds time.
 */
async function measure(content: Content, reps: number): Promise<{ metrics: Metrics; noise: Record<string, number>; info: Metrics; unitMs: number }> {
  const runs: Metrics[] = [];
  let unitMs = 0;
  let info: Metrics = {};
  for (let r = 0; r < reps; r++) {
    const x = await once(content);
    unitMs = x.unitMs;
    info = x.info;
    const m: Metrics = {};
    for (const [k, v] of Object.entries(x.raw)) m[`${k}/unit`] = v / x.unitMs;
    Object.assign(m, x.sizes);
    runs.push(m);
  }
  const metrics: Metrics = {};
  const noise: Record<string, number> = {};
  for (const k of Object.keys(runs[0]!)) {
    const vs = runs.map((m) => m[k]!).sort((a, b) => a - b);
    metrics[k] = round(vs[0]!, 4);
    noise[k] = round(cv(vs), 3);
  }
  return { metrics, noise, info, unitMs };
}

export async function runCi(content: Content, o: { update: boolean; baseline?: string }): Promise<number> {
  const file = o.baseline ?? BASELINE;
  const t0 = Date.now();
  // Silence the engine scenario's progress lines.
  const out = console.log;
  console.log = () => {};
  let res: Awaited<ReturnType<typeof measure>>;
  try {
    res = await measure(content, o.update ? REPS + 2 : REPS);
  } finally {
    console.log = out;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (o.update) {
    const b: Baseline = { at: new Date().toISOString(), machine: machine(), tolerance: TOLERANCE, metrics: res.metrics, noise: res.noise };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(b, null, 2) + '\n');
    console.log(`bench --ci: baseline written to ${file} (${secs} s)`);
    return 0;
  }
  if (!existsSync(file)) {
    console.error(`bench --ci: no baseline at ${file}; run pnpm bench --ci --update-baseline`);
    return 1;
  }
  const base = JSON.parse(readFileSync(file, 'utf8')) as Baseline;
  // The calibration ratio holds across machines of one CPU family, not across architectures (an x86 runner
  // against an arm64 baseline): there, timings are shown but only the deterministic sizes can fail.
  const here = machine();
  const sameKind = base.machine.platform === here.platform;
  let failed = 0;
  console.log(`bench --ci: calibration unit ${res.unitMs.toFixed(2)} ms; ${REPS} repetitions in ${secs} s; failing above ${base.tolerance} x baseline (${file})`);
  if (!sameKind) console.log(`bench --ci: baseline from ${base.machine.platform}, this is ${here.platform}: timings are informative only`);
  for (const [k, v] of Object.entries(res.metrics)) {
    const b = base.metrics[k];
    if (b === undefined) {
      console.log(`  new   ${k} = ${v}`);
      continue;
    }
    const ratio = b ? v / b : 1;
    const gated = sameKind || k.startsWith('size.');
    const bad = gated && ratio > base.tolerance;
    if (bad) failed++;
    console.log(`  ${bad ? 'FAIL' : gated ? 'ok  ' : 'info'}  ${k.padEnd(42)} ${String(v).padStart(12)}  baseline ${String(b).padStart(12)}  x${ratio.toFixed(2)}  (cv ${res.noise[k]})`);
  }
  for (const [k, v] of Object.entries(res.info)) console.log(`  info  ${k.padEnd(42)} ${String(v).padStart(12)}`);
  if (failed) console.error(`bench --ci: ${failed} metric(s) regressed more than ${Math.round((base.tolerance - 1) * 100)}%`);
  return failed ? 1 : 0;
}
