import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/** Sampling period of the event loop delay histogram; samples include it, so it is subtracted to get the lag. */
const LOOP_RESOLUTION_MS = 20;

/** Events per second over the last minute, from one counter per second (no timers). */
export class RateMeter {
  private slots = new Float64Array(60);
  private secs = new Float64Array(60);
  total = 0;

  add(now: number, n = 1): void {
    const sec = Math.floor(now / 1000);
    const i = sec % 60;
    if (this.secs[i] !== sec) {
      this.secs[i] = sec;
      this.slots[i] = 0;
    }
    this.slots[i]! += n;
    this.total += n;
  }

  /** Average per second over the last `window` complete seconds. */
  perSecond(now: number, window = 60): number {
    const cur = Math.floor(now / 1000);
    let sum = 0;
    for (let i = 0; i < 60; i++) {
      const age = cur - this.secs[i]!;
      if (age >= 1 && age <= window) sum += this.slots[i]!;
    }
    return sum / window;
  }
}

export class Histogram {
  readonly counts: number[];
  sum = 0;
  count = 0;

  constructor(readonly buckets: readonly number[]) {
    this.counts = buckets.map(() => 0);
  }

  observe(v: number): void {
    this.sum += v;
    this.count++;
    for (let i = 0; i < this.buckets.length; i++) if (v <= this.buckets[i]!) this.counts[i]!++;
  }
}

/** What the rest of the server reports at scrape time. */
export type MetricsSources = {
  now(): number;
  agentsRegistered(): number;
  agentsOnline(): number;
  agentsOnMap(): number;
  spectators(): number;
  wsWireBytes(): number;
  persistenceBuffered(): number;
};

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/**
 * Process metrics in the Prometheus text format (§15.3), hand-rolled: a handful of counters does not justify a
 * dependency. Counters are bumped by the hot paths; gauges are read from `MetricsSources` at scrape time.
 */
export class Metrics {
  readonly actions = new RateMeter();
  readonly actLatency = new Histogram([0.001, 0.0025, 0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.25, 0.5, 1]);
  readonly errors = new Map<string, number>();
  readonly batches = new RateMeter();
  wsPayloadBytes = 0;
  wsFulls = 0;
  wsBackpressure = 0;
  wsDropped = 0;
  wsRejected = 0;
  private loop: IntervalHistogram | null = null;

  constructor(private sources: MetricsSources | null = null) {}

  setSources(s: MetricsSources): void {
    this.sources = s;
  }

  error(code: string): void {
    this.errors.set(code, (this.errors.get(code) ?? 0) + 1);
  }

  /** Starts sampling the event loop delay (main process only; tests leave it off). */
  start(): void {
    if (this.loop) return;
    this.loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    this.loop.enable();
  }

  stop(): void {
    this.loop?.disable();
    this.loop = null;
  }

