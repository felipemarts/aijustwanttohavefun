/**
 * M6 acceptance through the balance simulation (PLANEJAMENTO §17 M6) at a reduced scale: a week of a village with
 * the server's own chronicle code turning its events into the Village Gazette. The full run is
 * `pnpm sim --scenario civilization`; see tools/bots/README.md. Its own file, so it runs beside the other tests.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { checkInvariants } from '@ajwf/engine';
import type { SimReport } from './sim/metrics';
import { defaultOptions, Simulation } from './sim/runner';

const HOUR = 3_600_000;

describe('civilization (M6 acceptance, reduced scale)', () => {
  // A week and a little more, so the first election closes; fewer, slower agents keep it quick. Project costs are
  // set for hundreds of agents: here the village only makes progress; the full run (`--scenario civilization`)
  // completes projects.
  const civ = defaultOptions({
    bots: 30,
    days: 7.05,
    actions: undefined,
    seed: 11,
    cadence: [{ id: '4h', everyMs: 4 * HOUR, actions: 120, weight: 1 }],
  });
  let r: SimReport;
  let world: Simulation;
  beforeAll(() => {
    world = new Simulation(civ);
    r = world.run();
  }, 120_000);

  it('builds, holds a full election and publishes 7 gazette editions in 7 days', () => {
    console.log(`projects ${JSON.stringify(r.civic.projects)}; elections ${JSON.stringify(r.civic.elections)}`);
    for (const e of r.gazette.editions) console.log(`${e.date}: ${e.headline}`);
    expect(r.civic.elections).toHaveLength(1);
    expect(r.civic.elections[0]!.voters).toBeGreaterThan(0);
    expect(r.civic.elections[0]!.winner).not.toBeNull();
    expect(r.gazette.finalEditions).toBeGreaterThanOrEqual(7);
    for (const e of r.gazette.editions) {
      expect(e.headline.length).toBeGreaterThan(10);
      expect(e.headline).not.toMatch(/^gazette\./);
    }
    expect(Object.values(world.s.village.projects).some((p) => p.gold > 0)).toBe(true);
    expect(checkInvariants(world.s, world.now)).toEqual([]);
  });
});
