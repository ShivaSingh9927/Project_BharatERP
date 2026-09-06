/**
 * Demo dataset for the review server.
 *
 * Builds a month a CA would recognise, then writes a matching statement CSV to
 * `sample-statement.csv` so the whole flow can be walked end to end:
 * import → BR-6 check → reconcile → BRS.
 *
 * The rows are chosen to exercise the cases that decide whether this product is
 * trustworthy, not to look tidy:
 *
 *   - an exact UTR match          → should auto-match with certainty
 *   - two invoices of ₹11,800 from the same customer, one payment
 *                                 → must be surfaced as ambiguous, never guessed
 *   - a receipt short by exactly 10% of the taxable value
 *                                 → customer-deducted TDS, not a shortfall
 *   - a part payment              → genuinely partial; must stay outstanding
 *   - bank charges with GST       → a claimable ITC that is normally missed
 *   - interest credited net of TDS→ income must be recorded gross
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedTenant } from './index.ts';
import { seedGstRates } from './gstRates.ts';
import { seedTdsSections, seedItcEligibility } from './tdsSections.ts';
import { createInvoice } from '../domain/invoicing.ts';
import { accountNumberHash } from '../domain/banking.ts';
import { gstinCheckDigit } from '../domain/gstin.ts';
import { withFirm, ownerPool, closePools } from '../db/pool.ts';

const gstin = (state: string, pan: string): string => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckDigit(first14);
};

const t = await seedTenant({
  firmName: 'Sharma & Associates',
  clientName: 'Shree Ram Trading Company',
  userEmail: 'ca@sharma-associates.test',
  startYear: 2026,
});

await ownerPool.query(
  'UPDATE clients SET gstin = $2, pan = $3, state_code = $4 WHERE id = $1',
  [t.clientId, gstin('27', 'AAPFS1234K'), 'AAPFS1234K', '27']);

await seedGstRates().catch(() => 0);   // idempotent enough for a demo
await seedTdsSections();
await seedItcEligibility(t.clientId);

const A = (n: string): string => {
  const id = t.accounts[n];
  if (!id) throw new Error(`missing account ${n}`);
  return id;
};

// --- bank account ----------------------------------------------------------
const bankAccountId = await withFirm(t.firmId, async (c) => {
  const r = await c.query<{ id: string }>(
    `INSERT INTO bank_accounts
       (firm_id, client_id, account_id, bank_name, account_number_last4,
        account_number_hash, ifsc, kind, opening_balance, opening_date)
     VALUES ($1,$2,$3,'HDFC Bank','7788',$4,'HDFC0001234','current','100000.00','2026-04-01')
     RETURNING id`,
    [t.firmId, t.clientId, A('Bank Accounts'), accountNumberHash('50100123457788')]);
  return r.rows[0]!.id;
});

// The opening bank balance needs a matching ledger entry, or the BRS starts
// out of balance by that amount and every later difference is masked.
await withFirm(t.firmId, async (c) => {
  const v = await c.query<{ id: string }>(
    `INSERT INTO vouchers (firm_id, client_id, voucher_type, voucher_number,
                           posting_date, fiscal_year_id, narration, created_by)
     VALUES ($1,$2,'opening','OPN/00001','2026-04-01',$3,'Opening balances',$4)
     RETURNING id`,
    [t.firmId, t.clientId, t.fiscalYearId, t.userId]);
  for (const [account, debit, credit] of [
    [A('Bank Accounts'), '100000.00', '0'],
    [A("Owner's Capital"), '0', '100000.00'],
  ] as const) {
    await c.query(
      `INSERT INTO ledger_entries (firm_id, client_id, voucher_id, line_no,
         posting_date, fiscal_year_id, account_id, debit, credit, is_opening)
       VALUES ($1,$2,$3,$4,'2026-04-01',$5,$6,$7,$8,true)`,
      [t.firmId, t.clientId, v.rows[0]!.id,
       account === A('Bank Accounts') ? 1 : 2, t.fiscalYearId, account, debit, credit]);
  }
});

// --- customers -------------------------------------------------------------
const party = async (name: string, legal: string, pan: string): Promise<string> =>
  withFirm(t.firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name, gstin,
                            gst_category, state_code, ledger_account_id, created_by)
       VALUES ($1,$2,'customer',$3,$4,$5,'registered_regular','27',$6,$7) RETURNING id`,
      [t.firmId, t.clientId, name, legal, gstin('27', pan), A('Debtors'), t.userId]);
    return r.rows[0]!.id;
  });

const acme = await party('Acme Trading', 'Acme Trading Pvt Ltd', 'AABCA4444P');
const bharat = await party('Bharat Steel', 'Bharat Steel Industries', 'AABCB5555Q');
const nova = await party('Nova Consulting', 'Nova Consulting LLP', 'AABCN6666R');

// --- invoices --------------------------------------------------------------
const line = (description: string, unitPrice: string, gstRate: string, hsn: string) =>
  ({ description, hsnSac: hsn, quantity: '1', unitPrice, gstRate,
     incomeAccountId: A('Sales') });

const inv = async (
  partyId: string, date: string, price: string, rate: string,
  description: string, hsn: string, expectedReference?: string,
): Promise<{ voucherId: string; grandTotal: string }> => {
  const r = await createInvoice(t.firmId, {
    clientId: t.clientId, partyId, postingDate: date,
    lines: [line(description, price, rate, hsn)], createdBy: t.userId,
  });
  if (expectedReference) {
    await withFirm(t.firmId, (c) => c.query(
      'UPDATE sales_invoices SET expected_reference = $2 WHERE voucher_id = $1',
      [r.voucherId, expectedReference]));
  }
  return r;
};

// The customer quoted this UTR when confirming payment — layer 1, exact.
const i1 = await inv(bharat, '2026-04-03', '40000', '18', 'MS plates', '7208',
  'HDFCR52026041012345');
// Two identical invoices, same customer — the ambiguity case.
const i2 = await inv(acme, '2026-04-05', '10000', '18', 'Fasteners — April', '7318');
const i3 = await inv(acme, '2026-04-06', '10000', '18', 'Fasteners — restock', '7318');
// Professional fees: the customer will deduct 10% TDS on the taxable value.
const i4 = await inv(nova, '2026-04-08', '50000', '18', 'Advisory retainer', '998311');
// This one gets a part payment only.
const i5 = await inv(bharat, '2026-04-12', '25000', '0', 'Scrap sale', '7204');

// --- the statement ---------------------------------------------------------
// Every figure is derived from the invoices above, so BR-6 passes and the
// matcher has something real to work against.
const rows: Array<[string, string, string, string, string]> = [
  // date, narration, ref, withdrawal, deposit
  ['02/04/26', 'BY CASH - BRANCH 0234', '', '', '15,000.00'],
  ['10/04/26', 'NEFT-HDFCR52026041012345-BHARAT STEEL INDUSTRIES-UTR HDFCR52026041012345', '', '', '47,200.00'],
  ['14/04/26', 'UPI/402612345678/Payment from/acme@okhdfcbank/UPI', '', '', '11,800.00'],
  ['18/04/26', 'NEFT-CITIN52026041812345-NOVA CONSULTING LLP', '', '', '54,000.00'],
  ['21/04/26', 'RTGS-HDFCR52026042199999-BHARAT STEEL INDUSTRIES', '', '', '10,000.00'],
  ['25/04/26', 'SMS CHARGES 04/2026 + GST', '', '118.00', ''],
  ['28/04/26', 'INT.PD:01-01-2026 TO 31-03-2026', '', '', '9,000.00'],
  ['30/04/26', 'CHQ PAID - 445566', '445566', '5,000.00', ''],
];

let balance = 100_000_00n;
const csv: string[] = [
  'Statement of account',
  'Account Number:,50100123457788',
  'Account Branch:,ANDHERI EAST MUMBAI',
  'Period:,01/04/26 to 30/04/26',
  'Opening Balance:,"1,00,000.00"',
  '',
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
];

const toPaise = (v: string): bigint =>
  v === '' ? 0n : BigInt(v.replace(/[,.]/g, ''));
const fmt = (p: bigint): string => {
  const whole = (p / 100n).toString();
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${grouped}.${String(p % 100n).padStart(2, '0')}`;
};

for (const [date, narration, ref, wdl, dep] of rows) {
  balance = balance - toPaise(wdl) + toPaise(dep);
  csv.push([
    date, `"${narration}"`, ref, date,
    wdl ? `"${wdl}"` : '', dep ? `"${dep}"` : '', `"${fmt(balance)}"`,
  ].join(','));
}
csv.push('', `Closing Balance:,"${fmt(balance)}"`, '*** End of statement ***');

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../sample-statement.csv');
writeFileSync(out, csv.join('\n') + '\n', 'utf8');

console.log(`
  firm            ${t.firmId}
  client          ${t.clientId}
  bank account    ${bankAccountId}

  invoices
    ${i1.voucherId}  ${i1.grandTotal.padStart(10)}  Bharat Steel   UTR quoted — exact match
    ${i2.voucherId}  ${i2.grandTotal.padStart(10)}  Acme Trading   identical pair, ambiguous
    ${i3.voucherId}  ${i3.grandTotal.padStart(10)}  Acme Trading   identical pair, ambiguous
    ${i4.voucherId}  ${i4.grandTotal.padStart(10)}  Nova           will arrive net of 10% TDS
    ${i5.voucherId}  ${i5.grandTotal.padStart(10)}  Bharat Steel   part payment only

  statement       ${out}
  closing balance ${fmt(balance)}

  Next:  npm run web   →  http://127.0.0.1:4321/import
`);

await closePools();
