import { describe, expect, it } from 'vitest';
import { Histogram, Metrics } from './metrics';
import { ADMIN, makeServer } from './test-helpers';

describe('operational metrics', () => {
  it('reports tick, flush, snapshot and GC histograms and the persistence counters', async () => {
    const s = await makeServer();
    const { key } = await s.register('Pip');
    await s.act(key, 'move', { dir: 'north' });
    await s.persistence.snapshot();
    await s.persistence.flushEvents();
    s.metrics.tickSeconds.observe(0.0004);
    s.spectators.tick();
    s.metrics.observeGc(undefined, 0.002);
    const text = (await s.app.inject({ method: 'GET', url: '/metrics', headers: { 'x-admin-token': ADMIN } })).body;
    const value = (name: string) => Number(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\S+)$`, 'm').exec(text)?.[1]);
    expect(value('ajwf_snapshots_total')).toBe(1);
    expect(value('ajwf_snapshot_failures_total')).toBe(0);
    expect(value('ajwf_snapshot_last_success_timestamp_seconds')).toBeGreaterThan(0);
    expect(value('ajwf_snapshot_last_rows')).toBeGreaterThan(0);
    expect(value('ajwf_snapshot_serialize_seconds_count')).toBeGreaterThan(0);
    expect(value('ajwf_events_written_total')).toBeGreaterThan(0);
    expect(value('ajwf_event_write_failures_total')).toBe(0);
    expect(value('ajwf_tick_seconds_bucket{le="0.0005"}')).toBe(1);
    expect(value('ajwf_ws_flush_seconds_count')).toBe(1);
    expect(value('ajwf_ws_messages_total')).toBe(0);
    expect(value('nodejs_gc_pause_seconds_count{kind="other"}')).toBe(1);
    expect(value('process_start_time_seconds')).toBeGreaterThan(0);
    expect(value('process_cpu_user_seconds_total')).toBeGreaterThan(0);
    expect(value('process_cpu_system_seconds_total')).toBeGreaterThanOrEqual(0);
    // Fine buckets around the 30 ms /act target.
    expect(text).toMatch(/^ajwf_act_latency_seconds_bucket\{le="0.03"\} \d+$/m);
  });

  it('counts histogram buckets cumulatively', () => {
    const h = new Histogram([0.001, 0.01]);
    for (const v of [0.0005, 0.005, 0.5]) h.observe(v);
    expect(h.counts).toEqual([1, 2]);
    expect(h.count).toBe(3);
    expect(new Metrics().render()).toMatch(/^ajwf_actions_total 0$/m);
  });
});
