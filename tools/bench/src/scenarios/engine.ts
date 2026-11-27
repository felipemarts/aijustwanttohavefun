/**
 * Engine scenario: the game rules alone, in-process, no HTTP and no store.
 *
 * - `applyAction` throughput and latency for a crowd of agents with a realistic mix (fight, gather, move, chat,
 *   trade), on a simulated clock paced at the target action rate so AP, cooldowns and respawns behave as live.
 * - `tick` with the timers that play produces, then with a heap of many timers (cost per due timer, idle tick).
 * - Snapshot export of the dirty entities every 5 simulated seconds, serialized the way the server does.
 * - Heap growth (live heap after full collections) and GC pauses over the run.
 */
import { hrtime } from 'node:process';
import type { Content } from '@ajwf/content';
import { viewFromWorld } from '@ajwf/bots';
import { applyAction, exportDirty, tick, type WorldState } from '@ajwf/engine';
import { createRng } from '@ajwf/shared';
import { Mix } from '../lib/brain';
import { GcWatch, liveHeap } from '../lib/gc';
import { log } from '../lib/report';
import { mb, round, Samples, summarize } from '../lib/stats';
import { populate, T0 } from '../lib/world';

export type EngineParams = { agents: number; actions: number; rate: number; seed: number; heapTimers: number[]; snapshotEveryMs?: number };

export const ENGINE_FULL: EngineParams = { agents: 2000, actions: 200_000, rate: 200, seed: 7, heapTimers: [10_000, 100_000] };

const ns = () => hrtime.bigint();
const usSince = (t0: bigint) => Number(ns() - t0) / 1000;

/** Min-heap of agent indexes by the simulated time they are ready to act again. */
class ReadyQueue {
  private at: number[] = [];
  private idx: number[] = [];

  push(i: number, t: number): void {
    const { at, idx } = this;
    at.push(t);
    idx.push(i);
    let k = at.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (at[p]! <= at[k]!) break;
      [at[p], at[k]] = [at[k]!, at[p]!];
      [idx[p], idx[k]] = [idx[k]!, idx[p]!];
      k = p;
    }
  }

  peekAt(): number {
    return this.at[0] ?? Infinity;
  }

  pop(): number {
    const { at, idx } = this;
    const top = idx[0]!;
    const lastAt = at.pop()!;
    const lastIdx = idx.pop()!;
    if (at.length) {
      at[0] = lastAt;
      idx[0] = lastIdx;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < at.length && at[l]! < at[m]!) m = l;
        if (r < at.length && at[r]! < at[m]!) m = r;
        if (m === k) break;
        [at[m], at[k]] = [at[k]!, at[m]!];
        [idx[m], idx[k]] = [idx[k]!, idx[m]!];
        k = m;
      }
    }
    return top;
  }
}

/** Serializes the dirty entities exactly like the server's Persistence (one JSON string per entity). */
function exportAndSerialize(s: WorldState): { agents: number; world: number; bytes: number } {
  const dirty = exportDirty(s);
  let bytes = 0;
  for (const a of dirty.agents) bytes += JSON.stringify(a).length;
  for (const w of dirty.world) bytes += JSON.stringify(w.data).length;
  return { agents: dirty.agents.length, world: dirty.world.length, bytes };
}

