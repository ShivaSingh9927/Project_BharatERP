/**
 * Reconciling the books against GSTR-2B — bills-and-expenses.md §5.
 *
 * The whole value is in the four situations every invoice can be in, and in
 * refusing to fabricate a match. Every fixture is a real reconciliation shape.
 */

import { describe, it, expect } from 'vitest';
import {
  reconcile, normaliseInvoiceNumber,
  type LedgerBill, type Gstr2bInvoice,
} from '../src/domain/gstr2b.ts';
import { parseGstr2b } from '../src/integrations/gstr2bJson.ts';

const bill = (o: Partial<LedgerBill> = {}): LedgerBill => ({
  voucherId: 'v1', supplierGstin: '09AAKCC1645G1ZN', billNumber: 'INV/2024/0042',
  billDate: '2026-08-17', taxableValue: '1000.00', totalTax: '180.00',
  grandTotal: '1180.00', ...o,
});

const filed = (o: Partial<Gstr2bInvoice> = {}): Gstr2bInvoice => ({
  supplierGstin: '09AAKCC1645G1ZN', invoiceNumber: 'INV/2024/0042',
  invoiceDate: '2026-08-17', taxableValue: '1000.00',
  igst: '180.00', cgst: '0.00', sgst: '0.00', cess: '0.00', total: '1180.00',
  itcAvailable: true, itcReason: null, ...o,
});

const only = (lines: ReturnType<typeof reconcile>, s: string) =>
  lines.filter((l) => l.status === s);

describe('normalising an invoice number', () => {
  it('reduces two spellings of the same number to one key', () => {
    // The case that strands a real credit if missed.
    expect(normaliseInvoiceNumber('INV/2024/0042'))
      .toBe(normaliseInvoiceNumber('INV-2024-42'));
  });
  it('strips leading zeros per segment but keeps distinct numbers distinct', () => {
    expect(normaliseInvoiceNumber('0042')).toBe('42');
    expect(normaliseInvoiceNumber('A/1')).not.toBe(normaliseInvoiceNumber('A/2'));
  });
});

