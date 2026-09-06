import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { ownerPool } from './pool.ts';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

await ownerPool.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const applied = new Set(
  (await ownerPool.query<{ filename: string }>('SELECT filename FROM schema_migrations'))
    .rows.map((r) => r.filename),
);

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
let ran = 0;

for (const f of files) {
  if (applied.has(f)) continue;
  const sql = readFileSync(join(dir, f), 'utf8');
  const c = await ownerPool.connect();
  try {
    // Each migration is atomic: it fully applies or leaves nothing behind.
    await c.query('BEGIN');
    await c.query(sql);
    await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
    await c.query('COMMIT');
    console.log(`  applied ${f}`);
    ran++;
  } catch (e) {
    await c.query('ROLLBACK');
    console.error(`  FAILED  ${f}\n`, e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    c.release();
  }
}

console.log(ran ? `${ran} migration(s) applied` : 'already up to date');
await ownerPool.end();
