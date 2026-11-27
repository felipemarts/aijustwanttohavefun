/**
 * Spectator scenario: WebSocket spectators (mostly `world`, some rooms, a few `village`) added in steps while a
 * crowd of agents acts at the target rate. Each step is measured on its own, so the report shows how cost grows
 * per connection (CPU, RSS, bytes out, flush time) as well as the totals at the highest count reached.
 *
 * `local` runs the server on this machine (macOS caps a process at 10,240 open files, so about 9,500 spectators);
 * `docker` runs the production image with a raised file limit and the load generators in containers next to it,
 * which reaches 20,000 on a laptop.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Content } from '@ajwf/content';
import { Crowd, registerCrowd } from '../lib/crowd';
import { cleanupDocker, imageExists, spawnDockerLoader, startDockerServer, stopDockerLoader, BENCH_IMAGE } from '../lib/docker';
import { log, type Target } from '../lib/report';
import { BENCH_ADMIN, histQuantiles, Sampler, startServer, val, type Prom, type RunningServer } from '../lib/server';
import { round } from '../lib/stats';
import { sleep } from './api';

const LOADER = join(dirname(fileURLToPath(import.meta.url)), '..', 'spectators', 'loader.ts');
const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export type SpectatorParams = {
  agents: number;
  rate: number;
  /** Highest spectator count; steps go up to it. */
  conns: number;
  /** Connections per load generator process. */
  perLoader: number;
  loaders: number;
  /** Measured seconds per step. */
  durationSec: number;
  mode: 'local' | 'docker';
  seed: number;
  port: number;
  nodeFlags?: string[];
};

export const SPECTATORS_FULL: Omit<SpectatorParams, 'port'> = { agents: 2000, rate: 200, conns: 20_000, perLoader: 2500, loaders: 8, durationSec: 45, mode: 'docker', seed: 21 };

type LoaderLine = { id: string; final: boolean; deflateOpen: number; deflateWireBytes: number; open: number; opened: number; failed: number; msgs: number; bytes: number; batches: number; fulls: number; errors: number; connectP50: number; connectP99: number; rssMb: number; closeCodes: Record<string, number> };

class Loader {
  last: LoaderLine | null = null;
  constructor(
    readonly id: string,
    readonly proc: ChildProcess,
    readonly docker: boolean,
  ) {
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      try {
        this.last = JSON.parse(line) as LoaderLine;
      } catch {
        // not a report
      }
    });
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (d: string) => {
      const t = d.trim();
      if (t) log(`loader ${id}: ${t.slice(0, 300)}`);
    });
  }

  async stop(): Promise<void> {
    if (this.docker) await stopDockerLoader(this.id, this.proc);
    else if (this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      await new Promise((r) => this.proc.once('exit', r));
    }
  }
}

