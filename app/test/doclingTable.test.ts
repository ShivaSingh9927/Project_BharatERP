/**
 * Docling as a reader behind the gates — bills-and-expenses.md §4.9.
 *
 * The point of these is not that Docling reads well. It is that Docling is
 * trusted no further than any other reader: what it returns faces `gradeTable`,
 * and a machine-learned reader that is fluently wrong is refused exactly as a
 * misread column would be.
 */

import { describe, it, expect } from 'vitest';
import { readInvoiceTableFromDocling } from '../src/parse/doclingTable.ts';
import type { DoclingTable } from '../src/parse/doclingTable.ts';

const table = (page: number, cells: string[][]): DoclingTable => ({ page, cells });

describe('picking a table among the several Docling returns', () => {
  it('keeps the one that ties and passes over the ones that do not', () => {
    /*
     * An Amazon page carries a line-item table, a tax summary, and a
     * consignment note. Rather than guess which is the bill, each is graded
     * and the first that ties is taken.
     */
    const tables = [
      table(1, [['Description of Goods', 'Qty', 'Value'],
                ['ZANDU', '1', '234.00']]),                 // consignment note
      table(1, [['Product', 'Description', 'Taxable Value', 'IGST', 'Total'],
                ['ZANDU', 'HSN 3004', '222.86', '11.14', '234.00']]),
    ];
    const t = readInvoiceTableFromDocling(tables, [1], 'yes', 'Total 234.00');
    expect(t?.readable).toBe(true);
    expect(t?.sums.taxable).toBe('222.86');
    expect(t?.sums.igst).toBe('11.14');
  });

  it('refuses a reading where a money cell holds two numbers', () => {
    /*
     * The real failure mode. On one Amazon layout Docling merged the item row
     * and the "TOTAL:" row, so the tax cell came back "24.82 24.82". Gate 1
     * catches it, the table is not believed, and the pipeline falls through to
     * the next reader — no wrong figure posted.
     */
    const tables = [
      table(1, [['Description', 'Net Amount', 'Tax Amount', 'Total Amount'],
                ['Item TOTAL:', '496.54', '24.82 24.82', '521.36 521.36']]),
    ];
    const t = readInvoiceTableFromDocling(tables, [1], 'yes', '');
    expect(t?.readable ?? false).toBe(false);
  });

  it('only looks at tables on the segment’s own pages', () => {
    const tables = [
      table(5, [['Product', 'Taxable Value', 'IGST', 'Total'],
                ['X', '100.00', '18.00', '118.00']]),
    ];
    // The segment is page 1; the only table is on page 5.
    expect(readInvoiceTableFromDocling(tables, [1], 'yes', '')).toBeNull();
    // ...and it reads once the page matches.
    expect(readInvoiceTableFromDocling(tables, [5], 'yes', 'Total 118.00')?.readable)
      .toBe(true);
  });

  it('returns null when Docling found nothing on the page', () => {
    expect(readInvoiceTableFromDocling([], [1], 'no', '')).toBeNull();
  });
});
