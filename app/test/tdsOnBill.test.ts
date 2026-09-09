/**
 * TDS proposed on a read bill — bills-and-expenses.md BE-36.
 *
 * `bills.test.ts` covers the ledger and the gate. This covers the half that
 * decides whether a CA ever SEES the deduction: the section is picked by how
 * the spend is classified, and classification happens on the review screen
 * after the document has been read. A question asked against the wrong account
 * is no question at all.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, registerGstin, type SeededTenant } from '../src/seed/index.ts';
import { seedItcEligibility } from '../src/seed/tdsSections.ts';
import { proposeFromDocument, postProposal } from '../src/domain/billProposal.ts';
import { entityTypeFromPan } from '../src/domain/tdsOnBill.ts';
import { splitDocuments } from '../src/parse/documentSplit.ts';
import { wordsToRows, type Word, type WordPage } from '../src/parse/pdfWords.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { ownerPool, closePools } from '../src/db/pool.ts';

const gstin = (state: string, pan: string) => {
  const f = `${state}${pan}1Z`;
  return f + gstinCheckDigit(f);
};
const OUR_GSTIN = gstin('09', 'AAACT1111T');
const CONSULTANT = gstin('09', 'AACCK2222K');   // 4th char C — a company

let t: SeededTenant;
const acct: Record<string, string> = {};
let consultant: string;

const w = (text: string, xMin: number, yMin: number): Word =>
  ({ text, xMin, xMax: xMin + text.length * 3.3, yMin, yMax: yMin + 6.6 });

const page = (taxable: string, tax: string, total: string): WordPage[] => [{
  number: 1, width: 600, height: 800,
  rows: wordsToRows([
    w('Qty', 40, 100), w('Taxable', 90, 100), w('IGST', 200, 100), w('Total', 280, 100),
    w('1', 40, 130), w(taxable, 90, 130), w(tax, 200, 130), w(total, 280, 130),
  ]),
}];

const doc = (number: string) => splitDocuments(
  `Tax Invoice\nInvoice Number # ${number}\nInvoice Date : 27-08-2026\n`
  + `GSTIN - ${CONSULTANT}\nIGST 18 %\n`
  + 'Whether tax is payable under reverse charge - No')[0]!;

const propose = (
  segment: ReturnType<typeof doc>, pages: WordPage[],
  extra: Partial<Parameters<typeof proposeFromDocument>[1]> = {},
) => proposeFromDocument(t.firmId,
  { clientId: t.clientId, createdBy: t.userId,
    expenseAccountId: acct['Purchases']!, ...extra },
  segment, pages, 'c'.repeat(64));

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  t = await seedTenant({
    firmName: `Tds ${tag}`, clientName: `Client ${tag}`,
    userEmail: `tds-${tag}@example.test`, startYear: 2026,
    pan: 'AAACT1111T', businessType: 'general',
  });
  await seedItcEligibility(t.clientId);
  await registerGstin(t.firmId, t.clientId, OUR_GSTIN, { primary: true });

  const r = await ownerPool.query<{ id: string; name: string }>(
    `SELECT id, name FROM accounts WHERE client_id = $1 AND NOT is_group
       AND name IN ('Purchases','Professional Fees','Contract Payments',
                    'Commission and Brokerage','Office Rent','Creditors',
                    'Travel Expenses')`, [t.clientId]);
  for (const a of r.rows) acct[a.name] = a.id;

  consultant = (await ownerPool.query<{ id: string }>(
    `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name, gstin,
                          gst_category, state_code, ledger_account_id, created_by)
     VALUES ($1,$2,'supplier','Kapoor Advisory','Kapoor Advisory',$3,
             'registered_regular','09',$4,$5) RETURNING id`,
    [t.firmId, t.clientId, CONSULTANT, acct['Creditors'], t.userId])).rows[0]!.id;
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('the payee type, read out of their PAN', () => {
  it('splits individual and HUF from everyone else', () => {
    /*
     * The fourth character of a PAN encodes the holder's constitution, and the
     * rate tables split on exactly that line: a contractor's bill is 1% for an
     * individual or HUF and 2% for anyone else. HUF belongs with individuals,
     * which is easy to get wrong because it is neither.
     */
    expect(entityTypeFromPan('AAAPK1234A')).toBe('individual');   // P — person
    expect(entityTypeFromPan('AAAHK1234A')).toBe('individual');   // H — HUF
    expect(entityTypeFromPan('AAACK1234A')).toBe('company');
    expect(entityTypeFromPan('AAAFK1234A')).toBe('company');      // firm / LLP
    expect(entityTypeFromPan('AAATK1234A')).toBe('company');      // trust
  });

  it('treats an absent or malformed PAN as no-PAN, which is the punitive rate', () => {
    // s.206AA, not a penalty invented for missing data. Over-deducting is
    // recoverable by the payee in their return; under-deducting is the
    // client's own liability plus interest.
    expect(entityTypeFromPan(null)).toBe('no_pan');
    expect(entityTypeFromPan('')).toBe('no_pan');
    expect(entityTypeFromPan('NOTAPAN')).toBe('no_pan');
    expect(entityTypeFromPan('AAAC1234KA')).toBe('no_pan');       // digits misplaced
  });
});

