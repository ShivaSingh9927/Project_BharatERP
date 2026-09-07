/**
 * One PDF, several documents — bills-and-expenses.md §4.1.
 *
 * The fixtures reproduce the PAGE STRUCTURE of real marketplace and foreign
 * invoices — where the heading sits, which page repeats the letterhead, which
 * page carries the GSTIN below the fold — with every identifier replaced and
 * every amount invented. The structure IS the test: splitting decides on the
 * first few lines of each page and on whether the identity changed, so a
 * fixture that tidied the pages would prove nothing.
 *
 * Real GSTINs, names and addresses stay out of the repository. The synthetic
 * ones are built with `gstinCheckDigit` so they are structurally genuine.
 */

import { describe, it, expect } from 'vitest';
import { splitDocuments, splitPagesFF } from '../src/parse/documentSplit.ts';
import { gstinCheckDigit, validateGstin } from '../src/domain/gstin.ts';

const gstin = (state: string, pan: string): string => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckDigit(first14);
};

const MARKETPLACE = gstin('29', 'AAACM1111M');   // Karnataka
const LOGISTICS   = gstin('07', 'AAACL2222L');   // Delhi
const SELLER      = gstin('23', 'AAACS3333S');   // Madhya Pradesh

const P = (...pages: string[]): string => pages.join('\f') + '\f';

// ---------------------------------------------------------------------------
describe('splitPagesFF', () => {
  it('treats the final form feed as a terminator, not a separator', () => {
    // pdftotext always ends with one. Counting it as a page made a four-page
    // invoice report five, and appended a phantom page to the last document.
    expect(splitPagesFF('a\fb\f')).toEqual(['a', 'b']);
  });

  it('keeps an interior blank page, which is real', () => {
    expect(splitPagesFF('a\f\fb\f')).toEqual(['a', '', 'b']);
  });

  it('handles a single page with no form feed at all', () => {
    expect(splitPagesFF('only')).toEqual(['only']);
  });
});

// ---------------------------------------------------------------------------
/*
 * The shape that motivated the module: three legal entities in one file, in
 * three different states, at three different rates. Posting this as one bill
 * would claim input credit against a GSTIN that charged almost none of it.
 */
const MARKETPLACE_ORDER = P(
`                                                        Tax Invoice
 Sold By: Example Marketplace Private Limited ,
 Ship-from Address: 1 Example Road, Bengaluru, Karnataka, IN - 560001
 GSTIN - ${MARKETPLACE}

                                            Invoice Number # AAA0000000000001

Order ID: OD000000000000000000               Billing Address
Order Date: 27-08-2025                       A N Other

           Description              Qty   Gross    Taxable    IGST    Total
SAC: 998599   Platform Fee           1     5.00      4.24     0.76     5.00
              IGST: 18.0 %`,

`                                    Bill of Supply

Bill of Supply Details                        Nature of transaction : INTRA
Bill of Supply Number : BBB0000000000002      Nature Of Supply : Service

Billed From                                   Billed To
Example Logistics Private Limited             A N Other
1 Example Street, New Delhi, IN-DL - 110085   State : Uttar Pradesh
GSTIN : ${LOGISTICS}                 Place of Supply : DELHI

Particulars      SAC       Qty   Gross    Taxable   SGST    CGST   Total
GT Charges       996511    1.0   66.00     66.00    0.00    0.00   66.00`,

`                              DETAILS OF GOODS TRANSPORTED BY GTA SUPPLIER

Is the supply subject to reverse charge: No
Person Liable to pay tax: GTA i.e. Example Logistics Private Limited`,

`Tax Invoice     Order Id: OD000000000000000000   Invoice No: CCC0000000000003   GSTIN: ${SELLER}
                Order Date: 27-08-2025           Invoice Date: 27-08-2025

Sold By                          Billing Address
EXAMPLE TRADERS,                 A N Other
GST: ${SELLER}

  Product              Description                    Qty  Gross  Taxable  IGST   Total
  Example Item         HSN: 30049011 | IGST: 5.00%     1   234.00  222.86  11.14  234.00`,
);

