import { constants, monitorEventLoopDelay, PerformanceObserver, type IntervalHistogram } from 'node:perf_hooks';

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

/** Buckets (seconds) for work done on the event loop: fine below the 30 ms `/act` target, coarse above it. */
export const LOOP_WORK_BUCKETS = [0.0005, 0.001, 0.002, 0.003, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.05, 0.1, 0.25, 0.5, 1] as const;

/** What the persistence loop reports (counters since boot; see `Persistence`). */
export type PersistenceStats = {
  snapshots: number;
  snapshotFailures: number;
  /** Epoch ms of the last snapshot stored (0 before the first). */
  lastSnapshotAt: number;
  /** Entities written by the last snapshot. */
  lastSnapshotRows: number;
  /** Main-thread time spent collecting and serializing dirty entities (blocks the game while it runs). */
  serialize: Histogram;
  /** Database time of a snapshot transaction (off the main thread). */
  write: Histogram;
  eventsWritten: number;
  eventWriteFailures: number;
  eventsDropped: number;
};

const GC_KINDS: Record<number, string> = {
  [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};

/** What the rest of the server reports at scrape time. */
export type MetricsSources = {
  now(): number;
  agentsRegistered(): number;
  agentsOnline(): number;
  agentsOnMap(): number;
  spectators(): number;
  wsWireBytes(): number;
  persistenceBuffered(): number;
  persistence?(): PersistenceStats;
};

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/**
 * Process metrics in the Prometheus text format (§15.3), hand-rolled: a handful of counters does not justify a
 * dependency. Counters are bumped by the hot paths; gauges are read from `MetricsSources` at scrape time.
 */
export class Metrics {
  readonly actions = new RateMeter();
  readonly actLatency = new Histogram(LOOP_WORK_BUCKETS);
  /** One game tick (timers due), on the event loop. */
  readonly tickSeconds = new Histogram(LOOP_WORK_BUCKETS);
  /** One spectator flush: building, serializing and handing every topic batch to its sockets. */
  readonly wsFlushSeconds = new Histogram(LOOP_WORK_BUCKETS);
  /** Garbage collection pauses by kind. */
  readonly gc = new Map<string, Histogram>();
  private gcObserver: PerformanceObserver | null = null;
  private readonly startedAt = Date.now();
  readonly errors = new Map<string, number>();
  readonly batches = new RateMeter();
  wsPayloadBytes = 0;
  /** Messages handed to spectator sockets (one per subscriber per batch, plus direct ones). */
  wsMessages = 0;
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

  /** Actions the engine refused with INTERNAL (an unexpected exception it caught), by action name. */
  readonly internalErrors = new Map<string, number>();

  internalError(action: string): void {
    this.internalErrors.set(action, (this.internalErrors.get(action) ?? 0) + 1);
  }

  /** Starts sampling the event loop delay and GC pauses (main process only; tests leave it off). */
  start(): void {
    if (this.loop) return;
    this.loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    this.loop.enable();
    this.gcObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) this.observeGc((e as { detail?: { kind?: number } }).detail?.kind, e.duration / 1000);
    });
    this.gcObserver.observe({ entryTypes: ['gc'] });
  }

  observeGc(kind: number | undefined, seconds: number): void {
    const name = GC_KINDS[kind ?? -1] ?? 'other';
    let h = this.gc.get(name);
    if (!h) this.gc.set(name, (h = new Histogram(LOOP_WORK_BUCKETS)));
    h.observe(seconds);
  }

  stop(): void {
    this.loop?.disable();
    this.loop = null;
    this.gcObserver?.disconnect();
    this.gcObserver = null;
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

    const histogram = (name: string, h: Histogram, labels: string[] = []) => {
      const l = (extra?: string) => `{${[...labels, ...(extra ? [extra] : [])].join(',')}}`;
      h.buckets.forEach((b, i) => line(`${name}_bucket`, h.counts[i]!, l(`le="${b}"`)));
      line(`${name}_bucket`, h.count, l('le="+Inf"'));
      line(`${name}_sum`, round(h.sum, 6), labels.length ? l() : '');
      line(`${name}_count`, h.count, labels.length ? l() : '');
    };
    metric('ajwf_act_latency_seconds', 'histogram', 'Server-side latency of POST /act.');
    histogram('ajwf_act_latency_seconds', this.actLatency);
    metric('ajwf_tick_seconds', 'histogram', 'Game tick (due timers) duration on the event loop.');
    histogram('ajwf_tick_seconds', this.tickSeconds);

    metric('ajwf_errors_total', 'counter', 'Error responses by API error code.');
    for (const [code, n] of [...this.errors].sort()) line('ajwf_errors_total', n, `{code="${esc(code)}"}`);
    metric('ajwf_action_internal_errors_total', 'counter', 'Actions refused with INTERNAL: an unexpected exception in the engine (a bug), by action.');
    if (!this.internalErrors.size) line('ajwf_action_internal_errors_total', 0);
    for (const [action, n] of [...this.internalErrors].sort()) line('ajwf_action_internal_errors_total', n, `{action="${esc(action)}"}`);

    metric('ajwf_ws_payload_bytes_total', 'counter', 'Spectator message bytes handed to sockets (before compression).');
    line('ajwf_ws_payload_bytes_total', this.wsPayloadBytes);
    metric('ajwf_ws_messages_total', 'counter', 'Messages handed to spectator sockets (each batch counts once per subscriber).');
    line('ajwf_ws_messages_total', this.wsMessages);
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
    metric('ajwf_ws_flush_seconds', 'histogram', 'Spectator batch flush (build, serialize once per topic, hand to sockets) on the event loop.');
    histogram('ajwf_ws_flush_seconds', this.wsFlushSeconds);

    const p = src?.persistence?.();
    if (p) {
      metric('ajwf_snapshots_total', 'counter', 'Snapshots of dirty entities stored.');
      line('ajwf_snapshots_total', p.snapshots);
      metric('ajwf_snapshot_failures_total', 'counter', 'Snapshot transactions that failed (retried at the next interval).');
      line('ajwf_snapshot_failures_total', p.snapshotFailures);
      metric('ajwf_snapshot_last_success_timestamp_seconds', 'gauge', 'When the last snapshot was stored (0: none since boot).');
      line('ajwf_snapshot_last_success_timestamp_seconds', round(p.lastSnapshotAt / 1000, 3));
      metric('ajwf_snapshot_last_rows', 'gauge', 'Entities written by the last snapshot.');
      line('ajwf_snapshot_last_rows', p.lastSnapshotRows);
      metric('ajwf_snapshot_serialize_seconds', 'histogram', 'Main-thread time to collect and serialize dirty entities.');
      histogram('ajwf_snapshot_serialize_seconds', p.serialize);
      metric('ajwf_snapshot_write_seconds', 'histogram', 'Database time of a snapshot transaction.');
      histogram('ajwf_snapshot_write_seconds', p.write);
      metric('ajwf_events_written_total', 'counter', 'Game events appended to the store.');
      line('ajwf_events_written_total', p.eventsWritten);
      metric('ajwf_event_write_failures_total', 'counter', 'Event batches that failed to be written (kept in memory and retried).');
      line('ajwf_event_write_failures_total', p.eventWriteFailures);
      metric('ajwf_events_dropped_total', 'counter', 'Events dropped because the in-memory buffer was full (store unreachable for too long).');
      line('ajwf_events_dropped_total', p.eventsDropped);
    }

    metric('ajwf_event_loop_lag_seconds', 'gauge', 'Event loop delay since the last scrape (mean, p99, max).');
    const h = this.loop;
    const ns = (v: number) => round(h && h.count > 0 ? Math.max(0, v / 1e9 - LOOP_RESOLUTION_MS / 1000) : 0, 6);
    line('ajwf_event_loop_lag_seconds', ns(h?.mean ?? 0), '{stat="mean"}');
    line('ajwf_event_loop_lag_seconds', ns(h?.percentile(99) ?? 0), '{stat="p99"}');
    line('ajwf_event_loop_lag_seconds', ns(h?.max ?? 0), '{stat="max"}');
    h?.reset();

    if (this.gc.size) {
      metric('nodejs_gc_pause_seconds', 'histogram', 'Garbage collection pauses by kind.');
      for (const [kind, h] of [...this.gc].sort((x, y) => x[0].localeCompare(y[0]))) histogram('nodejs_gc_pause_seconds', h, [`kind="${kind}"`]);
    }

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
    metric('process_cpu_user_seconds_total', 'counter', 'User CPU time (JavaScript, zlib, JSON).');
    line('process_cpu_user_seconds_total', round(cpu.user / 1e6, 3));
    metric('process_cpu_system_seconds_total', 'counter', 'System CPU time (socket writes and the kernel network stack).');
    line('process_cpu_system_seconds_total', round(cpu.system / 1e6, 3));
    metric('process_start_time_seconds', 'gauge', 'When the process started (Unix time).');
    line('process_start_time_seconds', round(this.startedAt / 1000, 3));
    return out.join('\n') + '\n';
  }
}

function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
