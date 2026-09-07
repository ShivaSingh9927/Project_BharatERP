/**
 * Reading the line-item table — bills-and-expenses.md §4.3.
 *
 * The fixtures reproduce the COLUMN GEOMETRY of real invoices, because that is
 * the whole difficulty. Everything here turns on which character position a
 * value sits at, so a fixture that tidied the spacing would prove nothing —
 * the same reason the statement fixtures are kept character-exact.
 *
 * Identifiers and amounts replaced throughout.
 */

import { describe, it, expect } from 'vitest';
import { splitDocuments } from '../src/parse/documentSplit.ts';
import { readInvoiceTable, gradeTable, statedTotalsInText } from '../src/parse/invoiceTable.ts';

const read = (text: string) => readInvoiceTable(splitDocuments(text)[0]!);

/*
 * The Blinkit geometry: fourteen columns, a rate column and an amount column
 * for each tax, an item description wrapping over six lines, and a totals row
 * that omits every blank column — which is exactly why counting numbers from
 * the left does not work and column positions are needed.
 */
const BLINKIT = `Tax Invoice

GSTIN                :     09AAACB1111B1Z0                    Invoice Number : T1

Sr. no   UPC    Item Description       MRP        Discount    Qty.   Taxable Value   CGST (%)    CGST (INR)   SGST (%)   SGST (INR)    Total

1        6196   Example Storage        8200.00    1651.00     1      5550.00         9.00        499.50       9.00       499.50        6549.00
         5918   Card
         8511   (256GB, C10, U1,
                V30)(Box)
                [EX-256G-
                I35GD] (HSN-
                85235100)

Total                                                         1                                  499.50                  499.50        6549.00

Amount in              Six Thousand Five Hundred And Forty-Nine Rupees Only
Words:`;

