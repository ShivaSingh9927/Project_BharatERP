/**
 * Word positions and coordinate-based columns.
 * Spec: bills-and-expenses.md §4.3
 *
 * The fixtures are word boxes, built to the geometry measured off real
 * invoices — the gaps in particular, since the whole design turns on them:
 *
 *     Blinkit caption    inside a column 0.23em   between columns 1.08–1.22em
 *     Amazon prose       between words   0.30em
 *     Amazon figures     between columns 0.43–0.61em
 *
 * No real invoice content: identifiers and amounts are invented.
 */

import { describe, it, expect } from 'vitest';
import { parseBboxLayout, wordsToRows, type Word } from '../src/parse/pdfWords.ts';
import { tableFromRows } from '../src/parse/wordColumns.ts';
import { readInvoiceTableFromWords } from '../src/parse/invoiceTable.ts';

/** A word 6.6pt tall — Blinkit's caption size — at the given x. */
const w = (text: string, xMin: number, yMin: number, width = text.length * 3.3,
           height = 6.6): Word =>
  ({ text, xMin, xMax: xMin + width, yMin, yMax: yMin + height });

// ---------------------------------------------------------------------------
describe('parsing the bbox output', () => {
  const HTML = `<doc>
  <page width="597.6" height="842.4">
    <flow><block xMin="1" yMin="1" xMax="9" yMax="9">
      <line xMin="1" yMin="1" xMax="9" yMax="9">
        <word xMin="10.0" yMin="20.0" xMax="30.0" yMax="28.0">Tax</word>
        <word xMin="35.0" yMin="20.0" xMax="70.0" yMax="28.0">Invoice</word>
      </line>
    </block></flow>
    <flow><block xMin="1" yMin="1" xMax="9" yMax="9">
      <line xMin="1" yMin="1" xMax="9" yMax="9">
        <word xMin="90.0" yMin="23.2" xMax="110.0" yMax="29.4">R&amp;D</word>
        <word xMin="10.0" yMin="60.0" xMax="40.0" yMax="68.0">Below</word>
      </line>
    </block></flow>
  </page>
</doc>`;

  it('reads the page size and every word box', () => {
    const pages = parseBboxLayout(HTML);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.width).toBeCloseTo(597.6);
    expect(pages[0]!.number).toBe(1);
  });

  it('clusters words into rows across separate blocks', () => {
    /*
     * A `<line>` lives inside a `<block>`, and a table's columns are usually
     * separate blocks — so one visual row is spread over several lines in
     * several blocks and the markup cannot be trusted for rows.
     *
     * "R&D" here sits at y=23.2 against its neighbours' y=20.0, the way a
     * different font baseline shifts a word on a real page. Matching on equal
     * y would split the row; midpoint-inside keeps it.
     */
    const rows = parseBboxLayout(HTML)[0]!.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.words.map((x) => x.text)).toEqual(['Tax', 'Invoice', 'R&D']);
    expect(rows[1]!.words.map((x) => x.text)).toEqual(['Below']);
  });

  it('unescapes entities without double-decoding', () => {
    // &amp; must resolve last, or "&amp;lt;" would come out as "<".
    expect(parseBboxLayout(HTML)[0]!.rows[0]!.words[2]!.text).toBe('R&D');
  });

  it('orders rows top to bottom and words left to right', () => {
    const rows = wordsToRows([
      w('third', 100, 50), w('first', 10, 10), w('second', 60, 10),
    ]);
    expect(rows.map((r) => r.words.map((x) => x.text))).toEqual(
      [['first', 'second'], ['third']]);
  });
});