function startLoader(p: SpectatorParams, server: RunningServer, id: string, conns: number, rooms: string): Loader {
  const seconds = String(24 * 3600);
  // Gentle enough for macOS's small accept backlog (kern.ipc.somaxconn 128).
  const openRate = '250';
  if (p.mode === 'docker') {
    return new Loader(id, spawnDockerLoader(LOADER, id, ['ws://ajwf-bench-server:8710/ws/spectate', String(conns), openRate, seconds, id, rooms]), true);
  }
  const ws = server.url.replace(/^http/, 'ws') + '/ws/spectate';
  const proc = spawn(process.execPath, ['--import', 'tsx', LOADER, ws, String(conns), openRate, seconds, id, rooms], { cwd: BENCH_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Loader(id, proc, false);
}

function loaderTotals(loaders: Loader[]) {
  const t = { deflateOpen: 0, deflateWireBytes: 0, open: 0, failed: 0, msgs: 0, bytes: 0, batches: 0, fulls: 0, errors: 0, connectP99: 0, rssMb: 0, closeCodes: {} as Record<string, number> };
  for (const l of loaders) {
    const x = l.last;
    if (!x) continue;
    t.open += x.open;
    t.deflateOpen += x.deflateOpen;
    t.deflateWireBytes += x.deflateWireBytes;
    t.failed += x.failed;
    t.msgs += x.msgs;
    t.bytes += x.bytes;
    t.batches += x.batches;
    t.fulls += x.fulls;
    t.errors += x.errors;
    t.connectP99 = Math.max(t.connectP99, x.connectP99);
    t.rssMb += x.rssMb;
    for (const [k, v] of Object.entries(x.closeCodes)) t.closeCodes[k] = (t.closeCodes[k] ?? 0) + v;
  }
  return t;
}

function stepWindow(m0: Prom, m1: Prom, seconds: number) {
  const d = (k: string) => val(m1, k) - val(m0, k);
  return {
    spectators: val(m1, 'ajwf_spectators_connected'),
    wireKBps: round(d('ajwf_ws_wire_bytes_total') / seconds / 1024, 1),
    payloadKBps: round(d('ajwf_ws_payload_bytes_total') / seconds / 1024, 1),
    batchesPerSec: round(d('ajwf_ws_batches_total') / seconds, 2),
    fullsPerSec: round(d('ajwf_ws_full_states_total') / seconds, 2),
    flush: histQuantiles(m0, m1, 'ajwf_ws_flush_seconds', [0.5, 0.99, 1]),
    backpressure: d('ajwf_ws_backpressure_total'),
    dropped: d('ajwf_ws_dropped_total'),
    rejected: d('ajwf_ws_rejected_total'),
    actPerSec: round(d('ajwf_actions_total') / seconds, 1),
    act: histQuantiles(m0, m1, 'ajwf_act_latency_seconds'),
    cpuPct: round((d('process_cpu_seconds_total') / seconds) * 100, 1),
    userCpuPct: round((d('process_cpu_user_seconds_total') / seconds) * 100, 1),
    systemCpuPct: round((d('process_cpu_system_seconds_total') / seconds) * 100, 1),
    /** Messages handed to sockets (one per subscriber per batch): what the per-connection cost scales with. */
    sendsPerSec: round(d('ajwf_ws_messages_total') / seconds, 0),
    userCpuUsPerSend: d('ajwf_ws_messages_total') ? round((d('process_cpu_user_seconds_total') * 1e6) / d('ajwf_ws_messages_total'), 2) : 0,
    rssMb: round(val(m1, 'process_resident_memory_bytes') / 2 ** 20, 1),
    heapMb: round(val(m1, 'nodejs_heap_used_bytes') / 2 ** 20, 1),
    externalMb: round(val(m1, 'nodejs_external_memory_bytes') / 2 ** 20, 1),
  };
}

/** Least-squares line through (x, y). */
function fit(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  const b = den ? num / den : 0;
  return { a: my - b * mx, b };
}

export async function runSpectators(content: Content, p: SpectatorParams) {
  if (p.mode === 'docker' && !imageExists()) throw new Error(`spectators (docker): image ${BENCH_IMAGE} not found; build it first: docker build -t ${BENCH_IMAGE} .`);
  const server = p.mode === 'docker' ? await startDockerServer(p.port) : await startServer({ port: p.port, ...(p.nodeFlags ? { nodeFlags: p.nodeFlags } : {}) });
  const loaders: Loader[] = [];
  let crowd: Crowd | null = null;
  try {
    log(`spectators (${p.mode}): server healthy after ${server.bootMs} ms`);
    const agents = await registerCrowd(server.url, BENCH_ADMIN, p.agents, p.seed);
    crowd = new Crowd(content, server.url, agents, p.seed);
    await crowd.warm();
    crowd.start(p.rate);
    log(`spectators: ${agents.length} agents acting at ${p.rate}/s; warming up 20 s`);
    await sleep(20_000);

    const rooms = [...content.rooms.keys()].join(',');
    const per = p.perLoader;
    const top = Math.min(p.conns, per * p.loaders);
    const steps = [0, ...[0.125, 0.25, 0.5, 0.75, 1].map((f) => Math.round((top * f) / per) * per)].filter((v, i, a) => a.indexOf(v) === i);
    const rows: (ReturnType<typeof stepWindow> & { target: number; client: ReturnType<typeof loaderTotals>; clientMsgsPerSec: number; clientKBps: number; compressedKBpsPerConn: number; loopLagP99MsMax: number; loopLagMaxMs: number })[] = [];
    let seq = 0;
    for (const target of steps) {
      while (loaders.length * per < target) loaders.push(startLoader(p, server, `l${seq++}`, per, rooms));
      // Wait for the connections to open (or stop growing).
      const t0 = Date.now();
      let prev = -1;
      for (;;) {
        await sleep(2000);
        const open = loaderTotals(loaders).open;
        if (open >= target * 0.995 || (open === prev && Date.now() - t0 > 20_000) || Date.now() - t0 > 180_000) break;
        prev = open;
      }
      await sleep(5000);
      const c0 = loaderTotals(loaders);
      const m0 = await server.metrics();
      const sampler = new Sampler(server, 5000);
      sampler.start();
      const w0 = Date.now();
      await sleep(p.durationSec * 1000);
      const m1 = await server.metrics();
      const seconds = (Date.now() - w0) / 1000;
      const g = sampler.stop();
      const c1 = loaderTotals(loaders);
      const row = {
        target,
        ...stepWindow(m0, m1, seconds),
        loopLagP99MsMax: g.loopLagP99MsMax,
        loopLagMaxMs: g.loopLagMaxMs,
        client: c1,
        clientMsgsPerSec: round((c1.msgs - c0.msgs) / seconds, 0),
        clientKBps: round((c1.bytes - c0.bytes) / seconds / 1024, 1),
        /** What one browser-like (compressing) connection downloads. */
        compressedKBpsPerConn: c1.deflateOpen ? round((c1.deflateWireBytes - c0.deflateWireBytes) / seconds / 1024 / c1.deflateOpen, 2) : 0,
      };
      rows.push(row);
      log(
        `spectators: ${row.spectators} open (target ${target}): out ${row.wireKBps} KB/s wire, ${row.batchesPerSec} batches/s, flush p99 ${row.flush.q.p99} ms, ` +
          `CPU ${row.cpuPct}% (user ${row.userCpuPct}%), RSS ${row.rssMb} MB, /act p99 ${row.act.q.p99} ms, backpressure ${row.backpressure}, ${row.compressedKBpsPerConn} KB/s per compressed connection`,
      );
      if (row.spectators < target * 0.9 && target > 0) {
        log(`spectators: only ${row.spectators} of ${target} connected; stopping the ramp here`);
        break;
      }
    }

    const xs = rows.map((r) => r.spectators);
    const rssFit = fit(xs, rows.map((r) => r.rssMb));
    const cpuFit = fit(xs, rows.map((r) => r.cpuPct));
    const userFit = fit(xs, rows.map((r) => r.userCpuPct));
    const sysFit = fit(xs, rows.map((r) => r.systemCpuPct));
    const wireFit = fit(xs, rows.map((r) => r.wireKBps));
    const reached = Math.max(...xs);
    const at20k = {
      rssMb: round(rssFit.a + rssFit.b * 20_000, 0),
      cpuPct: round(cpuFit.a + cpuFit.b * 20_000, 0),
      userCpuPct: round(userFit.a + userFit.b * 20_000, 0),
      systemCpuPct: round(sysFit.a + sysFit.b * 20_000, 0),
      wireKBps: round(wireFit.a + wireFit.b * 20_000, 0),
    };
    const last = rows.at(-1)!;
    const extrapolated = reached < 20_000;
    const targets: Target[] = [
      {
        name: 'spectators connected',
        target: '20,000',
        measured: `${reached}`,
        pass: reached >= 20_000 ? true : null,
        ...(extrapolated ? { note: `extrapolated to 20,000: RSS ≈ ${at20k.rssMb} MB, CPU ≈ ${at20k.cpuPct}% of one core` } : {}),
      },
      { name: `/act p99 with ${reached} spectators`, target: '< 30 ms', measured: `${last.act.q.p99} ms`, pass: last.act.q.p99! < 30 },
      {
        name: `process memory with ${reached} spectators`,
        target: '< 2 GB',
        measured: `${last.rssMb} MB RSS${extrapolated ? ` (≈ ${at20k.rssMb} MB at 20,000, extrapolated)` : ''}`,
        pass: (extrapolated ? at20k.rssMb : last.rssMb) < 2048,
      },
    ];
    return {
      params: p,
      metrics: {
        steps: rows,
        perConnection: {
          rssKb: round(rssFit.b * 1024, 1),
          cpuPctPer1k: round(cpuFit.b * 1000, 2),
          userCpuPctPer1k: round(userFit.b * 1000, 2),
          systemCpuPctPer1k: round(sysFit.b * 1000, 2),
          wireKBpsPer1k: round(wireFit.b * 1000, 1),
        },
        reached,
        extrapolatedTo20k: extrapolated ? at20k : null,
        agents: crowd.report(1),
      },
      targets,
      notes: [
        `${p.mode === 'docker' ? `Server: production image ${BENCH_IMAGE} in Docker Desktop's Linux VM (--ulimit nofile=65536); load generators in containers on the same network.` : 'Server and load generators on the host.'}`,
        'perConnection is the slope of a least-squares line through the steps.',
      ],
    };
  } finally {
    crowd?.stop();
    await Promise.all(loaders.map((l) => l.stop()));
    await server.stop();
    if (p.mode === 'docker') cleanupDocker();
  }
}
