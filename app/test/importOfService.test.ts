/**
 * Imports of service — bills-and-expenses.md §4.6, IGST Act s.7(4), s.13(3),
 * s.14 and Rule 34(2).
 *
 * Four real invoices sit behind these: a US company billing in rupees, a
 * Lithuanian one in dollars, a German host in euros, an Israeli one in
 * dollars. All charge no GST, correctly — the recipient owes it.
 */

import { describe, it, expect } from 'vitest';
import {
  tableCurrency, toRupees, timeOfSupply,
} from '../src/parse/importOfService.ts';
import { gradeTable } from '../src/parse/invoiceTable.ts';
import { parseAmount, currencyOf, currencyWasAssumed } from '../src/parse/values.ts';

describe('reading what currency a document speaks', () => {
  const table = (...rows: string[][]) =>
    gradeTable(['Description', 'Quantity', 'Unit Price', 'Amount'], rows,
               rows.map((r) => parseAmount(r[3]!).value));

  it('names the currency rather than stripping it', () => {
    // The parser used to discard the symbol and return a bare number, so a
    // euro invoice and a rupee invoice produced identical output.
    expect(parseAmount('€ 38.47').currency).toBe('EUR');
    expect(parseAmount('11.09 USD').currency).toBe('USD');
    expect(parseAmount('₹929.00').currency).toBe('INR');
    expect(parseAmount('1,180.00').currency).toBeNull();
    // The VALUE is unaffected — only the knowledge of what it counts.
    expect(parseAmount('€ 38.47').value).toBe('38.47');
  });

  it('marks a bare dollar sign as assumed, because several countries use it', () => {
    expect(currencyOf('$9.00')).toBe('USD');
    expect(currencyWasAssumed('$9.00')).toBe(true);
    expect(currencyWasAssumed('9.00 USD')).toBe(false);
  });

  it('reports the one currency a table is written in', () => {
    const c = tableCurrency(table(['Routing', '1', '$9.00', '$9.00']));
    expect(c.currency).toBe('USD');
    expect(c.assumed).toBe(true);
  });

  it('refuses to name a currency for a table that mixes them', () => {
    /*
     * A document speaking two currencies has been misread or is not one
     * invoice. Either way its figures cannot legitimately be added, and the
     * tie would pass on a sum that means nothing.
     */
    const c = tableCurrency(table(
      ['Routing', '1', '$9.00', '$9.00'],
      ['Storage', '1', '€ 6.49', '€ 6.49'],
    ));
    expect(c.currency).toBeNull();
    expect(c.mixed.sort()).toEqual(['EUR', 'USD']);
  });
});

describe('converting a foreign figure to rupees', () => {
  it('applies the rate the filer supplied', () => {
    expect(toRupees('9.56', '88.20')).toBe('843.19');
    expect(toRupees('44.96', '96.50')).toBe('4338.64');
  });

  it('keeps four decimal places of the rate', () => {
    /*
     * A rate is not money. Rounding 88.2050 to 88.21 before multiplying moves
     * a large invoice by more than the rounding it was meant to avoid.
     */
    expect(toRupees('1000.00', '88.2050')).toBe('88205.00');
    expect(toRupees('1000.00', '88.21')).toBe('88210.00');
  });

  it('refuses a rate that is not a rate', () => {
    expect(() => toRupees('10.00', '88.20501')).toThrow(/exchange rate/);
    expect(() => toRupees('10.00', 'about 88')).toThrow(/exchange rate/);
  });
});

describe('when the tax falls due — IGST s.13(3)', () => {
  it('is the sixtieth day after the invoice when nothing was paid', () => {
    // NOT the invoice date, and the difference decides the return period.
    const t = timeOfSupply('2026-07-09');
    expect(t.date).toBe('2026-09-07');
    expect(t.basis).toMatch(/sixtieth day/);
  });

  it('is the payment date when payment came first', () => {
    const t = timeOfSupply('2026-07-09', '2026-08-01');
    expect(t.date).toBe('2026-08-01');
  });

  it('stays at the sixtieth day when payment came later', () => {
    const t = timeOfSupply('2026-07-09', '2026-12-01');
    expect(t.date).toBe('2026-09-07');
  });

  it('crosses a month and a year end correctly', () => {
    expect(timeOfSupply('2026-11-20').date).toBe('2027-01-19');
  });
});
