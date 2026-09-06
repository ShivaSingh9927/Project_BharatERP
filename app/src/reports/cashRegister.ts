/**
 * Cash register: find the days a cash account went negative.
 * Spec: bills-and-expenses.md §12 — CA review answer B4.
 * Gap: DEFECT-LOG G-21
 *
 * A negative cash balance is not an unusual figure. It is an IMPOSSIBLE one:
 * you cannot pay out money you do not physically hold. When the books say cash
 * went to −₹4,200 on the 14th, one of three things happened — a receipt was
 * never recorded, a payment was recorded twice, or a payment was dated wrong —
 * and every one of them is a real error sitting in the ledger.
 *
 * The review named this the most common mistake CA firms have to fix, and it
 * arrives by a predictable route: the client keeps cash in a diary or a
 * spreadsheet and hands it over monthly (answer B4), so nothing checks it until
 * a person reads it.
 *
 * It is also close to free to detect, which is the point. There is no rule to
 * look up and no judgement to make — the balance either went below zero or it
 * did not.
 *
 * ── Two decisions worth stating ────────────────────────────────────────────
 *
 * **Only `cash` accounts.** A bank account may legitimately be overdrawn: an
 * OD or CC facility is a running loan and going negative is what it is FOR
 * (review answer B5). Applying this check to `bank` would flag every
 * manufacturing client with a cash-credit limit, every month, and be switched
 * off within a week — taking the genuine cash findings with it.
 *
 * **Per day, not per voucher.** Vouchers on the same date have no reliable
 * ordering: nobody records the minute a cash payment was made, and `line_no`
 * is an artefact of entry order, not of time. A within-day dip would therefore
 * be an artefact of how the ledger happens to be sorted. Day-end is the
 * strongest claim the data actually supports, and it is the one a CA can put
 * to a client.
 */

import { withFirm } from '../db/pool.ts';
import { paise, money } from '../domain/tax.ts';

export interface NegativeCashDay {
  accountId: string;
  accountName: string;
  /** The first date on which the closing balance was negative. */
  date: string;
  /** Closing balance that day, always negative. */
  balance: string;
  /** How far below zero — the minimum that must be unrecorded or misdated. */
  shortfall: string;
  /** Vouchers posted to this account that day, to start the investigation. */
  vouchers: Array<{ voucherNumber: string; voucherType: string; amount: string }>;
}

export interface CashRegisterCheck {
  ok: boolean;
  /** Every distinct episode, not only the first — a month can have several. */
  negativeDays: NegativeCashDay[];
  accountsChecked: number;
  detail: string;
}

/**
 * Walk each cash account day by day and report every day it closed negative.
 *
 * Consecutive negative days are reported as ONE episode. A cash book that goes
 * negative on the 14th and is not corrected until the 28th is a single missing
 * receipt, not fourteen findings, and listing it fourteen times would bury the
 * other errors in the month.
 */
export async function cashRegisterCheck(
  firmId: string, clientId: string,
  opts: { from?: string; to?: string } = {},
): Promise<CashRegisterCheck> {
  return withFirm(firmId, async (c) => {
    const accounts = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM accounts
       WHERE client_id = $1 AND account_type = 'cash' AND NOT is_group
       ORDER BY name`,
      [clientId]);

    const negativeDays: NegativeCashDay[] = [];

    for (const account of accounts.rows) {
      /*
       * The opening balance must include EVERYTHING before the window, not
       * just entries inside it. Starting a March report from zero would report
       * a negative cash book for any client who simply holds cash — the report
       * would be wrong in the alarming direction, and the first false alarm is
       * what gets a check like this disabled.
       */
      const opening = opts.from
        ? await c.query<{ bal: string }>(
            `SELECT COALESCE(sum(debit - credit), 0)::text AS bal
             FROM ledger_entries
             WHERE client_id = $1 AND account_id = $2 AND posting_date < $3`,
            [clientId, account.id, opts.from])
        : null;

      const days = await c.query<{ d: string; movement: string }>(
        `SELECT posting_date::text AS d,
                sum(debit - credit)::text AS movement
         FROM ledger_entries
         WHERE client_id = $1 AND account_id = $2
           AND ($3::date IS NULL OR posting_date >= $3)
           AND ($4::date IS NULL OR posting_date <= $4)
         GROUP BY posting_date
         ORDER BY posting_date`,
        [clientId, account.id, opts.from ?? null, opts.to ?? null]);

      let running = opening ? paise(opening.rows[0]!.bal) : 0n;
      let inEpisode = false;

      for (const day of days.rows) {
        running += paise(day.movement);

        if (running >= 0n) { inEpisode = false; continue; }
        if (inEpisode) continue;          // same episode, already reported
        inEpisode = true;

        const vouchers = await c.query<{
          voucher_number: string; voucher_type: string; amount: string;
        }>(
          `SELECT v.voucher_number, v.voucher_type::text AS voucher_type,
                  (le.debit - le.credit)::text AS amount
           FROM ledger_entries le JOIN vouchers v ON v.id = le.voucher_id
           WHERE le.client_id = $1 AND le.account_id = $2 AND le.posting_date = $3
           ORDER BY v.voucher_number`,
          [clientId, account.id, day.d]);

        negativeDays.push({
          accountId: account.id,
          accountName: account.name,
          date: day.d,
          balance: money(running),
          shortfall: money(-running),
          vouchers: vouchers.rows.map((v) => ({
            voucherNumber: v.voucher_number,
            voucherType: v.voucher_type,
            amount: money(paise(v.amount)),
          })),
        });
      }
    }

    const ok = negativeDays.length === 0;

    return {
      ok,
      negativeDays,
      accountsChecked: accounts.rowCount ?? 0,
      detail: ok
        ? `${accounts.rowCount ?? 0} cash account(s) stayed at or above zero throughout`
        : negativeDays
            .map((d) =>
              `${d.accountName} went to ${d.balance} on ${d.date} — at least ` +
              `${d.shortfall} of receipts is unrecorded, or a payment is ` +
              'duplicated or misdated')
            .join('; '),
    };
  });
}
