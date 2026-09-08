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

/** A reconciliation line as the screen shows it — the stored verdict plus the
 *  books-side figures joined back from the bill. */
export interface ReconLineView {
  id: string;
  status: string;
  supplierGstin: string | null;
  note: string;
  resolved: boolean;
  billNumber: string | null;
  billTax: string | null;
  filedNumber: string | null;
  filedTax: string | null;
}

/** Return periods that have at least one reconciliation, newest first. */
export async function periodsWithRecon(
  firmId: string, clientId: string,
): Promise<string[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ period: string }>(
      `SELECT DISTINCT period FROM gstr2b_recon_lines
        WHERE client_id = $1 ORDER BY period DESC`, [clientId]);
    return r.rows.map((x) => x.period);
  });
}

/**
 * The lines of the MOST RECENT reconciliation for a period.
 *
 * A period can be reconciled more than once — a fresh 2B download supersedes
 * the last — so only the newest statement's lines are shown. The books-side
 * tax is joined from the bill so the screen can total the credit at stake
 * without re-deriving it.
 */
export async function latestReconForPeriod(
  firmId: string, clientId: string, period: string,
): Promise<ReconLineView[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{
      id: string; status: string; supplier_gstin: string | null; note: string;
      resolved: boolean; bill_number: string | null; bill_tax: string | null;
      filed_number: string | null; filed_tax: string | null;
    }>(
      `WITH latest AS (
         SELECT id FROM gstr2b_statements
          WHERE client_id = $1 AND period = $2
          ORDER BY fetched_at DESC LIMIT 1)
       SELECT l.id, l.status, l.supplier_gstin, l.note,
              (l.resolved_at IS NOT NULL) AS resolved,
              pb.bill_number,
              (pb.total_cgst + pb.total_sgst + pb.total_igst + pb.total_cess)::text
                AS bill_tax,
              l.filed_number, l.filed_tax::text AS filed_tax
         FROM gstr2b_recon_lines l
         LEFT JOIN purchase_bills pb ON pb.voucher_id = l.voucher_id
        WHERE l.client_id = $1 AND l.period = $2
          AND l.statement_id = (SELECT id FROM latest)
        ORDER BY CASE l.status
          WHEN 'mismatch' THEN 0 WHEN 'in_books_only' THEN 1
          WHEN 'in_2b_only' THEN 2 ELSE 3 END, l.created_at`,
      [clientId, period]);
    return r.rows.map((x) => ({
      id: x.id, status: x.status, supplierGstin: x.supplier_gstin, note: x.note,
      resolved: x.resolved, billNumber: x.bill_number, billTax: x.bill_tax,
      filedNumber: x.filed_number, filedTax: x.filed_tax,
    }));
  });
}

/** Marks a reconciliation line resolved by a named reviewer. */
export async function resolveReconLine(
  firmId: string, lineId: string, userId: string,
): Promise<void> {
  await withFirm(firmId, (c) => c.query(
    `UPDATE gstr2b_recon_lines
        SET resolved_by = $2, resolved_at = now()
      WHERE id = $1 AND resolved_at IS NULL`, [lineId, userId]));
}
