/**
 * The firm's whole book of business, one client per row.
 * Spec: bills-and-expenses.md §9
 *
 * Every other screen answers "is THIS client all right?". A practice does not
 * run on that question — it runs on "which of my eighty clients needs me
 * today?", and no per-client screen ever answers it. This is that screen: the
 * deadlines coming, the credit at risk, the money overdue, ranked so the
 * trouble floats to the top.
 *
 * Computed across clients in a handful of set-based queries rather than by
 * looping the per-client dashboard, because a firm with two hundred clients
 * would otherwise pay two hundred round trips to draw one page.
 */

import { withFirm } from '../db/pool.ts';
import { paise, money } from './tax.ts';

/**
 * When a monthly return for `period` falls due.
 *
 * The statutory monthly dates: GSTR-1 on the 11th of the following month,
 * GSTR-3B on the 20th. Deliberately NOT modelled: the QRMP scheme, under which
 * small taxpayers file quarterly on different dates, and the extensions the
 * department issues most years. A firm with QRMP clients will see dates that
 * do not apply to them, so this is a prompt to look, not an authority.
 */
export function returnDueDates(period: string): { gstr1: string; gstr3b: string } {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    gstr1: `${ny}-${pad(nm)}-11`,
    gstr3b: `${ny}-${pad(nm)}-20`,
  };
}

/** Whole days from `from` to `to`; negative when `to` has passed. */
export function daysUntil(from: string, to: string): number {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000);
}

export interface CockpitRow {
  clientId: string;
  name: string;
  gstin: string | null;
  /** Tax declared for the period, from what posted to the output accounts. */
  outputTax: string;
  /** Input credit booked whose supplier has not filed it — s.16(2)(aa) risk. */
  creditAtRisk: string;
  /** Whether a 2B reconciliation has been run for the period at all. */
  reconciled: boolean;
  overduePayable: string;
  overdueCount: number;
  billsPosted: number;
  registrationIssues: number;
  gstr1Due: string;
  gstr3bDue: string;
  daysToGstr1: number;
  daysToGstr3b: number;
  /** Higher means needier — what the list is sorted by. */
  attention: number;
}

export interface Cockpit {
  period: string;
  periods: string[];
  today: string;
  rows: CockpitRow[];
  totals: {
    clients: number;
    outputTax: string;
    creditAtRisk: string;
    overduePayable: string;
    needingAttention: number;
  };
}

/**
 * Ranks a row by how much it needs a human.
 *
 * Deliberately crude and readable rather than a tuned score: an unreconciled
 * client with a deadline inside a week is the thing to look at, and credit at
 * risk is money. A CA should be able to see why a row is near the top.
 */
function attentionOf(r: Omit<CockpitRow, 'attention'>): number {
  let score = 0;
  if (r.daysToGstr3b >= 0 && r.daysToGstr3b <= 7) score += 40;
  if (r.daysToGstr3b < 0) score += 60;                       // already past due
  if (!r.reconciled && paise(r.outputTax) > 0n) score += 30;
  if (paise(r.creditAtRisk) > 0n) score += 25;
  if (r.registrationIssues > 0) score += 20;
  if (r.overdueCount > 0) score += 10;
  return score;
}

