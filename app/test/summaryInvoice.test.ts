/**
 * Invoices with no line items on their face — bills-and-expenses.md BE-18.
 *
 * This reader grades a document's own stated totals, which is a weaker kind of
 * evidence than a table of rows that sums. It is only safe because the
 * document must first DECLARE that it has no rows. So most of what is tested
 * here is the declaration gate and the ways the reader must refuse — not the
 * happy path, which is one test.
 *
 * The fixture below reproduces the LAYOUT of a real large-supplier invoice —
 * the label wording and the order of the lines, which is what the reader keys
 * on. Every figure, the invoice number and the party are invented: real client
 * documents and their contents stay out of this repo.
 */

import { describe, it, expect } from 'vitest';
import { annexureReference, readSummaryInvoice } from '../src/parse/summaryInvoice.ts';

const SUMMARY_INVOICE = `
                              TAX INVOICE
INVOICE NO :   AB1000000001       INVOICE DATE :   16-JUL-2026
Whether the tax is payable on Reverse Charge Basis: No
P.O.NO.                    :   Detail as per Annexure Attached.
Item Code                  :   Detail as per Annexure Attached.
Quantity                   :   Detail as per Annexure Attached.
HSN code                   :   Detail as per Annexure Attached.
Unit of Measurement        :   Detail as per Annexure Attached.
Total Basic Amount         :   12,34,567.00
Total Taxable Value        :   12,34,567.00
CGST                       :   0.00
SGST                       :   0.00
IGST                       :   2,22,222.06
Total (GST)                :   2,22,222.06
Total (Basic Amt + GST) (Rs.) : 14,56,789.06
Tax Collection at Source @ :   0.00
Total Invoice Amount (Rs.) :   14,56,789.06
`;

describe('reading an invoice whose items are in an annexure', () => {
  it('reads the stated totals and ties them', () => {
    const s = readSummaryInvoice(SUMMARY_INVOICE, 'yes');
    expect(s?.table.readable).toBe(true);
    expect(s?.table.sums).toMatchObject({
      taxable: '1234567.00', cgst: '0.00', sgst: '0.00',
      igst: '222222.06', total: '1456789.06',
    });
  });

  it('says on the record that the item detail was never seen', () => {
    const s = readSummaryInvoice(SUMMARY_INVOICE, 'yes');
    expect(s?.table.warnings?.join(' ')).toMatch(/no line items on its face/);
  });

  it('does not mistake the restated taxable value for a second amount', () => {
    // "Total Basic Amount" and "Total Taxable Value" are the same 12,34,567 —
    // summing both would double the taxable value and still leave the tax
    // looking plausible.
    const s = readSummaryInvoice(SUMMARY_INVOICE, 'yes');
    expect(s?.table.sums.taxable).toBe('1234567.00');
  });
});

describe('the declaration gate', () => {
  it('refuses to apply when the document never says its items are elsewhere', () => {
    // The same figures, no annexure language. This is the important one: it is
    // what stops the reader becoming a way to skip a table that read badly by
    // trusting the total underneath it.
    const noDeclaration = SUMMARY_INVOICE.replace(/Detail as per Annexure Attached\./g, '-');
    expect(readSummaryInvoice(noDeclaration, 'yes')).toBeNull();
  });

  it('is not tripped by an annexure mentioned in the terms', () => {
    const terms = SUMMARY_INVOICE.replace(/Detail as per Annexure Attached\./g, '-')
      + '\n8. Rates are as per annexure to the supply agreement.\n';
    expect(readSummaryInvoice(terms, 'yes')).toBeNull();
  });

  it('wants more than one item field deferred before it believes there are none', () => {
    const onlyPo = `
P.O.NO.             :   Detail as per Annexure Attached.
Total Taxable Value :   12,34,567.00
IGST                :   2,22,222.06
Total Invoice Amount:   14,56,789.06
`;
    expect(annexureReference(onlyPo)).toBeNull();
    expect(readSummaryInvoice(onlyPo, 'yes')).toBeNull();
  });

  it('names which fields were deferred, for the reviewer', () => {
    expect(annexureReference(SUMMARY_INVOICE)?.deferredFields)
      .toEqual(expect.arrayContaining(['Item Code', 'Quantity', 'HSN code']));
  });
});

describe('what it still refuses', () => {
  it('refuses when the stated figures do not add up', () => {
    const wrong = SUMMARY_INVOICE.replace('14,56,789.06', '14,56,999.06');
    const s = readSummaryInvoice(wrong, 'yes');
    expect(s).not.toBeNull();
    expect(s!.table.readable).toBe(false);
  });

  it('refuses when the same figure is stated twice with different values', () => {
    const conflict = SUMMARY_INVOICE.replace('Total Basic Amount         :   12,34,567.00',
                                  'Total Basic Amount         :   12,34,000.00');
    const s = readSummaryInvoice(conflict, 'yes');
    expect(s!.table.readable).toBe(false);
    expect(s!.table.reason).toMatch(/disagree/);
  });

  it('refuses when the stated total tax contradicts its own components', () => {
    // An independent statement of the same fact. If it disagrees, a component
    // was misread — even where the grand total happens to still tie.
    const conflict = SUMMARY_INVOICE.replace('Total (GST)                :   2,22,222.06',
                                  'Total (GST)                :   2,22,999.06');
    const s = readSummaryInvoice(conflict, 'yes');
    expect(s!.table.readable).toBe(false);
    expect(s!.table.reason).toMatch(/states its tax twice/);
  });

  it('does not read a rate as an amount', () => {
    const withRate = SUMMARY_INVOICE.replace('IGST                       :   2,22,222.06',
                                  'IGST Rate                  :   18.00\n'
                                  + 'IGST                       :   2,22,222.06');
    const s = readSummaryInvoice(withRate, 'yes');
    expect(s?.table.readable).toBe(true);
    expect(s?.table.sums.igst).toBe('222222.06');
  });

  it('ignores a labelled line carrying more than one figure', () => {
    // Two numbers after the separator means the line was not understood, and
    // picking one of them would be a guess.
    const ambiguous = SUMMARY_INVOICE.replace('Total Invoice Amount (Rs.) :   14,56,789.06',
                                   'Total Invoice Amount (Rs.) :   14,56,789.06  14,56,789.06');
    // The remaining "Total (Basic Amt + GST)" still states the total, so the
    // document is readable — but on the figure that WAS understood.
    const s = readSummaryInvoice(ambiguous, 'yes');
    expect(s?.table.sums.total).toBe('1456789.06');
  });
});
