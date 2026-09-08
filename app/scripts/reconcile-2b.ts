/**
 * Reconcile a client's posted bills against a GSTR-2B statement.
 *
 *   npx tsx scripts/reconcile-2b.ts <firm-id> <client-id> <period YYYY-MM> <2b.json>
 *
 * The 2B file is the JSON downloaded from the portal. Nothing is fetched here;
 * the authenticated fetch is a separate concern that produces the same records.
 */

import { readFileSync } from 'node:fs';
import { parseGstr2b } from '../src/integrations/gstr2bJson.ts';
import { runReconciliation } from '../src/domain/gstr2bStore.ts';
import { money, paise } from '../src/domain/tax.ts';
import { closePools } from '../src/db/pool.ts';

const [firmId, clientId, period, file] = process.argv.slice(2);
if (!firmId || !clientId || !period || !file) {
  console.error('usage: reconcile-2b.ts <firm-id> <client-id> <YYYY-MM> <2b.json>');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(file, 'utf8'));
const filed = parseGstr2b(raw);
console.log(`2B statement: ${filed.length} invoice(s) filed for ${period}\n`);

const lines = await runReconciliation(firmId, clientId, period, filed, raw, 'portal-json');

const order = ['mismatch', 'in_books_only', 'in_2b_only', 'matched'] as const;
const label: Record<string, string> = {
  matched: 'MATCHED', mismatch: 'MISMATCH',
  in_books_only: 'IN BOOKS, NOT FILED', in_2b_only: 'FILED, NOT IN BOOKS',
};
for (const status of order) {
  const group = lines.filter((l) => l.status === status);
  if (group.length === 0) continue;
  console.log(`### ${label[status]} (${group.length})`);
  for (const l of group) console.log(`  - ${l.note}`);
  console.log();
}

// The number that matters: credit 2B supports vs credit booked.
const supported = lines.filter((l) => l.status === 'matched')
  .reduce((s, l) => s + paise(l.bill!.totalTax), 0n);
const atRisk = lines.filter((l) => l.status === 'in_books_only' && l.bill?.supplierGstin)
  .reduce((s, l) => s + paise(l.bill!.totalTax), 0n);
console.log('=== summary ===');
console.log(`credit supported by 2B: ${money(supported)}`);
console.log(`credit booked but NOT yet filed by suppliers: ${money(atRisk)}`);

await closePools();
