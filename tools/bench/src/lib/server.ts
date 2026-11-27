/**
 * The real server as a child process (`node --import tsx apps/server/src/main.ts`, as `pnpm start` runs it), and
 * its `/metrics` read back: everything server-side in the reports comes from there, so the numbers are the ones
 * production monitoring would show.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './report';
import { round } from './stats';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const SERVER_DIR = join(REPO, 'apps', 'server');
export const BENCH_ADMIN = 'bench-admin-token-0123456789';

export type ServerOptions = {
  port: number;
  databaseUrl?: string;
  /** Extra Node flags, e.g. `--cpu-prof`. */
  nodeFlags?: string[];
  env?: Record<string, string>;
  /** Echo the server's stderr (warnings and errors) into the bench output. */
  quiet?: boolean;
};

export type RunningServer = {
  url: string;
  proc: ChildProcess;
  /** Spawn to first successful `/healthz`, in ms. */
  bootMs: number;
  metrics(): Promise<Prom>;
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>;
};

/** Servers this process started: killed if the bench exits without stopping them (Ctrl+C, a crash). */
const children = new Set<ChildProcess>();
let hooked = false;
function track(proc: ChildProcess): void {
  children.add(proc);
  proc.once('exit', () => children.delete(proc));
  if (hooked) return;
  hooked = true;
  process.once('exit', () => {
    for (const c of children) c.kill('SIGKILL');
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      for (const c of children) c.kill('SIGKILL');
      process.exit(130);
    });
  }
}

export async function startServer(o: ServerOptions): Promise<RunningServer> {
  const url = `http://127.0.0.1:${o.port}`;
  const busy = await fetch(`${url}/healthz`).then(
    () => true,
    () => false,
  );
  if (busy) throw new Error(`port ${o.port} is already in use (a server left over from an interrupted run?); use --port`);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'development',
    PORT: String(o.port),
    PUBLIC_URL: url,
    ADMIN_TOKEN: BENCH_ADMIN,
    LOG_LEVEL: 'warn',
    WORLD_SEED: '12345',
    DEV_LOGIN: '0',
    WS_MAX_CONNECTIONS: '50000',
    WS_MAX_PER_IP: '50000',
    ...(o.databaseUrl ? { DATABASE_URL: o.databaseUrl } : {}),
    ...o.env,
  };
  const t0 = Date.now();
  const proc = spawn(process.execPath, [...(o.nodeFlags ?? []), '--import', 'tsx', 'src/main.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'ignore', 'pipe'] });
  track(proc);
  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (chunk: string) => {
    if (!o.quiet) for (const line of chunk.split('\n')) if (line.trim()) log(`server: ${line.slice(0, 400)}`);
  });
  let exited = false;
  proc.once('exit', () => (exited = true));
  for (;;) {
    if (exited) throw new Error(`server exited during boot (code ${proc.exitCode})`);
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() - t0 > 180_000) throw new Error('server did not become healthy within 180 s');
    await new Promise((r) => setTimeout(r, 50));
  }
  const bootMs = Date.now() - t0;
  return {
    url,
    proc,
    bootMs,
    async metrics() {
      const res = await fetch(`${url}/metrics`, { headers: { authorization: `Bearer ${BENCH_ADMIN}` } });
      return parseProm(await res.text());
    },
    async stop() {
      const s0 = Date.now();
      if (exited) return { code: proc.exitCode, signal: proc.signalCode, ms: 0 };
      const done = once(proc, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
      proc.kill('SIGTERM');
      const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
      const [code, signal] = await done;
      clearTimeout(timer);
      return { code, signal, ms: Date.now() - s0 };
    },
  };
}

/** Samples of the Prometheus text format: `name{labels}` -> value. */
export type Prom = Map<string, number>;

export function parseProm(text: string): Prom {
  const m: Prom = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    m.set(line.slice(0, i), Number(line.slice(i + 1)));
  }
  return m;
}

export const val = (p: Prom, key: string) => p.get(key) ?? 0;

/** Labelled samples of one metric: `{code="X"}` -> value. */
export function labelled(p: Prom, name: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of p) {
    if (!k.startsWith(`${name}{`)) continue;
    const m = /="([^"]*)"/.exec(k);
    if (m) out[m[1]!] = v;
  }
  return out;
}

