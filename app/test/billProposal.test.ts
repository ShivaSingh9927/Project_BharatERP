/**
 * Proposing purchase bills from a read document — bills-and-expenses.md §4.4.
 *
 * Almost every test here is about what does NOT get posted. That is the point
 * of the module: reading a figure is the easy half, and deciding whether it is
 * safe to act on is the half that matters.
 *
 * Word boxes and document text are constructed rather than taken from a PDF,
 * so no real invoice content enters the repository. Geometry follows the real
 * measurements (see `pdfWords.test.ts`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, registerGstin, type SeededTenant } from '../src/seed/index.ts';
import { seedItcEligibility } from '../src/seed/tdsSections.ts';
import { proposeFromDocument, postProposal, deriveGstRate } from '../src/domain/billProposal.ts';
import { splitDocuments } from '../src/parse/documentSplit.ts';
import { wordsToRows, type Word, type WordPage } from '../src/parse/pdfWords.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { ownerPool, closePools } from '../src/db/pool.ts';

const gstin = (state: string, pan: string): string => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckDigit(first14);
};

const OUR_GSTIN  = gstin('09', 'AAACC1111C');   // Uttar Pradesh — the client
const SAME_STATE = gstin('09', 'AAACS2222S');   // a UP supplier
const FAR_STATE  = gstin('20', 'AAACF3333F');   // a Jharkhand supplier
const UNKNOWN    = gstin('27', 'AAACU4444U');   // never added as a party

let t: SeededTenant;
let purchases: string;

const w = (text: string, xMin: number, yMin: number,
           width = text.length * 3.3, height = 6.6): Word =>
  ({ text, xMin, xMax: xMin + width, yMin, yMax: yMin + height });

/** A minimal readable table: taxable, IGST or CGST/SGST, and a total. */
const page = (words: Word[]): WordPage[] =>
  [{ number: 1, width: 600, height: 800, rows: wordsToRows(words) }];

const interStateTable = (taxable: string, tax: string, total: string) => page([
  w('Qty', 40, 100), w('Taxable', 90, 100), w('IGST', 200, 100), w('Total', 280, 100),
  w('1', 40, 130), w(taxable, 90, 130), w(tax, 200, 130), w(total, 280, 130),
]);

const intraStateTable = () => page([
  w('Qty', 40, 100), w('Taxable', 90, 100), w('CGST', 200, 100),
  w('SGST', 260, 100), w('Total', 330, 100),
  w('1', 40, 130), w('1000.00', 90, 130), w('90.00', 200, 130),
  w('90.00', 260, 130), w('1180.00', 330, 130),
]);

const doc = (supplier: string | null, number: string, taxLine: string) =>
  splitDocuments(
    `Tax Invoice\nInvoice Number # ${number}\n`
    + (supplier ? `GSTIN - ${supplier}\n` : '')
    + `${taxLine}\nWhether tax is payable under reverse charge - No`)[0]!;

