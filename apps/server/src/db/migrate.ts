import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

export async function runMigrations(pool: pg.Pool): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
}

/** When the latest migration of this version was created (its `when` in drizzle's journal). */
export function latestMigrationAt(): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { when: number }[] };
  return Math.max(0, ...journal.entries.map((e) => e.when));
}

/**
 * For a server that does not migrate at boot (`MIGRATE_ON_BOOT=0`, its role cannot create anything): refuses to
 * start on a database whose schema is behind this version, instead of failing later on a missing table or column.
 * Reads drizzle's journal table, which the migrating role wrote.
 */
export async function checkMigrated(pool: pg.Pool): Promise<void> {
  let applied: number;
  try {
    const res = await pool.query<{ at: string | null }>('SELECT max(created_at)::text AS at FROM drizzle.__drizzle_migrations');
    applied = Number(res.rows[0]?.at ?? 0);
  } catch (err) {
    throw new Error('the database has no migration journal: run `pnpm db:migrate` with the owner role first', { cause: err });
  }
  if (applied < latestMigrationAt()) throw new Error('the database schema is behind this version: run `pnpm db:migrate` with the owner role first');
}

// CLI: `pnpm db:migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url });
  runMigrations(pool)
    .then(() => console.log('migrations applied'))
    .finally(() => pool.end());
}
