/**
 * Charges written in words rather than ruled into a grid — bills-and-expenses.md BE-19, BE-20.
 *
 * This reader has no column geometry. It cannot know which figures on a page
 * are charges, so it does not pretend to: it sums every line carrying exactly
 * one amount and requires the sum to equal the total the document states. The
 * arithmetic IS the safeguard, so most of what is tested here is the refusals.
 *
 * The fixture reproduces the LAYOUT of a real travel agent's invoice — the
 * wording and the order of the lines, which is what the reader keys on. Every
 * figure and name is invented; real client documents stay out of this repo.
 */

import { describe, it, expect } from 'vitest';
import { readChargeBlock } from '../src/parse/chargeBlock.ts';

/** 20,000 + 3,600 (18%) = 23,600. */
const TRAVEL = `
Paxname            Service Description/Particulars      Standard Charges
Ms. A Traveller        HOTEL BOOKING                          20,000.00

HOTEL NAME       :   A HOTEL                    NO OF ROOMS  :  01
NIGHTS           :   03                         CHECKIN DATE :  04/12/2026

                                     Add: Service Charge          0.00
                                     Add: IGST@18%             3,600.00

RS.  TWENTY-THREE THOUSAND SIX HUNDRED ONLY      Total Payable :  23,600.00
`;

describe('reading charges stated in words', () => {
  it('reads the base, the tax and the total, and ties them', () => {
    const c = readChargeBlock(TRAVEL, 'yes');
    expect(c?.table.readable).toBe(true);
    expect(c?.table.sums).toMatchObject({
      taxable: '20000.00', igst: '3600.00', total: '23600.00' });
  });

  it('reads a rate written with decimals as well as without', () => {
    // "18.00%" was silently unreadable while "18%" worked: the trailing
    // "18.00" parsed as a second amount on the line, so the whole addition was
    // discarded as not understood and the invoice had no tax at all.
    const c = readChargeBlock(TRAVEL.replace('IGST@18%', 'IGST@18.00%'), 'yes');
    expect(c?.table.sums.igst).toBe('3600.00');
  });

  it('finds the total when the label hides inside the amount in words', () => {
    // "NINETY" contains "NET". An earlier attempt trimmed the line to the
    // first of total|net|amount|grand and then anchored, which lost the line.
    const ninety = TRAVEL
      .replace('20,000.00', '90,000.00').replace('3,600.00', '16,200.00')
      .replace('23,600.00', '1,06,200.00')
      .replace('TWENTY-THREE THOUSAND SIX HUNDRED ONLY',
               'ONE LAKH SIX THOUSAND TWO HUNDRED NINETY-NINE ONLY');
    expect(readChargeBlock(ninety, 'yes')?.table.readable).toBe(true);
  });

  it('says on the record that the charges were not read from a table', () => {
    expect(readChargeBlock(TRAVEL, 'yes')?.table.warnings?.join(' '))
      .toMatch(/in words rather than in a table/);
  });

  it('folds a non-tax addition into the taxable value', () => {
    // A service charge is part of the consideration for the supply. 20,000 +
    // 1,000 = 21,000 taxable, 18% = 3,780, total 24,780.
    const withFee = TRAVEL
      .replace('Add: Service Charge          0.00', 'Add: Service Charge      1,000.00')
      .replace('3,600.00', '3,780.00').replace('23,600.00', '24,780.00');
    const c = readChargeBlock(withFee, 'yes');
    expect(c?.table.readable).toBe(true);
    expect(c?.table.sums.taxable).toBe('21000.00');
  });
});

describe('what it refuses', () => {
  it('refuses when the parts do not add to the stated total', () => {
    const c = readChargeBlock(TRAVEL.replace('Total Payable :  23,600.00',
                                             'Total Payable :  23,900.00'), 'yes');
    expect(c).not.toBeNull();
    expect(c!.table.readable).toBe(false);
  });

  it('refuses when the tax does not follow the rate printed beside it', () => {
    // 18% of 20,000 is 3,600. A document adding 3,000 and still totalling
    // consistently has had a figure misread.
    const c = readChargeBlock(TRAVEL.replace('3,600.00', '3,000.00')
                                    .replace('23,600.00', '23,000.00'), 'yes');
    expect(c!.table.readable).toBe(false);
    expect(c!.table.reason).toMatch(/does not follow the rate/);
  });

  it('accepts tax rounded to the whole rupee, as s.170 requires', () => {
    // 18% of 1,10,925 is 19,966.50; the statute rounds it to 19,967.
    const rounded = TRAVEL
      .replace('20,000.00', '110,925.00').replace('3,600.00', '19,967.00')
      .replace('23,600.00', '130,892.00');
    expect(readChargeBlock(rounded, 'yes')?.table.readable).toBe(true);
  });

  it('declines a document with no tax addition at all', () => {
    const noTax = TRAVEL.replace('Add: IGST@18%             3,600.00', '')
                        .replace('23,600.00', '20,000.00');
    expect(readChargeBlock(noTax, 'yes')).toBeNull();
  });

  it('declines an ordinary item grid rather than summing its columns', () => {
    // Every row of a grid carries several amounts, so none is counted as a
    // charge, the base comes to nothing and the reader stands down. This is
    // what stops it becoming a way past a table that read badly.
    const grid = `
Sr  Description      Qty   Rate      Taxable    IGST      Amount
1   Widget           2     500.00    1,000.00   180.00    1,180.00
2   Gadget           1     800.00      800.00   144.00      944.00
                                     Add: IGST@18%         324.00
                                     Total Payable :     2,124.00
`;
    expect(readChargeBlock(grid, 'yes')).toBeNull();
  });
});
