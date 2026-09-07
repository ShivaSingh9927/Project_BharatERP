/**
 * Reading the invoice date — bills-and-expenses.md §4.7.
 *
 * Every format here was taken off a real document in the corpus. Half the
 * vendors write dates that are ambiguous on their own, which is the whole
 * reason this file exists.
 */

import { describe, it, expect } from 'vitest';
import { extractInvoiceDate, findDates, inferDayOrder } from '../src/parse/invoiceDate.ts';

const on = (text: string, file?: string) => extractInvoiceDate(text, file);

// ---------------------------------------------------------------------------
describe('dates that settle themselves', () => {
  it.each([
    ['Invoice Date: 27-08-2025', '2025-08-27', 'a day over 12'],
    ['Invoice Date 01-Aug-2026', '2026-08-01', 'a named month'],
    ['Invoice Date : 03-Jun-2026', '2026-06-03', 'a named month'],
    ['Date of issue  July 9, 2026', '2026-07-09', 'a month written first'],
    ['Invoice date: 2026.09.03', '2026-09-03', 'the year first'],
  ])('reads %j via %s', (text, expected) => {
    expect(on(text).date).toBe(expected);
  });

  it('takes either reading when both fall on the same day', () => {
    // 05.05 is 5 May whichever way round it is written. Refusing here would be
    // fastidiousness rather than care — the return period is the same.
    expect(on('Invoice Date : 05.05.2026').date).toBe('2026-05-05');
  });

  it('rejects an impossible day rather than reading it the other way round', () => {
    // 31.02 is not 2 March. It is a misread, and it must not resolve.
    expect(findDates('31.02.2026')).toEqual([]);
  });

  it('reads 13.07 as day-first, since 13 cannot be a month', () => {
    expect(on('Invoice Date : 13.07.2026').date).toBe('2026-07-13');
  });
});

// ---------------------------------------------------------------------------
describe('dates that do not', () => {
  it('refuses when both readings fall in different months', () => {
    /*
     * The one that matters. "Indian invoices are day-first" is true and is
     * exactly the kind of assumption that has produced every wrong answer in
     * this codebase — so it is not made.
     */
    const r = on('Invoice Date : 04.09.2026');
    expect(r.date).toBeUndefined();
    expect(r.reason).toMatch(/could be 2026-09-04 or 2026-04-09/);
    expect(r.reason).toMatch(/different return periods/);
  });

  it('refuses a document with no date', () => {
    expect(on('Tax Invoice\nno dates here').reason).toMatch(/no date appears/);
  });

  it('refuses several unlabelled dates rather than taking the first', () => {
    // An order date and an invoice date are different dates and can fall in
    // different months.
    const r = on('Some Date 01-Aug-2026 and another 15-Sep-2026 elsewhere');
    expect(r.date).toBeUndefined();
    expect(r.reason).toMatch(/several dates/);
  });
});

// ---------------------------------------------------------------------------
describe('resolving ambiguity from the document itself', () => {
  it('uses a year-first date to place the month in an ambiguous one', () => {
    /*
     * What rescues Amazon. Its signature block prints `2026.09.03`, year
     * first and so unambiguous, and its 09 sits in the same position as the 09
     * in `04.09.2026`. The document has told us it writes day-first.
     */
    const r = on('Invoice Date : 04.09.2026\nDate: 2026.09.03 22:21:45 UTC');
    expect(r.date).toBe('2026-09-04');
    expect(r.basis).toMatch(/day-first/);
  });

  it('uses a day over 12 elsewhere on the page', () => {
    const r = on('Order Date: 27-08-2025\nBill of Supply Date : 01-09-2025');
    expect(r.date).toBe('2025-09-01');
  });

  it('settles the order from the whole FILE, not just one document', () => {
    /*
     * Day order is a property of whatever generated the PDF, and one PDF has
     * one generator. An Amazon file holds the seller's invoice and Amazon's
     * own fee invoice; only the second carries the signature block. Judged
     * segment by segment, page one refused a date page two could read — same
     * file, same system, same day.
     */
    const segment = 'Invoice Date : 04.09.2026';
    expect(on(segment).date).toBeUndefined();
    expect(on(segment, `${segment}\nelsewhere: 2026.09.03`).date).toBe('2026-09-04');
  });

  it('recognises month-first when the page proves it', () => {
    const r = on('Invoice Date : 04.09.2026\nOrder Date: 09.27.2026');
    expect(r.date).toBe('2026-04-09');
  });
});

// ---------------------------------------------------------------------------
describe('finding the right date among several', () => {
  it('prefers a labelled invoice date over an order date', () => {
    const r = on('Order Date: 20-08-2026\nInvoice Date: 27-08-2026');
    expect(r.date).toBe('2026-08-27');
  });

  it('reads a date the label follows rather than precedes', () => {
    /*
     * Blinkit prints "Invoice   :   03-Jun-2026" with the word "Date" on the
     * NEXT line, below the value, so no label pattern can reach it — and it
     * carries a second, unrelated date in its terms. A date within a line's
     * width of the word "invoice" is the document's own association.
     */
    const r = on('Invoice           :    03-Jun-2026\nDate\n\n'
      + 'Terms updated 22 Sep 2025 and subject to change');
    expect(r.date).toBe('2026-06-03');
  });
});

// ---------------------------------------------------------------------------
describe('inferDayOrder', () => {
  it('says unknown when nothing settles it', () => {
    expect(inferDayOrder(findDates('04.09.2026'))).toBe('unknown');
  });

  it('ignores a named-month date, which proves nothing about digits', () => {
    // "01-Aug-2026" is unambiguous but says nothing about how this vendor
    // arranges an all-numeric date.
    expect(inferDayOrder(findDates('01-Aug-2026'))).toBe('unknown');
  });
});
