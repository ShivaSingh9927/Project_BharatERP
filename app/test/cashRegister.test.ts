/**
 * Negative cash balances — CA review answer B4, DEFECT-LOG G-21.
 *
 * "A negative cash balance is mathematically impossible and the most common
 * error CAs have to fix." Not a rule to look up, not a judgement call: the
 * money either went below zero or it did not.
 *
 * The two tests that carry their weight are the OD account (which must NOT be
 * flagged, or the check gets switched off within a week) and the mid-month dip
 * that recovers by month end — because a closing-balance check would miss it,
 * and that is exactly the error this is for.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { postVoucher } from '../src/domain/posting.ts';
import { cashRegisterCheck } from '../src/reports/cashRegister.ts';
import { withFirm, closePools } from '../src/db/pool.ts';

let t: SeededTenant;
let odAccount: string;

const A = (n: string): string => t.accounts[n]!;

/** Money in or out of Cash, against Sales or Office Rent. */
const cashMove = (date: string, into: string, amount: string, other: string) =>
  postVoucher(t.firmId, {
    clientId: t.clientId,
    voucherType: into === 'in' ? 'receipt' : 'payment',
    postingDate: date,
    createdBy: t.userId,
    lines: into === 'in'
      ? [{ accountId: A('Cash'), debit: amount },
         { accountId: A('Sales'), credit: amount }]
      : [{ accountId: A('Office Rent'), debit: amount },
         { accountId: A('Cash'), credit: amount }],
  });

beforeAll(async () => {
  t = await seedTenant({
    firmName: `Cash Firm ${randomUUID().slice(0, 8)}`,
    clientName: 'Cash Test Ltd',
    userEmail: `cash-${randomUUID()}@test.local`,
    startYear: 2026,
  });

  // A cash-credit facility: a BANK account that is meant to run negative.
  odAccount = await withFirm(t.firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO accounts (firm_id, client_id, name, account_type, root_type,
                             normal_balance, liquidity_class, is_group, created_by)
       VALUES ($1,$2,'HDFC Cash Credit','bank','asset','debit','current',false,$3)
       RETURNING id`,
      [t.firmId, t.clientId, t.userId]);
    return r.rows[0]!.id;
  });
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('cash register (B4, G-21)', () => {
  it('passes a cash book that never goes below zero', async () => {
    await cashMove('2026-04-01', 'in', '50000', 'Sales');
    await cashMove('2026-04-05', 'out', '20000', 'Office Rent');

    const r = await cashRegisterCheck(t.firmId, t.clientId, { to: '2026-04-30' });
    expect(r.ok).toBe(true);
    expect(r.negativeDays).toEqual([]);
    expect(r.accountsChecked).toBeGreaterThan(0);
  });

  it('catches a dip that RECOVERS before month end', async () => {
    // The case a closing-balance check cannot see, and the reason this walks
    // day by day. Cash goes to -10,000 on the 12th and is back to +15,000 by
    // the 20th, so the month looks perfectly healthy from the outside.
    await cashMove('2026-05-12', 'out', '40000', 'Office Rent');   // 30,000 -> -10,000
    await cashMove('2026-05-20', 'in', '25000', 'Sales');          // -10,000 -> 15,000

    const month = await cashRegisterCheck(t.firmId, t.clientId,
      { from: '2026-05-01', to: '2026-05-31' });

    expect(month.ok).toBe(false);
    expect(month.negativeDays[0]!.date).toBe('2026-05-12');
    expect(month.negativeDays[0]!.balance).toBe('-10000.00');
    expect(month.negativeDays[0]!.shortfall).toBe('10000.00');
    expect(month.detail).toMatch(/unrecorded/);
  });

  it('names the vouchers of that day, to start the investigation', async () => {
    const r = await cashRegisterCheck(t.firmId, t.clientId,
      { from: '2026-05-01', to: '2026-05-31' });
    const day = r.negativeDays[0]!;
    expect(day.vouchers.length).toBeGreaterThan(0);
    expect(day.vouchers[0]!.voucherType).toBe('payment');
  });

  it('reports a run of negative days as ONE episode, not fourteen', async () => {
    // A cash book that goes negative and stays negative is one missing
    // receipt. Listing every day would bury the rest of the month's errors.
    await cashMove('2026-06-02', 'out', '20000', 'Office Rent');   // 15,000 -> -5,000
    await cashMove('2026-06-03', 'out', '1000', 'Office Rent');    // still negative
    await cashMove('2026-06-04', 'out', '1000', 'Office Rent');    // still negative

    const r = await cashRegisterCheck(t.firmId, t.clientId,
      { from: '2026-06-01', to: '2026-06-30' });
    expect(r.negativeDays).toHaveLength(1);
    expect(r.negativeDays[0]!.date).toBe('2026-06-02');
  });

  it('does NOT flag an overdraft account, which is meant to go negative', async () => {
    // Review answer B5: an OD/CC facility is a running loan and going negative
    // is what it is FOR. Flagging it would fire on every manufacturing client
    // every month, and the check would be switched off — taking the genuine
    // cash findings with it.
    await postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'payment', postingDate: '2026-07-01',
      createdBy: t.userId,
      lines: [{ accountId: A('Office Rent'), debit: '500000' },
              { accountId: odAccount, credit: '500000' }],
    });

    const r = await cashRegisterCheck(t.firmId, t.clientId,
      { from: '2026-07-01', to: '2026-07-31' });
    expect(r.negativeDays.some((d) => d.accountId === odAccount)).toBe(false);
  });

  it('counts everything before the window, not just entries inside it', async () => {
    // Starting a mid-year report from zero would report a negative cash book
    // for any client who simply holds cash. The first false alarm is what gets
    // a check like this disabled, so the opening balance is load-bearing.
    const july = await cashRegisterCheck(t.firmId, t.clientId,
      { from: '2026-07-01', to: '2026-07-31' });

    // Cash was positive at the end of June and had no July movements, so a
    // window starting in July must still see the carried-forward balance.
    expect(july.negativeDays.filter((d) => d.accountName === 'Cash')).toEqual([]);
  });
});
