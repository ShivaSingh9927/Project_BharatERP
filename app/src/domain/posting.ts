/**
 * Voucher posting — the single write path into the ledger.
 * Spec: gl-engine.md §5, §6 · audit-trail.md AT-2, AT-3, AT-13
 *
 * Validation runs in two places on purpose:
 *
 *   1. Here, in application code, so callers get clear, rule-tagged errors.
 *   2. In the database (constraints and triggers), so a caller that bypasses
 *      this module still cannot write an invalid or unbalanced voucher.
 *
 * The database layer is the guarantee; this layer is the good error message.
 */

import type { PoolClient } from 'pg';
import { withFirm } from '../db/pool.ts';
import {
  ValidationError,
  type PostVoucherInput,
  type PostedVoucher,
  type LedgerLineInput,
} from './types.ts';

/** Decimal string arithmetic in paise. Avoids float entirely. */
function toPaise(v: string | undefined): bigint {
  if (v === undefined || v === '') return 0n;
  if (!/^-?\d+(\.\d{1,2})?$/.test(v)) {
    throw new ValidationError(`amount "${v}" is not a valid 2dp decimal`, 'V-3');
  }
  const neg = v.startsWith('-');
  const [whole, frac = ''] = (neg ? v.slice(1) : v).split('.');
  const paise = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0'));
  return neg ? -paise : paise;
}

const fmt = (p: bigint): string => {
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};

/**
 * Application-side validation. Mirrors gl-engine.md §6 rules V-1..V-5.
 * V-6 (open period) and V-4 (account state) are additionally enforced in SQL.
 */
export function validateLines(lines: LedgerLineInput[]): { debit: bigint; credit: bigint } {
  if (lines.length < 2) {
    throw new ValidationError(`voucher has ${lines.length} line(s); at least 2 required`, 'V-2');
  }

  let debit = 0n;
  let credit = 0n;

  lines.forEach((l, i) => {
    const d = toPaise(l.debit);
    const c = toPaise(l.credit);

    if (d < 0n || c < 0n) {
      throw new ValidationError(`line ${i + 1}: amounts must be non-negative`, 'V-3');
    }
    if (d > 0n && c > 0n) {
      throw new ValidationError(
        `line ${i + 1}: a line carries either a debit or a credit, never both`, 'V-3');
    }
    if (d === 0n && c === 0n) {
      throw new ValidationError(`line ${i + 1}: amount must be greater than zero`, 'V-3');
    }

    debit += d;
    credit += c;
  });

  // V-1. The rule the whole system rests on (Lesson 1).
  if (debit !== credit) {
    throw new ValidationError(
      `debits ${fmt(debit)} ≠ credits ${fmt(credit)} (difference ${fmt(debit - credit)})`,
      'V-1',
    );
  }

  return { debit, credit };
}

/**
 * Post a voucher and its ledger entries atomically.
 *
 * Everything happens in one transaction: fiscal-year resolution, number
 * allocation, voucher insert, line inserts, and the audit row. The deferred
 * balance constraint fires at COMMIT, so a partially-written voucher can never
 * be observed.
 */
export async function postVoucher(
  firmId: string,
  input: PostVoucherInput,
): Promise<PostedVoucher> {
  validateLines(input.lines);

  // AT-13, checked here for a readable error; also a CHECK constraint.
  if (input.createdVia === 'ai_proposal' && !input.approvedBy) {
    throw new ValidationError(
      'AI-originated voucher requires approvedBy — a human is always responsible',
      'V-12',
    );
  }

  return withFirm(firmId, async (c: PoolClient) => {
    // V-6: resolves the fiscal year and rejects closed years/periods.
    const fy = await c.query<{ fy: string }>(
      'SELECT resolve_open_fiscal_year($1, $2) AS fy',
      [input.clientId, input.postingDate],
    );
    const fiscalYearId = fy.rows[0]!.fy;

    const number =
      input.voucherNumber ??
      (await c.query<{ n: string }>('SELECT next_voucher_number($1, $2, $3) AS n', [
        input.clientId, input.voucherType, fiscalYearId,
      ])).rows[0]!.n;

    const v = await c.query<{ id: string }>(
      `INSERT INTO vouchers
         (firm_id, client_id, voucher_type, voucher_number, posting_date,
          fiscal_year_id, narration, created_via, created_by, approved_by,
          ai_proposal_id, source_document_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        firmId, input.clientId, input.voucherType, number, input.postingDate,
        fiscalYearId, input.narration ?? null, input.createdVia ?? 'ui',
        input.createdBy, input.approvedBy ?? null,
        input.aiProposalId ?? null, input.sourceDocumentId ?? null,
      ],
    );
    const voucherId = v.rows[0]!.id;

    // `against_accounts` is denormalised purely for Tally-style presentation
    // ("Cash A/c Dr. To Sales A/c"). Never used in computation. gl-engine.md §5.3
    const debitAccounts = input.lines.filter((l) => toPaise(l.debit) > 0n).map((l) => l.accountId);
    const creditAccounts = input.lines.filter((l) => toPaise(l.credit) > 0n).map((l) => l.accountId);

    for (const [i, l] of input.lines.entries()) {
      const isDebit = toPaise(l.debit) > 0n;
      await c.query(
        `INSERT INTO ledger_entries
           (firm_id, client_id, voucher_id, line_no, posting_date, fiscal_year_id,
            account_id, debit, credit, party_type, party_id, cost_center_id,
            settles_voucher_id, against_accounts, is_opening, finance_book_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          firmId, input.clientId, voucherId, i + 1, input.postingDate, fiscalYearId,
          l.accountId, l.debit ?? '0', l.credit ?? '0',
          l.partyType ?? null, l.partyId ?? null, l.costCenterId ?? null,
          l.settlesVoucherId ?? null,
          isDebit ? creditAccounts : debitAccounts,
          l.isOpening ?? false, l.financeBookId ?? null,
        ],
      );
    }

    await c.query(
      `INSERT INTO audit_log
         (firm_id, client_id, entity_type, entity_id, action, after,
          actor_user_id, actor_type, ai_model, approved_by, batch_id)
       VALUES ($1,$2,'voucher',$3,'create',$4,$5,$6,$7,$8,$9)`,
      [
        firmId, input.clientId, voucherId,
        JSON.stringify({
          voucher_number: number,
          voucher_type: input.voucherType,
          posting_date: input.postingDate,
          lines: input.lines.length,
          created_via: input.createdVia ?? 'ui',
        }),
        input.createdBy,
        input.actorType ?? (input.createdVia === 'ai_proposal' ? 'ai_agent' : 'human'),
        input.aiModel ?? null,
        input.approvedBy ?? null,
        input.batchId ?? null,
      ],
    );

    return {
      id: voucherId,
      voucherNumber: number,
      fiscalYearId,
      lineCount: input.lines.length,
    };
  });
}

