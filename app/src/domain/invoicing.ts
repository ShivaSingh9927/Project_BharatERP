/**
 * Sales invoicing.
 * Spec: invoicing.md
 *
 * Creates a tax invoice: validates, computes tax, allocates a statutory
 * invoice number, writes the invoice and its lines, and posts the resulting
 * double entry through the GL engine.
 */

import type { PoolClient } from 'pg';
import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';
import { validateGstin, isIntraState, isValidStateCode } from './gstin.ts';
import { computeInvoice, money, paise, type GstTreatment } from './tax.ts';

export type GstCategory =
  | 'registered_regular' | 'registered_composition' | 'unregistered'
  | 'sez' | 'overseas' | 'deemed_export' | 'uin_holder'
  | 'tax_deductor' | 'tax_collector' | 'input_service_distributor';

export interface InvoiceLineInput {
  description: string;
  hsnSac: string;
  quantity: string;
  uom?: string;
  unitPrice: string;
  discountAmount?: string;
  /** Omit to resolve from the date-ranged rate master (§4.4). */
  gstRate?: string;
  cessRate?: string;
  gstTreatment?: GstTreatment;
  incomeAccountId: string;
}

export interface CreateInvoiceInput {
  clientId: string;
  /**
   * Which of the client's GST registrations issues this invoice (G-22).
   * Defaults to the client's primary. Decides the supplier GSTIN on the
   * document and half of the CGST+SGST vs IGST test.
   */
  registrationId?: string;
  partyId: string;
  postingDate: string;
  documentType?: 'tax_invoice' | 'bill_of_supply' | 'credit_note' | 'debit_note' | 'export_invoice';
  placeOfSupply?: string;          // defaults to the party's state
  isReverseCharge?: boolean;
  isExport?: boolean;
  exportType?: 'with_payment' | 'without_payment';
  dueDate?: string;
  narration?: string;
  lines: InvoiceLineInput[];
  createdBy: string;
  referenceInvoiceId?: string;     // credit / debit notes
  /** Override the allocated number, e.g. during Tally import. */
  invoiceNumber?: string;
}

export interface CreatedInvoice {
  voucherId: string;
  invoiceNumber: string;
  taxableValue: string;
  totalCgst: string;
  totalSgst: string;
  totalIgst: string;
  roundOff: string;
  grandTotal: string;
  intraState: boolean;
}

// ---------------------------------------------------------------------------
// Invoice numbering — CGST Rules, Rule 46(b). Spec: invoicing.md §5
// ---------------------------------------------------------------------------

/** Rule 46(b): ≤16 chars, alphanumerics plus hyphen and slash only. */
const RULE_46B = /^[A-Za-z0-9/-]{1,16}$/;

export function assertValidInvoiceNumber(n: string): void {
  if (!RULE_46B.test(n)) {
    throw new ValidationError(
      `invoice number "${n}" breaches Rule 46(b): max 16 characters, ` +
      'alphanumerics with hyphen and slash only',
      'SI-9',
    );
  }
}

/** `INV/26-27/` — the FY-scoped series prefix. Keeps numbers inside 16 chars. */
export function seriesPrefix(fyLabel: string, base = 'INV'): string {
  return `${base}/${fyLabel}/`;
}

/**
 * Allocate the next invoice number, atomically and without gaps.
 *
 * Uses the same `FOR UPDATE` counter as the GL engine rather than MAX()+1,
 * which races. Gaps matter here beyond tidiness: an unexplained missing number
 * in a GST invoice series invites questions about suppressed sales, which is
 * why INV-2 requires a cancelled invoice to keep its number forever.
 */
async function allocateNumber(
  c: PoolClient, clientId: string, fiscalYearId: string, fyLabel: string,
): Promise<string> {
  const prefix = seriesPrefix(fyLabel);

  await c.query(
    `INSERT INTO voucher_number_counters (client_id, voucher_type, fiscal_year_id, prefix, next_value)
     VALUES ($1, 'sales', $2, $3, 1)
     ON CONFLICT (client_id, voucher_type, fiscal_year_id) DO NOTHING`,
    [clientId, fiscalYearId, prefix],
  );

  const r = await c.query<{ next_value: number; prefix: string }>(
    `UPDATE voucher_number_counters SET next_value = next_value + 1
     WHERE client_id = $1 AND voucher_type = 'sales' AND fiscal_year_id = $2
     RETURNING next_value - 1 AS next_value, prefix`,
    [clientId, fiscalYearId],
  );

  const row = r.rows[0]!;
  const number = `${row.prefix}${String(row.next_value).padStart(4, '0')}`;
  assertValidInvoiceNumber(number);
  return number;
}

// ---------------------------------------------------------------------------

