/**
 * GSTR-1 — the outward-supplies return. invoicing.md §9.
 *
 * The classification decides which box a sale is filed in, and a wrong box is
 * a wrong return, so it is tested exhaustively and on its own.
 */

import { describe, it, expect } from 'vitest';
import { sectionOf, buildGstr1, type Gstr1Invoice } from '../src/domain/gstr1.ts';

const inv = (over: Partial<Gstr1Invoice> = {}): Gstr1Invoice => ({
  voucherId: 'v', invoiceNumber: 'INV-1', invoiceDate: '2026-08-01',
  documentType: 'tax_invoice', customerGstin: null, customerName: 'A Customer',
  placeOfSupply: '09', supplierState: '09', isExport: false, exportType: null,
  reverseCharge: false, grandTotal: '1180.00', taxable: '1000.00',
  igst: '0.00', cgst: '90.00', sgst: '90.00', cess: '0.00',
  items: [{ hsn: '1001', description: 'Goods', uqc: 'NOS', quantity: '1',
    rate: '18', taxable: '1000.00', igst: '0.00', cgst: '90.00', sgst: '90.00',
    cess: '0.00' }],
  ...over,
});

describe('which box a sale is filed in', () => {
  it('a registered customer is B2B', () => {
    expect(sectionOf(inv({ customerGstin: '09AAAAA0000A1Z5' }))).toBe('b2b');
  });
  it('a small consumer sale is B2CS', () => {
    expect(sectionOf(inv())).toBe('b2cs');
  });
  it('a large inter-state consumer sale is B2CL', () => {
    // No GSTIN, POS differs from supplier state, over 2.5 lakh.
    expect(sectionOf(inv({ placeOfSupply: '27', supplierState: '09',
      grandTotal: '300000.00' }))).toBe('b2cl');
  });
  it('a large INTRA-state consumer sale is still B2CS', () => {
    // The threshold is inter-state only; same-state stays summarised.
    expect(sectionOf(inv({ placeOfSupply: '09', supplierState: '09',
      grandTotal: '300000.00' }))).toBe('b2cs');
  });
  it('an export is EXP even to a registered buyer', () => {
    expect(sectionOf(inv({ isExport: true, customerGstin: '09AAAAA0000A1Z5' })))
      .toBe('exp');
  });
  it('a credit note is CDNR whatever it adjusts', () => {
    expect(sectionOf(inv({ documentType: 'credit_note',
      customerGstin: '09AAAAA0000A1Z5' }))).toBe('cdnr');
  });
});

describe('assembling the return', () => {
  it('groups B2B by customer and totals the liability', () => {
    const g = buildGstr1('2026-08', [
      inv({ customerGstin: '09AAAAA0000A1Z5', customerName: 'Acme' }),
      inv({ customerGstin: '09AAAAA0000A1Z5', invoiceNumber: 'INV-2' }),
      inv({ customerGstin: '27BBBBB1111B1Z4', customerName: 'Beta' }),
    ]);
    expect(g.b2b).toHaveLength(2);                    // two customers
    expect(g.b2b.find((c) => c.ctin === '09AAAAA0000A1Z5')!.invoices).toHaveLength(2);
    expect(g.summary.documents).toBe(3);
    expect(g.summary.totalTax).toBe('540.00');        // 3 × (90 + 90)
  });

  it('summarises B2CS by place of supply and rate', () => {
    const g = buildGstr1('2026-08', [
      inv({ placeOfSupply: '09' }),
      inv({ placeOfSupply: '09', invoiceNumber: 'INV-2' }),
      inv({ placeOfSupply: '27', supplierState: '27',
        igst: '0.00', cgst: '90.00', sgst: '90.00' }),
    ]);
    // Two POS groups; the 09 group merged two invoices at 18%.
    expect(g.b2cs).toHaveLength(2);
    const up = g.b2cs.find((r) => r.pos === '09')!;
    expect(up.taxable).toBe('2000.00');
  });

  it('rolls up the HSN summary across every section', () => {
    const g = buildGstr1('2026-08', [
      inv({ items: [{ hsn: '1001', description: 'X', uqc: 'NOS', quantity: '2',
        rate: '18', taxable: '1000.00', igst: '0', cgst: '90', sgst: '90', cess: '0' }] }),
      inv({ customerGstin: '09AAAAA0000A1Z5', items: [{ hsn: '1001',
        description: 'X', uqc: 'NOS', quantity: '3', rate: '18',
        taxable: '500.00', igst: '0', cgst: '45', sgst: '45', cess: '0' }] }),
    ]);
    expect(g.hsn).toHaveLength(1);                    // same HSN + rate
    expect(g.hsn[0]!.quantity).toBe('5');             // 2 + 3
    expect(g.hsn[0]!.taxable).toBe('1500.00');
  });
});
