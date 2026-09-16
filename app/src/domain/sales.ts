/**
 * Read models and customer setup for the sales desk.
 *
 * Invoice posting itself stays in invoicing.ts. This module deliberately does
 * not duplicate any tax or ledger rules; it only gathers what the form needs
 * and creates the customer master that invoicing.ts consumes.
 */

import { withFirm } from '../db/pool.ts';
import { validateGstin, isValidStateCode } from './gstin.ts';
import { ValidationError } from './types.ts';

export interface SalesCustomer {
  id: string;
  name: string;
  legalName: string | null;
  gstin: string | null;
  gstCategory: string;
  stateCode: string | null;
  phone: string | null;
}

export interface SalesRegistration {
  id: string;
  gstin: string;
  stateCode: string;
  primary: boolean;
}

export interface SalesAccount { id: string; name: string; }

export interface SalesInvoiceRow {
  voucherId: string;
  invoiceNumber: string;
  postingDate: string;
  customerName: string;
  grandTotal: string;
  outstanding: string;
}

export interface SalesDesk {
  customers: SalesCustomer[];
  registrations: SalesRegistration[];
  incomeAccounts: SalesAccount[];
  invoices: SalesInvoiceRow[];
}

export async function salesDesk(firmId: string, clientId: string): Promise<SalesDesk> {
  return withFirm(firmId, async (c) => {
    const customers = await c.query<{
      id: string; name: string; legal_name: string | null; gstin: string | null;
      gst_category: string; state_code: string | null; phone: string | null;
    }>(
      `SELECT id, name, legal_name, gstin, gst_category::text, state_code, phone
         FROM parties
        WHERE client_id = $1 AND party_type = 'customer' AND is_active
        ORDER BY name`, [clientId]);

    const registrations = await c.query<{
      id: string; gstin: string; state_code: string; is_primary: boolean;
    }>(
      `SELECT id, gstin, state_code, is_primary
         FROM client_registrations
        WHERE client_id = $1 AND (cancelled_on IS NULL OR cancelled_on > CURRENT_DATE)
        ORDER BY is_primary DESC, state_code`, [clientId]);

    const incomeAccounts = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM accounts
        WHERE client_id = $1 AND root_type = 'income'
          AND NOT is_group AND NOT is_disabled
        ORDER BY code NULLS LAST, name`, [clientId]);

    const invoices = await c.query<{
      voucher_id: string; invoice_number: string; posting_date: string;
      customer_name: string; grand_total: string; outstanding: string;
    }>(
      `SELECT si.voucher_id, v.voucher_number AS invoice_number,
              to_char(v.posting_date, 'YYYY-MM-DD') AS posting_date,
              si.customer_legal_name AS customer_name,
              si.grand_total::text,
              (si.grand_total - COALESCE((
                SELECT SUM(le.credit - le.debit)
                  FROM ledger_entries le
                 WHERE le.settles_voucher_id = si.voucher_id
              ), 0))::text AS outstanding
         FROM sales_invoices si
         JOIN vouchers v ON v.id = si.voucher_id
        WHERE si.client_id = $1
        ORDER BY v.posting_date DESC, v.voucher_number DESC
        LIMIT 30`, [clientId]);

    return {
      customers: customers.rows.map((x) => ({
        id: x.id, name: x.name, legalName: x.legal_name, gstin: x.gstin,
        gstCategory: x.gst_category, stateCode: x.state_code, phone: x.phone,
      })),
      registrations: registrations.rows.map((x) => ({
        id: x.id, gstin: x.gstin, stateCode: x.state_code, primary: x.is_primary,
      })),
      incomeAccounts: incomeAccounts.rows,
      invoices: invoices.rows.map((x) => ({
        voucherId: x.voucher_id, invoiceNumber: x.invoice_number,
        postingDate: x.posting_date, customerName: x.customer_name,
        grandTotal: x.grand_total, outstanding: x.outstanding,
      })),
    };
  });
}

export interface CreateCustomerInput {
  clientId: string;
  name: string;
  legalName?: string;
  billingAddress: string;
  gstCategory: 'registered_regular' | 'unregistered';
  gstin?: string;
  stateCode: string;
  phone?: string;
  createdBy: string;
}

export async function createCustomer(
  firmId: string, input: CreateCustomerInput,
): Promise<{ id: string; name: string }> {
  const name = input.name.trim();
  const legalName = input.legalName?.trim() || null;
  const billingAddress = input.billingAddress.trim();
  const gstin = input.gstin?.trim().toUpperCase() || null;
  const stateCode = input.stateCode.trim();
  const phone = input.phone?.trim() || null;

  if (!name) throw new ValidationError('customer name is required', 'SI-1');
  if (!billingAddress) throw new ValidationError('billing address is required', 'SI-1');
  if (!isValidStateCode(stateCode)) {
    throw new ValidationError(`"${stateCode}" is not a valid state code`, 'SI-4');
  }
  if (input.gstCategory === 'registered_regular') {
    const check = validateGstin(gstin);
    if (!check.valid) {
      throw new ValidationError(`customer GSTIN invalid — ${check.reason}`, 'SI-1');
    }
    if (gstin!.slice(0, 2) !== stateCode) {
      throw new ValidationError('customer state must match the first two GSTIN digits', 'SI-1');
    }
  } else if (gstin !== null) {
    throw new ValidationError('an unregistered customer cannot have a GSTIN', 'SI-1');
  }
  if (phone !== null && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) {
    throw new ValidationError('customer phone number is invalid', 'SI-1');
  }

  return withFirm(firmId, async (c) => {
    const debtor = await c.query<{ id: string }>(
      `SELECT id FROM accounts
        WHERE client_id = $1 AND account_type = 'receivable' AND NOT is_group
        ORDER BY code NULLS LAST LIMIT 1`, [input.clientId]);
    if (debtor.rowCount === 0) {
      throw new ValidationError('no Debtors account is configured', 'SI-7');
    }

    const r = await c.query<{ id: string; name: string }>(
      `INSERT INTO parties
         (firm_id, client_id, party_type, name, legal_name, gstin,
          gst_category, state_code, billing_address, phone, ledger_account_id, created_by)
       VALUES ($1,$2,'customer',$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, name`,
      [firmId, input.clientId, name, legalName, gstin, input.gstCategory,
       stateCode, JSON.stringify({ line1: billingAddress }), phone,
       debtor.rows[0]!.id, input.createdBy]);

    const customer = r.rows[0]!;
    await c.query(
      `INSERT INTO audit_log
         (firm_id, client_id, entity_type, entity_id, action, after,
          actor_user_id, actor_type)
       VALUES ($1,$2,'customer',$3,'create',$4,$5,'human')`,
      [firmId, input.clientId, customer.id,
       JSON.stringify({ name, legal_name: legalName, gstin, gst_category: input.gstCategory,
                        state_code: stateCode, billing_address: billingAddress,
                        phone }), input.createdBy]);

    return customer;
  });
}

export interface SalesInvoiceDetail {
  voucherId: string;
  invoiceNumber: string;
  supplierName: string;
  postingDate: string;
  dueDate: string | null;
  customerName: string;
  customerGstin: string | null;
  customerPhone: string | null;
  billingAddress: string | null;
  supplierGstin: string;
  placeOfSupply: string;
  taxableValue: string;
  totalCgst: string;
  totalSgst: string;
  totalIgst: string;
  totalCess: string;
  roundOff: string;
  grandTotal: string;
  lines: Array<{
    description: string; hsnSac: string; quantity: string; uom: string;
    unitPrice: string; taxableValue: string; gstRate: string;
    cgst: string; sgst: string; igst: string; cess: string;
  }>;
}

export async function salesInvoiceDetail(
  firmId: string, clientId: string, voucherId: string,
): Promise<SalesInvoiceDetail | null> {
  return withFirm(firmId, async (c) => {
    const h = await c.query<{
      voucher_id: string; invoice_number: string; supplier_name: string; posting_date: string;
      due_date: string | null; customer_name: string; customer_gstin: string | null;
      customer_phone: string | null;
      billing_address: string | null;
      supplier_gstin: string; place_of_supply: string; taxable_value: string;
      total_cgst: string; total_sgst: string; total_igst: string; total_cess: string;
      round_off: string; grand_total: string;
    }>(
      `SELECT si.voucher_id, v.voucher_number AS invoice_number,
              cl.name AS supplier_name,
              to_char(v.posting_date, 'YYYY-MM-DD') AS posting_date,
              to_char(si.due_date, 'YYYY-MM-DD') AS due_date,
              si.customer_legal_name AS customer_name, si.customer_gstin,
              p.phone AS customer_phone,
              si.billing_address->>'line1' AS billing_address,
              si.supplier_gstin, si.place_of_supply,
              si.taxable_value::text, si.total_cgst::text, si.total_sgst::text,
              si.total_igst::text, si.total_cess::text, si.round_off::text,
              si.grand_total::text
         FROM sales_invoices si JOIN vouchers v ON v.id = si.voucher_id
         JOIN clients cl ON cl.id = si.client_id
         JOIN parties p ON p.id = si.party_id
        WHERE si.client_id = $1 AND si.voucher_id = $2`, [clientId, voucherId]);
    if (h.rowCount === 0) return null;

    const lines = await c.query<{
      description: string; hsn_sac: string; quantity: string; uom: string;
      unit_price: string; taxable_value: string; gst_rate: string;
      cgst_amount: string; sgst_amount: string; igst_amount: string; cess_amount: string;
    }>(
      `SELECT description, hsn_sac, quantity::text, uom, unit_price::text,
              taxable_value::text, gst_rate::text, cgst_amount::text,
              sgst_amount::text, igst_amount::text, cess_amount::text
         FROM sales_invoice_items WHERE voucher_id = $1 ORDER BY line_no`, [voucherId]);

    const x = h.rows[0]!;
    return {
      voucherId: x.voucher_id, invoiceNumber: x.invoice_number,
      supplierName: x.supplier_name,
      postingDate: x.posting_date, dueDate: x.due_date,
      customerName: x.customer_name, customerGstin: x.customer_gstin,
      customerPhone: x.customer_phone,
      billingAddress: x.billing_address,
      supplierGstin: x.supplier_gstin, placeOfSupply: x.place_of_supply,
      taxableValue: x.taxable_value, totalCgst: x.total_cgst,
      totalSgst: x.total_sgst, totalIgst: x.total_igst,
      totalCess: x.total_cess, roundOff: x.round_off, grandTotal: x.grand_total,
      lines: lines.rows.map((l) => ({
        description: l.description, hsnSac: l.hsn_sac, quantity: l.quantity,
        uom: l.uom, unitPrice: l.unit_price, taxableValue: l.taxable_value,
        gstRate: l.gst_rate, cgst: l.cgst_amount, sgst: l.sgst_amount,
        igst: l.igst_amount, cess: l.cess_amount,
      })),
    };
  });
}