export async function createInvoice(
  firmId: string, input: CreateInvoiceInput,
): Promise<CreatedInvoice> {
  if (input.lines.length === 0) {
    throw new ValidationError('invoice has no line items', 'SI-7');
  }

  return withFirm(firmId, async (c) => {
    // --- party and supplier context ---------------------------------------
    const p = await c.query(
      `SELECT p.id, p.name, p.legal_name, p.gstin, p.gst_category, p.state_code,
              p.billing_address, p.ledger_account_id, p.is_active
       FROM parties p WHERE p.id = $1 AND p.client_id = $2`,
      [input.partyId, input.clientId],
    );
    if (p.rowCount === 0) throw new ValidationError('party not found for this client', 'SI-1');
    const party = p.rows[0]!;

    if (!party.is_active) {
      throw new ValidationError(`party "${party.name}" is inactive`, 'SI-1');
    }

    /*
     * Which of OUR registrations is issuing this invoice (G-22).
     *
     * A client can hold a GSTIN in several states, and the choice is not
     * cosmetic: it decides the supplier GSTIN printed on a legal document, and
     * it is one half of the intra-state test that picks CGST+SGST or IGST. The
     * same sale billed from Delhi and from Haryana carries different tax.
     *
     * A caller may name one; otherwise the client's primary is used. A
     * cancelled registration cannot issue an invoice.
     */
    const reg = await c.query<{ id: string; gstin: string; state_code: string }>(
      input.registrationId
        ? `SELECT id, gstin, state_code FROM client_registrations
           WHERE id = $2 AND client_id = $1`
        : `SELECT id, gstin, state_code FROM client_registrations
           WHERE client_id = $1 AND is_primary`,
      input.registrationId ? [input.clientId, input.registrationId] : [input.clientId]);

    if (reg.rowCount === 0) {
      throw new ValidationError(
        input.registrationId
          ? 'that GST registration does not belong to this client'
          : 'this client has no primary GST registration configured', 'SI-2');
    }
    const registration = reg.rows[0]!;
    party.supplier_gstin = registration.gstin;
    party.supplier_state = registration.state_code;

    // SI-2: our own GSTIN must be structurally sound before we put it on a
    // legal document.
    const supplierCheck = validateGstin(party.supplier_gstin);
    if (!supplierCheck.valid) {
      throw new ValidationError(`supplier GSTIN invalid — ${supplierCheck.reason}`, 'SI-2');
    }

    const category: GstCategory = party.gst_category;
    const isB2B = !['unregistered', 'overseas'].includes(category);

    // SI-3 / SI-1: a B2B invoice needs a customer GSTIN, and it must pass the
    // check digit. This is the validation that catches an OCR transposition
    // (bills-and-expenses.md BE-4b) before it reaches a legal document.
    if (isB2B) {
      const check = validateGstin(party.gstin);
      if (!check.valid) {
        throw new ValidationError(
          `customer GSTIN "${party.gstin}" invalid — ${check.reason}`, 'SI-1');
      }
    }

    // --- place of supply ---------------------------------------------------
    const placeOfSupply = input.placeOfSupply
      ?? party.state_code
      ?? (party.gstin ? party.gstin.slice(0, 2) : null);

    if (!placeOfSupply) throw new ValidationError('place of supply is required', 'SI-4');
    if (!isValidStateCode(placeOfSupply)) {
      throw new ValidationError(`"${placeOfSupply}" is not a valid state code`, 'SI-4');
    }

    // Exports are always treated as inter-state.
    const intraState = input.isExport
      ? false
      : isIntraState(party.supplier_gstin, placeOfSupply);

    // SI-11: a composition dealer cannot collect GST — they issue a Bill of
    // Supply, not a Tax Invoice.
    const documentType = input.documentType ?? 'tax_invoice';
    if (category === 'registered_composition' && documentType === 'tax_invoice') {
      const charging = input.lines.some((l) => Number(l.gstRate ?? '0') > 0);
      if (charging) {
        throw new ValidationError(
          'a composition dealer cannot collect GST — issue a Bill of Supply instead',
          'SI-11');
      }
    }

    if (input.isExport && !input.exportType) {
      throw new ValidationError('export invoice requires an export type', 'SI-12');
    }

    // --- resolve rates as of the posting date (§4.4, PR-7) -----------------
    const resolved = [];
    for (const [i, line] of input.lines.entries()) {
      if (!line.hsnSac || line.hsnSac.trim() === '') {
        // SI-5. A blank HSN does not merely look untidy — it makes GSTR-1
        // unfileable, because the HSN summary table is mandatory.
        throw new ValidationError(`line ${i + 1} has no HSN/SAC code`, 'SI-5');
      }

      let rateId: string | null = null;
      let gstRate = line.gstRate;
      let cessRate = line.cessRate ?? '0';

      if (gstRate === undefined) {
        const rr = await c.query(
          'SELECT rate_id, gst_rate, cess_rate FROM resolve_gst_rate($1, $2)',
          [line.hsnSac, input.postingDate],
        );
        if (rr.rowCount === 0) {
          throw new ValidationError(
            `no GST rate configured for HSN "${line.hsnSac}" as of ${input.postingDate}`,
            'SI-5');
        }
        rateId = rr.rows[0]!.rate_id;
        gstRate = rr.rows[0]!.gst_rate;
        cessRate = rr.rows[0]!.cess_rate;
      }

      resolved.push({ ...line, gstRate: gstRate!, cessRate, rateId });
    }

    // --- compute (deterministic, no model involvement) ---------------------
    const totals = computeInvoice(
      resolved.map((l) => ({
        quantity: l.quantity, unitPrice: l.unitPrice,
        discountAmount: l.discountAmount, gstRate: l.gstRate,
        cessRate: l.cessRate, gstTreatment: l.gstTreatment,
      })),
      intraState,
    );

    // --- fiscal year and number -------------------------------------------
    const fyRow = await c.query<{ fy: string; label: string }>(
      `SELECT resolve_open_fiscal_year($1, $2) AS fy,
              (SELECT label FROM fiscal_years
               WHERE client_id = $1 AND $2 BETWEEN start_date AND end_date) AS label`,
      [input.clientId, input.postingDate],
    );
    const fiscalYearId = fyRow.rows[0]!.fy;
    const fyLabel = fyRow.rows[0]!.label;

    const invoiceNumber = input.invoiceNumber
      ?? await allocateNumber(c, input.clientId, fiscalYearId, fyLabel);
    assertValidInvoiceNumber(invoiceNumber);

    // --- voucher -----------------------------------------------------------
    const v = await c.query<{ id: string }>(
      `INSERT INTO vouchers
         (firm_id, client_id, voucher_type, voucher_number, posting_date,
          fiscal_year_id, narration, created_by, created_via)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ui') RETURNING id`,
      [
        firmId, input.clientId,
        documentType === 'credit_note' ? 'credit_note'
          : documentType === 'debit_note' ? 'debit_note' : 'sales',
        invoiceNumber, input.postingDate, fiscalYearId,
        input.narration ?? null, input.createdBy,
      ],
    );
    const voucherId = v.rows[0]!.id;

    await c.query(
      `INSERT INTO sales_invoices
         (voucher_id, firm_id, client_id, document_type, party_id,
          customer_gstin, customer_legal_name, billing_address, supplier_gstin,
          registration_id,
          gst_category, place_of_supply, is_reverse_charge, is_export, export_type,
          due_date, taxable_value, total_cgst, total_sgst, total_igst, total_cess,
          round_off, grand_total, reference_invoice_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$24,
               $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        voucherId, firmId, input.clientId, documentType, input.partyId,
        party.gstin, party.legal_name ?? party.name, party.billing_address,
        party.supplier_gstin, category, placeOfSupply,
        input.isReverseCharge ?? false, input.isExport ?? false, input.exportType ?? null,
        input.dueDate ?? null,
        money(totals.taxableValue), money(totals.totalCgst), money(totals.totalSgst),
        money(totals.totalIgst), money(totals.totalCess),
        money(totals.roundOff), money(totals.grandTotal),
        input.referenceInvoiceId ?? null,
        registration.id,                                   // $24
      ],
    );

    for (const [i, line] of resolved.entries()) {
      const t = totals.lines[i]!;
      await c.query(
        `INSERT INTO sales_invoice_items
           (voucher_id, line_no, description, hsn_sac, quantity, uom, unit_price,
            discount_amount, taxable_value, gst_treatment, gst_rate,
            cgst_amount, sgst_amount, igst_amount, cess_rate, cess_amount,
            income_account_id, applied_rate_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          voucherId, i + 1, line.description, line.hsnSac, line.quantity,
          line.uom ?? 'NOS', line.unitPrice, line.discountAmount ?? '0',
          money(t.taxableValue), line.gstTreatment ?? 'taxable', line.gstRate,
          money(t.cgst), money(t.sgst), money(t.igst), line.cessRate, money(t.cess),
          line.incomeAccountId, line.rateId,
        ],
      );
    }

    // --- GL posting (invoicing.md §7, Lesson 5) ----------------------------
    //
    //   Debtors            Dr  grand total
    //       Sales                  Cr  taxable value
    //       Output CGST/SGST       Cr  or Output IGST
    //
    // Only the taxable value is revenue. The tax is not ours — we collect it
    // on the government's behalf, so it is a liability.
    const lines: Array<{ accountId: string; debit?: string; credit?: string;
                         partyType?: 'customer'; partyId?: string }> = [];

    lines.push({
      accountId: party.ledger_account_id,
      debit: money(totals.grandTotal),
      partyType: 'customer',
      partyId: input.partyId,
    });

    // Group revenue by income account so a mixed invoice posts correctly.
    const revenueByAccount = new Map<string, bigint>();
    resolved.forEach((l, i) => {
      const acc = l.incomeAccountId;
      revenueByAccount.set(acc, (revenueByAccount.get(acc) ?? 0n) + totals.lines[i]!.taxableValue);
    });
    for (const [accountId, amount] of revenueByAccount) {
      lines.push({ accountId, credit: money(amount) });
    }

    const taxAccount = async (accountType: string, name: string) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM accounts
         WHERE client_id = $1 AND account_type = $2 AND name = $3 AND NOT is_group`,
        [input.clientId, accountType, name]);
      if (r.rowCount === 0) throw new ValidationError(`tax account "${name}" not in chart`, 'SI-7');
      return r.rows[0]!.id;
    };

    if (totals.totalCgst > 0n) {
      lines.push({ accountId: await taxAccount('tax_output', 'Output CGST Payable'),
                   credit: money(totals.totalCgst) });
      lines.push({ accountId: await taxAccount('tax_output', 'Output SGST Payable'),
                   credit: money(totals.totalSgst) });
    }
    if (totals.totalIgst > 0n) {
      lines.push({ accountId: await taxAccount('tax_output', 'Output IGST Payable'),
                   credit: money(totals.totalIgst) });
    }
    if (totals.roundOff !== 0n) {
      const roundAcc = await taxAccount('round_off', 'Round Off');
      if (totals.roundOff > 0n) lines.push({ accountId: roundAcc, credit: money(totals.roundOff) });
      else lines.push({ accountId: roundAcc, debit: money(-totals.roundOff) });
    }

    // Insert ledger entries directly: we are already inside the transaction
    // and the voucher exists. The deferred balance constraint still fires at
    // COMMIT, so V-1 remains enforced by the database.
    const debitAccounts = lines.filter((l) => l.debit).map((l) => l.accountId);
    const creditAccounts = lines.filter((l) => l.credit).map((l) => l.accountId);

    for (const [i, l] of lines.entries()) {
      await c.query(
        `INSERT INTO ledger_entries
           (firm_id, client_id, voucher_id, line_no, posting_date, fiscal_year_id,
            account_id, debit, credit, party_type, party_id, against_accounts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          firmId, input.clientId, voucherId, i + 1, input.postingDate, fiscalYearId,
          l.accountId, l.debit ?? '0', l.credit ?? '0',
          l.partyType ?? null, l.partyId ?? null,
          l.debit ? creditAccounts : debitAccounts,
        ],
      );
    }

    await c.query(
      `INSERT INTO audit_log
         (firm_id, client_id, entity_type, entity_id, action, after, actor_user_id, actor_type)
       VALUES ($1,$2,'sales_invoice',$3,'create',$4,$5,'human')`,
      [
        firmId, input.clientId, voucherId,
        JSON.stringify({
          invoice_number: invoiceNumber, document_type: documentType,
          place_of_supply: placeOfSupply, intra_state: intraState,
          grand_total: money(totals.grandTotal),
        }),
        input.createdBy,
      ],
    );

    return {
      voucherId,
      invoiceNumber,
      taxableValue: money(totals.taxableValue),
      totalCgst: money(totals.totalCgst),
      totalSgst: money(totals.totalSgst),
      totalIgst: money(totals.totalIgst),
      roundOff: money(totals.roundOff),
      grandTotal: money(totals.grandTotal),
      intraState,
    };
  });
}

/**
 * Outstanding amount for an invoice.
 *
 * Derived from settlements, never stored (invoicing.md §4.5). A stored
 * counter drifts; a query cannot.
 */
export async function invoiceOutstanding(
  firmId: string, voucherId: string,
): Promise<{ grandTotal: string; settled: string; outstanding: string }> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ grand_total: string; settled: string }>(
      `SELECT si.grand_total::text,
              COALESCE((SELECT SUM(le.credit - le.debit)
                        FROM ledger_entries le
                        WHERE le.settles_voucher_id = si.voucher_id), 0)::text AS settled
       FROM sales_invoices si WHERE si.voucher_id = $1`,
      [voucherId]);
    if (r.rowCount === 0) throw new ValidationError('invoice not found', 'SI-13');
    const { grand_total, settled } = r.rows[0]!;
    return {
      grandTotal: grand_total,
      settled,
      outstanding: money(paise(grand_total) - paise(settled)),
    };
  });
}
