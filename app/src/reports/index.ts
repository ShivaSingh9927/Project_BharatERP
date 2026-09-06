/**
 * Reports.
 *
 * Every report is a query over ledger_entries. There is no stored balance
 * anywhere in the schema — balances are always computed. That removes an
 * entire class of drift bug and is what makes the append-only ledger
 * (GL-5) natural rather than awkward. Spec: gl-engine.md §8
 *
 * Note the date semantics, which are easy to get backwards:
 *   · P&L covers a RANGE   (income and expense over a period)
 *   · Balance Sheet is AS-OF a single date (a point-in-time position)
 */

import { withFirm } from '../db/pool.ts';

export interface TrialBalanceRow {
  accountId: string;
  code: string | null;
  name: string;
  rootType: string;
  debit: string;
  credit: string;
}

export interface TrialBalance {
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebit: string;
  totalCredit: string;
  /** Lesson 2's checksum. If false, something upstream is broken. */
  balanced: boolean;
}

/**
 * Trial Balance — every account's net position as of a date.
 *
 * Net-per-account, then split by side: an account whose debits exceed its
 * credits shows the difference in the debit column, and vice versa. Showing
 * gross debits and credits per account would also "balance" but would not be
 * a trial balance.
 */
export async function trialBalance(
  firmId: string, clientId: string, asOf: string,
): Promise<TrialBalance> {
  return withFirm(firmId, async (c) => {
    const { rows } = await c.query<TrialBalanceRow>(
      `WITH net AS (
         SELECT le.account_id,
                SUM(le.debit) - SUM(le.credit) AS bal
         FROM ledger_entries le
         WHERE le.client_id = $1 AND le.posting_date <= $2
           AND le.finance_book_id IS NULL          -- statutory books only (§7.3)
         GROUP BY le.account_id
       )
       SELECT a.id            AS "accountId",
              a.code,
              a.name,
              a.root_type     AS "rootType",
              CASE WHEN n.bal > 0 THEN n.bal ELSE 0 END::text AS debit,
              CASE WHEN n.bal < 0 THEN -n.bal ELSE 0 END::text AS credit
       FROM net n JOIN accounts a ON a.id = n.account_id
       WHERE n.bal <> 0
       ORDER BY a.root_type, a.code NULLS LAST, a.name`,
      [clientId, asOf],
    );

    const sum = (k: 'debit' | 'credit') =>
      rows.reduce((t, r) => t + BigInt(Math.round(Number(r[k]) * 100)), 0n);

    const d = sum('debit');
    const cr = sum('credit');
    const money = (p: bigint) => `${p / 100n}.${String(p % 100n).padStart(2, '0')}`;

    return {
      asOf,
      rows,
      totalDebit: money(d),
      totalCredit: money(cr),
      balanced: d === cr,
    };
  });
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  revenue: string;
  cogs: string;
  grossProfit: string;
  operatingExpenses: string;
  operatingProfit: string;
  nonOperating: string;
  netProfit: string;
}

/**
 * P&L as the waterfall from Lesson 7, driven entirely by `expense_class`.
 *
 *   Revenue − COGS            = Gross Profit      (product economics)
 *   Gross − Operating Expense = Operating Profit  (business economics)
 *   Operating − Non-operating = Net Profit        (owner's take-home)
 *
 * Income accounts carry credit balances, so their net is negated to present
 * revenue as a positive figure.
 */
export async function profitAndLoss(
  firmId: string, clientId: string, from: string, to: string,
): Promise<ProfitAndLoss> {
  return withFirm(firmId, async (c) => {
    const { rows } = await c.query<{ bucket: string; amount: string }>(
      `SELECT CASE
                WHEN a.root_type = 'income'                     THEN 'revenue'
                WHEN a.expense_class = 'cogs'                   THEN 'cogs'
                WHEN a.expense_class = 'opex'                   THEN 'opex'
                WHEN a.expense_class = 'non_operating'          THEN 'non_operating'
              END AS bucket,
              SUM(CASE WHEN a.root_type = 'income'
                       THEN le.credit - le.debit
                       ELSE le.debit  - le.credit END)::text AS amount
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
       WHERE le.client_id = $1
         AND le.posting_date BETWEEN $2 AND $3
         AND le.finance_book_id IS NULL
         AND a.root_type IN ('income','expense')
         AND le.is_opening = false          -- opening balances are not this year's P&L
       GROUP BY 1`,
      [clientId, from, to],
    );

    const get = (b: string) =>
      BigInt(Math.round(Number(rows.find((r) => r.bucket === b)?.amount ?? 0) * 100));

    const revenue = get('revenue');
    const cogs = get('cogs');
    const opex = get('opex');
    const nonOp = get('non_operating');

    const gross = revenue - cogs;
    const operating = gross - opex;
    const net = operating - nonOp;

    const m = (p: bigint) => {
      const neg = p < 0n; const a = neg ? -p : p;
      return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
    };

    return {
      from, to,
      revenue: m(revenue),
      cogs: m(cogs),
      grossProfit: m(gross),
      operatingExpenses: m(opex),
      operatingProfit: m(operating),
      nonOperating: m(nonOp),
      netProfit: m(net),
    };
  });
}

