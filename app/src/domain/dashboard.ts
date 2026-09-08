/**
 * The CA's landing view — the whole client on one screen.
 * Spec: bills-and-expenses.md §6
 *
 * A CA does not open the books to admire them; they open to see what needs
 * doing and what is at risk. So the dashboard leads with the number that costs
 * money — input credit booked that no supplier has yet filed, unclaimable
 * under s.16(2)(aa) until they do — and puts the work beside it: bills posted,
 * credit claimed, reconciliation items still open, suppliers whose
 * registration has gone quiet.
 *
 * It computes nothing new. Every figure is already settled elsewhere — the
 * ledger, a reconciliation run, the registry — and this only gathers them for
 * one period so the CA sees the month at a glance.
 */

import { withFirm } from '../db/pool.ts';
import { latestReconForPeriod } from './gstr2bStore.ts';
import { paise, money } from './tax.ts';

export interface Dashboard {
  period: string;
  periods: string[];
  billsPosted: number;
  purchaseValue: string;
  creditClaimed: string;
  /** Credit booked this period that 2B has not yet confirmed — the money at
   *  risk. Null when no reconciliation has been run for the period. */
  creditAtRisk: string | null;
  creditSupported: string | null;
  openReconItems: number;
  recentBills: Array<{ number: string; party: string; date: string; total: string }>;
  registrationIssues: Array<{ party: string; gstin: string; status: string }>;
  hasRecon: boolean;
}

/** The months this client has bills in, newest first — the period picker. */
async function billedPeriods(firmId: string, clientId: string): Promise<string[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ period: string }>(
      `SELECT DISTINCT to_char(bill_date, 'YYYY-MM') AS period
         FROM purchase_bills WHERE client_id = $1
        ORDER BY period DESC`, [clientId]);
    return r.rows.map((x) => x.period);
  });
}

export async function loadDashboard(
  firmId: string, clientId: string, wantPeriod?: string,
): Promise<Dashboard> {
  const periods = await billedPeriods(firmId, clientId);
  const period = wantPeriod ?? periods[0] ?? new Date().toISOString().slice(0, 7);

  const [totals, recent, issues] = await Promise.all([
    withFirm(firmId, async (c) => {
      const r = await c.query<{ n: string; value: string; claimed: string }>(
        `SELECT count(*) AS n,
                COALESCE(sum(grand_total), 0)::text AS value,
                COALESCE(sum(itc_claimable_value), 0)::text AS claimed
           FROM purchase_bills
          WHERE client_id = $1 AND to_char(bill_date, 'YYYY-MM') = $2`,
        [clientId, period]);
      return r.rows[0]!;
    }),
    withFirm(firmId, async (c) => {
      const r = await c.query<{ number: string; party: string; date: string; total: string }>(
        `SELECT bill_number AS number, supplier_legal_name AS party,
                to_char(bill_date, 'YYYY-MM-DD') AS date, grand_total::text AS total
           FROM purchase_bills WHERE client_id = $1
          ORDER BY approved_at DESC NULLS LAST LIMIT 8`, [clientId]);
      return r.rows;
    }),
    // Suppliers whose registration is anything but active. The registry is
    // shared reference data, joined to this client's own parties.
    withFirm(firmId, async (c) => {
      const r = await c.query<{ party: string; gstin: string; status: string }>(
        `SELECT p.name AS party, p.gstin, reg.status
           FROM parties p JOIN gstin_registry reg ON reg.gstin = p.gstin
          WHERE p.client_id = $1 AND p.party_type = 'supplier'
            AND reg.status NOT ILIKE 'active'
          ORDER BY p.name`, [clientId]);
      return r.rows;
    }),
  ]);

  const reconLines = await latestReconForPeriod(firmId, clientId, period);
  const hasRecon = reconLines.length > 0;
  let supported = 0n, atRisk = 0n, open = 0;
  for (const l of reconLines) {
    if (l.status === 'matched' && l.billTax) supported += paise(l.billTax);
    if (l.status === 'in_books_only' && l.supplierGstin && l.billTax) atRisk += paise(l.billTax);
    if (l.status !== 'matched' && !l.resolved) open += 1;
  }

  return {
    period, periods,
    billsPosted: Number(totals.n),
    purchaseValue: money(paise(totals.value)),
    creditClaimed: money(paise(totals.claimed)),
    creditAtRisk: hasRecon ? money(atRisk) : null,
    creditSupported: hasRecon ? money(supported) : null,
    openReconItems: open,
    recentBills: recent,
    registrationIssues: issues,
    hasRecon,
  };
}
