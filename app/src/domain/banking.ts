/**
 * Bank postings: settlements, statement-only transactions, cheque lifecycle.
 * Spec: bank-and-reconciliation.md §8.3, §9, §10
 *
 * Matching decides *what* a bank line is. This module turns that decision into
 * double entry. The two are kept apart deliberately: a wrong match is a
 * reviewable proposal, whereas a posting is a book of account.
 */

import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';
import { paise, money } from './tax.ts';
import { inferTdsShortfall } from './matching.ts';
import { reverseVoucher } from './posting.ts';

/** BR-2: enough to match and to display, never enough to move money. */
export function accountNumberHash(accountNumber: string): string {
  return createHash('sha256')
    .update(accountNumber.replace(/\s+/g, '').toUpperCase())
    .digest('hex');
}

const BANK_KINDS = ['current', 'savings', 'od', 'cc', 'fd'] as const;
type BankKind = typeof BANK_KINDS[number];

/**
 * Add the human-facing bank account. An opening book balance is optional: a
 * first statement proves the bank's balance, while the CA can decide later
 * whether an accounting opening entry is needed. The full account number is
 * used only for the fingerprint and last four digits; it is never written to
 * the database.
 */
export async function createBankAccount(
  firmId: string,
  input: {
    clientId: string;
    bankName: string;
    accountNumber: string;
    ifsc?: string;
    kind: string;
    openingBalance?: string;
    openingDate?: string;
    createdBy: string;
  },
): Promise<{ id: string; bankName: string; last4: string }> {
  const bankName = input.bankName.trim();
  const accountNumber = input.accountNumber.replace(/[\s-]+/g, '').toUpperCase();
  const ifsc = input.ifsc?.trim().toUpperCase() || null;
  const kind = input.kind as BankKind;
  if (bankName.length < 2 || bankName.length > 80) {
    throw new ValidationError('enter a valid bank name', 'BR-2');
  }
  if (!/^[A-Z0-9]{6,34}$/.test(accountNumber)) {
    throw new ValidationError('account number must be 6 to 34 letters or digits', 'BR-2');
  }
  if (ifsc !== null && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    throw new ValidationError('IFSC must look like HDFC0001234', 'BR-2');
  }
  if (!BANK_KINDS.includes(kind)) {
    throw new ValidationError('choose a valid account type', 'BR-2');
  }
  const openingDate = input.openingDate || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(openingDate) ||
      Number.isNaN(Date.parse(`${openingDate}T00:00:00Z`))) {
    throw new ValidationError('choose a valid opening date', 'BR-2');
  }
  let opening: bigint;
  try { opening = paise(input.openingBalance || '0'); }
  catch { throw new ValidationError('enter a valid opening balance', 'BR-2'); }

  return withFirm(firmId, async (c) => {
    const hash = accountNumberHash(accountNumber);
    const duplicate = await c.query(
      'SELECT 1 FROM bank_accounts WHERE client_id = $1 AND account_number_hash = $2',
      [input.clientId, hash]);
    if (duplicate.rowCount) throw new ValidationError('this bank account is already added', 'BR-2');

    // One ledger per real bank account. A shared "Bank Accounts" ledger makes
    // two accounts look separate on the upload screen but mixed in the books,
    // which defeats a BRS. The seeded bank ledger supplies the correct parent
    // and accounting attributes for each new child ledger.
    const template = await c.query<{
      parent_id: string | null; root_type: string; normal_balance: string;
      liquidity_class: string | null;
    }>(
      `SELECT parent_id, root_type::text, normal_balance::text,
              liquidity_class::text
       FROM accounts
       WHERE client_id = $1 AND account_type = 'bank' AND NOT is_group
       ORDER BY code NULLS LAST LIMIT 1`, [input.clientId]);
    if (!template.rows[0]) throw new ValidationError('no Bank Accounts ledger is configured', 'BR-2');
    const ledgerBaseName = `${bankName} ••${accountNumber.slice(-4)}`;
    // Two different accounts can theoretically share their last four digits.
    // Keep the human-safe display and add an ordinal only in that rare case.
    const sibling = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM accounts
       WHERE client_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND name = $3`,
      [input.clientId, template.rows[0]!.parent_id, ledgerBaseName],
    );
    const ledgerName = sibling.rows[0]!.n === 0
      ? ledgerBaseName : `${ledgerBaseName} (${sibling.rows[0]!.n + 1})`;
    const ledger = await c.query<{ id: string }>(
      `INSERT INTO accounts
         (firm_id, client_id, name, parent_id, is_group, root_type,
          account_type, normal_balance, liquidity_class, created_by, updated_by)
       VALUES ($1,$2,$3,$4,false,$5,'bank',$6,$7,$8,$8)
       RETURNING id`,
      [firmId, input.clientId, ledgerName, template.rows[0]!.parent_id,
       template.rows[0]!.root_type, template.rows[0]!.normal_balance,
       template.rows[0]!.liquidity_class, input.createdBy],
    );

    const made = await c.query<{ id: string }>(
      `INSERT INTO bank_accounts
         (firm_id, client_id, account_id, bank_name, account_number_last4,
          account_number_hash, ifsc, kind, opening_balance, opening_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [firmId, input.clientId, ledger.rows[0]!.id, bankName, accountNumber.slice(-4),
       hash, ifsc, kind, money(opening), openingDate]);
    const id = made.rows[0]!.id;

    if (opening !== 0n) {
      const fy = await c.query<{ id: string }>(
        `SELECT id FROM fiscal_years
         WHERE client_id = $1 AND start_date <= $2 AND end_date >= $2 LIMIT 1`,
        [input.clientId, openingDate]);
      if (!fy.rows[0]) throw new ValidationError('opening date is outside the configured financial year', 'BR-2');
      const capital = await c.query<{ id: string }>(
        `SELECT id FROM accounts
         WHERE client_id = $1 AND account_type = 'capital' AND NOT is_group
         ORDER BY code NULLS LAST LIMIT 1`, [input.clientId]);
      if (!capital.rows[0]) throw new ValidationError('no Capital account is configured', 'BR-2');
      const number = await c.query<{ number: string }>(
        `SELECT next_voucher_number($1, 'opening', $2) AS number`,
        [input.clientId, fy.rows[0].id]);
      const voucher = await c.query<{ id: string }>(
        `INSERT INTO vouchers
           (firm_id, client_id, voucher_type, voucher_number, posting_date,
            fiscal_year_id, narration, created_by)
         VALUES ($1,$2,'opening',$3,$4,$5,$6,$7) RETURNING id`,
        [firmId, input.clientId, number.rows[0]!.number, openingDate,
         fy.rows[0].id, `Opening balance — ${bankName} ••${accountNumber.slice(-4)}`,
         input.createdBy]);
      const amount = opening < 0n ? -opening : opening;
      const bankDebit = opening > 0n ? amount : 0n;
      const bankCredit = opening < 0n ? amount : 0n;
      for (const [line, accountId, debit, credit] of [
        [1, ledger.rows[0]!.id, bankDebit, bankCredit],
        [2, capital.rows[0].id, bankCredit, bankDebit],
      ] as const) {
        await c.query(
          `INSERT INTO ledger_entries
             (firm_id, client_id, voucher_id, line_no, posting_date,
              fiscal_year_id, account_id, debit, credit, is_opening)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
          [firmId, input.clientId, voucher.rows[0]!.id, line, openingDate,
           fy.rows[0].id, accountId, money(debit), money(credit)]);
      }
    }

    await c.query(
      `INSERT INTO audit_log
         (firm_id, client_id, entity_type, entity_id, action, after,
          actor_user_id, actor_type)
       VALUES ($1,$2,'bank_account',$3,'create',$4,$5,'human')`,
      [firmId, input.clientId, id, JSON.stringify({
        bankName, last4: accountNumber.slice(-4), ifsc, kind,
        openingBalance: input.openingBalance === undefined ? null : money(opening),
        openingDate: input.openingBalance === undefined ? null : openingDate,
      }), input.createdBy]);
    return { id, bankName, last4: accountNumber.slice(-4) };
  });
}

async function accountByName(
  c: PoolClient, clientId: string, name: string,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    'SELECT id FROM accounts WHERE client_id = $1 AND name = $2 AND NOT is_group',
    [clientId, name]);
  if (r.rowCount === 0) throw new ValidationError(`account "${name}" not in chart`, 'BV-8');
  return r.rows[0]!.id;
}

interface Leg {
  accountId: string;
  debit?: bigint;
  credit?: bigint;
  isOpening?: boolean;
  partyType?: 'customer' | 'supplier';
  partyId?: string;
  settlesVoucherId?: string;
}

async function postLegs(
  c: PoolClient,
  a: { firmId: string; clientId: string; voucherId: string; postingDate: string;
       fiscalYearId: string },
  legs: Leg[],
): Promise<void> {
  for (const [i, e] of legs.entries()) {
    await c.query(
      `INSERT INTO ledger_entries
         (firm_id, client_id, voucher_id, line_no, posting_date, fiscal_year_id,
          account_id, debit, credit, party_type, party_id, settles_voucher_id, is_opening)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        a.firmId, a.clientId, a.voucherId, i + 1, a.postingDate, a.fiscalYearId,
        e.accountId, money(e.debit ?? 0n), money(e.credit ?? 0n),
        e.partyType ?? null, e.partyId ?? null, e.settlesVoucherId ?? null, e.isOpening ?? false,
      ]);
  }
}

async function newVoucher(
  c: PoolClient,
  a: { firmId: string; clientId: string; type: string; postingDate: string;
       narration: string; createdBy: string; createdVia?: string; approvedBy?: string },
): Promise<{ voucherId: string; fiscalYearId: string }> {
  const fy = await c.query<{ fy: string }>(
    'SELECT resolve_open_fiscal_year($1, $2) AS fy', [a.clientId, a.postingDate]);
  const fiscalYearId = fy.rows[0]!.fy;

  const number = (await c.query<{ n: string }>(
    'SELECT next_voucher_number($1, $2, $3) AS n',
    [a.clientId, a.type, fiscalYearId])).rows[0]!.n;

  const v = await c.query<{ id: string }>(
    `INSERT INTO vouchers
       (firm_id, client_id, voucher_type, voucher_number, posting_date,
        fiscal_year_id, narration, created_by, created_via, approved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      a.firmId, a.clientId, a.type, number, a.postingDate, fiscalYearId,
      a.narration, a.createdBy, a.createdVia ?? 'ui', a.approvedBy ?? null,
    ]);
  return { voucherId: v.rows[0]!.id, fiscalYearId };
}

/**
 * Create a reviewed opening entry from the earliest imported statement. This
 * is deliberately an explicit action: the statement supplies the number, but
 * the reviewer authorises the accounting entry.
 */
export async function postOpeningFromFirstStatement(
  firmId: string,
  input: { clientId: string; bankAccountId: string; createdBy: string },
): Promise<{ amount: string; date: string }> {
  return withFirm(firmId, async (c) => {
    const bank = await c.query<{ account_id: string; bank_name: string; last4: string }>(
      `SELECT account_id, bank_name, account_number_last4 AS last4
       FROM bank_accounts WHERE id = $1 AND client_id = $2`,
      [input.bankAccountId, input.clientId],
    );
    if (!bank.rows[0]) throw new ValidationError('bank account not found', 'BR-2');
    const account = bank.rows[0]!;
    const already = await c.query<{ found: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ledger_entries
        WHERE account_id = $1 AND is_opening) AS found`, [account.account_id]);
    if (already.rows[0]!.found) {
      throw new ValidationError('an opening balance is already recorded for this bank account', 'BR-2');
    }
    const statement = await c.query<{ opening: string; date: string }>(
      `SELECT opening_balance::text AS opening, period_from::text AS date
       FROM bank_statements WHERE bank_account_id = $1
       ORDER BY period_from ASC, uploaded_at ASC LIMIT 1`, [input.bankAccountId]);
    if (!statement.rows[0]) throw new ValidationError('import a statement before setting its opening balance', 'BR-2');
    const source = statement.rows[0]!;
    const amount = paise(source.opening);
    if (amount === 0n) {
      await c.query('UPDATE bank_accounts SET opening_balance = $1, opening_date = $2 WHERE id = $3',
        [source.opening, source.date, input.bankAccountId]);
      return { amount: source.opening, date: source.date };
    }
    const capital = await c.query<{ id: string }>(
      `SELECT id FROM accounts WHERE client_id = $1 AND account_type = 'capital' AND NOT is_group
       ORDER BY code NULLS LAST LIMIT 1`, [input.clientId]);
    if (!capital.rows[0]) throw new ValidationError('no Capital account is configured', 'BR-2');
    const { voucherId, fiscalYearId } = await newVoucher(c, {
      firmId, clientId: input.clientId, type: 'opening', postingDate: source.date,
      narration: `Opening balance from first statement — ${account.bank_name} ••${account.last4}`,
      createdBy: input.createdBy, approvedBy: input.createdBy,
    });
    const abs = amount < 0n ? -amount : amount;
    await postLegs(c, { firmId, clientId: input.clientId, voucherId, postingDate: source.date, fiscalYearId }, [
      { accountId: account.account_id, debit: amount > 0n ? abs : 0n, credit: amount < 0n ? abs : 0n, isOpening: true },
      { accountId: capital.rows[0]!.id, debit: amount < 0n ? abs : 0n, credit: amount > 0n ? abs : 0n, isOpening: true },
    ]);
    await c.query('UPDATE bank_accounts SET opening_balance = $1, opening_date = $2 WHERE id = $3',
      [source.opening, source.date, input.bankAccountId]);
    return { amount: source.opening, date: source.date };
  });
}