const propose = (segment: ReturnType<typeof doc>, pages: WordPage[]) =>
  proposeFromDocument(t.firmId,
    { clientId: t.clientId, createdBy: t.userId, expenseAccountId: purchases },
    segment, pages, 'a'.repeat(64));

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  t = await seedTenant({
    firmName: `Proposal ${tag}`, clientName: `Client ${tag}`,
    userEmail: `proposal-${tag}@example.test`, startYear: 2026,
    pan: 'AAACC1111C', businessType: 'general',
  });
  await seedItcEligibility(t.clientId);
  await registerGstin(t.firmId, t.clientId, OUR_GSTIN, { primary: true });

  purchases = (await ownerPool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE client_id = $1 AND name = 'Purchases'`,
    [t.clientId])).rows[0]!.id;

  const creditors = (await ownerPool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE client_id = $1 AND name = 'Creditors'`,
    [t.clientId])).rows[0]!.id;

  for (const [name, g] of [['Near Supplier', SAME_STATE], ['Far Supplier', FAR_STATE]] as const) {
    await ownerPool.query(
      `INSERT INTO parties (firm_id, client_id, party_type, name, gstin,
                            gst_category, state_code, ledger_account_id, created_by)
       VALUES ($1,$2,'supplier',$3,$4,'registered_regular',$5,$6,$7)`,
      [t.firmId, t.clientId, name, g, g.slice(0, 2), creditors, t.userId]);
  }
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('deriveGstRate', () => {
  it('picks the scheduled rate that produces the tax', () => {
    expect(deriveGstRate('1000.00', '180.00')).toBe('18');
    expect(deriveGstRate('222.86', '11.14')).toBe('5');
  });

  it('does not invent a rate that is not on the schedule', () => {
    /*
     * The defect this closes. A real Flipkart platform fee of 4.24 carries
     * 0.76 of IGST and the document says 18%. Plain division gives 17.92%,
     * which reproduces 0.76 exactly — 4.24 x 17.92% = 0.7598 and
     * 4.24 x 18% = 0.7632, and both round to the same paise.
     *
     * The tax would still have posted correctly, but the rate is a filed field
     * and 17.92% is not a rate that exists.
     */
    expect(deriveGstRate('4.24', '0.76')).toBe('18');
  });

  it('believes the rate printed on the document over the schedule', () => {
    expect(deriveGstRate('4.24', '0.76', ['18'])).toBe('18');
  });

  it('computes an intra-state rate as two halves rounded separately', () => {
    /*
     * An intra-state supply is taxed at 9% for the centre and 9% for the
     * state, each rounded in its own right. On 105.94 that is 9.53 + 9.53 =
     * 19.06, while a single 18% charge gives 19.07 — a real Flipkart invoice
     * sits on exactly that paisa. Computing it as one charge made 18% look
     * wrong and refused a perfectly good bill.
     */
    expect(deriveGstRate('105.94', '19.06', [], true)).toBe('18');
    expect(deriveGstRate('105.94', '19.06', [], false)).toBeNull();
    expect(deriveGstRate('105.94', '19.07', [], false)).toBe('18');
  });

  it('reports zero tax as a zero rate, not as unknown', () => {
    // A bill of supply charges nothing, and that is a stated fact.
    expect(deriveGstRate('66.00', '0')).toBe('0');
  });

  it('refuses a rate that does not divide back to the exact paise', () => {
    /*
     * `createBill` recomputes tax from this rate, so an approximate one
     * produces a bill that disagrees with the paper by a rounding error nobody
     * could explain a year later. A tax that will not divide cleanly usually
     * means two rates on one document.
     */
    expect(deriveGstRate('1000.00', '123.45')).toBeNull();
  });

  it('refuses when there is no taxable value to divide by', () => {
    expect(deriveGstRate('0.00', '180.00')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('what will not be posted', () => {
  it('refuses an unknown supplier instead of creating one', () => {
    /*
     * A party carries a GSTIN, a state and a ledger account. Creating one from
     * a PDF would put an unreviewed master record behind every future bill
     * from that vendor.
     */
    return propose(doc(UNKNOWN, 'P1', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00')).then((p) => {
      expect(p.input).toBeNull();
      expect(p.blockers.join(' ')).toMatch(/no supplier is on file with GSTIN/);
    });
  });

  it('refuses a GSTIN that fails its check digit, even if a party matched', async () => {
    // Nothing else catches a corrupted identifier: every arithmetic test
    // passes on a transposed GSTIN.
    const broken = SAME_STATE.slice(0, 14) + (SAME_STATE[14] === 'A' ? 'B' : 'A');
    const p = await propose(doc(broken, 'P2', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/is not valid/);
  });

  it('refuses a document with no supplier GSTIN, pointing at reverse charge', async () => {
    // A foreign supplier: a valid bill, an import of service, and one whose
    // tax the recipient owes. Not an error — just not postable unattended.
    const p = await propose(doc(null, 'P3', 'Subscription 929.00'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/import of service/);
  });

  it('refuses when the table did not tie', async () => {
    const p = await propose(doc(SAME_STATE, 'P4', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '9999.00'));
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/could not be read.*does not add up/s);
  });

  it('refuses when no single rate explains the figures', async () => {
    const p = await propose(doc(SAME_STATE, 'P5', 'IGST 18 %'),
      interStateTable('1000.00', '123.45', '1123.45'));
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/no single GST rate explains/);
  });

  it('refuses a document that never said which kind it is', async () => {
    // An Amazon or Zepto heading naming three document types, whose rates
    // could not be read. Input credit must not rest on that.
    const seg = splitDocuments(
      `Tax Invoice/Bill of Supply/Cash Memo\nInvoice Number : P6\n`
      + `GSTIN - ${SAME_STATE}\nSR HSN Qty CGST S/UT GST\n1 30049011 1 2.50% 2.50%`)[0]!;
    const p = await propose(seg, intraStateTable());
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/does not say whether it is a tax invoice/);
  });
});

// ---------------------------------------------------------------------------
describe('posting a ready proposal', () => {
  it('posts, and the figures match the document', async () => {
    const p = await propose(doc(SAME_STATE, 'P10', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.blockers).toEqual([]);
    expect(p.partyName).toBe('Near Supplier');

    const bill = await postProposal(t.firmId, p,
      { billDate: '2026-07-01', approvedBy: t.userId });
    expect(bill.taxableValue).toBe('1000.00');
    expect(bill.totalGst).toBe('180.00');
    expect(bill.grandTotal).toBe('1180.00');
  });

  it('cannot post without naming a human approver (AT-13)', async () => {
    /*
     * Not this module's rule: `vouchers_ai_needs_approver_ck` is a database
     * CHECK that refuses any `ai_proposal` voucher with no approver. The first
     * version of this code omitted it and Postgres rejected all eleven real
     * documents — the control working exactly as designed against the first
     * path that tried to skirt it.
     */
    const p = await propose(doc(SAME_STATE, 'P11', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.input!.createdVia).toBe('ai_proposal');
    expect(p.input!.approvedBy).toBeUndefined();
  });

  it('refuses to post a blocked proposal at all', async () => {
    const p = await propose(doc(UNKNOWN, 'P12', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'));
    await expect(postProposal(t.firmId, p,
      { billDate: '2026-07-01', approvedBy: t.userId }))
      .rejects.toThrow(/not ready to post/);
  });

  it('carries the document’s printed figures through for PB-4 to re-check', async () => {
    // The rate this module derives is verified by code that did not derive it.
    const p = await propose(doc(SAME_STATE, 'P13', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.input!.claimedTotals).toMatchObject({
      igst: '180.00', grandTotal: '1180.00',
    });
  });
});

// ---------------------------------------------------------------------------
describe('the tax split is warned about, not blocked', () => {
  it('accepts CGST+SGST from an out-of-state supplier, with a warning', async () => {
    /*
     * This was a blocker, and it was wrong. A real Flipkart invoice from a
     * Jharkhand supplier charges CGST and SGST to a client registered in UP,
     * and it is correct: the split follows the supplier's state against the
     * PLACE OF SUPPLY, not against the recipient's registration. Blocking it
     * refused a perfectly good bill.
     *
     * It stays a warning because the other explanations — a supplier master
     * with the wrong state, or a vendor charging the wrong tax — survive every
     * arithmetic check, and claiming CGST+SGST on an inter-state supply is a
     * claim against the wrong government.
     */
    const p = await propose(
      doc(FAR_STATE, 'P20', 'Item CGST 9 % SGST 9 %'), intraStateTable());
    expect(p.blockers).toEqual([]);
    expect(p.warnings.join(' ')).toMatch(/check the place of supply/);

    const bill = await postProposal(t.firmId, p,
      { billDate: '2026-07-01', approvedBy: t.userId });
    expect(bill.grandTotal).toBe('1180.00');
  });

  it('says nothing when the split agrees with the states', async () => {
    const p = await propose(
      doc(SAME_STATE, 'P21', 'Item CGST 9 % SGST 9 %'), intraStateTable());
    expect(p.warnings.join(' ')).not.toMatch(/place of supply/);
  });
});