export interface BalanceSheet {
  asOf: string;
  currentAssets: string;
  nonCurrentAssets: string;
  totalAssets: string;
  currentLiabilities: string;
  nonCurrentLiabilities: string;
  totalLiabilities: string;
  equity: string;
  retainedProfit: string;
  totalEquity: string;
  totalLiabilitiesAndEquity: string;
  /** Lesson 3: Assets = Liabilities + Equity. A structural check, not arithmetic. */
  balanced: boolean;
  workingCapital: string;
}

/**
 * Balance Sheet, grouped by liquidity_class, as of a point in time.
 *
 * The profit for the period is folded into equity rather than stored — this is
 * Lesson 3's "profit flows into Equity" computed on the fly, so the sheet
 * balances before a formal year-end close has been run.
 */
export async function balanceSheet(
  firmId: string, clientId: string, asOf: string,
): Promise<BalanceSheet> {
  return withFirm(firmId, async (c) => {
    const { rows } = await c.query<{ bucket: string; amount: string }>(
      `SELECT CASE
                WHEN a.root_type = 'asset'     AND a.liquidity_class = 'current'     THEN 'ca'
                WHEN a.root_type = 'asset'                                            THEN 'nca'
                WHEN a.root_type = 'liability' AND a.liquidity_class = 'current'     THEN 'cl'
                WHEN a.root_type = 'liability'                                        THEN 'ncl'
                WHEN a.root_type = 'equity'                                           THEN 'eq'
                ELSE 'pl'
              END AS bucket,
              -- Only assets are debit-positive. Everything else is presented
              -- credit-positive, which makes the 'pl' bucket sum to
              -- income − expense (profit) rather than income + expense, and
              -- makes Drawings (equity, debit-normal) correctly *reduce*
              -- equity. Getting this sign wrong is why an earlier revision
              -- reported retained profit as 860,000 instead of 140,000.
              SUM(CASE WHEN a.root_type = 'asset'
                       THEN le.debit  - le.credit
                       ELSE le.credit - le.debit END)::text AS amount
       FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
       WHERE le.client_id = $1 AND le.posting_date <= $2
         AND le.finance_book_id IS NULL
       GROUP BY 1`,
      [clientId, asOf],
    );

    const get = (b: string) =>
      BigInt(Math.round(Number(rows.find((r) => r.bucket === b)?.amount ?? 0) * 100));

    const ca = get('ca'), nca = get('nca');
    const cl = get('cl'), ncl = get('ncl');
    const eq = get('eq');
    const retained = get('pl');   // income − expense, already credit-positive

    const assets = ca + nca;
    const liabilities = cl + ncl;
    const totalEquity = eq + retained;

    const m = (p: bigint) => {
      const neg = p < 0n; const a = neg ? -p : p;
      return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
    };

    return {
      asOf,
      currentAssets: m(ca),
      nonCurrentAssets: m(nca),
      totalAssets: m(assets),
      currentLiabilities: m(cl),
      nonCurrentLiabilities: m(ncl),
      totalLiabilities: m(liabilities),
      equity: m(eq),
      retainedProfit: m(retained),
      totalEquity: m(totalEquity),
      totalLiabilitiesAndEquity: m(liabilities + totalEquity),
      balanced: assets === liabilities + totalEquity,
      workingCapital: m(ca - cl),   // Lesson 9
    };
  });
}

/** Account ledger — running balance, Tally day-book style. */
export async function accountLedger(
  firmId: string, clientId: string, accountId: string, from: string, to: string,
) {
  return withFirm(firmId, async (c) => {
    const { rows } = await c.query(
      `SELECT le.posting_date AS "postingDate",
              v.voucher_number AS "voucherNumber",
              v.voucher_type   AS "voucherType",
              v.narration,
              le.debit::text, le.credit::text,
              le.against_accounts AS "againstAccounts",
              SUM(le.debit - le.credit) OVER (
                ORDER BY le.posting_date, le.id
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              )::text AS "runningBalance"
       FROM ledger_entries le
       JOIN vouchers v ON v.id = le.voucher_id
       WHERE le.client_id = $1 AND le.account_id = $2
         AND le.posting_date BETWEEN $3 AND $4
       ORDER BY le.posting_date, le.id`,
      [clientId, accountId, from, to],
    );
    return rows;
  });
}
