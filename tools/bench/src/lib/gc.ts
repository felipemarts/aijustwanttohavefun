import { constants, PerformanceObserver } from 'node:perf_hooks';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { round, Samples, summarize } from './stats';

const KIND: Record<number, string> = {
  [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};

/** Pauses by kind, observed with `perf_hooks` (the same numbers `--trace-gc` prints, without parsing logs). */
export class GcWatch {
  private obs: PerformanceObserver;
  private pauses = new Map<string, Samples>();

  constructor() {
    this.obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const kind = KIND[(e as { detail?: { kind?: number } }).detail?.kind ?? -1] ?? 'other';
        let s = this.pauses.get(kind);
        if (!s) this.pauses.set(kind, (s = new Samples(1024)));
        s.push(e.duration);
      }
    });
    this.obs.observe({ entryTypes: ['gc'] });
  }

  /** Stops observing; the observer delivers entries asynchronously, so wait a turn first. */
  async stop(wallMs: number) {
    await new Promise((r) => setImmediate(r));
    this.obs.disconnect();
    const byKind: Record<string, { count: number; totalMs: number; p50Ms: number; p99Ms: number; maxMs: number }> = {};
    let total = 0;
    let max = 0;
    for (const [kind, s] of this.pauses) {
      const v = s.view();
      const sum = v.reduce((a, b) => a + b, 0);
      const st = summarize(v);
      byKind[kind] = { count: v.length, totalMs: round(sum, 1), p50Ms: st.p50, p99Ms: st.p99, maxMs: st.max };
      total += sum;
      max = Math.max(max, st.max);
    }
    return { totalMs: round(total, 1), maxPauseMs: round(max, 2), shareOfWall: round(total / Math.max(1, wallMs), 4), byKind };
  }
}

let gcFn: (() => void) | null = null;

/** A full collection (exposes `gc` at run time, so no `--expose-gc` flag is needed). */
export function fullGc(): void {
  if (!gcFn) {
    setFlagsFromString('--expose-gc');
    gcFn = runInNewContext('gc') as () => void;
  }
  gcFn();
  gcFn();
}

/** Heap in use after a full collection: what the scenario really keeps alive. */
export function liveHeap(): number {
  fullGc();
  return process.memoryUsage().heapUsed;
}