/**
 * Reverse a posted voucher.
 *
 * Corrections are never edits (GL-6, AT-3/AT-4). This posts a mirror voucher
 * with debits and credits swapped and `reverses_id` set. The original stays
 * exactly as posted; a report re-run for a past date gives the same answer it
 * gave then. "Was this reversed?" is derived via the vouchers_with_reversal
 * view — nothing is mutated.
 */
export async function reverseVoucher(
  firmId: string,
  voucherId: string,
  opts: { postingDate?: string; reason: string; reversedBy: string },
): Promise<PostedVoucher> {
  return withFirm(firmId, async (c) => {
    const v = await c.query(
      `SELECT v.client_id, v.voucher_type, v.posting_date, v.voucher_number,
              (SELECT id FROM vouchers r WHERE r.reverses_id = v.id) AS already
       FROM vouchers v WHERE v.id = $1`,
      [voucherId],
    );
    if (v.rowCount === 0) throw new ValidationError(`voucher ${voucherId} not found`, 'V-4');
    const orig = v.rows[0]!;
    if (orig.already) {
      throw new ValidationError(`voucher ${orig.voucher_number} is already reversed`, 'V-7');
    }

    const lines = await c.query(
      `SELECT account_id, debit, credit, party_type, party_id,
              cost_center_id, finance_book_id
       FROM ledger_entries WHERE voucher_id = $1 ORDER BY line_no`,
      [voucherId],
    );

    const postingDate = opts.postingDate ?? orig.posting_date.toISOString().slice(0, 10);
    const fyId = (await c.query<{ fy: string }>(
      'SELECT resolve_open_fiscal_year($1, $2) AS fy', [orig.client_id, postingDate],
    )).rows[0]!.fy;

    const number = (await c.query<{ n: string }>(
      'SELECT next_voucher_number($1, $2, $3) AS n',
      [orig.client_id, orig.voucher_type, fyId],
    )).rows[0]!.n;

    const rev = await c.query<{ id: string }>(
      `INSERT INTO vouchers
         (firm_id, client_id, voucher_type, voucher_number, posting_date,
          fiscal_year_id, narration, reverses_id, created_by, created_via)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ui') RETURNING id`,
      [
        firmId, orig.client_id, orig.voucher_type, number, postingDate, fyId,
        `Reversal of ${orig.voucher_number}: ${opts.reason}`, voucherId, opts.reversedBy,
      ],
    );
    const revId = rev.rows[0]!.id;

    for (const [i, l] of lines.rows.entries()) {
      await c.query(
        `INSERT INTO ledger_entries
           (firm_id, client_id, voucher_id, line_no, posting_date, fiscal_year_id,
            account_id, debit, credit, party_type, party_id, cost_center_id, finance_book_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          firmId, orig.client_id, revId, i + 1, postingDate, fyId,
          l.account_id,
          l.credit,   // swapped — this is the whole point of a reversal
          l.debit,
          l.party_type, l.party_id, l.cost_center_id, l.finance_book_id,
        ],
      );
    }

    await c.query(
      `INSERT INTO audit_log
         (firm_id, client_id, entity_type, entity_id, action, after, actor_user_id, actor_type)
       VALUES ($1,$2,'voucher',$3,'reverse',$4,$5,'human')`,
      [
        firmId, orig.client_id, voucherId,
        JSON.stringify({ reversal_voucher_id: revId, reversal_number: number, reason: opts.reason }),
        opts.reversedBy,
      ],
    );

    return { id: revId, voucherNumber: number, fiscalYearId: fyId, lineCount: lines.rowCount! };
  });
}
