import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

/** Applies migrations/*.sql in filename order, once each. Safe to run from several processes. */
export async function migrate(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    await c.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const dir = path.join(process.cwd(), 'migrations');
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const done = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
      if (done.rowCount) continue;
      const sql = await fs.readFile(path.join(dir, f), 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        console.log(`migration applied: ${f}`);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    c.release();
  }
}
