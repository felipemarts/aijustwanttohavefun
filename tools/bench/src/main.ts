/**
 * `pnpm bench`: the fixed scenarios of PLANEJAMENTO §13.5, results in `tools/bench/results/*.local.json`.
 *
 *   pnpm bench                       every scenario at full scale (Postgres ones need --db or BENCH_DATABASE_URL)
 *   pnpm bench engine api            only these scenarios
 *   pnpm bench --ci                  the reduced version, compared with results/ci-baseline.json (exit 1 on regression)
 *   pnpm bench --ci --update-baseline  rewrite the baseline from this machine (best of 5 runs)
 *   pnpm bench --ci [--update-baseline] --baseline FILE   compare with (or write) another baseline file: CI
 *                                    measures the base commit on the same runner and compares the head with it
 *
 * Scenarios: engine, api, api-pg, spectators, registered. Flags: --db URL, --port N (default 8790), --duration S,
 * --agents N, --rate N, --cpu-prof DIR (profile the server). Spectators: --conns N, --loaders N, --per-loader N,
 * --mode docker|local (docker, the default, runs the production image built as ajwf:bench: 20,000 sockets need
 * Linux file limits; local runs on this machine, about 9,500 sockets on macOS).
 */
import { parseArgs } from 'node:util';
import { loadContent } from '@ajwf/content/node';
import { runCi } from './ci';
import { log, machine, save, type Result, type Target } from './lib/report';
import { API_FULL, runApi } from './scenarios/api';
import { ENGINE_FULL, runEngine } from './scenarios/engine';
import { REGISTERED_FULL, runRegistered } from './scenarios/registered';
import { runSpectators, SPECTATORS_FULL } from './scenarios/spectators';

const { values, positionals } = parseArgs({
  options: {
    ci: { type: 'boolean' },
    'update-baseline': { type: 'boolean' },
    baseline: { type: 'string' },
    db: { type: 'string' },
    port: { type: 'string' },
    duration: { type: 'string' },
    agents: { type: 'string' },
    rate: { type: 'string' },
    conns: { type: 'string' },
    loaders: { type: 'string' },
    'per-loader': { type: 'string' },
    mode: { type: 'string' },
    'cpu-prof': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
  // pnpm forwards a literal `--` before the script's arguments.
  args: process.argv.slice(2).filter((a) => a !== '--'),
});

if (values.help) {
  console.log('usage: pnpm bench [engine|api|api-pg|spectators|registered ...] [--ci [--update-baseline] [--baseline FILE]] [--db URL] [--port N] [--duration S] [--agents N] [--rate N] [--conns N] [--loaders N] [--per-loader N] [--mode docker|local] [--cpu-prof DIR]');
  process.exit(0);
}

const num = (v: string | undefined, fallback: number) => (v === undefined ? fallback : Number(v));
const content = loadContent();

if (values.ci) {
  process.exit(await runCi(content, { update: values['update-baseline'] ?? false, ...(values.baseline ? { baseline: values.baseline } : {}) }));
}

const db = values.db ?? process.env.BENCH_DATABASE_URL;
const port = num(values.port, 8790);
const all = ['engine', 'api', 'api-pg', 'spectators', 'registered'];
const chosen = positionals.length ? positionals : all;
for (const s of chosen) if (!all.includes(s)) throw new Error(`unknown scenario: ${s} (known: ${all.join(', ')})`);
const nodeFlags = values['cpu-prof'] ? ['--cpu-prof', `--cpu-prof-dir=${values['cpu-prof']}`] : undefined;
const summary: Target[] = [];

function record(name: string, r: { params: object; metrics: Record<string, unknown>; targets?: Target[]; notes?: string[] }): void {
  const result: Result = { scenario: name, at: new Date().toISOString(), machine: machine(), params: { ...r.params }, metrics: r.metrics, ...(r.targets ? { targets: r.targets } : {}), ...(r.notes ? { notes: r.notes } : {}) };
  log(`${name}: written to ${save(name, result)}`);
  summary.push(...(r.targets ?? []));
}

for (const name of chosen) {
  if ((name === 'api-pg' || name === 'registered') && !db) {
    log(`${name}: skipped (needs Postgres: --db postgres://... or BENCH_DATABASE_URL; the database is wiped)`);
    continue;
  }
  if (name === 'engine') record('engine', await runEngine(content, { ...ENGINE_FULL, agents: num(values.agents, ENGINE_FULL.agents) }));
  const apiOpts = {
    ...API_FULL,
    agents: num(values.agents, API_FULL.agents),
    rate: num(values.rate, API_FULL.rate),
    durationSec: num(values.duration, API_FULL.durationSec),
    port,
    ...(nodeFlags ? { nodeFlags } : {}),
  };
  if (name === 'api') record('api-memory', await runApi(content, apiOpts));
  if (name === 'api-pg') record('api-postgres', await runApi(content, { ...apiOpts, databaseUrl: db! }));
  if (name === 'spectators') {
    record(
      'spectators',
      await runSpectators(content, {
        ...SPECTATORS_FULL,
        agents: num(values.agents, SPECTATORS_FULL.agents),
        rate: num(values.rate, SPECTATORS_FULL.rate),
        conns: num(values.conns, SPECTATORS_FULL.conns),
        loaders: num(values.loaders, SPECTATORS_FULL.loaders),
        perLoader: num(values['per-loader'], SPECTATORS_FULL.perLoader),
        mode: values.mode === 'local' ? 'local' : SPECTATORS_FULL.mode,
        durationSec: num(values.duration, SPECTATORS_FULL.durationSec),
        port,
        ...(nodeFlags ? { nodeFlags } : {}),
      }),
    );
  }
  if (name === 'registered') record('registered', await runRegistered(content, { ...REGISTERED_FULL, port, databaseUrl: db!, durationSec: num(values.duration, REGISTERED_FULL.durationSec) }));
}

if (summary.length) {
  console.log('\nTargets (PLANEJAMENTO §3.4):');
  for (const t of summary) console.log(`  ${t.pass === null ? '  ?' : t.pass ? 'ok ' : 'FAIL'}  ${t.name}: ${t.measured} (target ${t.target})${t.note ? ` — ${t.note}` : ''}`);
}
process.exit(0);