// ---------------------------------------------------------------------------
// Settling a customer receipt — BR-16
// ---------------------------------------------------------------------------

export interface SettlementResult {
  receiptVoucherId: string;
  matchId: string;
  cashReceived: string;
  tdsRecognised: string;
  invoiceSettled: string;
  fullySettled: boolean;
  note: string;
}

export type BankReviewClassification =
  | 'business_expense' | 'personal' | 'transfer' | 'unsure'
  | 'share_application_pending' | 'related_party_loan_pending'
  | 'customer_advance_pending' | 'intercompany_transfer_pending'
  | 'refund_or_reversal_pending' | 'bank_interest_pending'
  | 'customer_receipt_pending';

const PENDING_RECEIPTS = new Set<BankReviewClassification>([
  'share_application_pending', 'related_party_loan_pending',
  'customer_advance_pending', 'intercompany_transfer_pending',
  'refund_or_reversal_pending', 'bank_interest_pending', 'customer_receipt_pending',
]);
const REVIEW_CLASSIFICATIONS = new Set<BankReviewClassification>([
  'business_expense', 'personal', 'transfer', 'unsure',
  ...PENDING_RECEIPTS,
]);

/** Ignore a statement line only within the explicitly selected client. */
export async function ignoreBankTransaction(
  firmId: string, clientId: string, bankTransactionId: string,
): Promise<void> {
  await withFirm(firmId, async (c) => {
    const result = await c.query(
      'UPDATE bank_transactions SET is_ignored = true WHERE id = $1 AND client_id = $2',
      [bankTransactionId, clientId]);
    if (result.rowCount === 0) throw new ValidationError('bank transaction not found', 'BV-6');
  });
}

