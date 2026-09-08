/**
 * Reading an amount as Indian documents actually write it.
 * Spec: bills-and-expenses.md BE-27
 *
 * `parseAmount` is the narrowest gate in the system and the one everything
 * else rests on: a figure it refuses is a cell gate 1 refuses, which is a
 * table that will not read, which is a bill that does not post. So the
 * notations here are not cosmetic — each one, unhandled, costs a whole
 * document.
 */

import { describe, it, expect } from 'vitest';
import { parseAmount, currencyOf } from '../src/parse/values.ts';

describe('the "rupees and no paise" suffix', () => {
  it('reads 15,000/- as fifteen thousand', () => {
    expect(parseAmount('15,000/-').value).toBe('15000.00');
  });

  it('reads it with a currency in front', () => {
    for (const v of ['Rs. 15,000/-', 'Rs.15000/-', '₹15,000/-', 'INR 15,000/-']) {
      expect(parseAmount(v).value).toBe('15000.00');
    }
  });

  it('reads the dash Word gives you instead of a hyphen', () => {
    /*
     * The one that mattered. Word autocorrects "/-" to an en dash as you type,
     * so a bill written in Word and exported to PDF carries U+2013 — which is
     * exactly how the professional-fees bill that prompted this arrived.
     */
    expect(parseAmount('15,000/–').value).toBe('15000.00');   // en dash
    expect(parseAmount('15,000/—').value).toBe('15000.00');   // em dash
  });

  it('reads the older /= bookkeeping form, and a trailing stop', () => {
    expect(parseAmount('15,000/=').value).toBe('15000.00');
    expect(parseAmount('15,000 /=').value).toBe('15000.00');
    expect(parseAmount('15,000/-.').value).toBe('15000.00');
  });

  it('handles lakh grouping', () => {
    expect(parseAmount('1,50,000/-').value).toBe('150000.00');
  });

  it('keeps accounting parentheses meaning negative', () => {
    // The suffix must not swallow the closing bracket and with it the sign.
    const r = parseAmount('(15,000/-)');
    expect(r.value).toBe('15000.00');
    expect(r.negative).toBe(true);
  });

  it('still refuses a suffix that is not one', () => {
    // The rule is a specific notation, not "ignore whatever trails a number".
    expect(() => parseAmount('15,000/x')).toThrow();
  });
});

describe('the word written out', () => {
  it('reads "15000 Rupees" and "15000 rupees only"', () => {
    // Written out at least as often as abbreviated, and "Only" closes the
    // figure on most Indian bills and receipts.
    for (const v of ['15000 Rupees', '15000 rupees only', '15,000 Rupees Only',
                     'Rupees 15,000', '15,000 Only']) {
      expect(parseAmount(v).value).toBe('15000.00');
    }
  });

  it('keeps the paise when there are any', () => {
    expect(parseAmount('15,000.50 Rupees Only').value).toBe('15000.50');
  });

  it('recognises the spelled-out word as an INR marker', () => {
    expect(currencyOf('15,000 Rupees')).toBe('INR');
  });

  it('does not strip "Rupees" into "upees"', () => {
    // Order matters: the spelled-out rule has to run before the bare "Rs" one.
    expect(parseAmount('Rupees 1,50,000/-').value).toBe('150000.00');
  });

  it('leaves an amount in words alone', () => {
    // No digits, so there is nothing here to read. Converting words to a
    // number is a different job and not one this function should guess at.
    expect(() => parseAmount('Rupees Fifteen Thousand Only')).toThrow();
  });

  it('treats a cell of nothing but the word as BLANK, not as zero', () => {
    /*
     * The distinction the whole module turns on. A blank cell is "no figure
     * here"; a zero is a figure read off the page. Collapsing the two would
     * let a stray word satisfy a money column that should have been empty.
     */
    const r = parseAmount('Only');
    expect(r.blank).toBe(true);
    expect(parseAmount('').blank).toBe(true);
  });
});