export async function loadCockpit(
  firmId: string, wantPeriod?: string, today = new Date().toISOString().slice(0, 10),
): Promise<Cockpit> {
  return withFirm(firmId, async (c) => {
    const periodsQ = await c.query<{ period: string }>(
      `SELECT DISTINCT to_char(posting_date, 'YYYY-MM') AS period
         FROM ledger_entries ORDER BY period DESC LIMIT 24`);
    const periods = periodsQ.rows.map((r) => r.period);
    const period = wantPeriod ?? periods[0] ?? today.slice(0, 7);

    /*
     * The firm's own clients. RLS already confines this to the firm — the
     * policy on `clients` is `firm_id = current_firm_id()` — and the filter is
     * repeated here on purpose: this is the one query in the system that is
     * deliberately cross-CLIENT, so a policy regression would turn it into a
     * cross-FIRM leak rather than an empty page. Two locks on the one door
     * worth locking twice.
     */
    const clients = await c.query<{ id: string; name: string; gstin: string | null }>(
      `SELECT c.id, c.name,
              (SELECT gstin FROM client_registrations cr
                WHERE cr.client_id = c.id AND cr.is_primary LIMIT 1) AS gstin
         FROM clients c WHERE c.firm_id = $1 ORDER BY c.name`, [firmId]);

    // Output tax for the period, per client — from the postings, as 3B reads it.
    const outQ = await c.query<{ client_id: string; tax: string }>(
      `SELECT le.client_id, SUM(le.credit - le.debit)::text AS tax
         FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
        WHERE a.account_type = 'tax_output'
          AND to_char(le.posting_date, 'YYYY-MM') = $1
        GROUP BY le.client_id`, [period]);
    const outputTax = new Map(outQ.rows.map((r) => [r.client_id, r.tax]));

    // Bills posted in the period.
    const billQ = await c.query<{ client_id: string; n: string }>(
      `SELECT client_id, count(*)::text AS n FROM purchase_bills
        WHERE to_char(bill_date, 'YYYY-MM') = $1 GROUP BY client_id`, [period]);
    const billsPosted = new Map(billQ.rows.map((r) => [r.client_id, Number(r.n)]));

    // Credit at risk: booked, but the supplier has not filed it. Taken from the
    // most recent reconciliation for the period, so it means what the 2B screen
    // means.
    const riskQ = await c.query<{ client_id: string; risk: string; lines: string }>(
      `WITH latest AS (
         SELECT DISTINCT ON (client_id) client_id, id
           FROM gstr2b_statements WHERE period = $1
          ORDER BY client_id, fetched_at DESC)
       SELECT l.client_id,
              COALESCE(SUM(CASE WHEN rl.status = 'in_books_only'
                                 AND rl.supplier_gstin IS NOT NULL
                            THEN (pb.total_cgst + pb.total_sgst + pb.total_igst
                                  + pb.total_cess) ELSE 0 END), 0)::text AS risk,
              count(*)::text AS lines
         FROM latest l
         JOIN gstr2b_recon_lines rl ON rl.statement_id = l.id
         LEFT JOIN purchase_bills pb ON pb.voucher_id = rl.voucher_id
        GROUP BY l.client_id`, [period]);
    const risk = new Map(riskQ.rows.map((r) => [r.client_id, r]));

    // Overdue payables — a running position, not period-scoped.
    const payQ = await c.query<{ client_id: string; amt: string; n: string }>(
      `SELECT pb.client_id,
              SUM(orig.amt - COALESCE(setl.amt, 0))::text AS amt,
              count(*)::text AS n
         FROM purchase_bills pb
         JOIN LATERAL (
           SELECT COALESCE(SUM(le.credit - le.debit), 0) AS amt
             FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
            WHERE le.voucher_id = pb.voucher_id AND a.account_type = 'payable'
         ) orig ON true
         LEFT JOIN LATERAL (
           SELECT SUM(le.debit - le.credit) AS amt FROM ledger_entries le
            WHERE le.settles_voucher_id = pb.voucher_id
         ) setl ON true
        WHERE (orig.amt - COALESCE(setl.amt, 0)) > 0.005
          AND COALESCE(pb.payment_due_date, pb.bill_date) < CURRENT_DATE
        GROUP BY pb.client_id`);
    const overdue = new Map(payQ.rows.map((r) => [r.client_id, r]));

    // Suppliers whose registration is not active.
    const regQ = await c.query<{ client_id: string; n: string }>(
      `SELECT p.client_id, count(*)::text AS n
         FROM parties p JOIN gstin_registry reg ON reg.gstin = p.gstin
        WHERE p.party_type = 'supplier' AND reg.status NOT ILIKE 'active'
        GROUP BY p.client_id`);
    const regIssues = new Map(regQ.rows.map((r) => [r.client_id, Number(r.n)]));

    const due = returnDueDates(period);
    const rows: CockpitRow[] = clients.rows.map((cl) => {
      const rk = risk.get(cl.id);
      const ov = overdue.get(cl.id);
      const partial: Omit<CockpitRow, 'attention'> = {
        clientId: cl.id, name: cl.name, gstin: cl.gstin,
        outputTax: money(paise(outputTax.get(cl.id) ?? '0')),
        creditAtRisk: money(paise(rk?.risk ?? '0')),
        reconciled: rk !== undefined && Number(rk.lines) > 0,
        overduePayable: money(paise(ov?.amt ?? '0')),
        overdueCount: Number(ov?.n ?? 0),
        billsPosted: billsPosted.get(cl.id) ?? 0,
        registrationIssues: regIssues.get(cl.id) ?? 0,
        gstr1Due: due.gstr1, gstr3bDue: due.gstr3b,
        daysToGstr1: daysUntil(today, due.gstr1),
        daysToGstr3b: daysUntil(today, due.gstr3b),
      };
      return { ...partial, attention: attentionOf(partial) };
    });

    // Neediest first; ties broken by money at risk. Written out rather than
    // chained, because `a - b || x > y ? 1 : -1` binds the ternary to the whole
    // expression and silently sorts by nothing.
    rows.sort((a, b) => {
      if (b.attention !== a.attention) return b.attention - a.attention;
      const d = paise(b.creditAtRisk) - paise(a.creditAtRisk);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });

    const total = (f: (r: CockpitRow) => string) =>
      money(rows.reduce((s, r) => s + paise(f(r)), 0n));

    return {
      period, periods, today, rows,
      totals: {
        clients: rows.length,
        outputTax: total((r) => r.outputTax),
        creditAtRisk: total((r) => r.creditAtRisk),
        overduePayable: total((r) => r.overduePayable),
        needingAttention: rows.filter((r) => r.attention >= 40).length,
      },
    };
  });
}
