/**
 * The Bank Reconciliation Statement.
 * Spec: bank-and-reconciliation.md §11
 *
 * The report a CA looks for first, and the one that proves the module works.
 *
 * Book balance and bank balance legitimately differ. That is not an error to
 * be hunted down — it is the float, and the BRS is the document that explains
 * it item by item. What IS an error is a residual left over after every item is
 * accounted for.
 */

import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';
import { paise, money } from './tax.ts';

export interface BrsLine {
  label: string;
  /** 'add' or 'less', relative to the book balance. */
  effect: 'add' | 'less';
  amount: string;
  count: number;
  detail: string;
}

export interface Brs {
  bankAccountId: string;
  asOf: string;
  bookBalance: string;
  lines: BrsLine[];
  computedBankBalance: string;
  actualBankBalance: string;
  /** BR-22: must be zero. Anything else is an exception, never a rounding. */
  difference: string;
  ties: boolean;
  exception: string | null;
}

/**
 * Generate the BRS for one bank account as at a date.
 *
 * The direction of each adjustment is worth stating explicitly, because it is
 * the part people reason about wrongly:
 *
 *   cheque issued, not presented   books already paid it, bank has not
 *                                  → the bank balance is HIGHER → add
 *   cheque received, not credited  books already banked it, bank has not
 *                                  → the bank balance is LOWER  → less
 *   bank debit not in books        the bank took it, books do not know
 *                                  → the bank balance is LOWER  → less
 *   bank credit not in books       the bank gave it, books do not know
 *                                  → the bank balance is HIGHER → add
 */