export interface BankReviewAccount {
  id: string;
  name: string;
  rootType: string;
  accountType: string;
}

export interface BankReviewOptions {
  expenseAccounts: BankReviewAccount[];
  transferAccounts: BankReviewAccount[];
  personalAccountName: string;
}

/** Accounts that may safely receive a statement-only classification. */
export async function bankReviewOptions(
  firmId: string, clientId: string, bankAccountId: string,
): Promise<BankReviewOptions> {
  return withFirm(firmId, async (c) => {
    const bank = await c.query<{ account_id: string }>(
      'SELECT account_id FROM bank_accounts WHERE id = $1 AND client_id = $2',
      [bankAccountId, clientId]);
    if (!bank.rows[0]) throw new ValidationError('bank account not found', 'BR-2');

    const accounts = await c.query<{
      id: string; name: string; rootType: string; accountType: string;
    }>(
      `SELECT id, name, root_type::text AS "rootType", account_type::text AS "accountType"
       FROM accounts
       WHERE client_id = $1 AND NOT is_group AND NOT is_disabled
       ORDER BY code NULLS LAST, name`, [clientId]);
    const expenseAccounts = accounts.rows.filter((a) => a.rootType === 'expense');
    const transferAccounts = accounts.rows.filter((a) =>
      a.id !== bank.rows[0]!.account_id
      && ['asset', 'liability', 'equity'].includes(a.rootType)
      && !['receivable', 'payable', 'tax_input', 'tax_output',
           'tds_receivable', 'tds_payable', 'temporary'].includes(a.accountType));

    const pan = (await c.query<{ pan: string | null }>(
      'SELECT pan FROM clients WHERE id = $1', [clientId])).rows[0]?.pan ?? null;
    const proprietor = pan?.length === 10 && pan[3] === 'P';
    return {
      expenseAccounts,
      transferAccounts,
      personalAccountName: proprietor ? 'Drawings' : 'Personal Expenses Recoverable',
    };
  });
}