// ---------------------------------------------------------------------------
describe('columns come from the caption, grouped by measured gaps', () => {
  /*
   * The Blinkit caption geometry: four tax columns written as eight words,
   * 1.5pt apart inside a column and about 7.7pt apart between columns, at a
   * word height of 6.6pt — so 0.23em against 1.15em.
   */
  const blinkitCaption = (): Word[] => {
    const out: Word[] = [];
    let x = 40;
    for (const group of [['Taxable', 'Value'], ['CGST', '(%)'], ['CGST', '(INR)'],
                         ['SGST', '(%)'], ['SGST', '(INR)'], ['Total']]) {
      for (const [i, t] of group.entries()) {
        if (i > 0) x += 1.5;                    // 0.23em — inside a column
        out.push(w(t, x, 100));
        x += t.length * 3.3;
      }
      x += 7.7;                                  // 1.17em — between columns
    }
    return out;
  };

  it('keeps "CGST" and "(%)" in one column, and apart from "CGST (INR)"', () => {
    /*
     * The defect this closes. One band per WORD gave two columns both labelled
     * "CGST" — one holding the rate, one the amount — and both mapped to the
     * `cgst` role and were summed. A Blinkit invoice reported 508.50 of CGST
     * instead of 499.50: the 9.00 rate added to the tax.
     */
    const t = tableFromRows(wordsToRows([
      ...blinkitCaption(),
      w('1000.00', 40, 120), w('9.00', 76, 120), w('90.00', 106, 120),
      w('9.00', 140, 120), w('90.00', 172, 120), w('1180.00', 205, 120),
    ]))!;
    expect(t.header).toEqual(['Taxable Value', 'CGST (%)', 'CGST (INR)',
                              'SGST (%)', 'SGST (INR)', 'Total']);
  });

  it('stacks a caption split over two lines into one column', () => {
    // Amazon writes "Net" above "Amount". They share an x, so they merge by
    // overlap without anyone counting how tall the caption is.
    const t = tableFromRows(wordsToRows([
      w('Description', 40, 100), w('Qty', 100, 100),
      w('Net', 150, 100), w('Total', 250, 100),
      w('Amount', 150, 108), w('Amount', 250, 108),
      w('Example', 40, 130), w('1', 100, 130),
      w('1000.00', 150, 130), w('1000.00', 250, 130),
    ]))!;
    expect(t.header).toEqual(['Description', 'Qty', 'Net Amount', 'Total Amount']);
  });

  it('never lets a wide data value bridge two columns', () => {
    /*
     * The second wrong answer. Grouping every word by transitive overlap
     * assumed no word in one column overlaps a word in another — and Amazon's
     * figures are wide relative to its gaps, so ₹2,626.27 reached into the
     * next column and merged "Net Amount", "Tax Rate" and "Tax Amount" into
     * one column captioned "Rate Tax Amount Net".
     *
     * Here the value is deliberately wide enough to overlap the neighbouring
     * caption. Columns come from the caption alone, so it cannot matter.
     */
    const t = tableFromRows(wordsToRows([
      w('Qty', 40, 100), w('Taxable', 90, 100), w('Total', 190, 100),
      w('1', 40, 130), w('2626.27', 88, 130, 90), w('3099.00', 190, 130),
    ]))!;
    expect(t.header).toEqual(['Qty', 'Taxable', 'Total']);
  });
});

// ---------------------------------------------------------------------------
describe('a tax named in a cell rather than a caption', () => {
  /*
   * Amazon's shape: a "Tax Type" column whose cell reads IGST, and a "Tax
   * Amount" column beside it. The same caption means IGST on one row and CGST
   * on the next, so the pair resolves per row.
   *
   * Before this, Amazon's fee invoices read taxable 4.24 and total 5.00 and
   * refused — the 0.76 between them had nowhere to go.
   */
  const amazonRows = (taxType: string) => wordsToRows([
    w('Description', 40, 100), w('Qty', 110, 100), w('Net', 150, 100),
    w('Tax', 210, 100), w('Tax', 260, 100), w('Total', 310, 100),
    w('Amount', 150, 108), w('Type', 210, 108),
    w('Amount', 260, 108), w('Amount', 310, 108),
    w('Example', 40, 130), w('1', 110, 130), w('4.24', 150, 130),
    w(taxType, 210, 130), w('0.76', 260, 130), w('5.00', 310, 130),
  ]);

  it('credits the tax amount to the tax its row names', () => {
    const t = readInvoiceTableFromWords(
      [{ number: 1, width: 600, height: 800, rows: amazonRows('IGST') }]);
    expect(t.readable).toBe(true);
    expect(t.sums.igst).toBe('0.76');
    expect(t.sums.cgst).toBeUndefined();
    expect(t.sums.total).toBe('5.00');
  });

  it('follows the cell, so CGST on the row means CGST in the sum', () => {
    const t = readInvoiceTableFromWords(
      [{ number: 1, width: 600, height: 800, rows: amazonRows('CGST') }]);
    expect(t.sums.cgst).toBe('0.76');
    expect(t.sums.igst).toBeUndefined();
  });

  it('refuses when the row names no tax, rather than assuming one', () => {
    /*
     * An unattributed tax amount is left out of the sum, which then falls
     * short of the total and gate 2 refuses the table. Quietly folding it into
     * IGST would make the tie pass on an assumption nobody checked — and IGST
     * versus CGST+SGST is the one decision that changes which government is
     * paid.
     */
    const t = readInvoiceTableFromWords(
      [{ number: 1, width: 600, height: 800, rows: amazonRows('—') }]);
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/does not add up/);
  });
});