export async function runEngine(content: Content, p: EngineParams) {
  const heap0 = liveHeap();
  const tReg = ns();
  const w = populate(content, p.agents, p.seed);
  const registerMs = usSince(tReg) / 1000;
  const heapAgents = liveHeap();
  const { s, agents, brains } = w;
  const byName = new Map(brains.map((b, i) => [b.name, i]));
  log(`engine: ${p.agents} agents registered in ${registerMs.toFixed(0)} ms; live heap ${mb(heapAgents - heap0)} MB for them`);

  const rng = createRng(p.seed ^ 0x5eed);
  const ctx = { now: T0, rng };
  const queue = new ReadyQueue();
  for (let i = 0; i < agents.length; i++) queue.push(i, T0 + rng.int(0, 10_000));

  const slotMs = 1000 / p.rate;
  const warmup = Math.min(40_000, Math.floor(p.actions / 5));
  const act = new Samples(p.actions);
  const obs = new Samples(p.actions);
  const ticks = new Samples(4096);
  const snaps = new Samples(1024);
  const snapRows = { agents: 0, world: 0, bytes: 0, count: 0, timersBytes: 0 };
  const mix = new Mix();
  let events = 0;
  let idleSlots = 0;
  let nextTick = T0 + 1000;
  const snapEvery = p.snapshotEveryMs ?? 5000;
  let nextSnap = T0 + snapEvery;
  let decideUs = 0;
  let loops = 0;
  const perAction = new Map<string, Samples>();

  let gc: GcWatch | null = null;
  let heapRun0 = 0;
  let wall0 = 0n;
  for (let n = 0; n < p.actions + warmup; ) {
    // Yield now and then: GC observations (and anything else asynchronous) are delivered between turns.
    if (++loops % 2000 === 0) await new Promise((r) => setImmediate(r));
    if (n === warmup && !gc) {
      heapRun0 = liveHeap();
      gc = new GcWatch();
      wall0 = ns();
    }
    const measured = n >= warmup;
    ctx.now += slotMs;
    while (ctx.now >= nextTick) {
      const t0 = ns();
      tick(s, { now: nextTick, rng });
      if (measured) ticks.push(usSince(t0));
      nextTick += 1000;
    }
    if (ctx.now >= nextSnap) {
      const t0 = ns();
      const timersDirty = s.dirty.has('timers');
      const r = exportAndSerialize(s);
      if (measured) {
        snaps.push(usSince(t0));
        snapRows.agents += r.agents;
        snapRows.world += r.world;
        snapRows.bytes += r.bytes;
        snapRows.count++;
        if (timersDirty) snapRows.timersBytes += JSON.stringify(s.timers.toJSON()).length;
      }
      nextSnap += snapEvery;
    }
    if (queue.peekAt() > ctx.now) {
      idleSlots++;
      continue;
    }
    const i = queue.pop();
    const a = agents[i]!;
    const brain = brains[i]!;
    const td = ns();
    const t0o = ns();
    const view = viewFromWorld(s, a.id, ctx);
    if (measured) obs.push(usSince(t0o));
    const step = brain.decide(content, view, ctx.now);
    decideUs += usSince(td);
    if ('wait' in step) {
      queue.push(i, ctx.now + Math.min(step.wait, 60_000) * rng.range(0.8, 1.2));
      continue;
    }
    const t0 = ns();
    const out = applyAction(s, { agentId: a.id, action: step.action, params: step.params }, ctx);
    const us = usSince(t0);
    n++;
    if (measured) {
      act.push(us);
      let pa = perAction.get(step.action);
      if (!pa) perAction.set(step.action, (pa = new Samples(1024)));
      pa.push(us);
      events += out.events.length;
      mix.add(step.action, out.result.ok ? null : out.result.error.code);
    }
    if (out.result.ok && step.action === 'trade_offer') {
      const trade = out.result.data?.trade;
      const to = byName.get(String(step.params.to));
      if (typeof trade === 'string' && to !== undefined) brains[to]!.offers.push(trade);
    }
    // Next turn in 2 to 8 simulated seconds: more agents are ready than the rate needs, as with a live crowd.
    queue.push(i, ctx.now + rng.range(2000, 8000));
  }
  const wallMs = Number(ns() - wall0) / 1e6;
  const gcStats = await gc!.stop(wallMs);
  const heapEnd = liveHeap();

  const actStats = summarize(act.view());
  const actTotalMs = act.view().reduce((x, y) => x + y, 0) / 1000;
  const simSeconds = (ctx.now - T0) / 1000;
  log(
    `engine: ${p.actions} actions, applyAction p50 ${actStats.p50} µs p99 ${actStats.p99} µs p99.9 ${actStats.p999} µs; ` +
      `${Math.round(p.actions / (actTotalMs / 1000))} ops/s engine-only; ${simSeconds.toFixed(0)} simulated s`,
  );

  const timersAfterRun = s.timers.size;
  const sizes = agentSizes(s);
  const timers = manyTimers(s, ctx.now, p.heapTimers);

  return {
    params: p,
    metrics: {
      registerMs: round(registerMs, 0),
      liveHeapPerAgentKb: round((heapAgents - heap0) / p.agents / 1024, 2),
      applyActionUs: actStats,
      opsPerSecEngineOnly: Math.round(p.actions / (actTotalMs / 1000)),
      opsPerSecWithPolicy: Math.round(p.actions / (wallMs / 1000)),
      observeUs: summarize(obs.view()),
      decideUsPerAction: round(decideUs / (p.actions + warmup), 2),
      eventsPerAction: round(events / p.actions, 3),
      simulatedSeconds: round(simSeconds, 0),
      idleSlots,
      mix: mix.shares(),
      applyActionUsByAction: Object.fromEntries(
        [...perAction].sort((x, y) => y[1].length - x[1].length).map(([k, v]) => {
          const st = summarize(v.view(), 1);
          return [k, { n: st.n, mean: st.mean, p99: st.p99, max: st.max }];
        }),
      ),
      agentSnapshotBytes: sizes,
      okShare: round(mix.ok / Math.max(1, mix.total), 3),
      refusals: mix.refused,
      tickUs: summarize(ticks.view()),
      snapshot: {
        everyMs: snapEvery,
        us: summarize(snaps.view()),
        agentsPerSnapshot: round(snapRows.agents / Math.max(1, snapRows.count), 1),
        worldKeysPerSnapshot: round(snapRows.world / Math.max(1, snapRows.count), 1),
        kbPerSnapshot: round(snapRows.bytes / Math.max(1, snapRows.count) / 1024, 1),
        timersKbPerSnapshot: round(snapRows.timersBytes / Math.max(1, snapRows.count) / 1024, 1),
        usPerDirtyEntity: round(snaps.view().reduce((x, y) => x + y, 0) / Math.max(1, snapRows.agents + snapRows.world), 2),
      },
      timersInHeapAfterRun: timersAfterRun,
      manyTimers: timers,
      heap: { beforeRunMb: mb(heapRun0), afterRunMb: mb(heapEnd), growthMb: mb(heapEnd - heapRun0), growthKbPer1kActions: round((heapEnd - heapRun0) / 1024 / (p.actions / 1000), 1) },
      gc: gcStats,
    },
  };
}

