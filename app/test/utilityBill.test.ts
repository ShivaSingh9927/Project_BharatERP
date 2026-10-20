/**
 * Reading an electricity bill by its own declaration.
 *
 * The text below is synthetic, laid out the way `pdftotext -layout` renders a
 * state distribution company's bill: the provider at the head, the consumer's
 * name a few lines down, the charge summary in ruled columns, and the bill
 * details table on a later page. No real bill content is used.
 */

import { describe, it, expect } from 'vitest';
import { readUtilityBill, currentBillAmounts, sameParty } from '../src/parse/utilityBill.ts';

const BILL = [
  '            Example Vidyut Vitran Nigam Ltd.                      Printed On : 7/9/2026 04:52:17 PM',
  '              Electricity Bill Cum Notice                         Due Date :      16-AUG-2026',
  '                                                                  Disconnection Date : 23-AUG-2026',
  'Account No.        : 1000-200-300                      Division : EXAMPLE DIVISION',
  'Name               : SAMPLE CONSUMER                   Category : LMV1 Residential / Domestic',
  'Father / Husband Name : SAMPLE RELATIVE',
  'Bill Duration 6 : 06-JUL-2026 To 09-AUG-2026',
  'Bill No            : 900-111-222-333     Net Billed Unit : 179.00 KWH',
  'Bill Date          : 09-AUG-2026',
  '      Previous Dues          Current Bill Amount          Payable Amount',
  '          -0.38                   1,264.61                    1,264.00',
  '    Due Date Rebate 9        Payable by Due Date      Minimum Payable Amount 10',
  '          12.01                   1,252.00',
  '\f                  Table 1: Bill Details',
  'Energy Charges              989.00      Current LPSC                4.20',
  'Demand Charges              247.50      Current Bill Amount      1264.61',
  'Electricity Duty             60.02      Arrear Amount              -0.38',
  'FPPA Surcharge              -36.11      Payable Amount              1264',
].join('\n');

describe('sameParty', () => {
  it('ignores legal suffixes and punctuation', () => {
    expect(sameParty('M/s. Shree Ram Trading Co.', 'Shree Ram Trading Company')).toBe(true);
    expect(sameParty('SHREE RAM TRADING PVT LTD', 'Shree Ram Trading Private Limited')).toBe(true);
  });
  it('does not treat a person and a business as the same', () => {
    expect(sameParty('SAMPLE CONSUMER', 'Shree Ram Trading Company')).toBe(false);
    expect(sameParty('Co', 'Shree Ram Trading Company')).toBe(false);
  });
});

describe('readUtilityBill', () => {
  it('reads the provider, the charge, the period, and what to pay by when', () => {
    expect(readUtilityBill(BILL)).toEqual({
      kind: 'electricity',
      issuer: 'Example Vidyut Vitran Nigam Ltd.',
      amount: '1264.61',
      period: { from: '2026-07-06', to: '2026-08-09' },
      dueDate: '2026-08-16',
      payable: '1264.00',
      connection: 'residential',
      consumerName: 'SAMPLE CONSUMER',
    });
  });

  it('reads the tariff category from its own field', () => {
    const shop = BILL.replace('LMV1 Residential / Domestic', 'LMV2 Non-Domestic / Commercial');
    expect(readUtilityBill(shop)?.connection).toBe('non_residential');
    expect(readUtilityBill(BILL.replace(/Category : .*/, ''))?.connection).toBeNull();
  });

  it('takes the connection holder, never the father or husband name', () => {
    const relativeFirst = BILL.replace(/Name +: SAMPLE CONSUMER {3}/, 'Account Type : LT   ');
    expect(readUtilityBill(relativeFirst)?.consumerName).toBeNull();
  });

  it('books the current bill amount, never the rounded payable amount', () => {
    // The payable includes earlier balances and rupee rounding; the charge for
    // the period is what the expense is.
    expect(currentBillAmounts(BILL)).toEqual(['1264.61']);
  });

  it('does not offer the consumer as the provider', () => {
    const noProvider = BILL.replace('Example Vidyut Vitran Nigam Ltd.', 'Customer Copy');
    expect(readUtilityBill(noProvider)?.issuer).toBeNull();
  });

  it('ignores a document that does not call itself an electricity bill', () => {
    expect(readUtilityBill(BILL.replace('Electricity Bill', 'Statement'))).toBeNull();
  });

  it('declines when two different current bill amounts are printed', () => {
    expect(readUtilityBill(`${BILL}\nRevised Current Bill Amount : 1300.00`)).toBeNull();
  });

  it('leaves out details it cannot settle rather than guessing', () => {
    const sparse = BILL
      .replace(/Bill Duration.*\n/, '')
      .replace('Due Date :      16-AUG-2026', 'Due Date :')
      .replace('Payable Amount              1264', 'Total');
    const read = readUtilityBill(sparse)!;
    expect(read.amount).toBe('1264.61');
    expect(read.period).toBeNull();
    expect(read.dueDate).toBeNull();
    expect(read.payable).toBeNull();
  });
});
