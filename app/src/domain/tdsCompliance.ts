/**
 * Depositing what was deducted, and filing the statement.
 * Spec: bills-and-expenses.md BE-37
 *
 * BE-36 put the liability in TDS Payable and stopped. That is half a job, and
 * the cheaper half: a deduction is a number in a ledger, while a DEPOSIT is a
 * date somebody has to meet. Miss it and s.201(1A) charges 1.5% per month;
 * miss the quarterly statement and s.234E charges ₹200 a day. Both run from
 * dates that were nowhere in the software.
 *
 * A CA does not need to be told what TDS is. They need to be told what is due,
 * by when, and what it has already cost to be late — which is what this
 * module computes and nothing more. It files nothing and pays nothing: the
 * challan is paid on the government's portal by a human, and recorded here.
 *
 * ── Everything about a month, from its own deductions ─────────────────────
 *
 * The deadline hangs off the month the tax was DEDUCTED in, never off the date
 * somebody got round to paying it. A March bill deducted in March is payable
 * by 30 April whether the bill was entered in March or in September.
 */

import { withFirm } from '../db/pool.ts';
import { postVoucher } from './posting.ts';
import { money, paise } from './tax.ts';
import { ValidationError } from './types.ts';

/** A due date, resolved from the master as of a date. */
export interface TdsDeadline {
  /** ISO date the obligation falls due. */
  due: string;
  /** The rule it comes from, so the date is checkable. */
  citation: string | null;
}

/**
 * Adds months to a year-month and clamps the day to the month's length.
 *
 * The clamp matters for one row and it is not hypothetical: a statement due on
 * "the 31st" of a 30-day month has to mean the 30th, and a February deadline
 * of the 30th has to mean the 28th or 29th. Getting this wrong reports a
 * client as late on a day they were not.
 */