export async function reviewBankTransaction(
  firmId: string,
  input: {
    clientId: string;
    bankTransactionId: string;
    classification: BankReviewClassification;
    accountId?: string;
    sourceName?: string;
    note?: string;
    reviewedBy: string;
  },
): Promise<{ posted: boolean; voucherId: string | null; classification: BankReviewClassification }> {
  if (!REVIEW_CLASSIFICATIONS.has(input.classification)) {
    throw new ValidationError('choose a valid review type', 'BR-18');
  }
  const note = input.note?.trim() ?? '';
  if (note.length > 500) throw new ValidationError('note must be 500 characters or fewer', 'BR-18');
  const sourceName = input.sourceName?.trim() ?? '';
  if (sourceName.length > 160) throw new ValidationError('sender name must be 160 characters or fewer', 'BR-18');

  return withFirm(firmId, async (c) => {
    const found = await c.query(
      `SELECT bt.*, btr.amount::text, btr.unmatched_amount::text, btr.status,
              ba.account_id AS gl_account_id
       FROM bank_transactions bt
       JOIN bank_transactions_reconciled btr ON btr.id = bt.id
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
       WHERE bt.id = $1 AND bt.client_id = $2`,
      [input.bankTransactionId, input.clientId]);
    if (!found.rows[0]) throw new ValidationError('bank transaction not found', 'BV-6');
    const txn = found.rows[0]!;
    const amount = paise(txn.amount);
    if (amount <= 0n || paise(txn.unmatched_amount) !== amount) {
      throw new ValidationError('this transaction is already fully or partly reconciled', 'BV-4');
    }

    if (input.classification === 'unsure') {
      await c.query(
        `INSERT INTO bank_transaction_reviews
           (bank_transaction_id, firm_id, client_id, classification,
            receipt_status, note, reviewed_by)
         VALUES ($1,$2,$3,'unsure','not_required',$4,$5)
         ON CONFLICT (bank_transaction_id) DO UPDATE SET
           classification = 'unsure', account_id = NULL, receipt_status = 'not_required',
           source_name = NULL, note = EXCLUDED.note, posted_voucher_id = NULL,
           reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now(), updated_at = now()`,
        [input.bankTransactionId, firmId, input.clientId, note || null, input.reviewedBy]);
      return { posted: false, voucherId: null, classification: input.classification };
    }

    const outbound = paise(txn.debit) > 0n;
    if (PENDING_RECEIPTS.has(input.classification)) {
      if (outbound) throw new ValidationError('this review choice requires an incoming receipt', 'BR-18');
      if (!sourceName) throw new ValidationError('enter who sent this money', 'BR-18');
      await c.query(
        `INSERT INTO bank_transaction_reviews
           (bank_transaction_id, firm_id, client_id, classification,
            receipt_status, source_name, note, reviewed_by)
         VALUES ($1,$2,$3,$4,'not_required',$5,$6,$7)
         ON CONFLICT (bank_transaction_id) DO UPDATE SET
           classification = EXCLUDED.classification, account_id = NULL,
           receipt_status = 'not_required', source_name = EXCLUDED.source_name,
           note = EXCLUDED.note, posted_voucher_id = NULL,
           reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now(), updated_at = now()`,
        [input.bankTransactionId, firmId, input.clientId, input.classification,
         sourceName, note || null, input.reviewedBy]);
      return { posted: false, voucherId: null, classification: input.classification };
    }
    if ((input.classification === 'business_expense' || input.classification === 'personal')
        && !outbound) {
      throw new ValidationError('only an outgoing payment can be classified this way', 'BR-18');
    }

    let target: { id: string; name: string; root_type: string; account_type: string } | undefined;
    if (input.classification === 'business_expense') {
      if (!input.accountId) throw new ValidationError('choose an expense account', 'BR-18');
      target = (await c.query(
        `SELECT id, name, root_type::text, account_type::text FROM accounts
         WHERE id = $1 AND client_id = $2 AND root_type = 'expense' AND NOT is_group`,
        [input.accountId, input.clientId])).rows[0];
      if (!target) throw new ValidationError('choose a valid expense account', 'BR-18');
    } else if (input.classification === 'personal') {
      const pan = (await c.query<{ pan: string | null }>(
        'SELECT pan FROM clients WHERE id = $1', [input.clientId])).rows[0]?.pan ?? null;
      const name = pan?.length === 10 && pan[3] === 'P'
        ? 'Drawings' : 'Personal Expenses Recoverable';
      const id = await accountByName(c, input.clientId, name);
      target = { id, name, root_type: name === 'Drawings' ? 'equity' : 'asset', account_type: 'general' };
    } else {
      if (!input.accountId) throw new ValidationError('choose the other account for this transfer', 'BR-18');
      target = (await c.query(
        `SELECT id, name, root_type::text, account_type::text FROM accounts
         WHERE id = $1 AND client_id = $2 AND root_type IN ('asset','liability','equity')
           AND NOT is_group`, [input.accountId, input.clientId])).rows[0];
      if (!target || target.id === txn.gl_account_id) {
        throw new ValidationError('choose a different balance-sheet account for the transfer', 'BR-18');
      }
    }

    const postingDate = txn.txn_date.toISOString().slice(0, 10);
    const transferBetweenCash = input.classification === 'transfer'
      && ['bank', 'cash'].includes(target.account_type);
    const type = transferBetweenCash ? 'contra' : outbound ? 'payment' : 'receipt';
    const label = input.classification === 'business_expense'
      ? `Expense without receipt — ${target.name}`
      : input.classification === 'personal'
        ? `Personal payment — ${target.name}`
        : `Transfer — ${target.name}`;
    const { voucherId, fiscalYearId } = await newVoucher(c, {
      firmId, clientId: input.clientId, type, postingDate,
      narration: `${label}: ${txn.narration}${note ? ` — ${note}` : ''}`,
      createdBy: input.reviewedBy, approvedBy: input.reviewedBy,
    });

    const legs: Leg[] = outbound
      ? [{ accountId: target.id, debit: amount }, { accountId: txn.gl_account_id, credit: amount }]
      : [{ accountId: txn.gl_account_id, debit: amount }, { accountId: target.id, credit: amount }];
    await postLegs(c, {
      firmId, clientId: input.clientId, voucherId, postingDate, fiscalYearId,
    }, legs);

    const receiptStatus = input.classification === 'business_expense' ? 'missing' : 'not_required';
    await c.query(
      `INSERT INTO bank_transaction_reviews
         (bank_transaction_id, firm_id, client_id, classification, account_id,
          receipt_status, note, posted_voucher_id, reviewed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (bank_transaction_id) DO UPDATE SET
         classification = EXCLUDED.classification, account_id = EXCLUDED.account_id,
         receipt_status = EXCLUDED.receipt_status, source_name = NULL, note = EXCLUDED.note,
         posted_voucher_id = EXCLUDED.posted_voucher_id,
         reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now(), updated_at = now()`,
      [input.bankTransactionId, firmId, input.clientId, input.classification,
       target.id, receiptStatus, note || null, voucherId, input.reviewedBy]);

    await c.query(
      `INSERT INTO reconciliation_matches
         (firm_id, client_id, bank_transaction_id, voucher_id, amount,
          match_type, evidence, proposed_by, approved_by)
       VALUES ($1,$2,$3,$4,$5,'manual',$6,'user',$7)`,
      [firmId, input.clientId, input.bankTransactionId, voucherId, money(amount),
       JSON.stringify({
         classification: input.classification,
         account: target.name,
         receipt_status: receiptStatus,
         gst_itc_claimed: '0.00',
         bank_statement_is_payment_evidence_only: true,
       }), input.reviewedBy]);

    return { posted: true, voucherId, classification: input.classification };
  });
}

