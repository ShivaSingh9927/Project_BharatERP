/**
 * What customers owe, and collecting it.
 * Spec: invoicing.md §11 · bills-and-expenses.md BE-40
 *
 * The mirror of `payables.ts`, and the half that was missing. A sales invoice
 * debited Debtors and the trail ended there — no ageing, no customer
 * statement, no way to record a receipt except by matching a bank line. Which
 * is backwards for the client whose books these are: "who has not paid me" is
 * the daily question and "who do I owe" is the monthly one.
 *
 * Outstanding is read from the LEDGER, never from a status column, for the
 * same reason payables does: the ledger is the one place that cannot lie. The
 * invoice's own receivable debit, less everything that has since settled it.
 *
 * ── The thing this has that payables does not ────────────────────────────
 *
 * A customer paying an Indian business usually withholds TDS. So ₹90,000
 * arrives against a ₹1,00,000 invoice and it is NOT a short payment — the
 * ₹10,000 is tax already paid to the government in the client's name, and it
 * is an ASSET they claim in their return. Recording it as a shortfall leaves
 * the invoice looking unpaid forever and loses the client a credit they are
 * entitled to. It is the most common thing to get wrong on this side of the
 * ledger, so `recordReceipt` asks about it explicitly.
 */

import { withFirm } from '../db/pool.ts';
import { postVoucher } from './posting.ts';
import { paise, money } from './tax.ts';
import { ValidationError } from './types.ts';

export type AgeBucket = 'not_due' | 'd0_30' | 'd31_60' | 'd61_90' | 'd90_plus';

export interface OutstandingInvoice {
  voucherId: string;
  invoiceNumber: string;
  partyId: string;
  customerName: string;
  invoiceDate: string;
  dueDate: string;
  grandTotal: string;
  outstanding: string;
  /** Withheld by this customer against this invoice, when any was. */
  tdsWithheld: string;
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
 * Every invoice with something still owed on it, oldest due first.
 *
 * A credit note reduces the receivable through the same `settles_voucher_id`
 * link a receipt uses, so it falls out here without a special case — the same
 * property that makes a purchase return work on the payables side.
 */
export async function outstandingInvoices(
  firmId: string, clientId: string,
): Promise<OutstandingInvoice[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{
      voucher_id: string; invoice_number: string; party_id: string;
      customer: string; invoice_date: string; due_date: string;
      grand_total: string; outstanding: string; tds: string;
      days_overdue: string;
    }>(
      `SELECT si.voucher_id, v.voucher_number AS invoice_number, si.party_id,
              si.customer_legal_name AS customer,
              to_char(v.posting_date, 'YYYY-MM-DD') AS invoice_date,
              to_char(COALESCE(si.due_date, v.posting_date), 'YYYY-MM-DD') AS due_date,
              si.grand_total::text,
              (orig.amt - COALESCE(setl.amt, 0))::text AS outstanding,
              COALESCE(tds.amt, 0)::text AS tds,
              (CURRENT_DATE - COALESCE(si.due_date, v.posting_date)) AS days_overdue
         FROM sales_invoices si
         JOIN vouchers v ON v.id = si.voucher_id
         JOIN LATERAL (
           SELECT COALESCE(SUM(le.debit - le.credit), 0) AS amt
             FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
            WHERE le.voucher_id = si.voucher_id AND a.account_type = 'receivable'
         ) orig ON true
         LEFT JOIN LATERAL (
           /*
            * Only entries against the RECEIVABLE itself settle it.
            *
            * Without the account test this summed every leg tagged with the
            * invoice — including the TDS Receivable debit, which is tagged so
            * the withholding can be traced back to the invoice it came off.
            * That leg is a debit, so it was SUBTRACTED from the settlement and
            * the invoice read 10,000 more outstanding than it was.
            */
           SELECT SUM(le.credit - le.debit) AS amt
             FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
            WHERE le.settles_voucher_id = si.voucher_id
              AND a.account_type = 'receivable'
         ) setl ON true
         LEFT JOIN LATERAL (
           SELECT SUM(le.debit) AS amt
             FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
            WHERE le.settles_voucher_id = si.voucher_id
              AND a.account_type = 'tds_receivable'
         ) tds ON true
        WHERE si.client_id = $1
          AND si.document_type IN ('tax_invoice', 'bill_of_supply', 'export_invoice')
          AND (orig.amt - COALESCE(setl.amt, 0)) > 0.005
        ORDER BY COALESCE(si.due_date, v.posting_date)`,
      [clientId]);

    return r.rows.map((x) => {
      const days = Number(x.days_overdue);
      return {
        voucherId: x.voucher_id, invoiceNumber: x.invoice_number,
        partyId: x.party_id, customerName: x.customer,
        invoiceDate: x.invoice_date, dueDate: x.due_date,
        grandTotal: x.grand_total, outstanding: x.outstanding,
        tdsWithheld: money(paise(x.tds)),
        daysOverdue: days, bucket: bucketOf(days),
      };
    });
  });
}

