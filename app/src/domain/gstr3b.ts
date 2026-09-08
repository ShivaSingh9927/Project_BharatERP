/**
 * GSTR-3B — the net return, and the one figure the client actually pays.
 * Spec: invoicing.md §10 · CGST Rule 88A
 *
 * GSTR-1 declared what was sold and GSTR-2B settled what may be claimed; 3B is
 * where they meet: output tax owed on sales and reverse-charge purchases, less
 * the input credit available, equals the cash to pay. That subtraction is not
 * a plain per-head difference — the law fixes the ORDER credit is set off in
 * (Rule 88A), and using it wrong overstates the cash or leaves credit stranded.
 * So the set-off is a pure function, tested on its own.
 *
 * Every figure is read from the LEDGER's own tax accounts — output from what
 * posted to Output GST Payable, credit from what posted to Input GST Credit —
 * so reverse charge, blocked and mixed bills are all already correct: 3B only
 * gathers what the postings decided. It does not FILE; lodging is the same
 * authenticated GSP step the other returns defer.
 */

import { withFirm } from '../db/pool.ts';
import { paise, money } from './tax.ts';

export interface Heads { igst: string; cgst: string; sgst: string; cess: string; }
interface HeadsP { igst: bigint; cgst: bigint; sgst: bigint; cess: bigint; }

const zero = (): HeadsP => ({ igst: 0n, cgst: 0n, sgst: 0n, cess: 0n });
const toStr = (h: HeadsP): Heads => ({
  igst: money(h.igst), cgst: money(h.cgst), sgst: money(h.sgst), cess: money(h.cess),
});

export interface SetOff {
  /** Cash payable per head after credit is applied. */
  cash: Heads;
  /** Credit that could not be used this period and carries forward. */
  carryForward: Heads;
}

/**
 * Applies input credit against output liability in the order the law fixes.
 *
 * Rule 88A: IGST credit is used up FIRST — against IGST, then CGST, then SGST
 * liability — before any CGST or SGST credit is touched. CGST credit may then
 * cover CGST and spill to IGST; SGST credit covers SGST and spills to IGST.
 * CGST and SGST credit never cross to each other. Cess is its own pool.
 *
 * Getting the order wrong is not a rounding matter: use CGST credit too early
 * and IGST credit is left stranded as a carry-forward while cash goes out that
 * a correct set-off would have saved.
 */
export function setOff(output: Heads, itc: Heads): SetOff {
  let oI = paise(output.igst), oC = paise(output.cgst), oS = paise(output.sgst);
  let iI = paise(itc.igst), iC = paise(itc.cgst), iS = paise(itc.sgst);

  const use = (owed: bigint, credit: bigint): [bigint, bigint] => {
    const u = owed < credit ? owed : credit;
    return [owed - u, credit - u];
  };

  // Phase 1 — IGST credit against IGST, then CGST, then SGST.
  [oI, iI] = use(oI, iI);
  [oC, iI] = use(oC, iI);
  [oS, iI] = use(oS, iI);
  // Phase 2 — CGST credit against CGST, then IGST.
  [oC, iC] = use(oC, iC);
  [oI, iC] = use(oI, iC);
  // Phase 3 — SGST credit against SGST, then IGST.
  [oS, iS] = use(oS, iS);
  [oI, iS] = use(oI, iS);

  const oCess = paise(output.cess), iCess = paise(itc.cess);
  const cashCess = oCess > iCess ? oCess - iCess : 0n;
  const cfCess = iCess > oCess ? iCess - oCess : 0n;

  return {
    cash: toStr({ igst: oI, cgst: oC, sgst: oS, cess: cashCess }),
    carryForward: toStr({ igst: iI, cgst: iC, sgst: iS, cess: cfCess }),
  };
}

export interface Gstr3b {
  period: string;
  /** 3.1(a) outward taxable supplies — sales. */
  outwardTaxable: string;
  /** 3.1(d) inward supplies liable to reverse charge — RCM purchases. */
  rcmTaxable: string;
  /** Total output tax owed, by head — sales plus reverse charge. */
  output: Heads;
  /** 4C net ITC available, by head. */
  itc: Heads;
  setOff: SetOff;
  /** The number the client pays in cash, all heads. */
  netCash: string;
  /** Total credit carried to next period. */
  carryForward: string;
}

const sum = (h: Heads) => paise(h.igst) + paise(h.cgst) + paise(h.sgst) + paise(h.cess);

/**
 * Builds the 3B for a period from the ledger's tax accounts.
 *
 * Output is what posted to the Output GST Payable accounts; credit is what
 * posted to Input GST Credit. Reading the postings rather than re-deriving is
 * what makes reverse charge fall out correctly — an RCM bill posts to both, so
 * it raises the liability and the credit at once, exactly as 3B reports it.
 */
export async function generateGstr3b(
  firmId: string, clientId: string, period: string,
): Promise<Gstr3b> {
  return withFirm(firmId, async (c) => {
    const tax = await c.query<{ account_type: string; name: string; net: string }>(
      `SELECT a.account_type::text, a.name,
              SUM(le.credit - le.debit)::text AS net
         FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
        WHERE le.client_id = $1
          AND to_char(le.posting_date, 'YYYY-MM') = $2
          AND a.account_type IN ('tax_output', 'tax_input')
        GROUP BY a.account_type, a.name`,
      [clientId, period]);

    const output = zero(), itc = zero();
    const head = (name: string): keyof HeadsP | null =>
      /igst/i.test(name) ? 'igst' : /cgst/i.test(name) ? 'cgst'
      : /sgst|utgst/i.test(name) ? 'sgst' : /cess/i.test(name) ? 'cess' : null;

    for (const r of tax.rows) {
      const h = head(r.name);
      if (h === null) continue;
      const net = paise(r.net);   // credit − debit
      if (r.account_type === 'tax_output') output[h] += net;   // a liability sits credit-side
      else itc[h] += -net;                                     // a credit sits debit-side
    }

    // Context figures for the 3.1 rows — the taxable values behind the tax.
    const ctx = await c.query<{ outward: string; rcm: string }>(
      `SELECT
         COALESCE((SELECT SUM(taxable_value) FROM sales_invoices si
                    JOIN vouchers v ON v.id = si.voucher_id
                   WHERE si.client_id = $1 AND to_char(v.posting_date, 'YYYY-MM') = $2), 0)::text
           AS outward,
         COALESCE((SELECT SUM(taxable_value) FROM purchase_bills
                   WHERE client_id = $1 AND is_reverse_charge
                     AND to_char(bill_date, 'YYYY-MM') = $2), 0)::text AS rcm`,
      [clientId, period]);

    const outputS = toStr(output), itcS = toStr(itc);
    const so = setOff(outputS, itcS);

    return {
      period,
      outwardTaxable: money(paise(ctx.rows[0]!.outward)),
      rcmTaxable: money(paise(ctx.rows[0]!.rcm)),
      output: outputS,
      itc: itcS,
      setOff: so,
      netCash: money(sum(so.cash)),
      carryForward: money(sum(so.carryForward)),
    };
  });
}

/** Months that have any tax movement — the period picker for 3B. */
export async function taxPeriods(
  firmId: string, clientId: string,
): Promise<string[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ period: string }>(
      `SELECT DISTINCT to_char(le.posting_date, 'YYYY-MM') AS period
         FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
        WHERE le.client_id = $1 AND a.account_type IN ('tax_output', 'tax_input')
        ORDER BY period DESC`, [clientId]);
    return r.rows.map((x) => x.period);
  });
}
