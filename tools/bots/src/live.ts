/**
 * `pnpm bots`: scripted bots playing against a running server over HTTP.
 *
 *   pnpm bots --url http://localhost:8710 --count 50 --rate 20 --duration 60 --admin-token dev-admin
 *
 * Every flag also reads an environment variable: AJWF_URL, BOTS_COUNT, ADMIN_TOKEN, BOTS_RATE, BOTS_SEED,
 * BOTS_DURATION. Ctrl+C stops the bots cleanly and prints the summary; a second Ctrl+C exits at once.
 */
import { parseArgs } from 'node:util';
import { loadContent } from '@ajwf/content/node';
import { runLiveBots } from './live-runner';
import { Stopper } from './pacing';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    count: { type: 'string' },
    'admin-token': { type: 'string' },
    rate: { type: 'string' },
    seed: { type: 'string' },
    duration: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  // pnpm forwards a literal `--` before the script's arguments.
  args: process.argv.slice(2).filter((a) => a !== '--'),
});

if (values.help) {
  console.log('usage: pnpm bots [--url URL] [--count N] [--admin-token TOKEN] [--rate ACTIONS_PER_SEC] [--seed N] [--duration SECONDS]');
  process.exit(0);
}

function num(flag: string | undefined, env: string | undefined, fallback: number, min = 0): number {
  const raw = flag ?? env;
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    console.error(`invalid number: ${raw}`);
    process.exit(2);
  }
  return n;
}

const env = process.env;
const url = values.url ?? env.AJWF_URL ?? 'http://localhost:8710';
const count = Math.floor(num(values.count, env.BOTS_COUNT, 10, 1));
const rate = num(values.rate, env.BOTS_RATE, 20, 0.01);
const seed = Math.floor(num(values.seed, env.BOTS_SEED, Date.now() % 2 ** 31));
const duration = num(values.duration, env.BOTS_DURATION, 0);
const adminToken = values['admin-token'] ?? env.ADMIN_TOKEN;

if (!adminToken) {
  console.warn('warning: no --admin-token. Bots will not be flagged as bots, and registration is limited to 5 per hour per IP.');
}

const stopper = new Stopper();
let interrupts = 0;
process.on('SIGINT', () => {
  if (++interrupts > 1) process.exit(130);
  console.log('\nstopping (Ctrl+C again to quit at once)...');
  stopper.stop();
});

console.log(`bots: ${count} against ${url}, ${rate} actions/s, seed ${seed}${duration ? `, ${duration} s` : ', until Ctrl+C'}`);
try {
  const summary = await runLiveBots(loadContent(), { url, count, rate, seed, duration, adminToken, stopper });
  process.exit(summary.registered ? 0 : 1);
} catch (err) {
  // ApiError messages never contain keys or tokens.
  console.error(`bots failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
