import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results');

export function machine() {
  const c = cpus();
  return {
    cpu: c[0]?.model ?? 'unknown',
    cores: c.length,
    memGb: Math.round(totalmem() / 2 ** 30),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    /** 1-minute load average when the result was written: a busy machine inflates every wall-clock number. */
    loadAvg1m: Math.round(loadavg()[0]! * 10) / 10,
  };
}

/** A target from PLANEJAMENTO §3.4 and how the run did against it. */
export type Target = { name: string; target: string; measured: string; pass: boolean | null; note?: string };

export type Result = {
  scenario: string;
  at: string;
  machine: ReturnType<typeof machine>;
  params: Record<string, unknown>;
  metrics: Record<string, unknown>;
  targets?: Target[];
  notes?: string[];
};

/** Writes `results/<name>.local.json` (gitignored) and returns its path. */
export function save(name: string, r: Result): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${name}.local.json`);
  writeFileSync(file, JSON.stringify(r, null, 2) + '\n');
  return file;
}

export function log(line: string): void {
  console.log(`[bench ${new Date().toISOString().slice(11, 19)}] ${line}`);
}
