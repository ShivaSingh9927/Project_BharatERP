/**
 * What the client owes suppliers, and paying it down.
 * Spec: bills-and-expenses.md §7 · gl-engine.md V-1
 *
 * A bill posts a credit to Creditors and there the trail ended — no way to see
 * who is owed, how overdue, or to record that they were paid. This closes that
 * loop: an ageing of the outstanding, and a payment that settles a bill by
 * debiting Creditors against the bank.
 *
 * Outstanding is read from the LEDGER, never from a status column, because the
 * ledger is the one place that cannot lie: the bill's own payable credit, less
 * every later entry that settles it. That also makes reverse charge correct
 * for free — an RCM bill credits the supplier only the taxable value, not the
 * grand total, and reading the actual posted credit picks that up without a
 * special case.
 */

import { withFirm } from '../db/pool.ts';
import { postVoucher } from './posting.ts';
import { paise, money } from './tax.ts';
import { ValidationError } from './types.ts';
import { resolveAndComputeTds, type EntityType, type TdsComputation } from './tds.ts';
import { entityTypeFromPan, recordTdsDeduction } from './tdsOnBill.ts';

export type AgeBucket = 'not_due' | 'd0_30' | 'd31_60' | 'd61_90' | 'd90_plus';

export interface OutstandingBill {
  voucherId: string;
  billNumber: string;
  partyId: string;
  supplierName: string;
  billDate: string;
  dueDate: string;
  grandTotal: string;
  outstanding: string;
  daysOverdue: number;
  bucket: AgeBucket;
}

function bucketOf(daysOverdue: number): AgeBucket {
  if (daysOverdue <= 0) return 'not_due';
  if (daysOverdue <= 30) return 'd0_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90_plus';
}

/**
 * Every bill with something still owed on it, oldest due first.
 *
 * The payable is the bill's own credit to a payable account; the settled part
 * is every ledger entry pointing back at the bill. What is left is what is
 * owed. Due date falls back to the bill date when the document stated none.
 */
export async function outstandingBills(
  firmId: string, clientId: string,
): Promise<OutstandingBill[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{
      voucher_id: string; bill_number: string; party_id: string;
      supplier: string; bill_date: string; due_date: string;
      grand_total: string; outstanding: string; days_overdue: string;
    }>(
      `SELECT pb.voucher_id, pb.bill_number, pb.party_id,
              pb.supplier_legal_name AS supplier,
              to_char(pb.bill_date, 'YYYY-MM-DD') AS bill_date,
              to_char(COALESCE(pb.payment_due_date, pb.bill_date), 'YYYY-MM-DD') AS due_date,
              pb.grand_total::text AS grand_total,
              (orig.amt - COALESCE(setl.amt, 0))::text AS outstanding,
              (CURRENT_DATE - COALESCE(pb.payment_due_date, pb.bill_date)) AS days_overdue
         FROM purchase_bills pb
         JOIN LATERAL (
           SELECT COALESCE(SUM(le.credit - le.debit), 0) AS amt
             FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
            WHERE le.voucher_id = pb.voucher_id AND a.account_type = 'payable'
         ) orig ON true
         LEFT JOIN LATERAL (
           SELECT SUM(le.debit - le.credit) AS amt
             FROM ledger_entries le
            WHERE le.settles_voucher_id = pb.voucher_id
         ) setl ON true
        WHERE pb.client_id = $1
          AND (orig.amt - COALESCE(setl.amt, 0)) > 0.005
        ORDER BY COALESCE(pb.payment_due_date, pb.bill_date)`,
      [clientId]);

    return r.rows.map((b) => {
      const days = Number(b.days_overdue);
      return {
        voucherId: b.voucher_id, billNumber: b.bill_number, partyId: b.party_id,
        supplierName: b.supplier, billDate: b.bill_date, dueDate: b.due_date,
        grandTotal: b.grand_total, outstanding: b.outstanding,
        daysOverdue: days, bucket: bucketOf(days),
      };
    });
  });
}

export interface PaymentAccount { id: string; name: string; }

