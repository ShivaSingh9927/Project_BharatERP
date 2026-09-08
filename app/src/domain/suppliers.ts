/**
 * A supplier, whole: who they are, what they've billed, what's owed, and what
 * the books have learned about them.
 * Spec: bills-and-expenses.md §8
 *
 * The bill review, the payables ageing, the registration check and the learned
 * line-defaults each hold a piece of a supplier. This gathers them onto one
 * page — the drill-down a reviewer reaches for when a name on the ageing needs
 * a second look. It reads; it decides nothing.
 */

import { withFirm } from '../db/pool.ts';
import { paise, money } from './tax.ts';

export interface SupplierListRow {
  id: string;
  name: string;
  gstin: string | null;
  status: string | null;
  outstanding: string;
}

/** Every supplier on file, with what is owed and how their registration reads. */
export async function supplierList(
  firmId: string, clientId: string,
): Promise<SupplierListRow[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{
      id: string; name: string; gstin: string | null; status: string | null;
      outstanding: string;
    }>(
      `SELECT p.id, p.name, p.gstin, reg.status,
              COALESCE(SUM(
                (SELECT COALESCE(SUM(le.credit - le.debit), 0)
                   FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
                  WHERE le.voucher_id = pb.voucher_id AND a.account_type = 'payable')
                - COALESCE((SELECT SUM(s.debit - s.credit) FROM ledger_entries s
                             WHERE s.settles_voucher_id = pb.voucher_id), 0)
              ), 0)::text AS outstanding
         FROM parties p
         LEFT JOIN purchase_bills pb ON pb.party_id = p.id
         LEFT JOIN gstin_registry reg ON reg.gstin = p.gstin
        WHERE p.client_id = $1 AND p.party_type = 'supplier'
        GROUP BY p.id, p.name, p.gstin, reg.status
        ORDER BY p.name`, [clientId]);
    return r.rows.map((x) => ({
      id: x.id, name: x.name, gstin: x.gstin, status: x.status,
      outstanding: money(paise(x.outstanding)),
    }));
  });
}

export interface SupplierBill {
  voucherId: string; billNumber: string; billDate: string;
  grandTotal: string; outstanding: string; settled: boolean;
}
export interface SupplierPayment {
  voucherNumber: string; date: string; amount: string; billNumber: string | null;
}
export interface LearnedMapping { lineKey: string; accountName: string; timesSeen: number; }

export interface SupplierDetail {
  id: string;
  name: string;
  legalName: string | null;
  gstin: string | null;
  stateCode: string | null;
  gstCategory: string;
  registration: {
    status: string; taxpayerType: string | null;
    registeredOn: string | null; cancelledOn: string | null;
    einvoiceRequired: boolean | null;
  } | null;
  totalBilled: string;
  totalPaid: string;
  totalOutstanding: string;
  bills: SupplierBill[];
  payments: SupplierPayment[];
  learned: LearnedMapping[];
}

export async function supplierDetail(
  firmId: string, clientId: string, partyId: string,
): Promise<SupplierDetail | null> {
  return withFirm(firmId, async (c) => {
    const p = await c.query<{
      name: string; legal_name: string | null; gstin: string | null;
      state_code: string | null; gst_category: string;
      status: string | null; taxpayer_type: string | null;
      registered_on: string | null; cancelled_on: string | null;
      einvoice_required: boolean | null;
    }>(
      `SELECT p.name, p.legal_name, p.gstin, p.state_code, p.gst_category::text,
              reg.status, reg.taxpayer_type,
              to_char(reg.registered_on, 'YYYY-MM-DD') AS registered_on,
              to_char(reg.cancelled_on, 'YYYY-MM-DD') AS cancelled_on,
              reg.einvoice_required
         FROM parties p
         LEFT JOIN gstin_registry reg ON reg.gstin = p.gstin
        WHERE p.id = $1 AND p.client_id = $2 AND p.party_type = 'supplier'`,
      [partyId, clientId]);
    if (p.rowCount === 0) return null;
    const row = p.rows[0]!;

    const bills = await c.query<{
      voucher_id: string; bill_number: string; bill_date: string;
      grand_total: string; outstanding: string;
    }>(
      `SELECT pb.voucher_id, pb.bill_number,
              to_char(pb.bill_date, 'YYYY-MM-DD') AS bill_date,
              pb.grand_total::text AS grand_total,
              ((SELECT COALESCE(SUM(le.credit - le.debit), 0)
                  FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
                 WHERE le.voucher_id = pb.voucher_id AND a.account_type = 'payable')
               - COALESCE((SELECT SUM(s.debit - s.credit) FROM ledger_entries s
                            WHERE s.settles_voucher_id = pb.voucher_id), 0))::text
                AS outstanding
         FROM purchase_bills pb
        WHERE pb.client_id = $1 AND pb.party_id = $2
        ORDER BY pb.bill_date DESC`, [clientId, partyId]);

    const payments = await c.query<{
      voucher_number: string; date: string; amount: string; bill_number: string | null;
    }>(
      `SELECT v.voucher_number,
              to_char(v.posting_date, 'YYYY-MM-DD') AS date,
              le.debit::text AS amount, pb.bill_number
         FROM ledger_entries le
         JOIN vouchers v ON v.id = le.voucher_id
         LEFT JOIN purchase_bills pb ON pb.voucher_id = le.settles_voucher_id
        WHERE v.client_id = $1 AND le.party_id = $2
          AND v.voucher_type = 'payment' AND le.debit > 0
        ORDER BY v.posting_date DESC, v.voucher_number DESC`, [clientId, partyId]);

    const learned = await c.query<{ line_key: string; name: string; times_seen: number }>(
      `SELECT d.line_key, a.name, d.times_seen
         FROM line_account_defaults d JOIN accounts a ON a.id = d.account_id
        WHERE d.client_id = $1 AND d.party_id = $2
        ORDER BY d.times_seen DESC, d.line_key`, [clientId, partyId]);

    let billed = 0n, outstanding = 0n;
    const billViews: SupplierBill[] = bills.rows.map((b) => {
      billed += paise(b.grand_total);
      const out = paise(b.outstanding);
      outstanding += out;
      return {
        voucherId: b.voucher_id, billNumber: b.bill_number, billDate: b.bill_date,
        grandTotal: b.grand_total, outstanding: money(out), settled: out <= 0n,
      };
    });
    const paid = payments.rows.reduce((s, x) => s + paise(x.amount), 0n);

    return {
      id: partyId, name: row.name, legalName: row.legal_name, gstin: row.gstin,
      stateCode: row.state_code, gstCategory: row.gst_category,
      registration: row.status === null ? null : {
        status: row.status, taxpayerType: row.taxpayer_type,
        registeredOn: row.registered_on, cancelledOn: row.cancelled_on,
        einvoiceRequired: row.einvoice_required,
      },
      totalBilled: money(billed),
      totalPaid: money(paid),
      totalOutstanding: money(outstanding),
      bills: billViews,
      payments: payments.rows.map((x) => ({
        voucherNumber: x.voucher_number, date: x.date,
        amount: money(paise(x.amount)), billNumber: x.bill_number,
      })),
      learned: learned.rows.map((x) => ({
        lineKey: x.line_key, accountName: x.name, timesSeen: x.times_seen,
      })),
    };
  });
}
