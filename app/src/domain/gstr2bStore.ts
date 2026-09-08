/**
 * Loading the books, and saving a reconciliation.
 * Spec: bills-and-expenses.md §5
 *
 * The matcher in `gstr2b.ts` is pure — it reads and writes nothing. This is
 * the small amount of database around it: pull the client's posted bills for a
 * period, and persist a run so a reviewer has a working list they can clear
 * rather than a report that vanishes when the terminal scrolls.
 */

import { withFirm } from '../db/pool.ts';
import { reconcile, type LedgerBill, type Gstr2bInvoice, type ReconLine }
  from './gstr2b.ts';
import { parseGstr2b } from '../integrations/gstr2bJson.ts';
import type { Gstr2bFetcher } from '../integrations/sandboxGstr2b.ts';
import { money, paise } from './tax.ts';

/**
 * The posted purchase bills for a client and return period.
 *
 * Filtered by the bill's own date, which is what decides its period — the same
 * date the tax falls due on. A bill outside the period is not this month's
 * reconciliation, even if it was entered this month.
 */
export async function ledgerBillsForPeriod(
  firmId: string, clientId: string, period: string,
): Promise<LedgerBill[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{
      voucher_id: string; supplier_gstin: string | null; bill_number: string;
      bill_date: string; taxable_value: string;
      total_cgst: string; total_sgst: string; total_igst: string;
      total_cess: string; grand_total: string;
    }>(
      `SELECT voucher_id, supplier_gstin, bill_number,
              to_char(bill_date, 'YYYY-MM-DD') AS bill_date,
              taxable_value, total_cgst, total_sgst, total_igst, total_cess,
              grand_total
         FROM purchase_bills
        WHERE client_id = $1 AND to_char(bill_date, 'YYYY-MM') = $2`,
      [clientId, period]);

    return r.rows.map((b) => ({
      voucherId: b.voucher_id,
      supplierGstin: b.supplier_gstin,
      billNumber: b.bill_number,
      billDate: b.bill_date,
      taxableValue: b.taxable_value,
      totalTax: money(paise(b.total_cgst) + paise(b.total_sgst)
                      + paise(b.total_igst) + paise(b.total_cess)),
      grandTotal: b.grand_total,
    }));
  });
}

/**
 * Runs a reconciliation for a period and stores it.
 *
 * The statement is kept as received (`raw`) so the run can be reproduced or
 * audited against exactly what 2B said, and every line of the verdict is
 * written for a reviewer to work through. Returns the lines so a caller can
 * also show them immediately.
 */
export async function runReconciliation(
  firmId: string, clientId: string, period: string,
  filed: Gstr2bInvoice[], raw: unknown, source: string,
): Promise<ReconLine[]> {
  const bills = await ledgerBillsForPeriod(firmId, clientId, period);
  const lines = reconcile(bills, filed);

  await withFirm(firmId, async (c) => {
    const st = await c.query<{ id: string }>(
      `INSERT INTO gstr2b_statements (firm_id, client_id, period, source, raw)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [firmId, clientId, period, source, JSON.stringify(raw)]);
    const statementId = st.rows[0]!.id;

    for (const l of lines) {
      const filedTax = l.filed
        ? money(paise(l.filed.igst) + paise(l.filed.cgst)
                + paise(l.filed.sgst) + paise(l.filed.cess))
        : null;
      await c.query(
        `INSERT INTO gstr2b_recon_lines
           (firm_id, client_id, statement_id, period, status, supplier_gstin,
            voucher_id, filed_number, filed_date, filed_taxable, filed_tax,
            filed_itc_available, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [firmId, clientId, statementId, period, l.status, l.supplierGstin,
         l.bill?.voucherId ?? null, l.filed?.invoiceNumber ?? null,
         l.filed?.invoiceDate ?? null, l.filed?.taxableValue ?? null,
         filedTax, l.filed?.itcAvailable ?? null, l.note]);
    }
  });

  return lines;
}

/**
 * Fetches 2B live and reconciles it in one step, once the taxpayer session is
 * established.
 *
 * The verification is the client's act — they received the OTP and chose to
 * relay it — so it happens here, immediately before the fetch that needs it,
 * and the code is used and discarded. What comes back is the same records the
 * downloaded-JSON path produces, so the reconciliation is identical; only the
 * `source` on the stored statement differs, recording that this one came over
 * the wire rather than by hand.
 */
export async function fetchAndReconcile(
  firmId: string, clientId: string, period: string,
  gstin: string, username: string, otp: string,
  fetcher: Gstr2bFetcher,
): Promise<ReconLine[]> {
  await fetcher.verifyOtp(gstin, username, otp);
  const raw = await fetcher.fetch(gstin, period);
  const filed = parseGstr2b(raw);
  return runReconciliation(firmId, clientId, period, filed, raw, 'sandbox');
}
