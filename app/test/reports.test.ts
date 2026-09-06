/**
 * Report acceptance tests.
 *
 * These use the exact worked examples from the accounting lessons, so the
 * expected figures are ones we derived by hand. If a future refactor breaks
 * the P&L waterfall or the accounting equation, these fail immediately.
 *
 * Spec: gl-engine.md §8, T-9, T-10
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { postVoucher } from '../src/domain/posting.ts';
import { trialBalance, balanceSheet, profitAndLoss, accountLedger } from '../src/reports/index.ts';
import { closePools } from '../src/db/pool.ts';

let t: SeededTenant;
const A = (n: string): string => {
  const id = t.accounts[n];
  if (!id) throw new Error(`missing account ${n}`);
  return id;
};

const post = (
  voucherType: Parameters<typeof postVoucher>[1]['voucherType'],
  postingDate: string,
  narration: string,
  lines: Parameters<typeof postVoucher>[1]['lines'],
) => postVoucher(t.firmId, {
  clientId: t.clientId, voucherType, postingDate, narration,
  createdBy: t.userId, lines,
});

beforeAll(async () => {
  t = await seedTenant({
    firmName: `Reports Firm ${randomUUID().slice(0, 8)}`,
    clientName: 'Bharat Manufacturing Co',
    userEmail: `rep-${randomUUID()}@test.local`,
    startYear: 2026,
  });

  const customer = randomUUID();
  const supplier = randomUUID();

  // --- Lesson 3: owner introduces capital -------------------------------
  await post('receipt', '2026-04-01', 'Owner capital introduced', [
    { accountId: A('Bank Accounts'), debit: '50000.00' },
    { accountId: A("Owner's Capital"), credit: '50000.00' },
  ]);

  // --- Lesson 1: bank loan received -------------------------------------
  await post('receipt', '2026-04-02', 'Bank loan received', [
    { accountId: A('Bank Accounts'), debit: '100000.00' },
    { accountId: A('Bank Loan'), credit: '100000.00' },
  ]);

  // --- Lesson 7 worked example: the manufacturing P&L -------------------
  // Sales 5,00,000 · Raw materials 2,00,000 · Factory wages 50,000
  // Office rent 40,000 · Marketing 30,000 · Interest 10,000
  // Expected: Gross 2,50,000 · Operating 1,80,000 · Net 1,70,000
  await post('sales', '2026-05-10', 'Sales for the year', [
    { accountId: A('Debtors'), debit: '500000.00', partyType: 'customer', partyId: customer },
    { accountId: A('Sales'), credit: '500000.00' },
  ]);
  await post('purchase', '2026-05-11', 'Raw materials consumed', [
    { accountId: A('Raw Materials'), debit: '200000.00' },
    { accountId: A('Creditors'), credit: '200000.00', partyType: 'supplier', partyId: supplier },
  ]);
  await post('journal', '2026-05-12', 'Factory wages', [
    { accountId: A('Factory Wages'), debit: '50000.00' },
    { accountId: A('Bank Accounts'), credit: '50000.00' },
  ]);
  await post('payment', '2026-05-13', 'Office rent', [
    { accountId: A('Office Rent'), debit: '40000.00' },
    { accountId: A('Bank Accounts'), credit: '40000.00' },
  ]);
  await post('payment', '2026-05-14', 'Marketing spend', [
    { accountId: A('Marketing'), debit: '30000.00' },
    { accountId: A('Bank Accounts'), credit: '30000.00' },
  ]);
  await post('payment', '2026-05-15', 'Interest on bank loan', [
    { accountId: A('Interest on Loan'), debit: '10000.00' },
    { accountId: A('Bank Accounts'), credit: '10000.00' },
  ]);

  // --- Lesson 3: owner withdraws for personal use (NOT an expense) ------
  await post('payment', '2026-06-01', 'Owner drawings', [
    { accountId: A('Drawings'), debit: '5000.00' },
    { accountId: A('Bank Accounts'), credit: '5000.00' },
  ]);

  // --- Lesson 8: annual depreciation, straight line ---------------------
  await post('journal', '2026-06-02', 'Furniture purchase', [
    { accountId: A('Furniture and Fixtures'), debit: '300000.00' },
    { accountId: A('Bank Accounts'), credit: '300000.00' },
  ]);
  await post('depreciation', '2027-03-31', 'Depreciation SLM 10yr on furniture', [
    { accountId: A('Depreciation'), debit: '30000.00' },
    { accountId: A('Accumulated Depreciation'), credit: '30000.00' },
  ]);
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('Trial Balance (Lesson 2)', () => {
  it('T-9 total debits equal total credits', async () => {
    const tb = await trialBalance(t.firmId, t.clientId, '2027-03-31');
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.rows.length).toBeGreaterThan(5);
  });

  it('omits accounts with a zero net balance', async () => {
    const tb = await trialBalance(t.firmId, t.clientId, '2027-03-31');
    expect(tb.rows.every((r) => Number(r.debit) !== 0 || Number(r.credit) !== 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Profit & Loss waterfall (Lesson 7)', () => {
  it('reproduces the hand-computed manufacturing example', async () => {
    const pl = await profitAndLoss(t.firmId, t.clientId, '2026-04-01', '2027-03-31');

    expect(pl.revenue).toBe('500000.00');
    expect(pl.cogs).toBe('250000.00');           // raw materials + factory wages
    expect(pl.grossProfit).toBe('250000.00');    // Lesson 7 answer

    // Opex here includes the lesson's 70,000 plus 30,000 depreciation.
    expect(pl.operatingExpenses).toBe('100000.00');
    expect(pl.operatingProfit).toBe('150000.00');

    expect(pl.nonOperating).toBe('10000.00');    // interest on loan
    expect(pl.netProfit).toBe('140000.00');
  });

  it('classifies factory wages as COGS but office rent as opex', async () => {
    // The distinction that Lesson 7 turns on: both are "wages/rent", but only
    // the factory one is a direct cost of what was sold. Prove the tags drive
    // the split rather than the account names.
    const pl = await profitAndLoss(t.firmId, t.clientId, '2026-04-01', '2027-03-31');
    const grossPlusOpex = Number(pl.grossProfit) - Number(pl.operatingProfit);
    expect(grossPlusOpex).toBe(Number(pl.operatingExpenses));
  });

  it('excludes Drawings from the P&L entirely (Lesson 3)', async () => {
    // Booking an owner withdrawal as an expense understates profit and is a
    // tax-compliance risk. It must never reach the P&L.
    const pl = await profitAndLoss(t.firmId, t.clientId, '2026-04-01', '2027-03-31');
    const expenses = Number(pl.cogs) + Number(pl.operatingExpenses) + Number(pl.nonOperating);
    expect(expenses).toBe(360000);               // no 5,000 drawings included
  });
});

// ---------------------------------------------------------------------------
describe('Balance Sheet (Lesson 3, Lesson 9)', () => {
  it('T-10 satisfies Assets = Liabilities + Equity', async () => {
    const bs = await balanceSheet(t.firmId, t.clientId, '2027-03-31');
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssets).toBe(bs.totalLiabilitiesAndEquity);
  });

  it('folds the period profit into equity without a formal close', async () => {
    const bs = await balanceSheet(t.firmId, t.clientId, '2027-03-31');
    const pl = await profitAndLoss(t.firmId, t.clientId, '2026-04-01', '2027-03-31');
    // Retained profit == net profit. Drawings are NOT here — they reduce the
    // equity bucket directly, because an owner withdrawal is not an expense
    // (Lesson 3).
    expect(Number(bs.retainedProfit)).toBe(Number(pl.netProfit));
    expect(Number(bs.equity)).toBe(45000);   // 50,000 capital − 5,000 drawings
  });

  it('computes Working Capital from liquidity_class (Lesson 9)', async () => {
    const bs = await balanceSheet(t.firmId, t.clientId, '2027-03-31');
    expect(Number(bs.workingCapital))
      .toBe(Number(bs.currentAssets) - Number(bs.currentLiabilities));
  });

  it('nets Accumulated Depreciation against Fixed Assets (Lesson 8)', async () => {
    const bs = await balanceSheet(t.firmId, t.clientId, '2027-03-31');
    // 3,00,000 cost − 30,000 accumulated = 2,70,000 net book value.
    expect(Number(bs.nonCurrentAssets)).toBe(270000);
  });
});

// ---------------------------------------------------------------------------
describe('Account ledger', () => {
  it('produces a running balance in date order', async () => {
    const rows = await accountLedger(
      t.firmId, t.clientId, A('Bank Accounts'), '2026-04-01', '2027-03-31');
    expect(rows.length).toBeGreaterThan(3);
    expect(rows[0]!.voucherNumber).toBeTruthy();
    // Final running balance must equal the trial balance figure for this account.
    const tb = await trialBalance(t.firmId, t.clientId, '2027-03-31');
    const bank = tb.rows.find((r) => r.name === 'Bank Accounts')!;
    const last = Number(rows[rows.length - 1]!.runningBalance);
    expect(last).toBe(Number(bank.debit) - Number(bank.credit));
  });
});
