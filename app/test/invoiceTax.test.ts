/**
 * Reading a document's tax profile — bills-and-expenses.md §4.2.
 *
 * The fixtures reproduce how each vendor lays out its tax information, because
 * that layout is the entire difficulty: two of the six vendors in the corpus
 * never put a tax name and its rate on the same line, and no amount of pattern
 * matching over running text will join them.
 *
 * Identifiers and amounts are replaced throughout. No real invoice content.
 */

import { describe, it, expect } from 'vitest';
import { splitDocuments } from '../src/parse/documentSplit.ts';
import { extractTaxProfile, taxProfileWarnings } from '../src/parse/invoiceTax.ts';

const one = (text: string) => {
  const segs = splitDocuments(text);
  expect(segs).toHaveLength(1);
  return { seg: segs[0]!, profile: extractTaxProfile(segs[0]!) };
};

// ---------------------------------------------------------------------------
describe('which taxes the document names', () => {
  it('reads IGST as an inter-state supply', () => {
    const { profile } = one(
      'Tax Invoice\nInvoice Number # A1\nSAC: 998599   Platform Fee   IGST: 18.0 %');
    expect(profile.taxKind).toBe('inter');
    expect(profile.charged).toBe('yes');
    expect(profile.rates).toEqual(['18']);
  });

  it('reads CGST and SGST as an intra-state supply', () => {
    const { profile } = one(
      'Tax Invoice\nInvoice Number # A2\nItem  CGST 9.00 %  SGST 9.00 %');
    expect(profile.taxKind).toBe('intra');
    expect(profile.charged).toBe('yes');
    expect(profile.rates).toEqual(['9']);
  });

  it('treats UTGST as the SGST half, not as a third tax', () => {
    const { profile } = one(
      'Tax Invoice\nInvoice Number # A3\nItem  CGST 9 %  UTGST 9 %');
    expect(profile.taxKind).toBe('intra');
  });

  it('normalises 18, 18.0 and 18.00 to one rate', () => {
    const { profile } = one(
      'Tax Invoice\nInvoice Number # A4\nIGST 18 %\nIGST: 18.0 %\nIGST 18.00%');
    expect(profile.rates).toEqual(['18']);
  });

  it('names no tax on a foreign invoice, and that is not an error', () => {
    // An import of service: no GSTIN, no GST, and a valid bill all the same.
    const { seg, profile } = one(
      'Invoice\nInvoice number F1\nExample Subscription  1  Rs 929.00');
    expect(profile.taxKind).toBe('none');
    expect(profile.charged).toBe('no');
    expect(taxProfileWarnings(seg, profile)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('charged is three-valued, and the third value is the point', () => {
  it('an explicit zero rate means charged: no', () => {
    // A Bill of Supply states "CGST 0.0 %". The zero is evidence, not absence.
    const { profile } = one(
      'Bill of Supply\nBill of Supply Number : B1\nGT Charges  CGST 0.0 %  SGST 0.0 %');
    expect(profile.taxKind).toBe('intra');   // the supply is still intra-state
    expect(profile.charged).toBe('no');
  });

  /*
   * The Blinkit layout. The per-cent sign lives in the COLUMN HEADING and the
   * bare number in the cell below, so name and rate never share a line.
   */
  const BLINKIT = `Tax Invoice

Sold By / Seller
EXAMPLE COMMERCE PRIVATE LIMITED
GSTIN                :    09AAACB1111B1Z0        Invoice Number : C1

Sr. no  UPC   Item Description   MRP     Qty  Taxable Value  CGST (%)  CGST (INR)  SGST (%)  SGST (INR)  Total

1       6196  Example Card       8200.00  1   5550.00        9.00      499.50      9.00      499.50      6549.00

Total                                 1                      499.50              499.50                  6549.00
Whether the tax is payable on reverse charge - No`;

  it('reports unreadable when the rate is in a cell and the name in a heading', () => {
    const { profile } = one(BLINKIT);
    expect(profile.taxKind).toBe('intra');       // the names are still readable
    expect(profile.charged).toBe('unreadable');  // the rates are not
    expect(profile.rates).toEqual([]);
  });

  it('raises no contradiction warning when it simply could not read', () => {
    // Before `unreadable` existed this produced "headed Tax Invoice but no GST
    // rate appears on it" — a false alarm on a perfectly ordinary invoice.
    const { seg, profile } = one(BLINKIT);
    expect(taxProfileWarnings(seg, profile)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('resolving a heading that named three document types', () => {
  const AMAZON = `Tax Invoice/Bill of Supply/Cash Memo
GST Registration No: 06AAACA2222A1Z4
Invoice Number : D1

Sl. No  Description   Unit Price  Qty  Net Amount  Tax Rate  Tax Type  Tax Amount  Total
 1      Example Item     2626.27   1     2626.27     18%      IGST       472.73    3099.00`;

  it('resolves to a tax invoice when tax is charged', () => {
    const { profile } = one(AMAZON);
    expect(profile.resolvedKind).toBe('tax_invoice');
    expect(profile.reason).toMatch(/IGST is charged/);
  });

  it('resolves to a bill of supply when nothing is charged anywhere', () => {
    const { profile } = one(
      'Tax Invoice/Bill of Supply/Cash Memo\nInvoice Number : D2\nExample Item   1   500.00');
    expect(profile.resolvedKind).toBe('bill_of_supply');
  });

  /*
   * The Zepto layout, and the failure that made `unreadable` necessary.
   *
   * Zepto names its taxes in a header row and prints the rates in data rows
   * several lines below. It genuinely charges CGST 2.50% + SGST 2.50%. Read as
   * charging nothing, its unspecified heading resolved to `bill_of_supply` —
   * demoting a real tax invoice, which silently destroys an input credit and
   * leaves a confident provenance trail behind the mistake.
   */
  const ZEPTO = `Seller Name: Example Groceries Private Limited
GSTIN: 09AAACZ3333Z1Z2

                          TAX INVOICE/BILL OF SUPPLY

  Invoice No.: E1                        Place Of Supply : UTTAR PRADESH (9)

 SR  Item      Unit                Taxable       S/UT   CGST         Cess   Total
 No  Descr     MRP    HSN    Qty     Amt.  Disc.  GST    Amt.  Amt.   Amt.    Amt.
  1  Example  259.00 08029000  1   246.66  50.19%  122.86  2.50% 2.50%  3.07  129.00`;

  it('leaves the kind unresolved rather than demoting a tax invoice', () => {
    const { profile } = one(ZEPTO);
    expect(profile.taxKind).toBe('intra');
    expect(profile.charged).toBe('unreadable');
    expect(profile.resolvedKind).toBe('unspecified');
  });

  it('says so, loudly, rather than letting it post quietly', () => {
    const { seg, profile } = one(ZEPTO);
    expect(taxProfileWarnings(seg, profile).join(' '))
      .toMatch(/does not say whether it is a tax invoice or a bill of supply/);
  });
});

// ---------------------------------------------------------------------------
describe('the paper is believed over the body', () => {
  it('does not overrule a stated heading, it contradicts it', () => {
    /*
     * A Bill of Supply charging GST is either mislabelled or a supplier error.
     * Silently retyping it as a tax invoice would attach a confident provenance
     * trail to a claim nobody checked — so the heading stands and a human is
     * told.
     */
    const { seg, profile } = one(
      'Bill of Supply\nBill of Supply Number : G1\nItem  IGST 18 %  180.00');
    expect(profile.resolvedKind).toBe('bill_of_supply');
    expect(taxProfileWarnings(seg, profile).join(' '))
      .toMatch(/headed "Bill of Supply" but names GST rates/);
  });
});

// ---------------------------------------------------------------------------
describe('reverse charge', () => {
  it.each([
    ['Whether tax is payable under reverse charge - No', false],
    ['Whether GST is payable on reverse-charge - No.', false],
    ['Is the supply subject to reverse charge: No', false],
    ['Whether tax is payable under reverse charge - Yes', true],
  ])('reads %j', (line, expected) => {
    const { profile } = one(`Tax Invoice\nInvoice Number # H1\nIGST 18 %\n${line}`);
    expect(profile.reverseCharge).toBe(expected);
  });

  it('reports null when the document does not say', () => {
    const { profile } = one('Tax Invoice\nInvoice Number # H2\nIGST 18 %');
    expect(profile.reverseCharge).toBeNull();
  });

  it('warns when the recipient owes the tax', () => {
    const { seg, profile } = one(
      'Tax Invoice\nInvoice Number # H3\nIGST 18 %\nWhether tax is payable under reverse charge - Yes');
    expect(taxProfileWarnings(seg, profile).join(' ')).toMatch(/recipient owes the tax/);
  });
});