describe('a marketplace order is several documents', () => {
  const segs = splitDocuments(MARKETPLACE_ORDER);

  it('finds one document per supplier, not one per file', () => {
    expect(segs).toHaveLength(3);
  });

  it('types each document as the paper describes itself', () => {
    expect(segs.map((s) => s.kind))
      .toEqual(['tax_invoice', 'bill_of_supply', 'tax_invoice']);
  });

  it('attributes the GTA annexure to the document it continues', () => {
    // Page 3 opens no document of its own. Left as a separate segment it would
    // become a fourth "bill" with no supplier and no total.
    expect(segs[1]!.pages).toEqual([2, 3]);
  });

  it('reads a distinct, valid supplier GSTIN for each', () => {
    const found = segs.map((s) => s.supplierGstin);
    expect(found).toEqual([MARKETPLACE, LOGISTICS, SELLER]);
    expect(new Set(found).size).toBe(3);
    for (const g of found) expect(validateGstin(g!).valid).toBe(true);
  });

  it('reads each document number', () => {
    expect(segs.map((s) => s.documentNumber)).toEqual([
      'AAA0000000000001', 'BBB0000000000002', 'CCC0000000000003',
    ]);
  });

  it('loses no text — the segments reconstruct the file', () => {
    expect(segs.map((s) => s.text).join('\f')).toBe(MARKETPLACE_ORDER.replace(/\f$/, ''));
  });
});

