/**
 * Development-only: drop and recreate the schema, then re-run migrations.
 * Never point this at anything but a local database.
 */
import { ownerPool } from './pool.ts';

const url = process.env.DATABASE_URL ?? '';
if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error('refusing to reset a non-local database');
  process.exit(1);
}

await ownerPool.query(`
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;
  GRANT ALL ON SCHEMA public TO bharaterp;
`);
// Clears any lingering default-privilege entries from 007.
await ownerPool.query(`
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bharaterp_app') THEN
      EXECUTE 'DROP OWNED BY bharaterp_app';
    END IF;
  END $$;
`);
console.log('schema dropped and recreated');
await ownerPool.end();
