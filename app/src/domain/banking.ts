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
          account_id, debit, credit, party_type, party_id, settles_voucher_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        a.firmId, a.clientId, a.voucherId, i + 1, a.postingDate, a.fiscalYearId,
        e.accountId, money(e.debit ?? 0n), money(e.credit ?? 0n),
        e.partyType ?? null, e.partyId ?? null, e.settlesVoucherId ?? null,
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
