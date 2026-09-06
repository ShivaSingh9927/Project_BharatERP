import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '../../.env');

// Minimal .env loader — avoids a dependency for something this small.
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
}

// Numerics arrive as strings by default. Money must never round-trip through
// a float, so keep them as strings and use a decimal type at the edges.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

/** Schema owner. Migrations and tests-of-permissions only. */
export const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Application runtime role. CANNOT update or delete ledger rows.
 * Everything the product does at runtime goes through this pool.
 */
export const appPool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });

/**
 * Run `fn` inside a transaction on the app pool with the tenant context set.
 *
 * `app.firm_id` drives row-level security (007_append_only.sql). set_config
 * with is_local=true scopes it to the transaction, so a pooled connection
 * cannot leak one firm's context into another firm's query.
 */
export async function withFirm<T>(
  firmId: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['app.firm_id', firmId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.all([ownerPool.end(), appPool.end()]);
}
