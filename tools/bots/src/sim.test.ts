/**
 * M4 and M5 acceptance through the balance simulation (PLANEJAMENTO §16.4, §17), at a reduced scale that runs
 * in CI: scripted bots of every profile play one world through `applyAction` and `tick` only. The full-scale runs
 * (500 bots) are `pnpm sim`; the M6 test is sim.civilization.test.ts; see tools/bots/README.md.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { checkInvariants } from '@ajwf/engine';
import { PROFILE_IDS } from './profiles/types';
import type { SimReport } from './sim/metrics';
import { defaultOptions, Simulation } from './sim/runner';


/** Enough of both populations to compare, over enough days for both to reach the middle levels; traitors among them. */
const OPTIONS = defaultOptions({
  bots: 64,
  days: 3.5,
  actions: undefined,
  seed: 7,
  mix: { explorer: 0.06, fighter: 0.3, social: 0.3, trader: 0.1, politician: 0.1, traitor: 0.14 },
});

let sim: Simulation;
let report: SimReport;

beforeAll(() => {
  sim = new Simulation(OPTIONS);
  // Throws on any exception and on any invariant violation (checked every 25,000 actions and at the end).
  report = sim.run();
}, 120_000);

describe('balance simulation (M4 acceptance, reduced scale)', () => {
  it('plays days of a world without breaking an invariant', () => {
    expect(checkInvariants(sim.s, sim.now)).toEqual([]);
    expect(report.sim.simulatedDays).toBeGreaterThanOrEqual(OPTIONS.days! - 0.1);
    expect(report.sim.actions).toBeGreaterThan(60_000);
    // Bots mostly do sensible things: the world says no to few of their actions.
    expect(report.refusals.rate).toBeLessThan(0.03);
  });

  it('agents in groups level at least 1.8 times faster than solo agents', () => {
    console.log(`group/solo: ${JSON.stringify(report.ratio)}; parties ${JSON.stringify(report.parties)}`);
    expect(report.ratio).not.toBeNull();
    // Compared at a level both populations reach (half of each), with the same cadence model.
    expect(report.ratio!.level).toBeGreaterThanOrEqual(5);
    expect(report.ratio!.ratio).toBeGreaterThanOrEqual(1.8);
  });

  it('every profile makes progress', () => {
    for (const p of PROFILE_IDS) {
      const v = report.byProfile[p];
      expect(v, p).toBeDefined();
      expect(v!.avgLevel, p).toBeGreaterThanOrEqual(4);
    }
    const a = report.actions;
    // Explorers gather, traders craft and sell, socials group up, politicians build and run for mayor.
    expect(a.gather ?? 0).toBeGreaterThan(0);
    expect(a.craft ?? 0).toBeGreaterThan(0);
    expect(a.market_sell ?? 0).toBeGreaterThan(0);
    expect(report.trades.guaranteed).toBeGreaterThan(0);
    expect(report.parties.formed).toBeGreaterThan(5);
    expect(a.contribute ?? 0).toBeGreaterThan(0);
    expect(a.run_for_mayor ?? 0).toBeGreaterThan(0);
  });
});

describe('trust and betrayal (M5 acceptance, reduced scale)', () => {
  it('traitors betray, scam and get bounties on their heads, and the world stays sound', () => {
    const t = report.trust.counts;
    console.log(`trust: ${JSON.stringify(t)}`);
    expect(t.betrayal ?? 0).toBeGreaterThan(0);
    expect(t.scam_reported ?? 0).toBeGreaterThan(0);
    expect(t.bounty_placed ?? 0).toBeGreaterThan(0);
    expect((t.steal ?? 0) + (t.steal_failed ?? 0)).toBeGreaterThan(0);
    expect(checkInvariants(sim.s, sim.now)).toEqual([]);
  });

  it('no agent below level 8 ever suffers PvP or theft (from the event stream)', () => {
    expect(report.trust.lowLevelExamples).toEqual([]);
    expect(report.trust.lowLevelPvp).toBe(0);
  });
});

describe('balance simulation runner', () => {
  it('is deterministic for a seed', () => {
    const run = () => new Simulation(defaultOptions({ bots: 30, actions: 15_000, seed: 3 })).run();
    const a = run();
    const b = run();
    expect(a.sim.actions).toBe(b.sim.actions);
    expect(a.sim.simulatedHours).toBe(b.sim.simulatedHours);
    expect(a.byProfile).toEqual(b.byProfile);
    expect(a.gold.daily).toEqual(b.gold.daily);
    expect(a.refusals).toEqual(b.refusals);
    expect(a.gazette.editions).toEqual(b.gazette.editions);
  });
});