export async function bankReconciliationStatement(
  firmId: string, bankAccountId: string, asOf: string,
): Promise<Brs> {
  return withFirm(firmId, async (c) => {
    const ba = await c.query<{ account_id: string; client_id: string;
                               opening_balance: string; bank_name: string }>(
      `SELECT account_id, client_id, opening_balance::text, bank_name
       FROM bank_accounts WHERE id = $1`, [bankAccountId]);
    if (ba.rowCount === 0) throw new ValidationError('bank account not found', 'BR-2');
    const acct = ba.rows[0]!;

    // Book balance straight from the ledger. A bank account is an asset, so it
    // is debit − credit (the sign convention that the Balance Sheet bug taught
    // us to state rather than assume).
    const book = await c.query<{ bal: string }>(
      `SELECT COALESCE(SUM(debit - credit), 0)::text AS bal
       FROM ledger_entries
       WHERE account_id = $1 AND posting_date <= $2`,
      [acct.account_id, asOf]);
    const bookBalance = paise(book.rows[0]!.bal);

    const lines: BrsLine[] = [];

    const unpresented = await c.query<{ total: string; n: number; nums: string[] }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total, COUNT(*)::int AS n,
              COALESCE(ARRAY_AGG(cheque_number ORDER BY cheque_date), '{}') AS nums
       FROM cheque_register
       WHERE bank_account_id = $1 AND direction = 'issued' AND status = 'pending'
         AND cheque_date <= $2`,
      [bankAccountId, asOf]);

    if (paise(unpresented.rows[0]!.total) !== 0n) {
      lines.push({
        label: 'Cheques issued but not yet presented',
        effect: 'add',
        amount: money(paise(unpresented.rows[0]!.total)),
        count: unpresented.rows[0]!.n,
        detail: `cheque no. ${unpresented.rows[0]!.nums.join(', ')}`,
      });
    }

    const uncredited = await c.query<{ total: string; n: number }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total, COUNT(*)::int AS n
       FROM cheque_register
       WHERE bank_account_id = $1 AND direction = 'received' AND status = 'pending'
         AND cheque_date <= $2`,
      [bankAccountId, asOf]);

    if (paise(uncredited.rows[0]!.total) !== 0n) {
      lines.push({
        label: 'Deposits made but not yet credited',
        effect: 'less',
        amount: money(paise(uncredited.rows[0]!.total)),
        count: uncredited.rows[0]!.n,
        detail: 'cheques banked, awaiting clearance',
      });
    }

    // Anything on the statement that is not fully matched has, by definition,
    // not reached the books. The derived view is the single source for that.
    const unmatched = await c.query<{ debits: string; credits: string;
                                      dn: number; cn: number }>(
      `SELECT COALESCE(SUM(CASE WHEN debit  > 0 THEN unmatched_amount END), 0)::text AS debits,
              COALESCE(SUM(CASE WHEN credit > 0 THEN unmatched_amount END), 0)::text AS credits,
              COUNT(*) FILTER (WHERE debit  > 0)::int AS dn,
              COUNT(*) FILTER (WHERE credit > 0)::int AS cn
       FROM bank_transactions_reconciled
       WHERE bank_account_id = $1 AND txn_date <= $2
         AND status <> 'matched' AND NOT is_ignored`,
      [bankAccountId, asOf]);
    const u = unmatched.rows[0]!;

    if (paise(u.debits) !== 0n) {
      lines.push({
        label: 'Amounts debited by the bank, not yet recorded in books',
        effect: 'less',
        amount: money(paise(u.debits)),
        count: u.dn,
        detail: 'charges, interest on OD, direct debits awaiting classification',
      });
    }
    if (paise(u.credits) !== 0n) {
      lines.push({
        label: 'Amounts credited by the bank, not yet recorded in books',
        effect: 'add',
        amount: money(paise(u.credits)),
        count: u.cn,
        detail: 'interest credited, receipts awaiting matching',
      });
    }

    const computed = lines.reduce(
      (acc, l) => l.effect === 'add' ? acc + paise(l.amount) : acc - paise(l.amount),
      bookBalance);

    // The bank's own figure: the latest statement's closing balance, falling
    // back to the last running balance we hold, then to the opening balance.
    const stmt = await c.query<{ closing: string | null }>(
      `SELECT closing_balance::text AS closing FROM bank_statements
       WHERE bank_account_id = $1 AND period_to <= $2
       ORDER BY period_to DESC LIMIT 1`,
      [bankAccountId, asOf]);

    const lastRunning = await c.query<{ bal: string | null }>(
      `SELECT running_balance::text AS bal FROM bank_transactions
       WHERE bank_account_id = $1 AND txn_date <= $2 AND running_balance IS NOT NULL
       ORDER BY txn_date DESC, row_no DESC NULLS LAST LIMIT 1`,
      [bankAccountId, asOf]);

    const actual = paise(
      stmt.rows[0]?.closing ?? lastRunning.rows[0]?.bal ?? acct.opening_balance);

    const difference = actual - computed;
    const ties = difference === 0n;

    return {
      bankAccountId,
      asOf,
      bookBalance: money(bookBalance),
      lines,
      computedBankBalance: money(computed),
      actualBankBalance: money(actual),
      difference: money(difference),
      ties,
      // BR-22: never rounded away. A residual means a real error on one side —
      // a missed statement page, a double-posted voucher, a wrong match — and
      // hiding it is how that error becomes permanent at period close.
      exception: ties ? null
        : `BR-22: the BRS does not tie. Book balance ${money(bookBalance)} adjusted to ` +
          `${money(computed)}, but ${acct.bank_name} reports ${money(actual)} — ` +
          `an unexplained difference of ${money(difference)}. Investigate before closing ` +
          'the period; do not adjust the figure to make it agree.',
    };
  });
}

/**
 * BR-23 — an unreconciled bank account blocks period close.
 *
 * Closing a period with an unreconciled account is precisely how an error
 * becomes permanent: once the period is locked, the correction can only be a
 * later-dated adjustment, which leaves both periods wrong.
 */
export async function assertReconciledForClose(
  firmId: string, clientId: string, asOf: string,
): Promise<{ ok: boolean; blockers: string[] }> {
  const accounts = await withFirm(firmId, async (c) => {
    const r = await c.query<{ id: string; bank_name: string; last4: string }>(
      `SELECT id, bank_name, account_number_last4 AS last4
       FROM bank_accounts WHERE client_id = $1`, [clientId]);
    return r.rows;
  });

  const blockers: string[] = [];

  for (const a of accounts) {
    const brs = await bankReconciliationStatement(firmId, a.id, asOf);
    if (!brs.ties) {
      blockers.push(`${a.bank_name} ••${a.last4}: ${brs.exception}`);
    }
  }

  return { ok: blockers.length === 0, blockers };
}
