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
  },
): Promise<PaymentResult> {
  return withFirm(firmId, async (c) => {
    // The bill's payable line — its account, its party, and what is still owed.
    const r = await c.query<{
      account_id: string; party_id: string; bill_number: string;
      outstanding: string;
    }>(
      `SELECT le.account_id, le.party_id, pb.bill_number,
              (COALESCE(SUM(le.credit - le.debit) OVER (), 0)
               - COALESCE((SELECT SUM(s.debit - s.credit) FROM ledger_entries s
                            WHERE s.settles_voucher_id = pb.voucher_id), 0))::text
                AS outstanding
         FROM ledger_entries le
         JOIN accounts a ON a.id = le.account_id
         JOIN purchase_bills pb ON pb.voucher_id = le.voucher_id
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

    if (amount <= 0n) {
      throw new ValidationError('a payment must be greater than zero.', 'BV-3');
    }
    if (amount > outstanding) {
      throw new ValidationError(
        `${money(amount)} exceeds the ${money(outstanding)} outstanding on bill ` +
        `${bill.bill_number}. Paying more than is owed would leave a negative ` +
        'balance the ageing cannot explain.', 'BV-4');
    }

    const posted = await postVoucher(firmId, {
      clientId: input.clientId,
      voucherType: 'payment',
      postingDate: input.paymentDate,
      narration: `Payment against bill ${bill.bill_number}` +
        (input.reference ? ` (${input.reference})` : ''),
      createdBy: input.createdBy,
      createdVia: 'ui',
      lines: [
        {
          accountId: bill.account_id, debit: money(amount),
          partyType: 'supplier', partyId: bill.party_id,
          settlesVoucherId: input.billVoucherId,
        },
        { accountId: input.paidFromAccountId, credit: money(amount) },
      ],
    });

    const after = outstanding - amount;
    return {
      voucherId: posted.id,
      paid: money(amount),
      outstandingAfter: money(after),
      fullySettled: after === 0n,
    };
  });
}
