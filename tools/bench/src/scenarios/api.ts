/**
 * API scenario: the real server process (in-memory store, or Postgres), driven over HTTP by a crowd of simulated
 * agents at a sustained action rate. Server-side `/act` latency comes from the server's own `/metrics` histogram
 * (deltas over the measured window); event loop lag, RSS and CPU are sampled from `/metrics` every 5 s.
 */
import type { Content } from '@ajwf/content';
import { Crowd, registerCrowd, type CrowdAgent } from '../lib/crowd';
import { log, type Target } from '../lib/report';
import { BENCH_ADMIN, histQuantiles, labelled, Sampler, startServer, val, type Prom, type RunningServer } from '../lib/server';
import { round } from '../lib/stats';
import { wipeDatabase } from '../lib/db';

export type ApiParams = {
  agents: number;
  rate: number;
  warmupSec: number;
  durationSec: number;
  seed: number;
  port: number;
  databaseUrl?: string;
  nodeFlags?: string[];
};

export const API_FULL: Omit<ApiParams, 'port'> = { agents: 2000, rate: 200, warmupSec: 30, durationSec: 180, seed: 11 };

/** Drives an already running server with known agents; returns the measured window. */
export async function driveCrowd(content: Content, server: RunningServer, agents: CrowdAgent[], p: Pick<ApiParams, 'rate' | 'warmupSec' | 'durationSec' | 'seed'>) {
  const crowd = new Crowd(content, server.url, agents, p.seed);
  const tWarm = Date.now();
  await crowd.warm();
  log(`api: ${agents.length} agents read their state in ${((Date.now() - tWarm) / 1000).toFixed(1)} s; warming up ${p.warmupSec} s at ${p.rate} actions/s`);
  crowd.start(p.rate);
  await sleep(p.warmupSec * 1000);
  crowd.measuring = true;
  const m0 = await server.metrics();
  const sampler = new Sampler(server);
  sampler.start();
  const t0 = Date.now();
  await sleep(p.durationSec * 1000);
  const m1 = await server.metrics();
  const seconds = (Date.now() - t0) / 1000;
  crowd.measuring = false;
  crowd.stop();
  const gauges = sampler.stop();
  await crowd.drain();
  return { seconds, m0, m1, gauges, client: crowd.report(seconds) };
}

/** Server-side numbers between two scrapes. */
export function serverWindow(m0: Prom, m1: Prom, seconds: number) {
  const d = (k: string) => val(m1, k) - val(m0, k);
  const errors0 = labelled(m0, 'ajwf_errors_total');
  const errors: Record<string, number> = {};
  for (const [code, n] of Object.entries(labelled(m1, 'ajwf_errors_total'))) if (n - (errors0[code] ?? 0) > 0) errors[code] = n - (errors0[code] ?? 0);
  return {
    actPerSec: round(d('ajwf_actions_total') / seconds, 1),
    actLatency: histQuantiles(m0, m1, 'ajwf_act_latency_seconds'),
    tick: histQuantiles(m0, m1, 'ajwf_tick_seconds', [0.5, 0.99]),
    snapshotSerialize: histQuantiles(m0, m1, 'ajwf_snapshot_serialize_seconds', [0.5, 0.99, 1]),
    snapshotWrite: histQuantiles(m0, m1, 'ajwf_snapshot_write_seconds', [0.5, 0.99]),
    snapshots: d('ajwf_snapshots_total'),
    snapshotFailures: d('ajwf_snapshot_failures_total'),
    lastSnapshotRows: val(m1, 'ajwf_snapshot_last_rows'),
    eventsWrittenPerSec: round(d('ajwf_events_written_total') / seconds, 1),
    eventWriteFailures: d('ajwf_event_write_failures_total'),
    eventsBufferedAtEnd: val(m1, 'ajwf_persistence_buffered_events'),
    errorsByCode: errors,
    gcMs: round(
      ['minor', 'major', 'incremental', 'weakcb'].reduce((a, k) => a + (val(m1, `nodejs_gc_pause_seconds_sum{kind="${k}"}`) - val(m0, `nodejs_gc_pause_seconds_sum{kind="${k}"}`)), 0) * 1000,
      1,
    ),
    cpuMsPerAction: round((d('process_cpu_seconds_total') / Math.max(1, d('ajwf_actions_total'))) * 1000, 3),
  };
}

export async function runApi(content: Content, p: ApiParams) {
  const store = p.databaseUrl ? 'postgres' : 'memory';
  // Each run starts from an empty database (the bench says so: never point it at real data).
  if (p.databaseUrl) await wipeDatabase(p.databaseUrl);
  const server = await startServer({ port: p.port, ...(p.databaseUrl ? { databaseUrl: p.databaseUrl } : {}), ...(p.nodeFlags ? { nodeFlags: p.nodeFlags } : {}) });
  log(`api (${store}): server healthy after ${server.bootMs} ms`);
  try {
    const tReg = Date.now();
    const agents = await registerCrowd(server.url, BENCH_ADMIN, p.agents, p.seed);
    const registerSec = (Date.now() - tReg) / 1000;
    log(`api (${store}): ${agents.length} agents registered in ${registerSec.toFixed(1)} s`);
    const w = await driveCrowd(content, server, agents, p);
    const s = serverWindow(w.m0, w.m1, w.seconds);
    const stopped = await server.stop();
    log(`api (${store}): ${s.actPerSec} act/s, /act p50 ${s.actLatency.q.p50} ms p99 ${s.actLatency.q.p99} ms p99.9 ${s.actLatency.q.p999} ms, RSS max ${w.gauges.rssMbMax} MB`);
    const targets: Target[] = [
      { name: `/act p99 (server, ${store})`, target: '< 30 ms', measured: `${s.actLatency.q.p99} ms`, pass: s.actLatency.q.p99! < 30 },
      { name: `actions per second sustained (${store})`, target: `${p.rate}`, measured: `${s.actPerSec}`, pass: s.actPerSec >= p.rate * 0.97 },
      { name: `process memory (${store})`, target: '< 2 GB', measured: `${w.gauges.rssMbMax} MB RSS`, pass: w.gauges.rssMbMax < 2048 },
    ];
    return {
      params: { ...p, store },
      metrics: {
        bootMs: server.bootMs,
        registered: agents.length,
        registerPerSec: round(agents.length / registerSec, 1),
        measuredSec: round(w.seconds, 1),
        server: s,
        process: w.gauges,
        client: w.client,
        shutdown: stopped,
      },
      targets,
    };
  } finally {
    await server.stop();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
