/**
 * Depositing what was deducted — bills-and-expenses.md BE-37.
 *
 * BE-36 computes the deduction; this is about the date. The two failures it
 * exists to catch cost money on a timetable rather than through a wrong
 * figure: tax deducted and not deposited carries 1.5% a month under
 * s.201(1A), and a statement not filed carries ₹200 a day under s.234E.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, registerGstin, createFiscalYear,
         type SeededTenant } from '../src/seed/index.ts';
import { seedItcEligibility } from '../src/seed/tdsSections.ts';
import { createBill } from '../src/domain/bills.ts';
import { tdsPosition, recordTdsDeposit, quarterDeductions,
         monthsOrPart, quarterOf } from '../src/domain/tdsCompliance.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { trialBalance } from '../src/reports/index.ts';
import { ownerPool, closePools } from '../src/db/pool.ts';

const gstin = (state: string, pan: string) => {
  const f = `${state}${pan}1Z`;
  return f + gstinCheckDigit(f);
};

let t: SeededTenant;
const acct: Record<string, string> = {};
let advocate: string;

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  t = await seedTenant({
    firmName: `Dep ${tag}`, clientName: `Client ${tag}`,
    userEmail: `dep-${tag}@example.test`, startYear: 2026,
    pan: 'AAACD2222D', businessType: 'general',
  });
  await seedItcEligibility(t.clientId);
  await createFiscalYear(t.firmId, t.clientId, 2027);
  await registerGstin(t.firmId, t.clientId, gstin('09', 'AAACD2222D'), { primary: true });

  const r = await ownerPool.query<{ id: string; name: string }>(
    `SELECT id, name FROM accounts WHERE client_id = $1 AND NOT is_group
       AND name IN ('Professional Fees','Creditors','Bank Accounts',
                    'TDS Payable','Interest and Penalties on Taxes')`,
    [t.clientId]);
  for (const a of r.rows) acct[a.name] = a.id;

  advocate = (await ownerPool.query<{ id: string }>(
    `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name, gstin,
                          gst_category, state_code, ledger_account_id, created_by)
     VALUES ($1,$2,'supplier','Mehta & Co','Mehta & Co',$3,
             'registered_regular','09',$4,$5) RETURNING id`,
    [t.firmId, t.clientId, gstin('09', 'AACFM3333M'), acct['Creditors'], t.userId])).rows[0]!.id;
});

afterAll(async () => { await closePools(); });

const bill = (number: string, date: string, amount: string) => createBill(t.firmId, {
  clientId: t.clientId, partyId: advocate,
  billNumber: number, billDate: date,
  lines: [{ description: 'Legal fees', unitPrice: amount, gstRate: '18',
            expenseAccountId: acct['Professional Fees']! }],
  createdBy: t.userId,
  tds: { category: 'Professional Fees', deduct: true },
});

// ---------------------------------------------------------------------------
describe('counting the months interest runs for', () => {
  it('charges a part month as a whole one', () => {
    /*
     * s.201(1A) charges interest "for every month or part of a month". One day
     * late is one month's interest — not a thirtieth of one. Prorating would
     * understate every single case, and a CA checking our figure against the
     * department's would find ours short.
     */
    expect(monthsOrPart('2026-05-07', '2026-05-08')).toBe(1);
    expect(monthsOrPart('2026-05-07', '2026-06-06')).toBe(1);
    expect(monthsOrPart('2026-05-07', '2026-06-07')).toBe(2);
    expect(monthsOrPart('2026-05-07', '2026-08-01')).toBe(3);
    // Not yet due, or paid on the day: nothing.
    expect(monthsOrPart('2026-05-07', '2026-05-07')).toBe(0);
    expect(monthsOrPart('2026-05-07', '2026-04-01')).toBe(0);
  });

  it('places a month in the right fiscal quarter', () => {
    // April-first fiscal year, so January is Q4 and not Q1.
    expect(quarterOf('2026-04').label).toMatch(/Q1/);
    expect(quarterOf('2026-09').label).toMatch(/Q2/);
    expect(quarterOf('2026-12').label).toMatch(/Q3/);
    expect(quarterOf('2027-01').label).toMatch(/Q4/);
    expect(quarterOf('2027-03').endMonth).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('what is due, and when', () => {
  it('dates a deposit from the month of deduction', async () => {
    await bill('MC/1', '2026-06-10', '200000');
    const p = await tdsPosition(t.firmId, t.clientId, '2026-06-30');
    const june = p.months.find((m) => m.period === '2026-06')!;

    expect(june.deducted).toBe('20000.00');
    expect(june.outstanding).toBe('20000.00');
    // Rule 30: the 7th of the following month.
    expect(june.deposit?.due).toBe('2026-07-07');
    expect(june.deposit?.citation).toMatch(/Rule 30/);
    // Not late yet, so no interest — the deadline is in the future.
    expect(june.overdue).toBeNull();
    // Rule 31A: Q1's statement, due 31 July.
    expect(june.statement?.due).toBe('2026-07-31');
    expect(june.statement?.quarter).toMatch(/Q1/);
  });

  it('gives March until 30 April, not 7 April', async () => {
    /*
     * The one exception in Rule 30, and it is a row in the master rather than
     * an `if` in the code — so a CBDT extension is an insert, not a deploy.
     */
    await bill('MC/2', '2027-03-20', '100000');
    const p = await tdsPosition(t.firmId, t.clientId, '2027-03-31');
    const march = p.months.find((m) => m.period === '2027-03')!;
    expect(march.deposit?.due).toBe('2027-04-30');
    expect(march.deposit?.citation).toMatch(/30 April/);
    // Q4's statement is the odd one out too: May, not April.
    expect(march.statement?.due).toBe('2027-05-31');
  });

  it('accrues interest once the deposit is late', async () => {
    // 20,000 unpaid, due 7 July, looked at on 20 August: two part months.
    const p = await tdsPosition(t.firmId, t.clientId, '2026-08-20');
    const june = p.months.find((m) => m.period === '2026-06')!;
    expect(june.overdue?.months).toBe(2);
    expect(june.overdue?.rate).toBe('1.50');
    expect(june.overdue?.interest).toBe('600.00');    // 20,000 x 1.5% x 2
    expect(p.totalInterest).toBe('600.00');
  });
});

// ---------------------------------------------------------------------------
describe('recording the challan', () => {
  it('refuses a challan for more than the month owes', async () => {
    /*
     * Over-depositing leaves TDS Payable in credit for a liability that never
     * existed, and the excess is genuinely hard to get back from the
     * department — so it is refused rather than reconciled later.
     */
    await expect(recordTdsDeposit(t.firmId, {
      clientId: t.clientId, period: '2026-06', depositedOn: '2026-07-05',
      tax: '25000', paidFromAccountId: acct['Bank Accounts']!,
      createdBy: t.userId,
    })).rejects.toThrow(/more than the 20000\.00 still owed/);
  });

  it('refuses a period that is not a month', async () => {
    await expect(recordTdsDeposit(t.firmId, {
      clientId: t.clientId, period: '2026', depositedOn: '2026-07-05',
      tax: '100', paidFromAccountId: acct['Bank Accounts']!,
      createdBy: t.userId,
    })).rejects.toThrow(/is not a month/);
  });

  it('clears the liability and keeps interest out of it', async () => {
    const r = await recordTdsDeposit(t.firmId, {
      clientId: t.clientId, period: '2026-06', depositedOn: '2026-08-20',
      tax: '20000', interest: '600',
      paidFromAccountId: acct['Bank Accounts']!,
      bsrCode: '0510308', challanSerial: '00042',
      createdBy: t.userId,
    });
    expect(r.remitted).toBe('20600.00');

    const rows = await ownerPool.query<{ name: string; debit: string; credit: string }>(
      `SELECT a.name, le.debit::text, le.credit::text
         FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
        WHERE le.voucher_id = $1`, [r.voucherId]);
    const by = Object.fromEntries(rows.rows.map((x) => [x.name, x]));

    // The tax clears the liability; the interest is the client's own cost and
    // goes to its own head, so TDS Payable still reconciles to what was
    // deducted rather than to what was remitted.
    expect(by['TDS Payable']!.debit).toBe('20000.00');
    expect(by['Interest and Penalties on Taxes']!.debit).toBe('600.00');
    expect(by['Bank Accounts']!.credit).toBe('20600.00');
  });

  it('refuses when the chart has nowhere to put the interest', async () => {
    /*
     * The bug this pins, which every test here structurally could not catch.
     *
     * `recordTdsDeposit` looked for the interest account by name and fell back
     * to "any account of that type" — so on a chart predating that account it
     * debited a client's late-payment interest to Other Income. Silently.
     * Every test tenant is built from the current chart template, so every
     * test had the account and every test passed; only a live run against an
     * older tenant showed it.
     *
     * A missing account is a chart to fix, not a reason to guess.
     */
    await ownerPool.query(
      `UPDATE accounts SET name = 'Renamed Away' WHERE id = $1`,
      [acct['Interest and Penalties on Taxes']]);
    try {
      await expect(recordTdsDeposit(t.firmId, {
        clientId: t.clientId, period: '2027-03', depositedOn: '2027-04-10',
        tax: '100', interest: '5',
        paidFromAccountId: acct['Bank Accounts']!, createdBy: t.userId,
      })).rejects.toThrow(/no "Interest and Penalties on Taxes" account/);
    } finally {
      await ownerPool.query(
        `UPDATE accounts SET name = 'Interest and Penalties on Taxes' WHERE id = $1`,
        [acct['Interest and Penalties on Taxes']]);
    }
  });

  it('stops charging interest on a month once it is paid', async () => {
    /*
     * The figure crystallised when the challan was paid. A report that kept
     * charging would bill the client for a debt they have settled — and it is
     * the reason interest is computed on the OUTSTANDING rather than on what
     * was deducted.
     */
    const p = await tdsPosition(t.firmId, t.clientId, '2026-12-31');
    const june = p.months.find((m) => m.period === '2026-06')!;
    expect(june.deposited).toBe('20000.00');
    expect(june.outstanding).toBe('0.00');
    expect(june.overdue).toBeNull();
  });

  it('leaves TDS Payable holding only what is still unpaid', async () => {
    const tb = await trialBalance(t.firmId, t.clientId, '2027-03-31');
    const tds = tb.rows.find((x) => x.name === 'TDS Payable')!;
    // 20,000 (June) + 10,000 (March) deducted, 20,000 deposited.
    expect(Number(tds.credit) - Number(tds.debit)).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
describe('the quarter, supplier by supplier', () => {
  it('lists the deductions a statement has to report', async () => {
    const q = await quarterDeductions(t.firmId, t.clientId, '2026-06');
    expect(q.rows.length).toBe(1);
    const row = q.rows[0]!;
    expect(row.party).toBe('Mehta & Co');
    // The PAN a return must quote, read out of the GSTIN that contains it.
    expect(row.pan).toBe('AACFM3333M');
    expect(row.base).toBe('200000.00');
    expect(row.amount).toBe('20000.00');
    expect(row.limb).toBe('credit');
    expect(row.billNumber).toBe('MC/1');
    expect(q.total).toBe('20000.00');
  });

  it('keeps a March deduction out of the Q1 statement', async () => {
    // The quarter is decided by the deduction date, and Q4 of one fiscal year
    // is not Q1 of the next.
    const q1 = await quarterDeductions(t.firmId, t.clientId, '2026-06');
    expect(q1.rows.some((r) => r.billNumber === 'MC/2')).toBe(false);
    const q4 = await quarterDeductions(t.firmId, t.clientId, '2027-03');
    expect(q4.rows.some((r) => r.billNumber === 'MC/2')).toBe(true);
  });
});