/** The accounts a payment can be made FROM — the client's bank and cash. */
export async function paymentAccounts(
  firmId: string, clientId: string,
): Promise<PaymentAccount[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM accounts
        WHERE client_id = $1 AND account_type IN ('bank', 'cash') AND NOT is_group
        ORDER BY account_type, name`, [clientId]);
    return r.rows;
  });
}

export interface PaymentResult {
  voucherId: string;
  paid: string;
  outstandingAfter: string;
  fullySettled: boolean;
  /** Withheld on this payment, when the bill did not deduct on credit. */
  tds: string | null;
  warnings: string[];
}

/**
 * Records a payment against a bill.
 *
 * Debit the payable the bill raised — clearing what we owe — and credit the
 * bank or cash it came from. The debit points back at the bill through
 * `settlesVoucherId`, which is what the ageing reads, so the outstanding falls
 * by exactly this payment and no status has to be maintained by hand.
 *
 * The amount may not exceed what is outstanding: over-paying a bill is the
 * error that quietly corrupts an ageing, turning a paid supplier into a
 * negative balance nobody notices (BV-4).
 */
export async function recordPayment(
  firmId: string,
  input: {
    clientId: string; billVoucherId: string; amount: string;
    paidFromAccountId: string; paymentDate: string;
    createdBy: string; reference?: string;
    /**
     * Withhold TDS on THIS payment, for a bill that did not deduct on credit.
     *
     * The usual path is that it did — s.194 charges the deduction at the
     * earlier of credit and payment, and booking the bill is the credit
     * (BE-36). This is the second limb, for a bill posted before that existed
     * or one a reviewer knowingly posted gross and is now correcting.
     *
     * A bill that already deducted CANNOT deduct again: the unique index on
     * `tds_deductions.bill_voucher_id` refuses it, and this refuses it first
     * with something a human can read.
     */
    tds?: { category: string; entityType?: EntityType };
  },
): Promise<PaymentResult> {
  return withFirm(firmId, async (c) => {
    // The bill's payable line — its account, its party, and what is still owed.
    const r = await c.query<{
      account_id: string; party_id: string; bill_number: string;
      outstanding: string; pan: string | null; gstin: string | null;
    }>(
      // The supplier's PAN comes along for the ride: TDS rates split on the
      // payee's constitution, and a GSTIN carries the PAN inside it.
      `SELECT le.account_id, le.party_id, pb.bill_number, pt.pan, pt.gstin,
              (COALESCE(SUM(le.credit - le.debit) OVER (), 0)
               - COALESCE((SELECT SUM(s.debit - s.credit) FROM ledger_entries s
                            WHERE s.settles_voucher_id = pb.voucher_id), 0))::text
                AS outstanding
         FROM ledger_entries le
         JOIN accounts a ON a.id = le.account_id
         JOIN purchase_bills pb ON pb.voucher_id = le.voucher_id
         JOIN parties pt ON pt.id = pb.party_id
        WHERE le.voucher_id = $1 AND a.account_type = 'payable'
        LIMIT 1`,
      [input.billVoucherId]);

    if (r.rowCount === 0) {
      throw new ValidationError(
        'this bill has no payable to pay — it may be a cash purchase or not a ' +
        'bill at all.', 'BV-1');
    }
    const bill = r.rows[0]!;
    const outstanding = paise(bill.outstanding);
    const amount = paise(input.amount);

    /*
     * Was this bill already deducted, on its credit?
     *
     * Checked before the amount, because "you cannot deduct twice" tells a
     * caller something they did not know, while "that exceeds the outstanding"
     * is the symptom — on a bill already settled net of tax, both are true and
     * only the first is useful.
     *
     * Worth SAYING even when no deduction was asked for: a reviewer looking at
     * ₹1,62,000 outstanding on a ₹1,77,000 invoice needs to know the missing
     * ₹15,000 is tax already withheld and not a hole in the ageing.
     */
    const already = await c.query<{ tds_amount: string; code: string }>(
      `SELECT d.tds_amount::text, s.code FROM tds_deductions d
         JOIN tds_sections s ON s.id = d.section_id
        WHERE d.bill_voucher_id = $1`, [input.billVoucherId]);
    const priorDeduction = already.rows[0];
    const warnings: string[] = [];

    if (input.tds && priorDeduction && paise(priorDeduction.tds_amount) > 0n) {
      throw new ValidationError(
        `bill ${bill.bill_number} already had TDS of ${priorDeduction.tds_amount} ` +
        `withheld under ${priorDeduction.code} when it was booked, and the ` +
        'supplier is credited net of it. Withholding again here would deduct ' +
        'twice on one credit and short-pay the supplier.', 'PB-12');
    }
    if (priorDeduction && paise(priorDeduction.tds_amount) > 0n) {
      warnings.push(
        `TDS of ${priorDeduction.tds_amount} was already withheld on this bill ` +
        `under ${priorDeduction.code}, so the outstanding is net of it — this ` +
        'payment settles what the supplier is owed, not the invoice total.');
    }

    if (amount <= 0n) {
      throw new ValidationError('a payment must be greater than zero.', 'BV-3');
    }
    if (amount > outstanding) {
      throw new ValidationError(
        `${money(amount)} exceeds the ${money(outstanding)} outstanding on bill ` +
        `${bill.bill_number}. Paying more than is owed would leave a negative ` +
        'balance the ageing cannot explain.', 'BV-4');
    }

    // --- TDS, on the payment limb ------------------------------------------
    let withheld = 0n;
    let computation: TdsComputation | null = null;

    if (input.tds) {
      const fy = await c.query<{ fy: string }>(
        'SELECT resolve_open_fiscal_year($1, $2) AS fy',
        [input.clientId, input.paymentDate]);
      computation = await resolveAndComputeTds(c, {
        clientId: input.clientId, partyId: bill.party_id,
        fiscalYearId: fy.rows[0]!.fy,
        category: input.tds.category,
        entityType: input.tds.entityType ?? entityTypeFromPan(bill.pan ?? bill.gstin?.slice(2, 12)),
        paymentAmount: input.amount, paymentDate: input.paymentDate,
      });
      if (computation === null) {
        throw new ValidationError(
          `no TDS section covers "${input.tds.category}" on ` +
          `${input.paymentDate}. Nothing has been withheld and nothing has ` +
          'been posted.', 'PB-10');
      }
      withheld = paise(computation.tdsAmount);
      if (withheld >= amount) {
        throw new ValidationError(
          `TDS of ${computation.tdsAmount} is at least the ${money(amount)} ` +
          'being paid, which would leave the supplier nothing. That happens ' +
          'when the threshold-crossing deduction lands on a small payment — ' +
          'it is correct arithmetic and the wrong payment to take it from. ' +
          'Deduct it on the bill instead.', 'PB-12');
      }
      if (withheld > 0n) {
        warnings.push(
          `TDS of ${computation.tdsAmount} was withheld on this PAYMENT rather ` +
          `than on the bill's credit — ${computation.explanation}. Deducting ` +
          'on the credit is the earlier of the two limbs and the one the ' +
          'section normally bites on; this is late if the bill was booked in ' +
          'an earlier month.');
      }
    }

    /*
     * The payable is cleared by the FULL amount; the bank parts with the net.
     *
     *   Creditors    Dr  amount
     *       TDS Payable      Cr  withheld
     *       Bank             Cr  amount − withheld
     *
     * The debit is the whole `amount` because that is what the supplier's
     * account is being relieved of — the withheld part is now owed to the
     * government instead, not still owed to them.
     */
    const posted = await postVoucher(firmId, {
      clientId: input.clientId,
      voucherType: 'payment',
      postingDate: input.paymentDate,
      narration: `Payment against bill ${bill.bill_number}` +
        (withheld > 0n && computation ? `, TDS ${computation.code} withheld` : '') +
        (input.reference ? ` (${input.reference})` : ''),
      createdBy: input.createdBy,
      createdVia: 'ui',
      lines: [
        {
          accountId: bill.account_id, debit: money(amount),
          partyType: 'supplier', partyId: bill.party_id,
          settlesVoucherId: input.billVoucherId,
        },
        ...(withheld > 0n
          ? [{ accountId: await tdsPayableAccount(c, input.clientId),
               credit: money(withheld) }]
          : []),
        { accountId: input.paidFromAccountId, credit: money(amount - withheld) },
      ],
    });

    if (computation) {
      await recordTdsDeduction(c, {
        firmId, clientId: input.clientId, voucherId: posted.id,
        billVoucherId: input.billVoucherId, partyId: bill.party_id,
        fiscalYearId: (await c.query<{ fy: string }>(
          'SELECT resolve_open_fiscal_year($1, $2) AS fy',
          [input.clientId, input.paymentDate])).rows[0]!.fy,
        deductedOn: 'payment', computation,
      });
    }

    const after = outstanding - amount;
    return {
      voucherId: posted.id,
      paid: money(amount),
      outstandingAfter: money(after),
      fullySettled: after === 0n,
      tds: withheld > 0n && computation ? computation.tdsAmount : null,
      warnings,
    };
  });
}

async function tdsPayableAccount(
  c: import('pg').PoolClient, clientId: string,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `SELECT id FROM accounts WHERE client_id = $1
       AND account_type = 'tds_payable' AND NOT is_group LIMIT 1`, [clientId]);
  if (r.rowCount === 0) {
    throw new ValidationError('TDS Payable account not in chart', 'PB-10');
  }
  return r.rows[0]!.id;
}