/** Size of one agent's snapshot JSON, and which fields weigh the most across all agents. */
function agentSizes(s: WorldState) {
  const per: number[] = [];
  const byKey = new Map<string, number>();
  let total = 0;
  for (const a of s.agents.values()) {
    const n = JSON.stringify(a).length;
    per.push(n);
    total += n;
    for (const [k, v] of Object.entries(a)) byKey.set(k, (byKey.get(k) ?? 0) + (JSON.stringify(v)?.length ?? 0));
  }
  const top = [...byKey].sort((x, y) => y[1] - x[1]).slice(0, 6);
  return { ...summarize(per, 0), heaviestFields: Object.fromEntries(top.map(([k, n]) => [k, round(n / Math.max(1, total), 3)])) };
}

/**
 * `tick` against a heap of many timers: the idle tick (nothing due) and the cost per due timer, plus what one
 * snapshot of the `timers` key costs at that size (the whole heap is serialized whenever any timer fired).
 */
function manyTimers(s: WorldState, now: number, sizes: number[]) {
  const out: Record<string, unknown>[] = [];
  const rng = createRng(99);
  for (const size of sizes) {
    while (s.timers.size < size) s.timers.push({ at: now + 1000 + rng.int(0, 3_600_000), kind: 'trade', id: `bench${s.timers.size}` });
    const heapSize = s.timers.size;
    let t0 = ns();
    for (let i = 0; i < 1000; i++) tick(s, { now, rng });
    const idleUs = usSince(t0) / 1000;
    // Ten simulated minutes in 1 s ticks: about size / 6 timers come due.
    let due = 0;
    let busyUs = 0;
    for (let k = 1; k <= 600; k++) {
      const before = s.timers.size;
      t0 = ns();
      tick(s, { now: now + k * 1000, rng });
      busyUs += usSince(t0);
      due += before - s.timers.size;
    }
    t0 = ns();
    const json = JSON.stringify(s.timers.toJSON());
    const serializeMs = usSince(t0) / 1000;
    out.push({
      heapSize,
      idleTickUs: round(idleUs, 3),
      dueTimers: due,
      usPerDueTimer: round(busyUs / Math.max(1, due), 3),
      timersKeySnapshotKb: round(json.length / 1024, 0),
      timersKeySerializeMs: round(serializeMs, 2),
    });
    now += 600_000;
  }
  return out;
}