// ---------------------------------------------------------------------------
describe('the identity check', () => {
  /*
   * A repeated letterhead is not a new document. Kamatera prints its invoice
   * number at the top of all four pages of one invoice; keying on the heading
   * alone would have produced four bills for one payment.
   */
  const REPEATED_HEADER = P(
`Example Cloud
  Example Holdings LTD, Tax I.D. 000000000

Invoice Number ABC/(000)000001 [ORIGINAL]                Invoice Date 01-Aug-2026

Summary of Charges
Services, Current Month                                              6.00 USD`,

`Example Cloud
  Example Holdings LTD, Tax I.D. 000000000

Invoice Number ABC/(000)000001 [ORIGINAL]                Invoice Date 01-Aug-2026

Line #   Product ID   Service Name       Quantity   Unit Price   Total
1        VM           example-server     1.00       6.00 USD     6.00 USD`,
  );

  it('merges pages that restate the same document number', () => {
    const segs = splitDocuments(REPEATED_HEADER);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.pages).toEqual([1, 2]);
  });

  /*
   * The converse, and the reason the number is checked before the GSTIN: one
   * supplier can issue two invoices inside one file. A real order does exactly
   * this — two tax invoices from the same company on consecutive pages.
   */
  const SAME_SUPPLIER_TWICE = P(
`                                    Tax Invoice
 Sold By: Example Electronics Private Limited ,
 GSTIN - ${SELLER}
                                      Invoice Number # DDD0000000000004`,

`                                    Tax Invoice
 Sold By: EXAMPLE ELECTRONICS PRIVATE LIMITED ,
 GSTIN - ${SELLER}
                                      Invoice Number # EEE0000000000005`,
  );

  it('splits two invoices from one supplier, which only the number reveals', () => {
    const segs = splitDocuments(SAME_SUPPLIER_TWICE);
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.documentNumber))
      .toEqual(['DDD0000000000004', 'EEE0000000000005']);
    expect(segs.map((s) => s.supplierGstin)).toEqual([SELLER, SELLER]);
  });

  it('merges rather than splits when identity cannot be read on either side', () => {
    // The deliberate bias. One oversized bill is visibly wrong and gets
    // rejected; two half-bills each carry a plausible total and post silently.
    const segs = splitDocuments(P('Tax Invoice\nno identifiers here',
                                  'Tax Invoice\nnor here'));
    expect(segs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('foreign suppliers', () => {
  /*
   * An import of service: billed in rupees to an Indian address, with no GSTIN
   * and no GST, because the supplier has neither. This is a valid bill, not a
   * malformed one — it belongs on the reverse-charge path. A splitter that
   * required a GSTIN would reject it outright.
   */
  const FOREIGN = P(
`Invoice
Invoice number FFF-0006
Date of issue  July 9, 2026

Example Inc                        Bill to
1 Example Street                   A N Other
San Francisco, California          Firozabad 283203
United States                      Uttar Pradesh

Description                        Qty   Unit price   Amount
Example Subscription                 1   Rs 929.00    Rs 929.00`,
  );

  it('accepts a document with no GSTIN at all', () => {
    const segs = splitDocuments(FOREIGN);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.supplierGstin).toBeNull();
    expect(segs[0]!.documentNumber).toBe('FFF-0006');
  });

  it('reads "Invoice no.:" without capturing the punctuation', () => {
    // This returned ".:" — the word boundary after the optional dot let the
    // capture begin at the separator instead of after it.
    const segs = splitDocuments('Example GmbH\n\nInvoice no.: 000000000001\n');
    expect(segs[0]!.documentNumber).toBe('000000000001');
  });

  it('types an unqualified heading as a plain invoice, not a tax invoice', () => {
    // The distinction decides whether input credit can rest on it.
    expect(splitDocuments(FOREIGN)[0]!.kind).toBe('invoice');
  });
});

// ---------------------------------------------------------------------------
describe('degenerate input', () => {
  it('returns one unknown segment for text with no heading', () => {
    const segs = splitDocuments('just some text\nwith no heading at all');
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe('unknown');
  });

  it('returns nothing for empty input rather than one empty document', () => {
    expect(splitDocuments('')).toHaveLength(0);
  });

  it('does not mistake footer boilerplate for a new document', () => {
    // "computer-generated tax invoice" in a footer is the reason the heading
    // must sit near the top of the page to count.
    const segs = splitDocuments(P(
      `Tax Invoice\nGSTIN - ${MARKETPLACE}\nInvoice Number # GGG0000000000007`,
      `Line 1\nLine 2\nLine 3\nLine 4\nThis is a computer-generated tax invoice.`,
    ));
    expect(segs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
/*
 * The Amazon shape: two suppliers, one page each, and a heading that refuses
 * to commit. Every Amazon document is headed "Tax Invoice/Bill of Supply/Cash
 * Memo" and lets the tax table decide which it actually is.
 */
const SELLER_HR = gstin('06', 'AAACH4444H');   // Haryana
const AMAZON    = gstin('29', 'AAACZ5555Z');   // Karnataka

const AMAZON_ORDER = P(
`                                    Tax Invoice/Bill of Supply/Cash Memo
                                              (Original for Recipient)

Sold By :                                                        Billing Address :
EXAMPLE RETAIL LIMITED                                                  A N Other
Gurgaon, Haryana, 122503                             KANPUR, UTTAR PRADESH, 208016
IN                                                             State/UT Code: 09

PAN No: AAACH4444H
GST Registration No: ${SELLER_HR}                  Place of supply: UTTAR PRADESH

Order Number: 000-0000000-0000000                    Invoice Number : HHH4-0000008
Order Date: 03.09.2026                                   Invoice Date : 04.09.2026

Sl.                                    Unit        Net    Tax  Tax   Tax    Total
    Description                                Qty
No                                     Price       Amount Rate Type  Amount Amount
 1 Example Earbuds | HSN:85183011  2,626.27  1  2,626.27  18%  IGST  472.73 3,099.00
TOTAL:                                                               472.73 3,099.00
Whether tax is payable under reverse charge - No`,

`                                    Tax Invoice/Bill of Supply/Cash Memo
                                              (Original for Recipient)

Sold By :                                                        Billing Address :
Example Marketplace Services Private Limited                            A N Other
Bangalore, Karnataka - 560064                        KANPUR, UTTAR PRADESH, 208016
India                                                          State/UT Code: 09

PAN No: AAACZ5555Z
GST Registration No: ${AMAZON}                                Invoice Number : JJJ-000000009

Sl. No Description             Unit Price  Qty  Net Amount  Tax Rate Tax Type Tax Amount Total
     1 Offer Processing Fees         7.63         7.63        18%     IGST       1.37     9.00
TOTAL:                                                                           1.37     9.00`,
);

describe('a heading that names three document types at once', () => {
  const segs = splitDocuments(AMAZON_ORDER);

  it('still finds the boundary between the two suppliers', () => {
    expect(segs).toHaveLength(2);
    expect(segs.map((x) => x.supplierGstin)).toEqual([SELLER_HR, AMAZON]);
    expect(segs.map((x) => x.documentNumber))
      .toEqual(['HHH4-0000008', 'JJJ-000000009']);
  });

  it('refuses to type the document from the heading', () => {
    /*
     * The defect this fixes. "Tax Invoice" matched out of
     * "Tax Invoice/Bill of Supply/Cash Memo" and every Amazon document was
     * typed `tax_invoice` — right on all eight in the corpus, because they all
     * charge GST, and wrong on a Bill of Supply from a composition dealer,
     * which carries the identical heading and charges none.
     *
     * That error runs in the expensive direction: input credit looks claimable
     * on a document that never charged any.
     */
    expect(segs.map((x) => x.kind)).toEqual(['unspecified', 'unspecified']);
  });

  it('does not let a continuation page overwrite the refusal', () => {
    // `unspecified` is a decision, not a gap. A later page mentioning "Tax
    // Invoice" must not resolve it — only the tax table can.
    const withFooter = splitDocuments(P(
      `Tax Invoice/Bill of Supply/Cash Memo\nGST Registration No: ${SELLER_HR}\nInvoice Number : KKK-0000010`,
      `Line 1\nLine 2\nLine 3\nThis is a computer-generated tax invoice.`,
    ));
    expect(withFooter).toHaveLength(1);
    expect(withFooter[0]!.kind).toBe('unspecified');
  });

  it('leaves an unambiguous heading typed exactly as before', () => {
    // The combined pattern needs a separator and a second alternative, so a
    // plain "Tax Invoice" must not be caught by it.
    expect(splitDocuments('Tax Invoice\nInvoice Number # LLL0000000000011')[0]!.kind)
      .toBe('tax_invoice');
  });
});

// ---------------------------------------------------------------------------
/*
 * The Zepto shape: letterhead first, heading afterwards.
 *
 * Every other vendor in the corpus puts its title at or near the top. Zepto
 * prints the seller name, address, GSTIN and FSSAI licence FIRST and the
 * heading below all of it — the seventh non-blank line. With the window at 3
 * the document came back `unknown`.
 */
const GROCER = gstin('09', 'AAACG6666G');   // Uttar Pradesh

const LETTERHEAD_FIRST = P(
`Seller Name: Example Groceries Private Limited
1/EX-1/10, Example Vihar, Kanpur, Uttar Pradesh - 208017

GSTIN: ${GROCER}
FSSAI: 00000000000000



                                                  TAX INVOICE/BILL OF SUPPLY

  Invoice No.: 00000C0000000001              Place Of Supply : UTTAR PRADESH (9)
  Order No.: EXAMPLEORDER0001                Date : 09-08-2026`,

`Whether GST is payable on reverse-charge - No.

Order Delivered From -
EXAMPLE ENTERPRISES`,
);

describe('a heading that sits below the letterhead', () => {
  it('is found even though it is the seventh line, not the first', () => {
    const segs = splitDocuments(LETTERHEAD_FIRST);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe('unspecified');
    expect(segs[0]!.documentNumber).toBe('00000C0000000001');
    expect(segs[0]!.supplierGstin).toBe(GROCER);
  });

  /*
   * Widening the window was only safe because position stopped being the sole
   * defence. A heading OPENS its line; boilerplate MENTIONS one mid-sentence.
   * These two cases are the whole justification for the change — if either
   * fails, the window must go back to being narrow.
   */
  it('still ignores boilerplate that mentions a heading mid-sentence', () => {
    /*
     * The isolating case. Page 2 names a DIFFERENT supplier, so the identity
     * test would fire — the only thing holding the two pages together is that
     * "tax invoice" appears inside a sentence rather than opening a line.
     *
     * An earlier version of this test also gave page 2 its own line-initial
     * "Invoice Number # …". That was a bad premise: such a page really does
     * look like a new document, and asserting it must not split was asking the
     * splitter to ignore its strongest signal.
     */
    const segs = splitDocuments(P(
      `Tax Invoice\nGSTIN - ${MARKETPLACE}\nInvoice Number # MMM0000000000012`,
      `Consignor GSTIN ${LOGISTICS} acted on behalf of the seller.\n`
      + `This is a computer-generated tax invoice.`,
    ));
    expect(segs).toHaveLength(1);
    expect(segs[0]!.pages).toEqual([1, 2]);
  });

  it('does not read a bare date label as a title', () => {
    // "Invoice Date" opens its own line on several layouts and is never a
    // heading. Read as one, a continuation page carrying only a date label
    // becomes the start of a document.
    const segs = splitDocuments(P(
      `Tax Invoice\nGSTIN - ${MARKETPLACE}\nInvoice Number # PPP0000000000015`,
      `Invoice Date : 04.09.2026\nGSTIN - ${LOGISTICS}`,
    ));
    expect(segs).toHaveLength(1);
  });

  it('accepts a heading with data run onto the same line', () => {
    // The reason the rule is "starts the line" and not "is the whole line" —
    // Flipkart puts the order and invoice numbers beside the title.
    const segs = splitDocuments(
      `Tax Invoice   Order Id: OD0001   Invoice No: OOO0000000000014   GSTIN: ${SELLER}`);
    expect(segs[0]!.kind).toBe('tax_invoice');
  });
});

describe('an invoice number with no label at all', () => {
  it('reads a line that is nothing but "Invoice" and the number', () => {
    /*
     * A Lithuanian supplier heads its page this way. Nothing read the number,
     * nothing blocked the bill, and `createBill` was handed a null straight
     * into a NOT NULL column — the constraint said what, not why.
     */
    const [d] = splitDocuments('Invoice PC-699272\nSeptember 05, 2026\n');
    expect(d!.documentNumber).toBe('PC-699272');
  });

  it('does not mistake a label or a heading for a number', () => {
    // The token must carry a digit and stand alone on its line.
    expect(splitDocuments('Invoice Date: 05/09/2026\n')[0]!.documentNumber).toBeNull();
    expect(splitDocuments('Invoice to Shiva Singh\n')[0]!.documentNumber).toBeNull();
    expect(splitDocuments('Invoice\n')[0]!.documentNumber).toBeNull();
  });

  it('still prefers a labelled number when the document has one', () => {
    const [d] = splitDocuments('Invoice XYZ-1\nInvoice Number : T9\n');
    expect(d!.documentNumber).toBe('T9');
  });
});