describe('the four situations', () => {
  it('matches an invoice in both, with agreeing figures', () => {
    const r = reconcile([bill()], [filed()]);
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('matched');
    expect(r[0]!.note).toMatch(/credit of 180\.00 is supported/);
  });

  it('matches across different spellings of the number', () => {
    const r = reconcile([bill({ billNumber: 'INV-2024-42' })],
                        [filed({ invoiceNumber: 'INV/2024/0042' })]);
    expect(r[0]!.status).toBe('matched');
  });

  it('flags a bill the supplier has not filed — credit not yet available', () => {
    /*
     * The money case. s.16(2)(aa): booked, tied to the paisa, and still not
     * claimable because the supplier has not filed it.
     */
    const r = reconcile([bill()], []);
    expect(r[0]!.status).toBe('in_books_only');
    expect(r[0]!.note).toMatch(/NOT\s+available/);
    expect(r[0]!.note).toMatch(/s\.16\(2\)\(aa\)/);
  });

  it('flags a filing with no bill — a purchase unrecorded', () => {
    const r = reconcile([], [filed()]);
    expect(r[0]!.status).toBe('in_2b_only');
    expect(r[0]!.note).toMatch(/not in the books/);
  });

  it('flags a match whose money disagrees, rather than claiming it', () => {
    const r = reconcile([bill({ totalTax: '180.00' })],
                        [filed({ igst: '90.00', cgst: '0.00' })]);
    expect(r[0]!.status).toBe('mismatch');
    expect(r[0]!.note).toMatch(/figures differ/);
  });

  it('absorbs a rupee of rounding but not more', () => {
    expect(reconcile([bill()], [filed({ taxableValue: '1000.50' })])[0]!.status)
      .toBe('matched');
    expect(reconcile([bill()], [filed({ taxableValue: '1002.00' })])[0]!.status)
      .toBe('mismatch');
  });

  it('will not claim a matched invoice the department marks unavailable', () => {
    const r = reconcile([bill()],
      [filed({ itcAvailable: false, itcReason: 'filed after the cut-off' })]);
    expect(r[0]!.status).toBe('mismatch');
    expect(r[0]!.note).toMatch(/NOT available.*cut-off/);
  });

  it('matches the same invoice when the number was transcribed differently', () => {
    /*
     * The real case that a naive key misses: books "LIAC75E260000050", 2B
     * "LIAC75E-26-0000050" — the buyer dropped the separators. The numbers
     * cannot be reconciled by rule, but the same supplier, date and amounts
     * are that invoice. Matched, and flagged for a human to confirm.
     */
    const r = reconcile(
      [bill({ billNumber: 'LIAC75E260000050', taxableValue: '8083.90',
              totalTax: '1455.08', billDate: '2026-03-26',
              supplierGstin: '09AAECB9200C3Z1' })],
      [filed({ invoiceNumber: 'LIAC75E-26-0000050', taxableValue: '8083.90',
               igst: '0.00', cgst: '727.54', sgst: '727.54',
               invoiceDate: '2026-03-26', supplierGstin: '09AAECB9200C3Z1' })]);
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('matched');
    expect(r[0]!.note).toMatch(/written differently on each side/);
  });

  it('does not amount-match two different invoices that merely cost the same', () => {
    /*
     * The guard on pass two. Same supplier and amount but DIFFERENT dates are
     * two invoices, not one transcribed twice — so no amount match, and both
     * sides stay unmatched for a human.
     */
    const r = reconcile(
      [bill({ billNumber: 'A-1', billDate: '2026-03-01' })],
      [filed({ invoiceNumber: 'B-2', invoiceDate: '2026-03-15' })]);
    expect(only(r, 'matched')).toHaveLength(0);
    expect(only(r, 'in_books_only')).toHaveLength(1);
    expect(only(r, 'in_2b_only')).toHaveLength(1);
  });

  it('does not match the same number under a different supplier', () => {
    // The GSTIN scopes everything — the same number from another supplier is
    // another invoice.
    const r = reconcile([bill()], [filed({ supplierGstin: '27AAKCC1645G1ZP' })]);
    expect(only(r, 'matched')).toHaveLength(0);
    expect(only(r, 'in_books_only')).toHaveLength(1);
    expect(only(r, 'in_2b_only')).toHaveLength(1);
  });

  it('does not try to match a bill with no GSTIN against 2B', () => {
    // An import of service does not claim ITC through 2B at all.
    const r = reconcile([bill({ supplierGstin: null })], []);
    expect(r[0]!.status).toBe('in_books_only');
    expect(r[0]!.note).toMatch(/cannot appear in 2B/);
  });
});

describe('reading the portal JSON', () => {
  const doc = {
    data: { docdata: { b2b: [
      { ctin: '09AAKCC1645G1ZN', inv: [
        { inum: 'INV/2024/0042', dt: '17-08-2026', val: '1180.00',
          itcavl: 'Y',
          items: [{ itm_det: { txval: 1000, iamt: 180, camt: 0, samt: 0, csamt: 0 } }] },
      ] },
    ] } },
  };

  it('reads a supplier, its invoice, and sums the item tax', () => {
    const [inv, ...rest] = parseGstr2b(doc);
    expect(rest).toHaveLength(0);
    expect(inv!.supplierGstin).toBe('09AAKCC1645G1ZN');
    expect(inv!.invoiceDate).toBe('2026-08-17');       // DD-MM-YYYY -> ISO
    expect(inv!.taxableValue).toBe('1000.00');
    expect(inv!.igst).toBe('180.00');
    expect(inv!.itcAvailable).toBe(true);
  });

  it('carries an ITC-blocked invoice through as blocked', () => {
    const d = structuredClone(doc);
    d.data.docdata.b2b[0]!.inv[0]!.itcavl = 'N';
    (d.data.docdata.b2b[0]!.inv[0] as any).rsn = 'POS and supplier state differ';
    const [inv] = parseGstr2b(d);
    expect(inv!.itcAvailable).toBe(false);
    expect(inv!.itcReason).toMatch(/POS/);
  });

  it('refuses a file that is not a 2B statement', () => {
    expect(() => parseGstr2b({ hello: 'world' })).toThrow(/does not look like/);
  });

  it('reconciles what it parsed against the books end to end', () => {
    const r = reconcile([bill()], parseGstr2b(doc));
    expect(r[0]!.status).toBe('matched');
  });
});