/**
 * Quantiles of a Prometheus histogram between two scrapes, interpolated linearly inside the bucket (what
 * `histogram_quantile` does). Values in ms. Quantiles that land in `+Inf` report the last finite bound.
 */
export function histQuantiles(before: Prom, after: Prom, name: string, qs = [0.5, 0.99, 0.999]): { count: number; meanMs: number; q: Record<string, number> } {
  const bounds: { le: number; n: number }[] = [];
  for (const [k, v] of after) {
    const m = new RegExp(`^${name}_bucket\\{le="([^"]+)"\\}$`).exec(k);
    if (!m) continue;
    const le = m[1] === '+Inf' ? Infinity : Number(m[1]);
    bounds.push({ le, n: v - (before.get(k) ?? 0) });
  }
  bounds.sort((a, b) => a.le - b.le);
  const total = bounds.at(-1)?.n ?? 0;
  const sum = val(after, `${name}_sum`) - val(before, `${name}_sum`);
  const q: Record<string, number> = {};
  for (const quant of qs) {
    const rank = quant * total;
    let prevLe = 0;
    let prevN = 0;
    let out = 0;
    for (const b of bounds) {
      if (b.n >= rank) {
        if (b.le === Infinity) out = prevLe;
        else out = prevLe + ((b.le - prevLe) * (rank - prevN)) / Math.max(1e-9, b.n - prevN);
        break;
      }
      prevLe = b.le;
      prevN = b.n;
    }
    q[`p${String(quant * 100).replace('.', '')}`] = round(out * 1000, 2);
  }
  return { count: total, meanMs: round(total ? (sum / total) * 1000 : 0, 3), q };
}

/** Samples the server's gauges every few seconds while a phase runs: RSS, heap, CPU and event loop lag. */
export class Sampler {
  readonly rows: { t: number; rssMb: number; heapMb: number; cpuPct: number; lagP99Ms: number; lagMaxMs: number; spectators: number }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private last: { t: number; cpu: number } | null = null;

  constructor(
    private server: RunningServer,
    private everyMs = 5000,
  ) {}

  start(): void {
    const take = async () => {
      try {
        const p = await this.server.metrics();
        const t = Date.now();
        const cpu = val(p, 'process_cpu_seconds_total');
        const prev = this.last;
        this.last = { t, cpu };
        if (!prev) return;
        this.rows.push({
          t,
          rssMb: round(val(p, 'process_resident_memory_bytes') / 2 ** 20, 1),
          heapMb: round(val(p, 'nodejs_heap_used_bytes') / 2 ** 20, 1),
          cpuPct: round(((cpu - prev.cpu) / ((t - prev.t) / 1000)) * 100, 1),
          lagP99Ms: round(val(p, 'ajwf_event_loop_lag_seconds{stat="p99"}') * 1000, 2),
          lagMaxMs: round(val(p, 'ajwf_event_loop_lag_seconds{stat="max"}') * 1000, 2),
          spectators: val(p, 'ajwf_spectators_connected'),
        });
      } catch {
        // a missed sample is fine
      }
    };
    void take();
    this.timer = setInterval(() => void take(), this.everyMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const r = this.rows;
    const max = (f: (x: (typeof r)[number]) => number) => (r.length ? Math.max(...r.map(f)) : 0);
    const mean = (f: (x: (typeof r)[number]) => number) => (r.length ? round(r.reduce((a, x) => a + f(x), 0) / r.length, 1) : 0);
    return {
      samples: r.length,
      rssMbMax: max((x) => x.rssMb),
      rssMbLast: r.at(-1)?.rssMb ?? 0,
      heapMbMax: max((x) => x.heapMb),
      cpuPctMean: mean((x) => x.cpuPct),
      cpuPctMax: max((x) => x.cpuPct),
      loopLagP99MsMean: mean((x) => x.lagP99Ms),
      loopLagP99MsMax: max((x) => x.lagP99Ms),
      loopLagMaxMs: max((x) => x.lagMaxMs),
    };
  }
}
