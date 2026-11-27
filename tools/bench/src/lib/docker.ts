/**
 * The server as a container of the production image, for the spectator scenario at full scale: macOS caps one
 * process at 10,240 open files (`kern.maxfilesperproc`), so 20,000 sockets need Linux. Containers this module
 * creates are named `ajwf-bench-*` and removed when the run ends.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { BENCH_ADMIN, parseProm, type RunningServer } from './server';

export const BENCH_IMAGE = process.env.BENCH_IMAGE ?? 'ajwf:bench';
export const BENCH_NET = 'ajwf-bench-net';
const SERVER_NAME = 'ajwf-bench-server';

export function docker(args: string[], quiet = false): string {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'pipe'] }).trim();
  } catch (err) {
    if (quiet) return '';
    throw err;
  }
}

export function imageExists(image = BENCH_IMAGE): boolean {
  return docker(['image', 'inspect', image, '--format', '{{.Id}}'], true) !== '';
}

/** Removes what a previous (interrupted) run may have left behind. Only `ajwf-bench-*` names are touched. */
export function cleanupDocker(): void {
  const names = docker(['ps', '-a', '--filter', 'name=ajwf-bench-', '--format', '{{.Names}}'], true).split('\n').filter((n) => n.startsWith('ajwf-bench-'));
  if (names.length) docker(['rm', '-f', ...names], true);
  docker(['network', 'rm', BENCH_NET], true);
}

export async function startDockerServer(port: number, env: Record<string, string> = {}): Promise<RunningServer> {
  cleanupDocker();
  docker(['network', 'create', BENCH_NET]);
  const url = `http://127.0.0.1:${port}`;
  const vars: Record<string, string> = {
    NODE_ENV: 'development',
    PUBLIC_URL: url,
    ADMIN_TOKEN: BENCH_ADMIN,
    LOG_LEVEL: 'warn',
    WORLD_SEED: '12345',
    WS_MAX_CONNECTIONS: '50000',
    WS_MAX_PER_IP: '50000',
    ...env,
  };
  const t0 = Date.now();
  docker([
    'run',
    '-d',
    '--name',
    SERVER_NAME,
    '--network',
    BENCH_NET,
    '--ulimit',
    'nofile=65536:65536',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '-p',
    `127.0.0.1:${port}:8710`,
    ...Object.entries(vars).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    BENCH_IMAGE,
  ]);
  for (;;) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) break;
    } catch {
      // not yet
    }
    if (Date.now() - t0 > 120_000) throw new Error(`container did not become healthy: ${docker(['logs', '--tail', '30', SERVER_NAME], true)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    // No local process: stop() goes through docker.
    proc: null as unknown as ChildProcess,
    bootMs: Date.now() - t0,
    async metrics() {
      const res = await fetch(`${url}/metrics`, { headers: { authorization: `Bearer ${BENCH_ADMIN}` } });
      return parseProm(await res.text());
    },
    async stop() {
      const s0 = Date.now();
      docker(['stop', '-t', '60', SERVER_NAME], true);
      const code = Number(docker(['inspect', SERVER_NAME, '--format', '{{.State.ExitCode}}'], true) || NaN);
      cleanupDocker();
      return { code: Number.isNaN(code) ? null : code, signal: null, ms: Date.now() - s0 };
    },
  };
}

/** A loader container on the bench network, running the standalone loader with Node's type stripping. */
export function spawnDockerLoader(loaderFile: string, id: string, args: string[]): ChildProcess {
  return spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      `ajwf-bench-loader-${id}`,
      '--network',
      BENCH_NET,
      '--ulimit',
      'nofile=65536:65536',
      // Inside the server package, so `ws` resolves from its node_modules.
      '-v',
      `${loaderFile}:/app/apps/server/bench-loader.ts:ro`,
      '--entrypoint',
      'node',
      BENCH_IMAGE,
      '--experimental-strip-types',
      '--no-warnings',
      '/app/apps/server/bench-loader.ts',
      ...args,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

export async function stopDockerLoader(id: string, proc: ChildProcess): Promise<void> {
  docker(['stop', '-t', '10', `ajwf-bench-loader-${id}`], true);
  if (proc.exitCode === null) await once(proc, 'exit');
}