// ---------------------------------------------------------------------------
describe('the word path faces the same gates as the text path', () => {
  it('refuses a table whose arithmetic does not tie', () => {
    const t = readInvoiceTableFromWords([{
      number: 1, width: 600, height: 800,
      rows: wordsToRows([
        w('Taxable', 40, 100), w('IGST', 150, 100), w('Total', 250, 100),
        w('1000.00', 40, 130), w('180.00', 150, 130), w('9999.00', 250, 130),
      ]),
    }]);
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/does not add up/);
  });

  it('refuses when there is no caption to anchor the columns', () => {
    const t = readInvoiceTableFromWords([{
      number: 1, width: 600, height: 800,
      rows: wordsToRows([w('just', 40, 100), w('prose', 80, 100)]),
    }]);
    expect(t.readable).toBe(false);
    expect(t.reason).toMatch(/no row of words looks like a table header/);
  });
});

// ---------------------------------------------------------------------------
/*
 * The truncation defect, found by a model disagreeing with us.
 *
 * `readable: true` and a tied sum were taken as proof the table was read
 * correctly. They are not proof it was read COMPLETELY — a whole-table check
 * cannot see rows that were never presented to it.
 */
describe('an item that wraps does not end the table', () => {
  /*
   * The real Flipkart geometry: three fee lines, each followed by an
   * "[IMEI/Serial No: ...]" line and an "IGST: 18.0 %" line whose text runs
   * out of the description column and into the numeric bands.
   */
  const threeFeeLines = () => wordsToRows([
    w('Description', 40, 100), w('Qty', 150, 100),
    w('Taxable', 200, 100), w('IGST', 280, 100), w('Total', 340, 100),

    w('Credit Card Fee', 40, 130), w('1', 150, 130),
    w('50.00', 200, 130), w('9.00', 280, 130), w('59.00', 340, 130),
    w('1. [IMEI/Serial No: 0000000000 ]', 40, 138, 260),
    w('IGST: 18.0 %', 40, 146),

    w('Protect Promise Fee', 40, 160), w('1', 150, 160),
    w('109.32', 200, 160), w('19.68', 280, 160), w('129.00', 340, 160),
    w('1. [IMEI/Serial No: 0000000000 ]', 40, 168, 260),
    w('IGST: 18.0 %', 40, 176),

    w('Offer Handling Fee', 40, 190), w('1', 150, 190),
    w('168.64', 200, 190), w('30.36', 280, 190), w('199.00', 340, 190),
    w('1. [IMEI/Serial No: 0000000000 ]', 40, 198, 260),
    w('IGST: 18.0 %', 40, 206),
  ]);

  it('reads every line item, not just the first', () => {
    /*
     * This reported a taxable value of 50.00 against a true 327.96 — and
     * passed both gates, because one row's 50.00 + 9.00 = 59.00 ties
     * perfectly on its own. The bill would have been posted at a seventh of
     * its value with a clean arithmetic trail behind it.
     */
    const t = readInvoiceTableFromWords(
      [{ number: 1, width: 600, height: 800, rows: threeFeeLines() }]);
    expect(t.readable).toBe(true);
    expect(t.sums.taxable).toBe('327.96');
    expect(t.sums.igst).toBe('59.04');
    expect(t.sums.total).toBe('387.00');
  });

  it('still stops at content that is genuinely below the table', () => {
    /*
     * The distinction doing the work: an item's continuation carries no amount
     * of its own, while a floated "Grand Total" does. Counting that as an item
     * row would double the total.
     */
    const rows = [...threeFeeLines(), ...wordsToRows([
      w('Grand Total', 200, 230), w('387.00', 340, 230),
    ])];
    const t = readInvoiceTableFromWords(
      [{ number: 1, width: 600, height: 800, rows }]);
    expect(t.sums.total).toBe('387.00');
  });
});