describe('reading a real column geometry', () => {
  const t = read(BLINKIT);

  it('reads every money column to the value on the paper', () => {
    expect(t.readable).toBe(true);
    expect(t.sums.taxable).toBe('5550.00');
    expect(t.sums.cgst).toBe('499.50');
    expect(t.sums.sgst).toBe('499.50');
    expect(t.sums.total).toBe('6549.00');
  });

  it('keeps a tax RATE column out of the tax amount', () => {
    // "CGST (%)" and "CGST (INR)" sit side by side. Adding the 9.00 into the
    // tax total would be nonsense that still very nearly ties.
    expect(t.sums.cgst).toBe('499.50');
    expect(t.roles.filter((r) => r === 'cgst')).toHaveLength(1);
    expect(t.roles).toContain('rate');
  });

  it('finds the totals row even though it omits most columns', () => {
    expect(t.totals).not.toBeNull();
    expect(t.totals!.by.total).toBe('6549.00');
  });

  it('excludes the words-and-signature block below the table', () => {
    // Decided by geometry: those lines run straight through the column edges
    // the rows above observe. No stop-list.
    expect(t.rows.some((r) => r.cells.join(' ').includes('Rupees Only'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('gate 1 — one amount per money cell', () => {
  it('refuses when a money cell holds several numbers at once', () => {
    // A column that IS identified as money and holds two values is proof the
    // boundaries are wrong. Nothing from such a table can be trusted.
    const t = read(`Tax Invoice
Invoice Number : T2

Description          Taxable Value        Total

Example Item         1000.00 180.00     1180.00`);
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/should hold one amount per row/);
  });

  it('refuses the Amazon geometry, though not via this gate', () => {
    /*
     * Amazon's numeric columns are separated by ONE space, below the minimum a
     * gutter needs, so they collapse into a single cell reading
     * "2626.27 1 2626.27 18% IGST 472.73 3099.00".
     *
     * Gate 1 does NOT catch it, and the reason is worth recording: that cell's
     * heading is a bare "Amount", which maps to `other` precisely because it is
     * ambiguous, so it is never checked as money. What refuses the table is the
     * verification requirement — no taxable value could be recovered.
     *
     * Two gates catching different things is the point. Either alone would let
     * this through.
     */
    const t = read(`Tax Invoice
Invoice Number : T2b

Sl.                                     Unit    Net Tax Tax Tax Total
    Description                     Qty
No                                      Price   Amount Rate Type Amount Amount
 1 Example Item                          2626.27 1 2626.27 18% IGST 472.73 3099.00`);
    expect(t.readable).toBe(false);
  });

  it('does not treat the totals-row caption as a broken column', () => {
    // "Total" landing in a money column is the row labelling itself, not a
    // misread. Only a second NUMBER is evidence of bad boundaries.
    expect(read(BLINKIT).readable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('gate 2 — the arithmetic has to tie', () => {
  const BROKEN = `Tax Invoice
Invoice Number : T3

Description          Taxable Value   IGST      Total

Example Item         1000.00         180.00    1999.00`;

  it('refuses a table whose parts do not add up to its whole', () => {
    const t = read(BROKEN);
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/does not add up/);
  });

  it('accepts the same table once it does', () => {
    const t = read(BROKEN.replace('1999.00', '1180.00'));
    expect(t.readable).toBe(true);
    expect(t.sums.igst).toBe('180.00');
  });

  it('refuses when a stated totals row disagrees with the rows above it', () => {
    const t = read(`Tax Invoice
Invoice Number : T4

Description          Taxable Value   IGST      Total

Example Item A       1000.00         180.00    1180.00
Example Item B        500.00          90.00     590.00
Total                1500.00         270.00    9999.00`);
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/totals row claims/);
  });
});

// ---------------------------------------------------------------------------
describe('readable means verified, not merely parsed', () => {
  it('refuses a table with a total and nothing to check it against', () => {
    /*
     * Amazon's fee invoice reached this state: a total recovered, no taxable
     * value, and the tie passing because there was nothing on the other side
     * of it to disagree. A figure no arithmetic checked is precisely what this
     * reader exists not to produce.
     */
    const t = read(`Tax Invoice
Invoice Number : T5

Description                    Qty    Total

Example Fee                      1     9.00`);
    expect(t.readable).toBe(false);
    /*
     * The wording moved when untaxed documents got their own path: this
     * fixture charges no tax, so it is now refused for stating no total to
     * check against rather than for missing one side of the tie. Same refusal,
     * and a more accurate reason — there is no tax here for a taxable value to
     * sit opposite.
     */
    expect(t.reason).toMatch(/nothing here to verify against/);
  });

  it('refuses a table with no money column at all', () => {
    const t = read(`Tax Invoice
Invoice Number : T6

Sr. no   HSN        Description        Qty

1        85235100   Example Item       1`);
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/nothing here to post/);
  });
});

// ---------------------------------------------------------------------------
describe('column labels', () => {
  it('joins a header split across lines', () => {
    // Flipkart writes "Gross" above "Amount ₹". Read as two rows, the second
    // becomes a data row whose Gross cell contains the word "Amount".
    const t = read(`Tax Invoice
Invoice Number : T7

     Description        Qty      Gross      Taxable      IGST      Total
                                Amount     value        Amt.

Example Item              1     1180.00    1000.00     180.00    1180.00`);
    expect(t.readable).toBe(true);
    expect(t.header).toContain('Gross Amount');
    expect(t.sums.taxable).toBe('1000.00');
  });

  it('will not read a bare "Amount" as a total', () => {
    /*
     * Amazon has "Tax Amount" AND "Total Amount". Mapping any "amount" to
     * `total` summed both, and a ₹9.00 invoice reported ₹10.37 — the tax added
     * to the total that already contained it.
     *
     * A bare "Amount" is gross, taxable, tax or total depending on the vendor,
     * so it takes part in no sum. Losing a column is recoverable; inventing a
     * total is not.
     */
    const t = read(`Tax Invoice
Invoice Number : T8

Description            Qty        Amount        Tax Amount        Total Amount

Example Item             1           9.00              1.37               10.37`);
    // Note the extra "Qty": a header is only recognised on two or more column
    // words, so "Description / Amount" alone would not be found at all. That
    // is deliberately conservative — a missed table refuses, it does not guess.
    expect(t.header).toEqual(
      ['Description', 'Qty', 'Amount', 'Tax Amount', 'Total Amount']);
    expect(t.roles).toEqual(
      ['description', 'qty', 'other', 'tax_amount', 'total']);
    expect(t.sums.total).toBe('10.37');

    // "Tax Amount" is a tax whose NAME lives in another column. This table has
    // no "Tax Type" column to name it, so the 1.37 is credited nowhere rather
    // than guessed at — see the pdfWords tests for why that matters.
    expect(t.sums.tax_amount).toBeUndefined();
    expect(t.sums.igst).toBeUndefined();
  });
});

/*
 * A rounding difference is accepted, named, and bounded — bills-and-expenses.md
 * §4.3, gl-engine.md V-10.
 *
 * The document these are built from states a total of 9539.00 against parts
 * that sum to 9538.98 and prints NO round-off line anywhere, so the two paise
 * can only be inferred. Refusing it would be wrong — `computeTotals` has
 * always rounded the payable total to the nearest rupee — but accepting it in
 * silence would be worse, so it is accepted with a warning.
 *
 * The three refusals below are what stop this being a tolerance. The same
 * corpus contains ₹5.00 platform fees, where "within 50 paise" would be a
 * tenth of the document.
 */
describe('rounding to the nearest rupee', () => {
  const table = (taxable: string, cgst: string, sgst: string, total: string) =>
    `Tax Invoice

GSTIN     :   09AAACB1111B1Z0        Invoice Number : R1

Sr.   Description        Taxable Value   CGST (INR)   SGST (INR)   Total

1     Example Item       ${taxable.padEnd(15)} ${cgst.padEnd(12)} ${sgst.padEnd(12)} ${total}
`;

  it('accepts two paise absorbed into a whole-rupee total, and says so', () => {
    const t = read(table('8083.90', '727.54', '727.54', '9539.00'));
    expect(t.readable).toBe(true);
    expect(t.roundOff).toBe('0.02');
    expect(t.warnings?.join(' ')).toMatch(/9538\.98[\s\S]*9539\.00/);
    // The difference is inferred, and the warning has to admit that.
    expect(t.warnings?.join(' ')).toMatch(/prints\s+no\s+round-off\s+line/);
  });

  it('refuses a difference when the stated total is not a whole rupee', () => {
    /*
     * 5.35 read against 5.37 stated. Two paise again — the same gap the case
     * above accepts — but rounding to the nearest rupee cannot produce 5.37,
     * so this is a misread wearing a rounding difference's clothes. It is
     * also the shape a ₹5.00 platform fee would take, where two paise is not
     * negligible at all.
     */
    const t = read(table('4.53', '0.41', '0.41', '5.37'));
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/does not add up/);
    expect(t.roundOff).toBeUndefined();
  });

  it('refuses a difference under a rupee that rounds to a different rupee', () => {
    // 8538.98 read against 9539.00 stated: a thousand rupees apart, so no.
    const t = read(table('7083.90', '727.54', '727.54', '9539.00'));
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/does not add up/);
  });

  it('refuses a whole rupee or more, however whole the total looks', () => {
    // 9538.00 read against 9539.00 stated — exactly the bound, and out.
    const t = read(table('8082.92', '727.54', '727.54', '9539.00'));
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/does not add up/);
  });

  it('says nothing when the figures tie exactly', () => {
    const t = read(table('8083.92', '727.54', '727.54', '9539.00'));
    expect(t.readable).toBe(true);
    expect(t.roundOff).toBeUndefined();
    expect(t.warnings).toBeUndefined();
  });
});

/**
 * A document that charges no tax — bills-and-expenses.md §4.3.
 *
 * An import of service has one money column and no tax anywhere, so the tie
 * has nothing to work with. Four foreign invoices in the corpus were refused
 * for lacking a taxable value they cannot have. What checks them instead is
 * the total the document states in its own text.
 */
describe('a document with no tax at all', () => {
  const rows = [
    ['Traffic routing', '1', '9.00', '9.00'],
    ['Payment fee', '1', '0.56', '0.56'],
  ];
  const header = ['Description', 'Quantity', 'Unit Price', 'Amount'];

  it('takes the total as the taxable value when the page states that total', () => {
    const t = gradeTable(header, rows, ['9.56']);
    expect(t.readable).toBe(true);
    expect(t.sums.taxable).toBe('9.56');
    expect(t.warnings?.join(' ')).toMatch(/charges no tax/);
  });

  it('refuses when the page states no total at all', () => {
    // Nothing to check a single figure against, which is where this started.
    const t = gradeTable(header, rows, []);
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/nothing here to verify against/);
  });

  it('refuses when the rows read do not reach the total stated', () => {
    /*
     * The case that matters. A real Kamatera invoice bills in sections and
     * states a total for each; only the first section's rows were read, and
     * matching ANY stated total accepted 6.00 as the whole of an 11.09
     * invoice. Requiring the largest catches the two thirds that were missed.
     */
    const t = gradeTable(header, rows, ['9.56', '20.00']);
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/largest it states is 20\.00/);
    expect(t.reason).toMatch(/row was probably missed/);
  });

  it('reads a total floated outside the table, and only from a total label', () => {
    expect(statedTotalsInText('Total  $9.56')).toEqual(['9.56']);
    expect(statedTotalsInText('Amount due   ₹929.00')).toEqual(['929.00']);
    expect(statedTotalsInText('Total: 11.09 USD')).toEqual(['11.09']);
    // A line that merely mentions a figure is not a stated total.
    expect(statedTotalsInText('Traffic routing; #532846  1  $9.00')).toEqual([]);
  });

  it('does not apply when the document says it charges tax, whatever the columns say', () => {
    /*
     * The case the cross-check caught. Amazon separates its numeric columns by
     * a single space, so the coordinate reader recovers no tax column from it
     * — and judged on columns alone the document looked untaxed, so its net
     * amount of 2626.27 became the whole bill and 472.73 of IGST on the paper
     * disappeared. It posted, and was noticed only because the model read the
     * same page and disagreed.
     *
     * "No tax column was found" is not "this document charges no tax".
     */
    const header = ['Description', 'Qty', 'Amount'];
    const rows = [['Example Item', '1', '2626.27']];
    expect(gradeTable(header, rows, ['2626.27'], 'no').readable).toBe(true);
    expect(gradeTable(header, rows, ['2626.27'], 'yes').readable).toBe(false);
    // Nor does an undetermined answer unlock it: that is the document not to
    // assume about.
    expect(gradeTable(header, rows, ['2626.27'], 'unreadable').readable).toBe(false);
  });

  it('does not apply where the document does charge tax', () => {
    /*
     * The relaxation is only safe because there is no tax to check against.
     * A taxed document with a total and no taxable column is still the Amazon
     * failure, and still refused.
     */
    const t = gradeTable(
      ['Description', 'IGST', 'Total'], [['Fee', '0.76', '5.00']], ['5.00']);
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/only a total|nothing checks the other/);
  });
});

/**
 * The Zepto geometry — a rate column and an amount column for every tax, a
 * three-line stacked heading, and the totals stated twice with only the
 * second labelled.
 *
 * Every one of these was a separate refusal on a real document.
 */
describe('a rate column that does not say it is one', () => {
  it('reclassifies a money column whose cells are all percentages', () => {
    /*
     * Zepto captions its rate columns "CGST" and "S/UT GST" with no per-cent
     * sign anywhere in the heading, though every cell beneath reads "2.50%".
     * Read from the caption those were tax amounts, so gate 1 refused the
     * whole table on "0.00%" — which does not parse as an amount.
     */
    const t = gradeTable(
      ['Taxable Amt.', 'CGST', 'S/UT GST', 'CGST Amt.', 'S/UT GST Amt.', 'Total Amt.'],
      [['54.29', '2.50%', '2.50%', '1.36', '1.36', '57.00']]);
    expect(t.roles[1]).toBe('rate');
    expect(t.roles[2]).toBe('rate');
    expect(t.roles[3]).toBe('cgst');
    expect(t.roles[4]).toBe('sgst');
  });

  it('leaves a column mixing figures and percentages alone', () => {
    /*
     * That is a misread boundary, which is precisely what gate 1 exists to
     * catch. Relabelling it as a rate would hide the fault.
     */
    const t = gradeTable(
      ['Taxable', 'CGST', 'Total'],
      [['100.00', '9.00', '109.00'], ['100.00', '9.00%', '109.00']]);
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/should hold one amount per row/);
  });

  it('recognises a state GST column whose caption lost its S/UT', () => {
    /*
     * CGST never travels alone — there is no central-only intra-state supply.
     * Zepto stacks its heading over three lines and the "S/UT" lands in a
     * neighbouring band, so the column arrives called "GST Amt." and
     * classified as nothing, dropping its half of the tax.
     *
     * A guess, and a safe one: if it were really a COMBINED figure the
     * arithmetic would come out over by the central half and be refused.
     */
    const t = gradeTable(
      ['Taxable Amt.', 'CGST Amt.', 'GST Amt.', 'Total Amt.'],
      [['54.29', '1.36', '1.36', '57.01']]);
    expect(t.roles[2]).toBe('sgst');
    expect(t.readable).toBe(true);
  });
});

describe('a totals row with nothing written in it', () => {
  const header = ['SR No', 'Description', 'Taxable Amt.', 'CGST Amt.', 'Total Amt.'];

  it('is recognised by restating the rows above it', () => {
    /*
     * Zepto prints its totals twice: once as a bare line of figures with every
     * label column empty, and once below as "Item Total". Only the second says
     * what it is, so the first was counted as an item and every figure on the
     * bill doubled. The arithmetic still nearly tied, because both sides
     * doubled together, which is how it got as far as it did.
     */
    const t = gradeTable(header, [
      ['1', 'Noodles', '54.29', '1.36', '57.00'],
      ['2', 'Bananas', '13.33', '0.33', '14.00'],
      ['', '', '67.62', '1.69', '71.00'],
    ]);
    expect(t.sums.taxable).toBe('67.62');     // not 135.24
    expect(t.totals).not.toBeNull();
  });

  it('keeps a second line that merely looks like a total', () => {
    /*
     * The guard that matters. Two equal lines: the last one's total equals the
     * sum of the others, and dropping it would silently halve the bill. It
     * carries a serial and a description, so it identifies itself as an item.
     */
    const t = gradeTable(header, [
      ['1', 'Item A', '50.00', '0.00', '50.00'],
      ['2', 'Item B', '50.00', '0.00', '50.00'],
    ]);
    expect(t.sums.taxable).toBe('100.00');
  });
});

describe('a stated total that agrees with the parts, not the column', () => {
  it('accepts a document that rounds each line to a rupee', () => {
    /*
     * Zepto rounds every line to a whole rupee, so its total column sums to
     * 71.00 while the row restating those lines says 71.01 — taxable plus tax,
     * unrounded. Insisting on the total column refused sound arithmetic.
     *
     * Still exact: the alternative is computed, not tolerated.
     */
    const t = gradeTable(
      ['SR No', 'Description', 'Taxable Amt.', 'CGST Amt.', 'S/UT GST Amt.', 'Total Amt.'],
      [
        // 57.01 printed as 57.00, and 38.02 printed as 38.00.
        ['1', 'Noodles', '54.29', '1.36', '1.36', '57.00'],
        ['2', 'Chutney', '36.20', '0.91', '0.91', '38.00'],
        ['', '', '90.49', '2.27', '2.27', '95.03'],
      ]);
    expect(t.readable).toBe(true);
    expect(t.sums.total).toBe('95.00');       // the rounded lines
    expect(t.roundOff).toBe('-0.03');         // ...against parts of 95.03
  });
});