// ---------------------------------------------------------------------------
describe('proposing the deduction', () => {
  it('says nothing on a head that attracts no TDS', async () => {
    // The default, and it must stay silent: a prompt on every grocery bill
    // would make the feature the first thing a CA switches off.
    const p = await propose(doc('KA/1'), page('100000.00', '18000.00', '118000.00'));
    expect(p.tds).toBeNull();
    expect(p.confirmations.map((c) => c.field)).not.toContain('tds_deduction');
  });

  it('asks once the reviewer classifies the line to a TDS head', async () => {
    /*
     * The sequencing this exists for. On a fresh upload every line points at
     * the default head, so nothing attracts TDS; the reviewer then moves it to
     * Professional Fees, and only THEN is 10% due. The accounts are threaded
     * into the proposal so the question is asked about the head being posted
     * to rather than the one the parser happened to default to.
     */
    const p = await propose(doc('KA/2'), page('100000.00', '18000.00', '118000.00'),
      { lineAccounts: [acct['Professional Fees']!] });

    expect(p.tds?.category).toBe('Professional Fees');
    expect(p.tds?.computation?.tdsAmount).toBe('10000.00');
    // 10% of the taxable value, not of the 1,18,000 total — TDS is deducted
    // excluding GST where the GST is shown separately (Circular 23/2017).
    expect(p.tds?.base).toBe('100000.00');

    const q = p.confirmations.find((c) => c.field === 'tds_deduction');
    expect(q).toBeDefined();
    expect(q!.question).toMatch(/10000\.00 is deductible/);
    expect(q!.question).toMatch(/Circular 23\/2017/);
    expect(q!.instead).toMatch(/post gross/);
  });

  it('reads the payee type out of the GSTIN when no PAN column is filled', async () => {
    // A GSTIN is <state><PAN><entity><Z><check>, so the PAN is already on file.
    // Without this every registered vendor would take the 20% punitive rate.
    const p = await propose(doc('KA/3'), page('100000.00', '18000.00', '118000.00'),
      { lineAccounts: [acct['Professional Fees']!] });
    expect(p.tds?.entityType).toBe('company');
    expect(p.tds?.computation?.rate).toBe('10.000');
  });

  it('refuses to post until the question is answered', async () => {
    const p = await propose(doc('KA/4'), page('100000.00', '18000.00', '118000.00'),
      { lineAccounts: [acct['Professional Fees']!] });
    await expect(postProposal(t.firmId, p, { approvedBy: t.userId }))
      .rejects.toThrow(/questions that have to be answered/);
  });

  it('withholds when the answer is yes', async () => {
    const p = await propose(doc('KA/5'), page('100000.00', '18000.00', '118000.00'),
      { lineAccounts: [acct['Professional Fees']!] });
    const q = p.confirmations.find((c) => c.field === 'tds_deduction')!;
    const bill = await postProposal(t.firmId, p, {
      approvedBy: t.userId, confirm: { tds_deduction: q.chose },
    });
    expect(bill.tds?.amount).toBe('10000.00');
    expect(bill.tds?.category).toBe('Professional Fees');
  });

  it('posts gross when the answer is no, and records the shortfall', async () => {
    const p = await propose(doc('KA/6'), page('50000.00', '9000.00', '59000.00'),
      { lineAccounts: [acct['Professional Fees']!] });
    const q = p.confirmations.find((c) => c.field === 'tds_deduction')!;
    const bill = await postProposal(t.firmId, p, {
      approvedBy: t.userId, confirm: { tds_deduction: q.instead },
    });
    expect(bill.tds).toBeNull();
    expect(bill.warnings.join(' ')).toMatch(/was NOT withheld/);
  });

  it('will not deduct two sections on one bill', async () => {
    /*
     * A bill mixing professional fees with a commission would resolve two
     * sections at two rates with two running thresholds, and nothing
     * downstream — certificate, return, challan — is built for a single credit
     * carrying two deductions. Reported rather than half-deducted.
     */
    const p = await propose(
      doc('KA/7'),
      [{ number: 1, width: 600, height: 800, rows: wordsToRows([
        w('Qty', 40, 100), w('Taxable', 90, 100), w('IGST', 200, 100), w('Total', 280, 100),
        // Deliberately different figures: two identical rows and the reader
        // takes the second for a restatement of the total, leaving one line.
        w('1', 40, 130), w('60000.00', 90, 130), w('10800.00', 200, 130), w('70800.00', 280, 130),
        w('1', 40, 160), w('30000.00', 90, 160), w('5400.00', 200, 160), w('35400.00', 280, 160),
      ]) }],
      { lineAccounts: [acct['Professional Fees']!, acct['Commission and Brokerage']!] });

    expect(p.tds?.mixedHeads.length).toBe(2);
    expect(p.tds?.computation).toBeNull();
    expect(p.warnings.join(' ')).toMatch(/deducted under different TDS sections/);
    // And no question, because there is no single answer to give.
    expect(p.confirmations.map((c) => c.field)).not.toContain('tds_deduction');
  });

  it('deducts only the lines whose own head attracts TDS', async () => {
    // A bill mixing fees with reimbursed travel is common, and deducting on
    // the whole of it would withhold tax on a reimbursement that bears none.
    const p = await propose(
      doc('KA/8'),
      [{ number: 1, width: 600, height: 800, rows: wordsToRows([
        w('Qty', 40, 100), w('Taxable', 90, 100), w('IGST', 200, 100), w('Total', 280, 100),
        w('1', 40, 130), w('100000.00', 90, 130), w('18000.00', 200, 130), w('118000.00', 280, 130),
        w('1', 40, 160), w('40000.00', 90, 160), w('7200.00', 200, 160), w('47200.00', 280, 160),
      ]) }],
      { lineAccounts: [acct['Professional Fees']!, acct['Travel Expenses']!] });

    expect(p.tds?.base).toBe('100000.00');       // not 1,40,000
  });
});