  render(): string {
    const src = this.sources;
    const now = src?.now() ?? Date.now();
    const out: string[] = [];
    const metric = (name: string, type: 'gauge' | 'counter' | 'histogram', help: string) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    const line = (name: string, v: number, labels = '') => out.push(`${name}${labels} ${Number.isFinite(v) ? v : 0}`);

    if (src) {
      metric('ajwf_agents_registered', 'gauge', 'Active (not retired or banned) agents.');
      line('ajwf_agents_registered', src.agentsRegistered());
      metric('ajwf_agents_online', 'gauge', 'Agents that called the API in the last 15 minutes.');
      line('ajwf_agents_online', src.agentsOnline());
      metric('ajwf_agents_on_map', 'gauge', 'Agents shown to spectators (recently active).');
      line('ajwf_agents_on_map', src.agentsOnMap());
      metric('ajwf_spectators_connected', 'gauge', 'Open spectator WebSocket connections.');
      line('ajwf_spectators_connected', src.spectators());
      metric('ajwf_ws_wire_bytes_total', 'counter', 'Bytes written to spectator sockets (after compression and framing).');
      line('ajwf_ws_wire_bytes_total', src.wsWireBytes());
      metric('ajwf_persistence_buffered_events', 'gauge', 'Events waiting to be written to the store.');
      line('ajwf_persistence_buffered_events', src.persistenceBuffered());
    }
    metric('ajwf_actions_total', 'counter', 'POST /act requests handled.');
    line('ajwf_actions_total', this.actions.total);
    metric('ajwf_actions_per_second', 'gauge', 'POST /act requests per second, averaged over the last minute.');
    line('ajwf_actions_per_second', round(this.actions.perSecond(now)));

    metric('ajwf_act_latency_seconds', 'histogram', 'Server-side latency of POST /act.');
    this.actLatency.buckets.forEach((b, i) => line('ajwf_act_latency_seconds_bucket', this.actLatency.counts[i]!, `{le="${b}"}`));
    line('ajwf_act_latency_seconds_bucket', this.actLatency.count, '{le="+Inf"}');
    line('ajwf_act_latency_seconds_sum', round(this.actLatency.sum, 6));
    line('ajwf_act_latency_seconds_count', this.actLatency.count);

    metric('ajwf_errors_total', 'counter', 'Error responses by API error code.');
    for (const [code, n] of [...this.errors].sort()) line('ajwf_errors_total', n, `{code="${esc(code)}"}`);

    metric('ajwf_ws_payload_bytes_total', 'counter', 'Spectator message bytes handed to sockets (before compression).');
    line('ajwf_ws_payload_bytes_total', this.wsPayloadBytes);
    metric('ajwf_ws_batches_total', 'counter', 'Topic batches built and sent (one serialization each).');
    line('ajwf_ws_batches_total', this.batches.total);
    metric('ajwf_ws_batches_per_second', 'gauge', 'Topic batches per second, averaged over the last minute.');
    line('ajwf_ws_batches_per_second', round(this.batches.perSecond(now)));
    metric('ajwf_ws_full_states_total', 'counter', 'Full states sent (subscriptions and backpressure recoveries).');
    line('ajwf_ws_full_states_total', this.wsFulls);
    metric('ajwf_ws_backpressure_total', 'counter', 'Times a slow spectator was paused above the 1 MB high-water mark.');
    line('ajwf_ws_backpressure_total', this.wsBackpressure);
    metric('ajwf_ws_dropped_total', 'counter', 'Spectator connections dropped for staying stuck or missing a pong.');
    line('ajwf_ws_dropped_total', this.wsDropped);
    metric('ajwf_ws_rejected_total', 'counter', 'Spectator connections refused by the connection limits.');
    line('ajwf_ws_rejected_total', this.wsRejected);

    metric('ajwf_event_loop_lag_seconds', 'gauge', 'Event loop delay since the last scrape (mean, p99, max).');
    const h = this.loop;
    const ns = (v: number) => round(h && h.count > 0 ? Math.max(0, v / 1e9 - LOOP_RESOLUTION_MS / 1000) : 0, 6);
    line('ajwf_event_loop_lag_seconds', ns(h?.mean ?? 0), '{stat="mean"}');
    line('ajwf_event_loop_lag_seconds', ns(h?.percentile(99) ?? 0), '{stat="p99"}');
    line('ajwf_event_loop_lag_seconds', ns(h?.max ?? 0), '{stat="max"}');
    h?.reset();

    const mem = process.memoryUsage();
    metric('process_resident_memory_bytes', 'gauge', 'Resident set size.');
    line('process_resident_memory_bytes', mem.rss);
    metric('nodejs_heap_used_bytes', 'gauge', 'V8 heap in use.');
    line('nodejs_heap_used_bytes', mem.heapUsed);
    metric('nodejs_heap_total_bytes', 'gauge', 'V8 heap reserved.');
    line('nodejs_heap_total_bytes', mem.heapTotal);
    metric('nodejs_external_memory_bytes', 'gauge', 'Memory held by buffers and other C++ objects.');
    line('nodejs_external_memory_bytes', mem.external);
    const cpu = process.cpuUsage();
    metric('process_cpu_seconds_total', 'counter', 'User and system CPU time.');
    line('process_cpu_seconds_total', round((cpu.user + cpu.system) / 1e6, 3));
    return out.join('\n') + '\n';
  }
}

function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
