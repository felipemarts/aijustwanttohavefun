/**
 * `pnpm sim`: runs the in-process balance simulation and writes a JSON report under tools/bots/reports/.
 *
 *   pnpm sim --bots 500 --actions 500000 --seed 1
 *   pnpm sim --bots 500 --days 21 --mix social=0.5,fighter=0.5
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_IDS, type ProfileId } from './profiles/types';
import { formatReport } from './sim/format';
import { DEFAULT_CADENCE, DEFAULT_MIX, defaultOptions, Simulation, type Cadence } from './sim/runner';

const HELP = `Usage: pnpm sim [options]
  --bots N          bots (default 500)
  --actions N       stop after N actions (default 500000; 0 = no limit)
  --days D          stop after D simulated days (default: no limit)
  --seed N          seed (default 1)
  --mix a=w,...     profile weights (explorer, fighter, social, trader, politician, traitor)
  --cadence id:minutes:actions:weight,...   behaviour model (default 30m/1h/2h/4h/12h buckets)
  --session N       max actions per session for every bucket
  --think a-b       seconds between two actions of a session (default 3-8)
  --out FILE        report path (default tools/bots/reports/sim-<bots>b-<seed>-<limit>.json)
  --quiet           no daily progress lines`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv: string[]): void {
  if (argv.includes('--help')) {
    console.log(HELP);
    return;
  }
  const num = (name: string, def?: number) => {
    const v = arg(argv, name);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name}: not a number: ${v}`);
    return n;
  };
  const mix = { ...DEFAULT_MIX };
  const mixArg = arg(argv, 'mix');
  if (mixArg) {
    for (const k of PROFILE_IDS) mix[k] = 0;
    for (const part of mixArg.split(',')) {
      const [k, w] = part.split('=');
      if (!PROFILE_IDS.includes(k as ProfileId)) throw new Error(`--mix: unknown profile ${k}`);
      mix[k as ProfileId] = Number(w ?? 1);
    }
  }
  let cadence: Cadence[] = DEFAULT_CADENCE;
  const cadArg = arg(argv, 'cadence');
  if (cadArg) {
    cadence = cadArg.split(',').map((part) => {
      const [id, minutes, actions, weight] = part.split(':');
      return { id: id!, everyMs: Number(minutes) * 60_000, actions: Number(actions ?? 40), weight: Number(weight ?? 1) };
    });
  }
  const session = num('session');
  if (session) cadence = cadence.map((c) => ({ ...c, actions: session }));
  const think = (arg(argv, 'think') ?? '3-8').split('-').map((x) => Number(x) * 1000) as [number, number];
  const actions = num('actions', 500_000)!;
  const days = num('days');
  const opt = defaultOptions({
    bots: num('bots', 500)!,
    ...(actions > 0 ? { actions } : { actions: undefined }),
    ...(days !== undefined ? { days } : {}),
    seed: num('seed', 1)!,
    mix,
    cadence,
    thinkMs: think,
    ...(argv.includes('--quiet') ? {} : { progress: (line: string) => console.log(line) }),
  });
  const sim = new Simulation(opt);
  const report = sim.run();
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports');
  const limit = days !== undefined ? `${days}d` : `${actions}a`;
  const out = arg(argv, 'out') ?? join(root, `sim-${opt.bots}b-${opt.seed}-${limit}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('');
  console.log(formatReport(report));
  console.log('');
  console.log(`Report: ${out}`);
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
