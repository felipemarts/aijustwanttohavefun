import type { SimReport } from './metrics';

const fmtMap = (m: Record<string, number>, n = 8) =>
  Object.entries(m)
    .slice(0, n)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ') || '-';

const h = (x: number | null | undefined) => (x === null || x === undefined ? '  -  ' : `${x.toFixed(1)}h`);

/** The readable summary printed after a run. */
export function formatReport(r: SimReport): string {
  const out: string[] = [];
  const s = r.sim;
  out.push(`Simulation: ${r.config.bots} bots, seed ${r.config.seed}: ${s.actions} actions (${s.waits} pauses, ${s.sessions} sessions) over ${s.simulatedHours} simulated hours (${s.simulatedDays} real days)`);
  out.push(`Speed: ${s.actionsPerSecond} actions/s (${s.wallSeconds} s wall clock)`);
  out.push('');
  out.push('Time for half of each population to reach a level (simulated hours; share that reached it):');
  const levels = Object.keys(r.solo.levels);
  out.push(`  level   ${levels.map((l) => l.padStart(13)).join('')}`);
  const row = (name: string, p: SimReport['solo']) => `  ${name.padEnd(8)}${levels.map((l) => `${h(p.levels[+l]!.p50Hours)} ${String(Math.round(p.levels[+l]!.reached * 100)).padStart(3)}%`.padStart(13)).join('')}`;
  out.push(row('solo', r.solo));
  out.push(row('grouped', r.grouped));
  for (const [p, v] of Object.entries(r.byProfile)) if (p !== 'fighter' && p !== 'social') out.push(row(p, v));
  out.push(r.ratio ? `  Group/solo speed at level ${r.ratio.level}: ${r.ratio.soloHours}h / ${r.ratio.groupedHours}h = ${r.ratio.ratio}x` : '  Group/solo speed: no level reached by half of both populations');
  out.push('');
  out.push('Profiles (avg / median / max level, XP per AP, deaths, refusal rate):');
  for (const [p, v] of Object.entries(r.byProfile)) out.push(`  ${p.padEnd(11)} n=${String(v.n).padStart(3)}  ${v.avgLevel.toFixed(2)} / ${v.medianLevel} / ${v.maxLevel}  ${v.xpPerAp} XP/AP  ${v.deaths} deaths  ${(v.refusalRate * 100).toFixed(1)}% refused`);
  for (const [p, v] of Object.entries(r.byProfile)) out.push(`  ${p.padEnd(11)} AP: ${fmtMap(v.apShare, 6)} | XP: ${fmtMap(v.xpBySource, 6)}`);
  out.push('Cadence buckets (avg level all/solo/grouped, AP spent per day, hours for half to reach L5/L10/L15/L20, solo | grouped):');
  const hs = (m: Record<number, number | null>) => [5, 10, 15, 20].map((L) => h(m[L])).join(' ');
  for (const [c, v] of Object.entries(r.byCadence)) out.push(`  ${c.padEnd(5)} n=${String(v.n).padStart(3)}  level ${v.avgLevel.toFixed(2)}/${v.soloLevel.toFixed(2)}/${v.groupedLevel.toFixed(2)}  ${String(v.apPerDay).padStart(6)} AP/day  solo ${hs(v.soloHours)} | grouped ${hs(v.groupedHours)}`);
  out.push('');
  out.push(`XP by source: ${fmtMap(r.xp.bySource)}`);
  out.push(`XP per AP by source: ${fmtMap(r.xp.perApBySource)}`);
  out.push('');
  const d = r.gold.daily;
  out.push(`Gold per agent by day (avg/median/supply): ${d.map((x) => `d${x.day} ${x.avg}/${x.median}/${x.supplyPerAgent}`).join('  ')}`);
  out.push(`Gold sources: ${fmtMap(r.gold.sources)}`);
  out.push(`Gold sinks: ${fmtMap(r.gold.sinks)}`);
  out.push(`Net gold created: ${r.gold.net}; supply growth over the last days: ${(r.gold.supplyGrowthPerDay * 100).toFixed(1)}%/day`);
  out.push('');
  out.push(`Deaths: ${fmtMap(r.deaths)}`);
  const top = ['crypt_guard', 'bone_hound', 'the_hollow_regent', 'ancient_colossus', 'wraith', 'bandit_captain', 'swamp_hag', 'kobold_foreman', 'rock_golem'];
  out.push(`Kills of group and high-level monsters: ${top.map((m) => `${m} ${r.kills[m] ?? 0}`).join(', ')}`);
  out.push(`Quests completed: ${fmtMap(r.quests)}`);
  out.push(`Parties: ${r.parties.formed} formed, ${r.parties.activeAtEnd} alive at the end, lifetime avg ${r.parties.avgLifetimeHours}h median ${r.parties.medianLifetimeHours}h, avg max size ${r.parties.avgMaxSize}; grouped bots' blows: ${(r.parties.blowsInParty * 100).toFixed(0)}% in a party, ${(r.parties.blowsWithMate * 100).toFixed(0)}% with a party mate in the room`);
  out.push(`Trades: ${r.trades.guaranteed} guaranteed; market ${r.trades.market.trades} trades, ${r.trades.market.units} units, ${r.trades.market.gold} gold`);
  for (const [item, rows] of Object.entries(r.trades.prices)) out.push(`  ${item}: ${rows.map((x) => `d${x.day} ${x.avg}g x${x.units}`).join('  ')}`);
  out.push('');
  const cv = r.civic;
  out.push(`Projects: ${cv.projects.map((p) => `${p.id} (day ${p.day})`).join(', ') || 'none'}; ${cv.projectsPerDay}/day; treasury ${cv.treasury}`);
  out.push(`Elections: ${cv.elections.map((e) => `#${e.n} day ${e.day}: ${e.candidates} candidates, ${e.voters}/${e.eligible} voted (${(e.turnout * 100).toFixed(0)}%), winner ${e.winner ?? 'none'}`).join('; ') || 'none closed'}; current: ${cv.candidates} candidates, ${cv.votesNow} votes; mayor ${cv.mayor ?? 'none'}`);
  out.push(`Civic actions: ${fmtMap(cv.actions, 12)}`);
  out.push('');
  const g = r.gazette;
  out.push(`Village Gazette: ${g.finalEditions} final editions; highlights: ${fmtMap(g.highlights, 12)}`);
  for (const e of g.editions) out.push(`  ${e.date}${e.final ? '' : ' (running)'}: ${e.headline}  [${e.highlights} highlights]`);
  out.push('');
  out.push(`Trust and betrayal: ${fmtMap(r.trust.counts, 14)}`);
  out.push(`  per day: ${fmtMap(r.trust.perDay, 14)}`);
  out.push(`  PvP or theft involving an agent below level 8: ${r.trust.lowLevelPvp}`);
  out.push('');
  out.push(`Refusals: ${r.refusals.total} (${(r.refusals.rate * 100).toFixed(2)}% of actions): ${fmtMap(r.refusals.byCode)}`);
  out.push(`  top: ${fmtMap(r.refusals.top, 10)}`);
  out.push(`World near the village: ${(r.world.monstersAliveNearVillage * 100).toFixed(0)}% of daytime monster slots alive, ${(r.world.resourcesLeftNearVillage * 100).toFixed(0)}% of resource stock left; ${(r.world.waitShare * 100).toFixed(1)}% of turns were pauses`);
  out.push(`  pauses: ${fmtMap(r.world.pauses, 12)}`);
  out.push(`  where: ${fmtMap(r.world.pauseRooms, 10)}`);
  return out.join('\n');
}

/** Every edition of the Village Gazette in full, as a reader would see it. */
export function formatGazette(r: SimReport): string {
  const out: string[] = ['THE VILLAGE GAZETTE'];
  for (const e of r.gazette.editions) {
    out.push('');
    out.push(`=== ${e.date}${e.final ? '' : ' (running)'} === ${e.headline}`);
    for (const sec of e.sections) {
      out.push(`  ${sec.title}`);
      for (const item of sec.items) out.push(`    - ${item}`);
    }
  }
  return out.join('\n');
}