/**
 * Apply an inbound bank line against a sales invoice.
 *
 * Three outcomes, and telling them apart is the whole point:
 *
 *   full        received == outstanding            → invoice closed
 *   TDS         shortfall is a plausible TDS rate  → invoice CLOSED, gap to
 *                                                    TDS Receivable (BR-16)
 *   partial     anything else                      → balance stays outstanding
 *
 * The middle case is the one manual bookkeeping gets wrong, and it is wrong in
 * both directions at once: a receivable that will never be collected, and a
 * tax credit silently thrown away.
 *
 * `treatShortfallAsTds` is required rather than inferred — §16.5 resolved
 * conservatively. The system computes the implied rate and shows its working;
 * a human says yes.
 */
export async function settleInvoiceFromBankLine(
  firmId: string,
  input: {
    clientId: string;
    bankTransactionId: string;
    invoiceVoucherId: string;
    /** Cash allocated from this bank line. Defaults to the whole line. */
    amount?: string;
    treatShortfallAsTds?: boolean;
    matchType?: 'known_link' | 'exact' | 'scored' | 'rule' | 'ai_proposed' | 'manual';
    confidence?: number;
    evidence?: Record<string, unknown>;
    createdBy: string;
    approvedBy?: string;
  },
): Promise<SettlementResult> {
  return withFirm(firmId, async (c) => {
    const t = await c.query(
      `SELECT bt.*, ba.account_id AS gl_account_id
       FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
       WHERE bt.id = $1 AND bt.client_id = $2`,
      [input.bankTransactionId, input.clientId]);
    if (t.rowCount === 0) throw new ValidationError('bank transaction not found', 'BV-6');
    const txn = t.rows[0]!;

    if (paise(txn.credit) <= 0n) {
      throw new ValidationError(
        'an invoice is settled by an inbound credit, not a debit', 'BV-4');
    }

    const inv = await c.query(
      `SELECT si.grand_total::text, si.taxable_value::text, si.party_id,
              p.ledger_account_id, p.name,
              (si.grand_total - COALESCE((
                 SELECT SUM(le.credit - le.debit) FROM ledger_entries le
                 WHERE le.settles_voucher_id = si.voucher_id), 0))::text AS outstanding
       FROM sales_invoices si JOIN parties p ON p.id = si.party_id
       WHERE si.voucher_id = $1 AND si.client_id = $2`,
      [input.invoiceVoucherId, input.clientId]);
    if (inv.rowCount === 0) throw new ValidationError('invoice not found for this client', 'BV-6');
    const invoice = inv.rows[0]!;

    const cash = paise(input.amount ?? txn.credit);
    const outstanding = paise(invoice.outstanding);

    if (cash <= 0n) throw new ValidationError('settlement amount must be positive', 'BV-4');

    // BV-4. Over-allocation is the failure that silently corrupts an ageing —
    // the surplus disappears into a negative balance nobody reads.
    if (cash > outstanding) {
      throw new ValidationError(
        `BV-4: ${money(cash)} exceeds the ${money(outstanding)} outstanding on this invoice`,
        'BV-4');
    }

    let tds = 0n;
    let note = '';

    if (input.treatShortfallAsTds) {
      const inferred = inferTdsShortfall({
        invoiceGrandTotal: invoice.outstanding,
        invoiceTaxableValue: invoice.taxable_value,
        amountReceived: money(cash),
      });
      if (!inferred.isLikelyTds) {
        throw new ValidationError(
          `BR-16: ${inferred.explanation}`, 'BR-16');
      }
      tds = paise(inferred.shortfall);
      note = inferred.explanation;
    }

    const settled = cash + tds;

    const { voucherId, fiscalYearId } = await newVoucher(c, {
      firmId, clientId: input.clientId, type: 'receipt',
      postingDate: txn.txn_date.toISOString().slice(0, 10),
      narration: tds > 0n
        ? `Receipt from ${invoice.name}, net of ${money(tds)} TDS deducted at source`
        : `Receipt from ${invoice.name}`,
      createdBy: input.createdBy, approvedBy: input.approvedBy,
    });

    const legs: Leg[] = [{ accountId: txn.gl_account_id, debit: cash }];
    if (tds > 0n) {
      legs.push({ accountId: await accountByName(c, input.clientId, 'TDS Receivable'), debit: tds });
    }
    legs.push({
      accountId: invoice.ledger_account_id, credit: settled,
      partyType: 'customer', partyId: invoice.party_id,
      settlesVoucherId: input.invoiceVoucherId,
    });

    await postLegs(c, {
      firmId, clientId: input.clientId, voucherId,
      postingDate: txn.txn_date.toISOString().slice(0, 10), fiscalYearId,
    }, legs);

    // The MATCH amount is the cash that moved through the bank, not the
    // invoice value settled. The TDS never touched the account, so counting it
    // here would breach BV-5 and overstate what the bank line covered.
    const m = await c.query<{ id: string }>(
      `INSERT INTO reconciliation_matches
         (firm_id, client_id, bank_transaction_id, voucher_id, amount,
          match_type, confidence, evidence, proposed_by, approved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        firmId, input.clientId, input.bankTransactionId, input.invoiceVoucherId,
        money(cash), input.matchType ?? 'manual', input.confidence ?? null,
        JSON.stringify({
          ...(input.evidence ?? {}),
          receipt_voucher_id: voucherId,
          cash_received: money(cash),
          tds_recognised: money(tds),
          invoice_settled: money(settled),
          ...(note ? { tds_inference: note } : {}),
        }),
        input.matchType === 'ai_proposed' ? 'ai' : 'user',
        input.approvedBy ?? input.createdBy,
      ]);

    return {
      receiptVoucherId: voucherId,
      matchId: m.rows[0]!.id,
      cashReceived: money(cash),
      tdsRecognised: money(tds),
      invoiceSettled: money(settled),
      fullySettled: settled >= outstanding,
      note: note || (settled >= outstanding
        ? 'invoice settled in full'
        : `${money(outstanding - settled)} remains outstanding`),
    };
  });
}

// ---------------------------------------------------------------------------
// Statement-only transactions — §9
// ---------------------------------------------------------------------------

/**
 * Bank charges, with the GST on them claimed rather than absorbed.
 *
 * The GST component is a genuine ITC that is missed constantly, because the
 * charge arrives as a single line on a statement rather than as an invoice
 * anyone looks at.
 */
export async function postBankCharge(
  firmId: string,
  input: {
    clientId: string; bankTransactionId: string; amount: string;
    gstAmount?: string; intraState?: boolean; description?: string;
    createdBy: string; approvedBy?: string;
  },
): Promise<{ voucherId: string; matchId: string; chargeNet: string; itcClaimed: string }> {
  return withFirm(firmId, async (c) => {
    const t = await c.query(
      `SELECT bt.*, ba.account_id AS gl_account_id
       FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bank_account_id
       WHERE bt.id = $1 AND bt.client_id = $2`,
      [input.bankTransactionId, input.clientId]);
    if (t.rowCount === 0) throw new ValidationError('bank transaction not found', 'BV-6');
    const txn = t.rows[0]!;

    const total = paise(input.amount);
    const gst = paise(input.gstAmount ?? '0');
    const net = total - gst;
    if (net < 0n) throw new ValidationError('GST exceeds the charge', 'BV-4');

    const postingDate = txn.txn_date.toISOString().slice(0, 10);
    const { voucherId, fiscalYearId } = await newVoucher(c, {
      firmId, clientId: input.clientId, type: 'payment', postingDate,
      narration: input.description ?? `Bank charge — ${txn.narration}`,
      createdBy: input.createdBy, approvedBy: input.approvedBy,
    });

    const legs: Leg[] = [
      { accountId: await accountByName(c, input.clientId, 'Bank Charges'), debit: net },
    ];
    if (gst > 0n) {
      if (input.intraState ?? true) {
        const half = gst / 2n;
        legs.push({ accountId: await accountByName(c, input.clientId, 'Input CGST Credit'), debit: half });
        legs.push({ accountId: await accountByName(c, input.clientId, 'Input SGST Credit'), debit: gst - half });
      } else {
        legs.push({ accountId: await accountByName(c, input.clientId, 'Input IGST Credit'), debit: gst });
      }
    }
    legs.push({ accountId: txn.gl_account_id, credit: total });

    await postLegs(c, { firmId, clientId: input.clientId, voucherId, postingDate, fiscalYearId }, legs);

    const m = await c.query<{ id: string }>(
      `INSERT INTO reconciliation_matches
         (firm_id, client_id, bank_transaction_id, voucher_id, amount,
          match_type, evidence, proposed_by, approved_by)
       VALUES ($1,$2,$3,$4,$5,'rule',$6,'user',$7) RETURNING id`,
      [
        firmId, input.clientId, input.bankTransactionId, voucherId, money(total),
        JSON.stringify({ charge_net: money(net), itc_claimed: money(gst) }),
        input.approvedBy ?? input.createdBy,
      ]);

    return {
      voucherId, matchId: m.rows[0]!.id,
      chargeNet: money(net), itcClaimed: money(gst),
    };
  });
}

/**
 * BR-17 — bank interest arrives net of TDS.
 *
 *   Bank            Dr   9,000    -- what actually landed
 *   TDS Receivable  Dr   1,000    -- withheld by the bank
 *       Interest Income     Cr  10,000  -- the gross earned
 *
 * Recording only the ₹9,000 that appeared on the statement does two things
 * wrong: it understates income, and it discards a ₹1,000 credit the client has
 * already paid. Form 26AS will show the bank reported ₹10,000, so the books
 * will also disagree with the department's own record.
 */
export async function postInterestCredit(
  firmId: string,
  input: {
    clientId: string; bankTransactionId: string;
    /** Gross interest earned. Where unknown, derive from Form 26AS, not the statement. */
    grossInterest: string;
    tdsWithheld?: string;
    createdBy: string; approvedBy?: string;
  },
): Promise<{ voucherId: string; matchId: string; gross: string; tds: string; net: string }> {
  return withFirm(firmId, async (c) => {
    const t = await c.query(
      `SELECT bt.*, ba.account_id AS gl_account_id
       FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bank_account_id
       WHERE bt.id = $1 AND bt.client_id = $2`,
      [input.bankTransactionId, input.clientId]);
    if (t.rowCount === 0) throw new ValidationError('bank transaction not found', 'BV-6');
    const txn = t.rows[0]!;

    const gross = paise(input.grossInterest);
    const credited = paise(txn.credit);
    const tds = input.tdsWithheld !== undefined ? paise(input.tdsWithheld) : gross - credited;

    if (tds < 0n) {
      throw new ValidationError(
        `BR-17: ${money(credited)} was credited but gross interest is only ${money(gross)}`,
        'BR-17');
    }
    if (gross - tds !== credited) {
      throw new ValidationError(
        `BR-17: gross ${money(gross)} less TDS ${money(tds)} = ${money(gross - tds)}, ` +
        `but ${money(credited)} was credited`, 'BR-17');
    }

    const postingDate = txn.txn_date.toISOString().slice(0, 10);
    const { voucherId, fiscalYearId } = await newVoucher(c, {
      firmId, clientId: input.clientId, type: 'receipt', postingDate,
      narration: tds > 0n
        ? `Bank interest ${money(gross)} received net of ${money(tds)} TDS`
        : `Bank interest ${money(gross)}`,
      createdBy: input.createdBy, approvedBy: input.approvedBy,
    });

    const legs: Leg[] = [{ accountId: txn.gl_account_id, debit: credited }];
    if (tds > 0n) {
      legs.push({ accountId: await accountByName(c, input.clientId, 'TDS Receivable'), debit: tds });
    }
    legs.push({ accountId: await accountByName(c, input.clientId, 'Interest Income'), credit: gross });

    await postLegs(c, { firmId, clientId: input.clientId, voucherId, postingDate, fiscalYearId }, legs);

    const m = await c.query<{ id: string }>(
      `INSERT INTO reconciliation_matches
         (firm_id, client_id, bank_transaction_id, voucher_id, amount,
          match_type, evidence, proposed_by, approved_by)
       VALUES ($1,$2,$3,$4,$5,'rule',$6,'user',$7) RETURNING id`,
      [
        firmId, input.clientId, input.bankTransactionId, voucherId, money(credited),
        JSON.stringify({
          gross_interest: money(gross), tds_withheld: money(tds),
          reconcile_against: 'Form 26AS',
        }),
        input.approvedBy ?? input.createdBy,
      ]);

    return {
      voucherId, matchId: m.rows[0]!.id,
      gross: money(gross), tds: money(tds), net: money(credited),
    };
  });
}

// ---------------------------------------------------------------------------
// Cheques — §10
// ---------------------------------------------------------------------------

/**
 * BR-19 — an issued cheque posts to the ledger on the ISSUE date.
 *
 * The payment voucher already exists; this only records the instrument, so the
 * float can be explained. Clearance is a matching event, not a second posting.
 */
export async function registerCheque(
  firmId: string,
  input: {
    clientId: string; bankAccountId: string; voucherId: string; partyId?: string;
    chequeNumber: string; chequeDate: string;
    direction: 'issued' | 'received'; amount: string;
  },
): Promise<{ chequeId: string }> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO cheque_register
         (firm_id, client_id, bank_account_id, voucher_id, party_id,
          cheque_number, cheque_date, direction, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        firmId, input.clientId, input.bankAccountId, input.voucherId,
        input.partyId ?? null, input.chequeNumber, input.chequeDate,
        input.direction, input.amount,
      ]);
    return { chequeId: r.rows[0]!.id };
  });
}

/** Clearance: link the instrument to the bank line that presented it. */
export async function clearCheque(
  firmId: string,
  input: {
    clientId: string; chequeId: string; bankTransactionId: string;
    clearedDate: string; clearedBy: string;
  },
): Promise<{ matchId: string; floatDays: number }> {
  return withFirm(firmId, async (c) => {
    const q = await c.query(
      'SELECT * FROM cheque_register WHERE id = $1 AND client_id = $2',
      [input.chequeId, input.clientId]);
    if (q.rowCount === 0) throw new ValidationError('cheque not found', 'BV-6');
    const cheque = q.rows[0]!;
    if (cheque.status !== 'pending') {
      throw new ValidationError(`cheque is already ${cheque.status}`, 'BR-19');
    }

    await c.query(
      "UPDATE cheque_register SET status = 'cleared', cleared_date = $2 WHERE id = $1",
      [input.chequeId, input.clearedDate]);

    const floatDays = Math.round(
      (+new Date(input.clearedDate) - +cheque.cheque_date) / 86_400_000);

    const m = await c.query<{ id: string }>(
      `INSERT INTO reconciliation_matches
         (firm_id, client_id, bank_transaction_id, voucher_id, amount,
          match_type, evidence, proposed_by, approved_by)
       VALUES ($1,$2,$3,$4,$5,'exact',$6,'system',$7) RETURNING id`,
      [
        firmId, input.clientId, input.bankTransactionId, cheque.voucher_id,
        cheque.amount,
        JSON.stringify({
          cheque_number: cheque.cheque_number,
          issued: cheque.cheque_date.toISOString().slice(0, 10),
          cleared: input.clearedDate,
          float_days: floatDays,
        }),
        input.clearedBy,
      ]);

    return { matchId: m.rows[0]!.id, floatDays };
  });
}

/**
 * BR-20 — a bounce is three things, not one.
 *
 *   1. the original payment must be reversed in full
 *   2. the bank's return charge is a new expense
 *   3. for a RECEIVED cheque, dishonour may be an offence under Section 138 of
 *      the Negotiable Instruments Act
 *
 * The third is why this is not a routine reversal. The client has a limited
 * window to issue a statutory notice, and missing it forfeits the remedy — so
 * the flag is raised loudly rather than left as a status nobody filters on.
 */
export async function bounceCheque(
  firmId: string,
  input: {
    clientId: string; chequeId: string; bounceDate: string; reason: string;
    returnCharge?: string; bankTransactionId?: string; actedBy: string;
  },
): Promise<{ reversalVoucherId: string; chargeVoucherId: string | null;
             section138Flag: boolean; warnings: string[] }> {
  const cheque = await withFirm(firmId, async (c) => {
    const q = await c.query(
      'SELECT * FROM cheque_register WHERE id = $1 AND client_id = $2',
      [input.chequeId, input.clientId]);
    if (q.rowCount === 0) throw new ValidationError('cheque not found', 'BV-6');
    return q.rows[0]!;
  });

  const reversal = await reverseVoucher(firmId, cheque.voucher_id, {
    postingDate: input.bounceDate,
    reason: `Cheque ${cheque.cheque_number} dishonoured — ${input.reason}`,
    reversedBy: input.actedBy,
  });

  const section138 = cheque.direction === 'received';
  const warnings: string[] = [];
  if (section138) {
    warnings.push(
      `Section 138, Negotiable Instruments Act: cheque ${cheque.cheque_number} for ` +
      `${money(paise(cheque.amount))} was dishonoured. A statutory demand notice must be ` +
      'issued within the prescribed period to preserve the remedy — this is a legal ' +
      'deadline, not a bookkeeping one.');
  }

  let chargeVoucherId: string | null = null;

  await withFirm(firmId, async (c) => {
    await c.query(
      `UPDATE cheque_register
         SET status = 'bounced', bounce_reason = $2, section_138_flag = $3,
             reversal_voucher_id = $4
       WHERE id = $1`,
      [input.chequeId, input.reason, section138, reversal.id]);

    if (input.returnCharge && paise(input.returnCharge) > 0n) {
      const bank = await c.query<{ account_id: string }>(
        'SELECT account_id FROM bank_accounts WHERE id = $1', [cheque.bank_account_id]);
      const { voucherId, fiscalYearId } = await newVoucher(c, {
        firmId, clientId: input.clientId, type: 'payment', postingDate: input.bounceDate,
        narration: `Cheque return charge — ${cheque.cheque_number}`,
        createdBy: input.actedBy,
      });
      await postLegs(c, {
        firmId, clientId: input.clientId, voucherId,
        postingDate: input.bounceDate, fiscalYearId,
      }, [
        { accountId: await accountByName(c, input.clientId, 'Bank Charges'),
          debit: paise(input.returnCharge) },
        { accountId: bank.rows[0]!.account_id, credit: paise(input.returnCharge) },
      ]);
      chargeVoucherId = voucherId;
    }
  });

  return {
    reversalVoucherId: reversal.id,
    chargeVoucherId,
    section138Flag: section138,
    warnings,
  };
}

/**
 * BR-21 — cheques go stale after three months.
 *
 * An uncleared cheque sitting in the register forever is not merely untidy: it
 * inflates the BRS reconciling items indefinitely, so the statement still ties
 * while describing money that will never move.
 */
export async function staleCheques(
  firmId: string, clientId: string, asOf: string,
): Promise<Array<{ chequeId: string; chequeNumber: string; chequeDate: string;
                   amount: string; ageDays: number; direction: string }>> {
  return withFirm(firmId, async (c) => {
    const r = await c.query(
      `SELECT id                          AS "chequeId",
              cheque_number               AS "chequeNumber",
              cheque_date::text           AS "chequeDate",
              amount::text                AS amount,
              ($3::date - cheque_date)    AS "ageDays",
              direction::text             AS direction
       FROM cheque_register
       WHERE client_id = $1 AND firm_id = $2 AND status = 'pending'
         AND ($3::date - cheque_date) > 90
       ORDER BY cheque_date`,
      [clientId, firmId, asOf]);
    return r.rows;
  });
}
