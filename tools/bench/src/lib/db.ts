import pg from 'pg';
import { round } from './stats';

/** Drops every table (and drizzle's migration journal) so the server starts from an empty database. */
export async function wipeDatabase(url: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;');
  } finally {
    await c.end();
  }
}

export async function dbSizeMb(url: string): Promise<number> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query<{ n: string }>('SELECT pg_database_size(current_database()) AS n');
    return round(Number(r.rows[0]!.n) / 2 ** 20, 1);
  } finally {
    await c.end();
  }
}

