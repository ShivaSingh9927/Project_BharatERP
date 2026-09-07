/**
 * Sets up a throwaway tenant so the bill pipeline can be run against real
 * invoices, and prints the command to run it.
 *
 *   npx tsx scripts/demo-ingest-setup.ts ~/Downloads/myinvoice
 *
 * ── This is a DEMO script and it does one thing the product refuses to ────
 *
 * It creates a supplier for every GSTIN it finds in the folder. `billProposal`
 * deliberately will not do that — a party carries a state and a ledger account,
 * and inventing one from a PDF leaves an unreviewed master record behind every
 * future bill from that vendor. Here it is acceptable only because the whole
 * tenant is disposable and exists to exercise the reader.
 *
 * Nothing in `src/` calls this. If it ever needs to, that is the signal that
 * supplier onboarding has been skipped rather than built.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { seedTenant, registerGstin, createFiscalYear } from '../src/seed/index.ts';
import { seedItcEligibility } from '../src/seed/tdsSections.ts';
import { enableLlmExtraction } from '../src/domain/billProposal.ts';
import { gstinCheckDigit, validateGstin } from '../src/domain/gstin.ts';
import { extractPdfText } from '../src/parse/pdf.ts';
import { splitDocuments } from '../src/parse/documentSplit.ts';
import { ownerPool, closePools } from '../src/db/pool.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: npx tsx scripts/demo-ingest-setup.ts <dir-of-pdfs>');
  process.exit(1);
}

const tag = randomUUID().slice(0, 8);
const t = await seedTenant({
  firmName: `Demo ${tag}`, clientName: `Demo client ${tag}`,
  userEmail: `demo-${tag}@example.test`, startYear: 2026,
  pan: 'AAACD1111D', businessType: 'general',
});
await seedItcEligibility(t.clientId);
await registerGstin(t.firmId, t.clientId,
  `09AAACD1111D1Z${gstinCheckDigit('09AAACD1111D1Z')}`, { primary: true });

/*
 * Two fiscal years, not one.
 *
 * The corpus spans 2025-08 to 2026-09, so its real invoice dates fall in both
 * FY2025-26 and FY2026-27. With today's date hardcoded this never came up;
 * now that dates are read, `V-6: no fiscal year covers posting date` refuses
 * anything outside a seeded year — correctly, and it would look like a parser
 * failure to anyone who had not seen this comment.
 */
await createFiscalYear(t.firmId, t.clientId, 2025);

const accounts = await ownerPool.query<{ id: string; name: string }>(
  `SELECT id, name FROM accounts WHERE client_id = $1
     AND name IN ('Purchases', 'Creditors')`, [t.clientId]);
const purchases = accounts.rows.find((a) => a.name === 'Purchases')!.id;
const creditors = accounts.rows.find((a) => a.name === 'Creditors')!.id;

await enableLlmExtraction(t.firmId, {
  provider: 'deepseek',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  enabledBy: t.userId,
  crossCheck: true,
});

// Suppliers, from whatever GSTINs the folder actually contains.
const seen = new Set<string>();
let bad = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.pdf'))) {
  let segments;
  try { segments = splitDocuments(extractPdfText(readFileSync(join(dir, f)))); }
  catch { continue; }

  for (const s of segments) {
    if (!s.supplierGstin || seen.has(s.supplierGstin)) continue;
    if (!validateGstin(s.supplierGstin).valid) { bad++; continue; }
    seen.add(s.supplierGstin);
    await ownerPool.query(
      `INSERT INTO parties (firm_id, client_id, party_type, name, gstin,
                            gst_category, state_code, ledger_account_id, created_by)
       VALUES ($1,$2,'supplier',$3,$4,'registered_regular',$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [t.firmId, t.clientId, `Vendor ${s.supplierGstin.slice(0, 6)}`,
       s.supplierGstin, s.supplierGstin.slice(0, 2), creditors, t.userId]);
  }
}

/*
 * Suppliers outside India, which have no GSTIN to be found by.
 *
 * `billProposal` matches these by looking for a party's NAME in the document,
 * so the names here are the ones actually printed on the four foreign invoices
 * in the corpus. They are created with gst_category 'overseas', which is what
 * makes the tax post to IGST rather than being split as a local supply.
 *
 * Hardcoded, and only defensible because this tenant is disposable: a real
 * onboarding names its own foreign vendors.
 */
const OVERSEAS = ['Anomaly', 'Lietparkas', 'Hetzner Online GmbH', 'Kamatera'];
for (const name of OVERSEAS) {
  await ownerPool.query(
    `INSERT INTO parties (firm_id, client_id, party_type, name,
                          gst_category, ledger_account_id, created_by)
     VALUES ($1,$2,'supplier',$3,'overseas',$4,$5)
     ON CONFLICT DO NOTHING`,
    [t.firmId, t.clientId, name, creditors, t.userId]);
}

console.log(`firm      ${t.firmId}`);
console.log(`client    ${t.clientId}`);
console.log(`purchases ${purchases}`);
console.log(`user      ${t.userId}`);
console.log(`suppliers ${seen.size} created${bad > 0 ? `, ${bad} GSTIN(s) failed their checksum` : ''}`);
console.log(`fiscal years 2025-26 and 2026-27`);
console.log(`model     enabled, cross-check ON\n`);
console.log('Now run, from this directory:\n');
console.log(`  DEEPSEEK_API=$(grep -oE 'sk-[A-Za-z0-9]+' ~/Documents/api_keys/DEEPSEEK_API.txt) \\`);
console.log(`    npx tsx scripts/ingest-bills.ts \\`);
console.log(`    ${t.firmId} ${t.clientId} ${purchases} ${dir}\n`);
console.log('Add --post and APPROVED_BY=' + t.userId + ' once the dry run looks right.');

await closePools();
