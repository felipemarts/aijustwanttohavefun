import { createHash } from 'node:crypto';
import { hrtime } from 'node:process';

/**
 * A fixed CPU workload with the same ingredients as a game action (small objects, Map lookups, string building,
 * JSON, a hash), timed several times; the fastest run is the machine's "speed unit". CI compares per-operation
 * costs divided by this unit, so a slower or busier runner does not read as a regression.
 */
export function calibrate(reps = 7): number {
  let best = Infinity;
  let sink = 0;
  for (let r = 0; r < reps; r++) {
    const t0 = hrtime.bigint();
    sink += work();
    const ms = Number(hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
  }
  if (sink === 42) console.log('');
  return best;
}

function work(): number {
  const m = new Map<string, { id: number; hp: number; inv: Record<string, number>; tags: string[] }>();
  let acc = 0;
  for (let i = 0; i < 20_000; i++) {
    const id = `a${(i % 2000).toString(36)}`;
    let o = m.get(id);
    if (!o) m.set(id, (o = { id: i, hp: 100, inv: {}, tags: [] }));
    o.hp = (o.hp * 31 + i) % 997;
    o.inv[`item_${i % 17}`] = (o.inv[`item_${i % 17}`] ?? 0) + 1;
    if (o.tags.length < 8) o.tags.push(`t${i % 5}`);
    if (i % 20 === 0) acc += JSON.stringify(o).length + JSON.parse(`{"n":${i},"s":"${id}"}`).n;
    if (i % 200 === 0) acc += createHash('sha256').update(id).digest()[0]!;
  }
  return acc + m.size;
}