function dueDate(year: number, month: number, offset: number, day: number): string {
  const m0 = month - 1 + offset;
  const y = year + Math.floor(m0 / 12);
  const m = (m0 % 12 + 12) % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(day, lastDay);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Which fiscal quarter a month belongs to, and the month it ends in. */
export function quarterOf(period: string): { label: string; endMonth: number } {
  const m = Number(period.slice(5, 7));
  if (m >= 4 && m <= 6) return { label: 'Q1 (Apr-Jun)', endMonth: 6 };
  if (m >= 7 && m <= 9) return { label: 'Q2 (Jul-Sep)', endMonth: 9 };
  if (m >= 10 && m <= 12) return { label: 'Q3 (Oct-Dec)', endMonth: 12 };
  return { label: 'Q4 (Jan-Mar)', endMonth: 3 };
}

/**
 * Whole months between two dates, counting a part month as a whole one.
 *
 * s.201(1A) charges interest "for every month or part of a month", which is
 * not a proration and not a day count: one day late is one month's interest.
 * Computing it pro rata would understate every single case, and a CA checking
 * our figure against the department's would find ours short.
 */
export function monthsOrPart(fromIso: string, toIso: string): number {
  if (toIso <= fromIso) return 0;
  const [fy, fm, fd] = fromIso.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = toIso.split('-').map(Number) as [number, number, number];
  const whole = (ty - fy) * 12 + (tm - fm);
  // A later day-of-month means the final part month has begun, so it counts.
  return td >= fd ? whole + 1 : whole;
}

async function deadlineFor(
  clientId: string, kind: 'deposit' | 'statement', period: string,
  c: import('pg').PoolClient,
): Promise<TdsDeadline | null> {
  const year = Number(period.slice(0, 4));
  const month = kind === 'deposit'
    ? Number(period.slice(5, 7))
    : quarterOf(period).endMonth;
  /*
   * The quarter's end month may fall in the NEXT calendar year: Q4 of
   * FY2026-27 ends in March 2027, and a January period names 2027 already, so
   * only a period from Oct-Dec needs the year rolled forward.
   */
  const endYear = kind === 'statement' && month < Number(period.slice(5, 7))
    ? year + 1 : year;

  const r = await c.query<{ off: number; day: number; citation: string | null }>(
    `SELECT due_month_offset AS off, due_day AS day, source_citation AS citation
       FROM tds_deadlines
      WHERE kind = $1 AND period_month = $2
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $3::date)
      ORDER BY effective_from DESC LIMIT 1`,
    [kind, month, `${endYear}-${String(month).padStart(2, '0')}-01`]);
  const row = r.rows[0];
  if (row === undefined) return null;
  return {
    due: dueDate(endYear, month, row.off, row.day),
    citation: row.citation,
  };
}

/** What one month's deductions owe the government. */
export interface MonthlyObligation {
  /** YYYY-MM — the month the tax was DEDUCTED in. */
  period: string;
  /** Withheld on bills and payments in that month. */
  deducted: string;
  /** Paid over by challan against that month. */
  deposited: string;
  outstanding: string;
  /** What the section required but a reviewer declined to withhold. */
  shortfall: string;
  deposit: TdsDeadline | null;
  /** Null until the deposit is late. */
  overdue: null | {
    days: number;
    months: number;
    /** s.201(1A)(ii) at the stored rate, on what is still unpaid. */
    interest: string;
    rate: string;
  };
  statement: (TdsDeadline & { quarter: string }) | null;
  /** How many suppliers and deductions sit in this month. */
  deductions: number;
  parties: number;
}

export interface TdsPosition {
  asOf: string;
  months: MonthlyObligation[];
  totalOutstanding: string;
  totalInterest: string;
  totalShortfall: string;
}

/**
 * Everything owed, by month, with what lateness has cost.
 *
 * Read from `tds_deductions` rather than from the TDS Payable balance, and the
 * difference is the point: the ledger balance is one number, while an
 * obligation is per month with its own deadline. A client who deposited April
 * and forgot May owes nothing overall on some views and is two months late on
 * one month's tax.
 */
export async function tdsPosition(
  firmId: string, clientId: string, asOf: string,
): Promise<TdsPosition> {
  return withFirm(firmId, async (c) => {
    const rate = await c.query<{ value: string }>(
      `SELECT value::text FROM compliance_thresholds
        WHERE key = 'tds_interest_late_deposit'
          AND effective_from <= $1::date
          AND (effective_to IS NULL OR effective_to >= $1::date)
        ORDER BY effective_from DESC LIMIT 1`, [asOf]);
    // No rate on file is not an excuse to invent one; interest is reported as
    // zero and the deadline still shows, which is the honest half-answer.
    const interestRate = rate.rows[0]?.value ?? null;

    const rows = await c.query<{
      period: string; deducted: string; shortfall: string;
      deductions: string; parties: string;
    }>(
      `SELECT to_char(v.posting_date, 'YYYY-MM') AS period,
              SUM(d.tds_amount)::text AS deducted,
              SUM(d.tds_computed - d.tds_amount)::text AS shortfall,
              COUNT(*)::text AS deductions,
              COUNT(DISTINCT d.party_id)::text AS parties
         FROM tds_deductions d
         JOIN vouchers v ON v.id = d.voucher_id
        WHERE d.client_id = $1 AND v.posting_date <= $2::date
        GROUP BY 1
        HAVING SUM(d.tds_amount) > 0 OR SUM(d.tds_computed - d.tds_amount) > 0
        ORDER BY 1`,
      [clientId, asOf]);

    const paid = await c.query<{ period: string; tax: string }>(
      `SELECT period, SUM(tax_amount)::text AS tax FROM tds_challans
        WHERE client_id = $1 AND deposited_on <= $2::date GROUP BY 1`,
      [clientId, asOf]);
    const paidBy = new Map(paid.rows.map((r) => [r.period, paise(r.tax)]));

    let totalOutstanding = 0n, totalInterest = 0n, totalShortfall = 0n;
    const months: MonthlyObligation[] = [];

    for (const r of rows.rows) {
      const deducted = paise(r.deducted);
      const deposited = paidBy.get(r.period) ?? 0n;
      const outstanding = deducted - deposited;
      const shortfall = paise(r.shortfall);
      const deposit = await deadlineFor(clientId, 'deposit', r.period, c);
      const st = await deadlineFor(clientId, 'statement', r.period, c);

      /*
       * Interest accrues only on what is still UNPAID.
       *
       * A month deposited late has already had its interest crystallised —
       * that figure belongs on the challan that paid it, not here, or every
       * report would keep charging a client for a debt they have settled.
       */
      let overdue: MonthlyObligation['overdue'] = null;
      if (outstanding > 0n && deposit !== null && asOf > deposit.due) {
        const monthsLate = monthsOrPart(deposit.due, asOf);
        const interest = interestRate === null ? 0n
          : (outstanding * paise(interestRate) * BigInt(monthsLate) + 5000n) / 10000n;
        const days = Math.round(
          (Date.parse(asOf) - Date.parse(deposit.due)) / 86_400_000);
        overdue = { days, months: monthsLate, interest: money(interest),
                    rate: interestRate ?? '0' };
        totalInterest += interest;
      }

      if (outstanding > 0n) totalOutstanding += outstanding;
      totalShortfall += shortfall;

      months.push({
        period: r.period, deducted: money(deducted), deposited: money(deposited),
        outstanding: money(outstanding > 0n ? outstanding : 0n),
        shortfall: money(shortfall),
        deposit, overdue,
        statement: st === null ? null : { ...st, quarter: quarterOf(r.period).label },
        deductions: Number(r.deductions), parties: Number(r.parties),
      });
    }

    return {
      asOf, months,
      totalOutstanding: money(totalOutstanding),
      totalInterest: money(totalInterest),
      totalShortfall: money(totalShortfall),
    };
  });
}

/** One deduction, for the statement and for the certificate. */
export interface DeductionRow {
  party: string;
  pan: string | null;
  section: string;
  billNumber: string | null;
  deductedOn: string;
  base: string;
  rate: string;
  amount: string;
  limb: 'credit' | 'payment';
}

/**
 * The deductions in one quarter, supplier by supplier.
 *
 * What Form 26Q reports, and what a Form 16A certificate is built from. This
 * produces the DATA and deliberately not the file: a wrong figure in a filed
 * return is corrected by a revised return, and the section codes in our master
 * are still marked unverified (see `seedTdsSections`). Printing a certificate
 * off unverified codes would put our guess on the client's letterhead.
 */
export async function quarterDeductions(
  firmId: string, clientId: string, period: string,
): Promise<{ quarter: string; rows: DeductionRow[]; total: string }> {
  const q = quarterOf(period);
  const year = Number(period.slice(0, 4));
  const endYear = q.endMonth < Number(period.slice(5, 7)) ? year + 1 : year;
  const startMonth = q.endMonth - 2;
  const from = startMonth < 1
    ? `${endYear - 1}-${String(startMonth + 12).padStart(2, '0')}-01`
    : `${endYear}-${String(startMonth).padStart(2, '0')}-01`;
  const to = dueDate(endYear, q.endMonth, 0, 31);

  return withFirm(firmId, async (c) => {
    const r = await c.query<{
      party: string; pan: string | null; gstin: string | null; code: string;
      bill_number: string | null; on: string; base: string; rate: string;
      amount: string; limb: 'credit' | 'payment';
    }>(
      `SELECT p.name AS party, p.pan, p.gstin, s.code,
              pb.bill_number, to_char(v.posting_date, 'YYYY-MM-DD') AS on,
              d.taxable_base::text AS base, d.rate::text,
              d.tds_amount::text AS amount, d.deducted_on AS limb
         FROM tds_deductions d
         JOIN vouchers v ON v.id = d.voucher_id
         JOIN parties p ON p.id = d.party_id
         JOIN tds_sections s ON s.id = d.section_id
         LEFT JOIN purchase_bills pb ON pb.voucher_id = d.bill_voucher_id
        WHERE d.client_id = $1 AND d.tds_amount > 0
          AND v.posting_date >= $2::date AND v.posting_date <= $3::date
        ORDER BY v.posting_date, p.name`,
      [clientId, from, to]);

    let total = 0n;
    const rows = r.rows.map((x) => {
      total += paise(x.amount);
      return {
        party: x.party,
        // The PAN a return must quote — from its own column, or out of the
        // GSTIN, which contains it.
        pan: x.pan ?? x.gstin?.slice(2, 12) ?? null,
        section: x.code, billNumber: x.bill_number, deductedOn: x.on,
        base: x.base, rate: x.rate, amount: x.amount, limb: x.limb,
      };
    });
    return { quarter: `${q.label} to ${to}`, rows, total: money(total) };
  });
}

/**
 * Records a challan — the money reaching the government.
 *
 *   TDS Payable    Dr  tax
 *   Interest       Dr  interest, where any was paid
 *       Bank           Cr  the whole remittance
 *
 * Interest and late fee are debited to their OWN expense head, not to TDS
 * Payable, and that is not a detail. They are the client's own cost of being
 * late rather than tax withheld from anybody, so burying them in the liability
 * would make TDS Payable stop reconciling with what was deducted — and they
 * have to be findable at year end, because interest on late tax is added back
 * in the income computation rather than allowed as a business expense.
 */
export async function recordTdsDeposit(
  firmId: string,
  input: {
    clientId: string;
    /** YYYY-MM — the month whose deductions this pays over. */
    period: string;
    depositedOn: string;
    tax: string;
    interest?: string;
    lateFee?: string;
    paidFromAccountId: string;
    bsrCode?: string;
    challanSerial?: string;
    createdBy: string;
  },
): Promise<{ voucherId: string; challanId: string; remitted: string }> {
  if (!/^\d{4}-\d{2}$/.test(input.period)) {
    throw new ValidationError(
      `"${input.period}" is not a month. A challan pays over one month's ` +
      'deductions, and which month decides whether it was on time.', 'PB-13');
  }
  const tax = paise(input.tax);
  const interest = paise(input.interest ?? '0');
  const lateFee = paise(input.lateFee ?? '0');
  if (tax + interest + lateFee <= 0n) {
    throw new ValidationError('a challan must remit something.', 'PB-13');
  }

  return withFirm(firmId, async (c) => {
    /*
     * Not more than the month actually owes.
     *
     * Over-depositing against a month leaves TDS Payable in credit for a
     * liability that never existed, and the excess is genuinely hard to
     * recover from the department — so it is refused here rather than
     * discovered at reconciliation.
     */
    const owed = await c.query<{ deducted: string; paid: string }>(
      `SELECT COALESCE((SELECT SUM(d.tds_amount) FROM tds_deductions d
                          JOIN vouchers v ON v.id = d.voucher_id
                         WHERE d.client_id = $1
                           AND to_char(v.posting_date, 'YYYY-MM') = $2), 0)::text
               AS deducted,
              COALESCE((SELECT SUM(tax_amount) FROM tds_challans
                         WHERE client_id = $1 AND period = $2), 0)::text AS paid`,
      [input.clientId, input.period]);
    const outstanding = paise(owed.rows[0]!.deducted) - paise(owed.rows[0]!.paid);
    if (tax > outstanding) {
      throw new ValidationError(
        `${money(tax)} is more than the ${money(outstanding)} still owed on ` +
        `${input.period}. Either the month is wrong — a challan is dated by ` +
        'the month of DEDUCTION, not the month it was paid — or a deduction ' +
        'is missing from the books.', 'PB-13');
    }

    /*
     * By NAME, exactly, and no fallback.
     *
     * This was written as "prefer the account with this name, else any of the
     * type", which on a chart predating the interest account debited the
     * client's late-payment interest to Other Income — silently, and only a
     * live run against an old tenant showed it. Every test tenant is created
     * fresh, so every test had the account and every test passed.
     *
     * A missing account is a chart to fix, not a reason to guess which one the
     * caller meant.
     */
    const account = async (type: string, name: string) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM accounts WHERE client_id = $1 AND account_type = $2
           AND name = $3 AND NOT is_group LIMIT 1`,
        [input.clientId, type, name]);
      if (r.rowCount === 0) {
        throw new ValidationError(
          `there is no "${name}" account in this client's chart, so there is ` +
          'nowhere to put this figure. Add it before recording the challan — ' +
          'posting it to a neighbouring head would misstate the accounts.',
          'PB-13');
      }
      return r.rows[0]!.id;
    };

    const lines: Array<{ accountId: string; debit?: string; credit?: string }> = [
      { accountId: await account('tds_payable', 'TDS Payable'), debit: money(tax) },
    ];
    if (interest + lateFee > 0n) {
      lines.push({
        accountId: await account('general', 'Interest and Penalties on Taxes'),
        debit: money(interest + lateFee),
      });
    }
    lines.push({
      accountId: input.paidFromAccountId,
      credit: money(tax + interest + lateFee),
    });

    const posted = await postVoucher(firmId, {
      clientId: input.clientId,
      voucherType: 'payment',
      postingDate: input.depositedOn,
      narration:
        `TDS for ${input.period} deposited` +
        (input.challanSerial ? `, challan ${input.challanSerial}` : '') +
        (interest + lateFee > 0n
          ? ` (includes ${money(interest + lateFee)} interest and fee)` : ''),
      createdBy: input.createdBy,
      createdVia: 'ui',
      lines,
    });

    const challan = await c.query<{ id: string }>(
      `INSERT INTO tds_challans
         (firm_id, client_id, voucher_id, period, deposited_on, bsr_code,
          challan_serial, tax_amount, interest_amount, late_fee_amount, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [firmId, input.clientId, posted.id, input.period, input.depositedOn,
       input.bsrCode ?? null, input.challanSerial ?? null,
       money(tax), money(interest), money(lateFee), input.createdBy]);

    return {
      voucherId: posted.id, challanId: challan.rows[0]!.id,
      remitted: money(tax + interest + lateFee),
    };
  });
}
