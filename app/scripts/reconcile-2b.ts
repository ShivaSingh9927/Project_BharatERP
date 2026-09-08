/**
 * Reconcile a client's posted bills against GSTR-2B.
 *
 * Two ways in. Off a file the CA downloaded from the portal:
 *
 *   npx tsx scripts/reconcile-2b.ts <firm> <client> <YYYY-MM> --file 2b.json
 *
 * Or fetched live, which the taxpayer authorises with a one-time password.
 * That is two steps, because the OTP arrives on the client's phone between
 * them:
 *
 *   # 1. ask the GST Network to send the client an OTP
 *   npx tsx scripts/reconcile-2b.ts <firm> <client> <YYYY-MM> \
 *       --request-otp --gstin <GSTIN> --username <portal-username>
 *
 *   # 2. once the client reads it off their phone, verify and reconcile
 *   npx tsx scripts/reconcile-2b.ts <firm> <client> <YYYY-MM> \
 *       --fetch --gstin <GSTIN> --username <portal-username> --otp <code>
 *
 * The username and OTP are the client's to supply. Nothing here stores a
 * portal password — there is none in this flow — and the OTP is used once and
 * discarded.
 */

import { readFileSync } from 'node:fs';
import { parseGstr2b } from '../src/integrations/gstr2bJson.ts';
import { runReconciliation, fetchAndReconcile } from '../src/domain/gstr2bStore.ts';
import { sandboxGstr2bFromEnv } from '../src/integrations/sandboxGstr2b.ts';
import { money, paise } from '../src/domain/tax.ts';
import { closePools } from '../src/db/pool.ts';
import type { ReconLine } from '../src/domain/gstr2b.ts';

const [firmId, clientId, period] = process.argv.slice(2);
const flag = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=')
  ?? (process.argv.includes(`--${n}`)
      ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const has = (n: string) => process.argv.includes(`--${n}`);

if (!firmId || !clientId || !period) {
  console.error('usage: reconcile-2b.ts <firm> <client> <YYYY-MM> ' +
                '[--file 2b.json | --request-otp ... | --fetch ...]');
  process.exit(1);
}

function report(lines: ReconLine[]): void {
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
  const supported = lines.filter((l) => l.status === 'matched')
    .reduce((s, l) => s + paise(l.bill!.totalTax), 0n);
  const atRisk = lines.filter((l) => l.status === 'in_books_only' && l.bill?.supplierGstin)
    .reduce((s, l) => s + paise(l.bill!.totalTax), 0n);
  console.log('=== summary ===');
  console.log(`credit supported by 2B: ${money(supported)}`);
  console.log(`credit booked but NOT yet filed by suppliers: ${money(atRisk)}`);
}

if (has('request-otp')) {
  const gstin = flag('gstin'), username = flag('username');
  const fetcher = sandboxGstr2bFromEnv();
  if (!fetcher) { console.error('SANDBOX_API_KEY/SECRET not set.'); process.exit(1); }
  if (!gstin || !username) { console.error('--request-otp needs --gstin and --username'); process.exit(1); }
  const { message } = await fetcher.requestOtp(gstin, username);
  console.log(`${message}\nThe client will receive an OTP on the phone and email ` +
              'registered with the GST portal. Re-run with --fetch --otp <code>.');
} else if (has('fetch')) {
  const gstin = flag('gstin'), username = flag('username'), otp = flag('otp');
  const fetcher = sandboxGstr2bFromEnv();
  if (!fetcher) { console.error('SANDBOX_API_KEY/SECRET not set.'); process.exit(1); }
  if (!gstin || !username || !otp) { console.error('--fetch needs --gstin --username --otp'); process.exit(1); }
  const lines = await fetchAndReconcile(firmId, clientId, period, gstin, username, otp, fetcher);
  console.log(`fetched 2B for ${gstin}, ${period}\n`);
  report(lines);
} else {
  const file = flag('file');
  if (!file) { console.error('give --file 2b.json, or --request-otp / --fetch'); process.exit(1); }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const filed = parseGstr2b(raw);
  console.log(`2B statement: ${filed.length} invoice(s) filed for ${period}\n`);
  report(await runReconciliation(firmId, clientId, period, filed, raw, 'portal-json'));
}

await closePools();