export interface ReceiptAccount { id: string; name: string; }

/** The accounts money can be received INTO — the client's bank and cash. */
export async function receiptAccounts(
  firmId: string, clientId: string,
): Promise<ReceiptAccount[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM accounts
        WHERE client_id = $1 AND account_type IN ('bank', 'cash') AND NOT is_group
        ORDER BY account_type, name`, [clientId]);
    return r.rows;
  });
}

export interface ReceiptResult {
  voucherId: string;
  received: string;
  /** Withheld by the customer and booked as an asset, not as a shortfall. */
  tdsWithheld: string;
  /** What the invoice is credited by — cash plus tax withheld. */
  settled: string;
  outstandingAfter: string;
  fullySettled: boolean;
  warnings: string[];
}

/**
 * Records money received against an invoice.
 *
 *   Bank / Cash        Dr  what arrived
 *   TDS Receivable     Dr  what the customer withheld
 *       Debtors            Cr  the two together
 *
 * The credit to Debtors is the SUM, because that is what the customer has
 * discharged: cash to us, and tax to the government on our behalf. Crediting
 * only the cash would leave the invoice permanently short by the withholding
 * and the client chasing a debt that was already settled.
 */
export async function recordReceipt(
  firmId: string,
  input: {
    clientId: string; invoiceVoucherId: string;
    /** What actually arrived in the bank. */
    amount: string;
    /**
     * What the customer withheld as TDS, if any.
     *
     * Asked rather than inferred from the difference. A short payment and a
     * withholding look identical in a bank statement and mean opposite things
     * — one is a debt still owed, the other is an asset already earned — and
     * only the customer's advice or their Form 16A settles which it is.
     */
    tdsWithheld?: string;
    receivedIntoAccountId: string;
    receiptDate: string;
    createdBy: string;
    reference?: string;
  },
): Promise<ReceiptResult> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{
      account_id: string; party_id: string; invoice_number: string;
      customer: string; outstanding: string;
    }>(
      `SELECT le.account_id, le.party_id, v.voucher_number AS invoice_number,
              si.customer_legal_name AS customer,
              (COALESCE(SUM(le.debit - le.credit) OVER (), 0)
               - COALESCE((SELECT SUM(s.credit - s.debit) FROM ledger_entries s
                             JOIN accounts sa ON sa.id = s.account_id
                            WHERE s.settles_voucher_id = si.voucher_id
                              AND sa.account_type = 'receivable'), 0))::text
                AS outstanding
         FROM ledger_entries le
         JOIN accounts a ON a.id = le.account_id
         JOIN sales_invoices si ON si.voucher_id = le.voucher_id
         JOIN vouchers v ON v.id = si.voucher_id
        WHERE le.voucher_id = $1 AND si.client_id = $2
          AND a.account_type = 'receivable'
        LIMIT 1`,
      [input.invoiceVoucherId, input.clientId]);

    if (r.rowCount === 0) {
      throw new ValidationError(
        'this invoice has no receivable to collect — it may be a cash sale, a ' +
        'credit note, or not an invoice at all.', 'RV-1');
    }
    const inv = r.rows[0]!;
    const outstanding = paise(inv.outstanding);
    const cash = paise(input.amount);
    const tds = paise(input.tdsWithheld ?? '0');
    const settled = cash + tds;
    const warnings: string[] = [];

    if (cash < 0n || tds < 0n) {
      throw new ValidationError(
        'a receipt cannot be negative. Money going the other way is a refund ' +
        'or a credit note, and both are their own document.', 'RV-2');
    }
    if (settled <= 0n) {
      throw new ValidationError('a receipt has to be for something.', 'RV-2');
    }
    if (settled > outstanding) {
      throw new ValidationError(
        `${money(settled)}` +
        (tds > 0n ? ` (${money(cash)} received plus ${money(tds)} withheld)` : '') +
        ` is more than the ${money(outstanding)} outstanding on invoice ` +
        `${inv.invoice_number}. Receiving more than is owed leaves a credit ` +
        'balance the ageing cannot explain — if the customer has overpaid, ' +
        'that is an advance against their next invoice, not a receipt against ' +
        'this one.', 'RV-3');
    }

    const lines: Array<{ accountId: string; debit?: string; credit?: string;
                         partyType?: 'customer'; partyId?: string;
                         settlesVoucherId?: string }> = [
      { accountId: input.receivedIntoAccountId, debit: money(cash) },
    ];

    if (tds > 0n) {
      const acc = await c.query<{ id: string }>(
        `SELECT id FROM accounts WHERE client_id = $1
           AND account_type = 'tds_receivable' AND name = 'TDS Receivable'
           AND NOT is_group LIMIT 1`, [input.clientId]);
      if (acc.rowCount === 0) {
        throw new ValidationError(
          'there is no "TDS Receivable" account in this chart, so there is ' +
          'nowhere to put the tax the customer withheld. Add it before ' +
          'recording this receipt — booking the shortfall anywhere else would ' +
          'either understate income or lose the client a credit they are owed.',
          'RV-1');
      }
      lines.push({
        accountId: acc.rows[0]!.id, debit: money(tds),
        // Points at the invoice so the ageing counts it as settled, and so the
        // withholding can be traced to the invoice it was deducted from —
        // which is what reconciling against Form 26AS needs.
        settlesVoucherId: input.invoiceVoucherId,
      });
      warnings.push(
        `${money(tds)} of this invoice was withheld by ${inv.customer} as TDS ` +
        'and is not a shortfall — it is tax already paid to the government in ' +
        'the client\'s name, and it is claimed in their return. Check it ' +
        'against the customer\'s Form 16A and against Form 26AS before ' +
        'filing: a withholding the customer never actually deposited is a ' +
        'credit the client cannot take.');
    }

    lines.push({
      accountId: inv.account_id, credit: money(settled),
      partyType: 'customer', partyId: inv.party_id,
      settlesVoucherId: input.invoiceVoucherId,
    });

    const posted = await postVoucher(firmId, {
      clientId: input.clientId,
      voucherType: 'receipt',
      postingDate: input.receiptDate,
      narration: `Receipt against invoice ${inv.invoice_number}` +
        (tds > 0n ? `, ${money(tds)} TDS withheld` : '') +
        (input.reference ? ` (${input.reference})` : ''),
      createdBy: input.createdBy,
      createdVia: 'ui',
      lines,
    });

    const after = outstanding - settled;
    return {
      voucherId: posted.id,
      received: money(cash),
      tdsWithheld: money(tds),
      settled: money(settled),
      outstandingAfter: money(after),
      fullySettled: after === 0n,
      warnings,
    };
  });
}

/**
 * Writes off a receivable that will never be collected.
 *
 *   Bad Debts    Dr  what is being given up
 *       Debtors      Cr
 *
 * Lesson 4: a customer who will never pay is a real business loss — an
 * expense, and distinct from Drawings. The chart carries the account for
 * exactly this.
 *
 * ── And the GST is NOT recoverable ───────────────────────────────────────
 *
 * This is the trap. The invoice charged GST and that GST was paid to the
 * government at the time of supply; India has no bad-debt relief in GST, so
 * writing the debt off recovers none of it. The write-off is therefore the
 * WHOLE outstanding amount, tax included, and anyone expecting the tax back is
 * told plainly that it is gone.
 */
export async function writeOffReceivable(
  firmId: string,
  input: {
    clientId: string; invoiceVoucherId: string; amount: string;
    /** Why it is uncollectable. A write-off with no reason is a missing asset. */
    reason: string;
    writeOffDate: string; createdBy: string; approvedBy: string;
  },
): Promise<{ voucherId: string; writtenOff: string; warnings: string[] }> {
  if (input.reason.trim() === '') {
    throw new ValidationError(
      'say why this debt is uncollectable. A write-off with no reason is ' +
      'indistinguishable from money going missing, and it is the first thing ' +
      'an auditor asks about.', 'RV-4');
  }

  return withFirm(firmId, async (c) => {
    const r = await c.query<{
      account_id: string; party_id: string; invoice_number: string;
      customer: string; outstanding: string; total_tax: string;
    }>(
      `SELECT le.account_id, le.party_id, v.voucher_number AS invoice_number,
              si.customer_legal_name AS customer,
              (si.total_cgst + si.total_sgst + si.total_igst + si.total_cess)::text
                AS total_tax,
              (COALESCE(SUM(le.debit - le.credit) OVER (), 0)
               - COALESCE((SELECT SUM(s.credit - s.debit) FROM ledger_entries s
                             JOIN accounts sa ON sa.id = s.account_id
                            WHERE s.settles_voucher_id = si.voucher_id
                              AND sa.account_type = 'receivable'), 0))::text
                AS outstanding
         FROM ledger_entries le
         JOIN accounts a ON a.id = le.account_id
         JOIN sales_invoices si ON si.voucher_id = le.voucher_id
         JOIN vouchers v ON v.id = si.voucher_id
        WHERE le.voucher_id = $1 AND si.client_id = $2
          AND a.account_type = 'receivable'
        LIMIT 1`,
      [input.invoiceVoucherId, input.clientId]);
    if (r.rowCount === 0) {
      throw new ValidationError('no such invoice for this client', 'RV-1');
    }
    const inv = r.rows[0]!;
    const outstanding = paise(inv.outstanding);
    const amount = paise(input.amount);

    if (amount <= 0n) {
      throw new ValidationError('a write-off has to be for something.', 'RV-2');
    }
    if (amount > outstanding) {
      throw new ValidationError(
        `${money(amount)} is more than the ${money(outstanding)} outstanding on ` +
        `invoice ${inv.invoice_number}.`, 'RV-3');
    }

    const badDebts = await c.query<{ id: string }>(
      `SELECT id FROM accounts WHERE client_id = $1 AND name = 'Bad Debts'
         AND NOT is_group LIMIT 1`, [input.clientId]);
    if (badDebts.rowCount === 0) {
      throw new ValidationError(
        'there is no "Bad Debts" account in this chart. A debt given up is an ' +
        'expense of the business and needs its own head — putting it anywhere ' +
        'else hides a real loss.', 'RV-1');
    }

    const posted = await postVoucher(firmId, {
      clientId: input.clientId,
      voucherType: 'journal',
      postingDate: input.writeOffDate,
      narration:
        `Bad debt written off — invoice ${inv.invoice_number}, ` +
        `${inv.customer}: ${input.reason.trim()}`,
      createdBy: input.createdBy,
      approvedBy: input.approvedBy,
      createdVia: 'ui',
      lines: [
        { accountId: badDebts.rows[0]!.id, debit: money(amount) },
        {
          accountId: inv.account_id, credit: money(amount),
          partyType: 'customer', partyId: inv.party_id,
          settlesVoucherId: input.invoiceVoucherId,
        },
      ],
    });

    const warnings: string[] = [
      `${money(amount)} has been written off as a bad debt, which is an ` +
      'expense of the business and reduces this year\'s profit by that amount.',
    ];
    if (paise(inv.total_tax) > 0n) {
      warnings.push(
        `the GST on this invoice — ${money(paise(inv.total_tax))} — is NOT ` +
        'recoverable. It became payable at the time of supply and India has no ' +
        'bad-debt relief in GST, so the write-off includes tax already paid to ' +
        'the government on money that never arrived. Nothing is adjusted in ' +
        'GSTR-1 or GSTR-3B, and issuing a credit note instead to get the tax ' +
        'back would be a false statement that the supply was cancelled.');
    }
    return { voucherId: posted.id, writtenOff: money(amount), warnings };
  });
}

/** One line of a customer's account. */
export interface StatementLine {
  date: string;
  voucherType: string;
  reference: string;
  narration: string;
  debit: string;
  credit: string;
  balance: string;
}

/**
 * A customer's account, oldest first, with a running balance.
 *
 * What gets emailed when somebody disputes what they owe, so it is built from
 * the ledger entries against that party rather than from the invoices — a
 * statement that omitted a receipt or a credit note would be worse than none.
 */
export async function customerStatement(
  firmId: string, clientId: string, partyId: string,
): Promise<{ customer: string; lines: StatementLine[]; closing: string }> {
  return withFirm(firmId, async (c) => {
    const p = await c.query<{ name: string }>(
      `SELECT name FROM parties WHERE id = $1 AND client_id = $2`,
      [partyId, clientId]);
    if (p.rowCount === 0) {
      throw new ValidationError('no such customer for this client', 'RV-1');
    }

    const r = await c.query<{
      date: string; voucher_type: string; reference: string;
      narration: string | null; debit: string; credit: string;
    }>(
      `SELECT to_char(le.posting_date, 'YYYY-MM-DD') AS date,
              v.voucher_type::text, v.voucher_number AS reference,
              v.narration, le.debit::text, le.credit::text
         FROM ledger_entries le
         JOIN vouchers v ON v.id = le.voucher_id
         JOIN accounts a ON a.id = le.account_id
        WHERE le.client_id = $1 AND le.party_id = $2
          AND a.account_type = 'receivable'
        ORDER BY le.posting_date, v.voucher_number, le.line_no`,
      [clientId, partyId]);

    let balance = 0n;
    const lines = r.rows.map((x) => {
      balance += paise(x.debit) - paise(x.credit);
      return {
        date: x.date, voucherType: x.voucher_type, reference: x.reference,
        narration: x.narration ?? '', debit: x.debit, credit: x.credit,
        balance: money(balance),
      };
    });
    return { customer: p.rows[0]!.name, lines, closing: money(balance) };
  });
}
