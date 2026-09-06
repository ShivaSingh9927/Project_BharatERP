import { ownerPool } from './pool.ts';

const deadline = Date.now() + 60_000;
for (;;) {
  try {
    await ownerPool.query('SELECT 1');
    console.log('database ready');
    break;
  } catch {
    if (Date.now() > deadline) { console.error('timed out waiting for database'); process.exit(1); }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
await ownerPool.end();
