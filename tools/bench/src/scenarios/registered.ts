/**
 * Registered scale: 20,000 agents in Postgres (rows and snapshots, written through the server's own store), then
 * the real server boots from them. Measures boot time and memory with the full population loaded, then drives
 * 2,000 of them at the target rate (the full §3.4 picture with the Postgres store), stops gracefully (final
 * snapshot) and boots a second time from what it saved.
 *
 * The active agents play a little in-process before being saved, so their snapshots carry a realistic state
 * (bonds, visited rooms, inventory) instead of the bare registration.
 */
import type { Content } from '@ajwf/content';
import { viewFromWorld } from '@ajwf/bots';
import { applyAction, exportAll } from '@ajwf/engine';
import { PgStore } from '@ajwf/server/src/store/pg';
import { createRng } from '@ajwf/shared';
import type { CrowdAgent } from '../lib/crowd';
import { log, type Target } from '../lib/report';
import { startServer, val } from '../lib/server';
import { round } from '../lib/stats';
import { dbSizeMb, wipeDatabase } from '../lib/db';
import { benchKey, populate, sha256, T0 } from '../lib/world';
import { driveCrowd, serverWindow } from './api';

export type RegisteredParams = {
  registered: number;
  active: number;
  rate: number;
  warmupSec: number;
  durationSec: number;
  /** In-process actions per active agent before saving. */
  playPerAgent: number;
  seed: number;
  port: number;
  databaseUrl: string;
};

export const REGISTERED_FULL: Omit<RegisteredParams, 'port' | 'databaseUrl'> = { registered: 20_000, active: 2000, rate: 200, warmupSec: 30, durationSec: 120, playPerAgent: 30, seed: 31 };

/** Writes `n` agents (rows with deterministic keys, and snapshots) plus the world through `PgStore`. */
export async function seedDatabase(content: Content, url: string, n: number, active: number, playPerAgent: number, seed: number): Promise<{ agents: CrowdAgent[]; seedSec: number }> {
  const t0 = Date.now();
  await wipeDatabase(url);
  const store = await PgStore.open(url);
  try {
    const w = populate(content, n, seed);
    // A little play for the agents that will be active, on a simulated clock.
    const rng = createRng(seed ^ 0xbeef);
    const ctx = { now: T0, rng };
    for (let turn = 0; turn < playPerAgent; turn++) {
      for (let i = 0; i < active; i++) {
        ctx.now += 5;
        const a = w.agents[i]!;
        const step = w.brains[i]!.decide(content, viewFromWorld(w.s, a.id, ctx), ctx.now);
        if (!('wait' in step)) applyAction(w.s, { agentId: a.id, action: step.action, params: step.params }, ctx);
      }
    }
    // Saved with the wall clock: the server's clock is real time, and play timestamps must not be in the future.
    const now = Date.now();
    let next = 0;
    const worker = async () => {
      while (next < w.agents.length) {
        const i = next++;
        const a = w.agents[i]!;
        await store.insertAgent(
          {
            id: a.id,
            name: a.name,
            nameNorm: a.norm,
            nameSkeleton: a.skeleton,
            cls: a.cls,
            language: a.lang,
            bio: a.bio,
            appearance: a.appearance,
            appearanceHash: a.lookHash,
            keyHash: sha256(benchKey(i)),
            claimTokenHash: sha256(`claim-${seed}-${i}`),
            isBot: true,
            claimedAt: now,
          },
          JSON.stringify(a),
          now,
        );
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    const all = exportAll(w.s);
    await store.saveSnapshot({ agents: [], world: all.world.filter((e) => e.data !== null && e.data !== undefined).map((e) => ({ key: e.key, json: JSON.stringify(e.data) })) }, now);
    return { agents: w.agents.slice(0, active).map((a, i) => ({ name: a.name, key: benchKey(i) })), seedSec: (Date.now() - t0) / 1000 };
  } finally {
    await store.close();
  }
}

export async function runRegistered(content: Content, p: RegisteredParams) {
  log(`registered: seeding ${p.registered} agents into Postgres (${p.active} of them played ${p.playPerAgent} actions each)`);
  const { agents, seedSec } = await seedDatabase(content, p.databaseUrl, p.registered, p.active, p.playPerAgent, p.seed);
  const dbMb = await dbSizeMb(p.databaseUrl);
  log(`registered: seeded in ${seedSec.toFixed(0)} s; database ${dbMb} MB`);

  const s1 = await startServer({ port: p.port, databaseUrl: p.databaseUrl });
  let boot1: Record<string, number>;
  let drive: Awaited<ReturnType<typeof driveCrowd>>;
  let stop1: Awaited<ReturnType<typeof s1.stop>>;
  try {
    // Let the boot settle (first snapshot, lazy caches) before reading the idle footprint.
    await new Promise((r) => setTimeout(r, 6000));
    const idle = await s1.metrics();
    boot1 = {
      bootMs: s1.bootMs,
      registered: val(idle, 'ajwf_agents_registered'),
      idleRssMb: round(val(idle, 'process_resident_memory_bytes') / 2 ** 20, 1),
      idleHeapMb: round(val(idle, 'nodejs_heap_used_bytes') / 2 ** 20, 1),
    };
    log(`registered: boot 1 in ${s1.bootMs} ms with ${boot1.registered} agents; idle RSS ${boot1.idleRssMb} MB`);
    drive = await driveCrowd(content, s1, agents, p);
  } finally {
    stop1 = await s1.stop();
  }
  const win = serverWindow(drive.m0, drive.m1, drive.seconds);
  log(`registered: ${win.actPerSec} act/s, /act p99 ${win.actLatency.q.p99} ms, RSS max ${drive.gauges.rssMbMax} MB; graceful stop in ${stop1.ms} ms (exit ${stop1.code})`);

  const s2 = await startServer({ port: p.port, databaseUrl: p.databaseUrl });
  let boot2: Record<string, number>;
  try {
    const m = await s2.metrics();
    boot2 = { bootMs: s2.bootMs, registered: val(m, 'ajwf_agents_registered'), rssMb: round(val(m, 'process_resident_memory_bytes') / 2 ** 20, 1) };
  } finally {
    await s2.stop();
  }
  log(`registered: boot 2 (after play and a graceful stop) in ${boot2.bootMs} ms with ${boot2.registered} agents`);

  const targets: Target[] = [
    { name: 'registered agents loaded at boot', target: `${p.registered}`, measured: `${boot1.registered} (boot ${round(boot1.bootMs! / 1000, 1)} s, idle RSS ${boot1.idleRssMb} MB)`, pass: boot1.registered === p.registered },
    { name: `/act p99 (server, postgres, ${p.registered} registered)`, target: '< 30 ms', measured: `${win.actLatency.q.p99} ms`, pass: win.actLatency.q.p99! < 30 },
    { name: `actions per second sustained (postgres, ${p.active} active)`, target: `${p.rate}`, measured: `${win.actPerSec}`, pass: win.actPerSec >= p.rate * 0.97 },
    { name: `process memory (postgres, ${p.registered} registered, ${p.active} active)`, target: '< 2 GB', measured: `${drive.gauges.rssMbMax} MB RSS`, pass: drive.gauges.rssMbMax < 2048 },
  ];
  return {
    params: p,
    metrics: { seedSec: round(seedSec, 1), databaseMb: dbMb, boot1, server: win, process: drive.gauges, client: drive.client, shutdown: stop1, boot2 },
    targets,
  };
}
