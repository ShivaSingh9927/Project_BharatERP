/**
 * Purchase bills.
 * Spec: bills-and-expenses.md
 *
 * The asymmetry that shapes this module: on the sales side we CREATE the
 * document and control its format. Here the vendor creates it and we receive
 * it, in one of hundreds of layouts. Bills are an extraction-and-verification
 * problem, not a generation problem — so nothing on the document is trusted
 * until it has been independently recomputed.
 */

import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';
import { validateGstin, isIntraState, isValidStateCode } from './gstin.ts';
import { computeInvoice, verifyTaxFigures, money, paise } from './tax.ts';
import { decideItc, type ItcEligibility } from './itc.ts';
import { resolveAndComputeTds, type EntityType, type TdsComputation } from './tds.ts';

export interface BillLineInput {
  description: string;
  hsnSac?: string;
  quantity?: string;
  unitPrice: string;
  gstRate?: string;
  expenseAccountId: string;
}

export interface CreateBillInput {
  clientId: string;
  partyId: string;
  billNumber: string;                 // the vendor's number, not ours
  billDate: string;
  postingDate?: string;
  placeOfSupply?: string;
  isReverseCharge?: boolean;
  lines: BillLineInput[];
  createdBy: string;
  createdVia?: 'ui' | 'api' | 'ai_proposal' | 'whatsapp';
  approvedBy?: string;
  sourceDocumentId?: string;
  paymentDueDate?: string;
  /** Figures printed on the vendor's document, for PB-4 cross-checking. */
  claimedTotals?: { cgst?: string; sgst?: string; igst?: string; grandTotal?: string };
}

export interface CreatedBill {
  voucherId: string;
  billNumber: string;
  taxableValue: string;
  totalGst: string;
  grandTotal: string;
  intraState: boolean;
  itcEligibility: ItcEligibility;
  itcClaimable: boolean;
  warnings: string[];
}

/** BE-2: deduplicate on content, not filename. */
export function contentHash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function createBill(
  firmId: string, input: CreateBillInput,
): Promise<CreatedBill> {
  if (input.lines.length === 0) {
    throw new ValidationError('bill has no line items', 'PB-5');
  }

  const warnings: string[] = [];
  const postingDate = input.postingDate ?? input.billDate;

  return withFirm(firmId, async (c) => {
    // --- supplier -----------------------------------------------------------
    const p = await c.query(
      `SELECT p.id, p.name, p.legal_name, p.gstin, p.gst_category, p.state_code,
              p.ledger_account_id, p.is_active,
              cl.gstin AS buyer_gstin, cl.state_code AS buyer_state
       FROM parties p JOIN clients cl ON cl.id = p.client_id
       WHERE p.id = $1 AND p.client_id = $2`,
      [input.partyId, input.clientId]);
    if (p.rowCount === 0) throw new ValidationError('supplier not found for this client', 'PB-1');
    const sup = p.rows[0]!;

    if (sup.gstin) {
      // PB-1. Runs whichever engine parsed the document — LlamaParse read the
      // GSTIN correctly in our probe, but correctness must never be contingent
      // on a vendor performing well (BE-4f).
      const check = validateGstin(sup.gstin);
      if (!check.valid) {
        throw new ValidationError(
          `supplier GSTIN "${sup.gstin}" invalid — ${check.reason}`, 'PB-1');
      }
    }

    // PB-3: a bill cannot predate the relationship or postdate reality.
    if (new Date(input.billDate) > new Date(postingDate)) {
      warnings.push(`bill date ${input.billDate} is after the posting date ${postingDate}`);
    }

    const placeOfSupply = input.placeOfSupply ?? sup.buyer_state
      ?? (sup.buyer_gstin ? sup.buyer_gstin.slice(0, 2) : null);
    if (!placeOfSupply || !isValidStateCode(placeOfSupply)) {
      throw new ValidationError(`invalid place of supply "${placeOfSupply}"`, 'PB-6');
    }

    const intraState = sup.gstin
      ? isIntraState(sup.gstin, placeOfSupply)
      : true;   // unregistered supplier — treat as local

    // --- ITC eligibility, per line (§6.2) -----------------------------------
    const clientRow = await c.query<{ business_type: string | null }>(
      `SELECT NULL::text AS business_type`);   // business_type lands with the client profile
    const businessType = clientRow.rows[0]?.business_type ?? null;

    const resolved = [];
    for (const [i, line] of input.lines.entries()) {
      const acc = await c.query<{ itc_eligibility: ItcEligibility | null; name: string }>(
        `SELECT itc_eligibility, name FROM accounts
         WHERE id = $1 AND client_id = $2 AND NOT is_group`,
        [line.expenseAccountId, input.clientId]);
      if (acc.rowCount === 0) {
        throw new ValidationError(`expense account for line ${i + 1} not found or is a group`, 'PB-1');
      }

      const decision = decideItc({
        accountEligibility: acc.rows[0]!.itc_eligibility,
        clientBusinessType: businessType,
      });

      if (decision.eligibility === 'blocked') {
        warnings.push(
          `line ${i + 1} (${acc.rows[0]!.name}): ${decision.reason} — ` +
          'GST added to cost rather than claimed');
      }
      if (decision.needsHumanDecision) {
        warnings.push(`line ${i + 1} (${acc.rows[0]!.name}): needs a CA decision on ITC`);
      }

      resolved.push({ ...line, itc: decision.eligibility, accountName: acc.rows[0]!.name });
    }

    // A bill is treated as blocked if any line is. Mixed bills are split by
    // the caller; keeping the header simple avoids a partial-claim state that
    // GSTR-3B cannot express cleanly.
    const billItc: ItcEligibility =
      resolved.some((l) => l.itc === 'blocked') ? 'blocked'
      : resolved.some((l) => l.itc === 'conditional') ? 'conditional'
      : 'eligible';

    // --- compute ------------------------------------------------------------
    const totals = computeInvoice(
      resolved.map((l) => ({
        quantity: l.quantity ?? '1',
        unitPrice: l.unitPrice,
        gstRate: l.gstRate ?? '0',
      })),
      intraState,
    );

    // PB-4. Vendor invoices contain arithmetic errors more often than expected.
    // Recompute independently; a mismatch is a finding for the CA, never
    // something to silently overwrite.
    if (input.claimedTotals) {
      const v = verifyTaxFigures(
        money(totals.taxableValue),
        resolved[0]?.gstRate ?? '0',
        intraState,
        input.claimedTotals,
      );
      if (!v.matches) {
        warnings.push(`PB-4 tax mismatch — ${v.detail}. Route to CA for adjudication.`);
      }
    }

    // --- fiscal year and voucher -------------------------------------------
    const fy = await c.query<{ fy: string }>(
      'SELECT resolve_open_fiscal_year($1, $2) AS fy', [input.clientId, postingDate]);
    const fiscalYearId = fy.rows[0]!.fy;

    const number = (await c.query<{ n: string }>(
      "SELECT next_voucher_number($1, 'purchase', $2) AS n",
      [input.clientId, fiscalYearId])).rows[0]!.n;

    const v = await c.query<{ id: string }>(
      `INSERT INTO vouchers
         (firm_id, client_id, voucher_type, voucher_number, posting_date,
          fiscal_year_id, narration, created_by, created_via, approved_by,
          source_document_id)
       VALUES ($1,$2,'purchase',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        firmId, input.clientId, number, postingDate, fiscalYearId,
        `Bill ${input.billNumber} from ${sup.legal_name ?? sup.name}`,
        input.createdBy, input.createdVia ?? 'ui', input.approvedBy ?? null,
        input.sourceDocumentId ?? null,
      ]);
    const voucherId = v.rows[0]!.id;

    await c.query(
      `INSERT INTO purchase_bills
         (voucher_id, firm_id, client_id, party_id, supplier_gstin, supplier_legal_name,
          bill_number, bill_date, place_of_supply, is_reverse_charge,
          taxable_value, total_cgst, total_sgst, total_igst, total_cess,
          round_off, grand_total, itc_eligibility, payment_due_date,
          approval_status, source_document_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        voucherId, firmId, input.clientId, input.partyId, sup.gstin,
        sup.legal_name ?? sup.name, input.billNumber, input.billDate,
        placeOfSupply, input.isReverseCharge ?? false,
        money(totals.taxableValue), money(totals.totalCgst), money(totals.totalSgst),
        money(totals.totalIgst), money(totals.totalCess), money(totals.roundOff),
        money(totals.grandTotal), billItc, input.paymentDueDate ?? null,
        'pending_review', input.sourceDocumentId ?? null,
      ]);

    for (const [i, l] of resolved.entries()) {
      const t = totals.lines[i]!;
      await c.query(
        `INSERT INTO purchase_bill_items
           (voucher_id, line_no, description, hsn_sac, quantity, unit_price,
            taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount,
            cess_amount, expense_account_id, itc_eligibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          voucherId, i + 1, l.description, l.hsnSac ?? null, l.quantity ?? '1',
          l.unitPrice, money(t.taxableValue), l.gstRate ?? '0',
          money(t.cgst), money(t.sgst), money(t.igst), money(t.cess),
          l.expenseAccountId, l.itc,
        ]);
    }

    // --- GL posting ---------------------------------------------------------
    await postBillToLedger(c, {
      firmId, clientId: input.clientId, voucherId, postingDate, fiscalYearId,
      partyId: input.partyId, creditorAccountId: sup.ledger_account_id,
      lines: resolved.map((l, i) => ({
        accountId: l.expenseAccountId,
        taxableValue: totals.lines[i]!.taxableValue,
        cgst: totals.lines[i]!.cgst,
        sgst: totals.lines[i]!.sgst,
        igst: totals.lines[i]!.igst,
        itc: l.itc,
      })),
      grandTotal: totals.grandTotal,
      roundOff: totals.roundOff,
      isReverseCharge: input.isReverseCharge ?? false,
    });

    await c.query(
      `INSERT INTO audit_log
         (firm_id, client_id, entity_type, entity_id, action, after,
          actor_user_id, actor_type, approved_by)
       VALUES ($1,$2,'purchase_bill',$3,'create',$4,$5,$6,$7)`,
      [
        firmId, input.clientId, voucherId,
        JSON.stringify({
          bill_number: input.billNumber, supplier: sup.legal_name ?? sup.name,
          grand_total: money(totals.grandTotal), itc_eligibility: billItc,
          warnings,
        }),
        input.createdBy,
        input.createdVia === 'ai_proposal' ? 'ai_agent' : 'human',
        input.approvedBy ?? null,
      ]);

    return {
      voucherId,
      billNumber: input.billNumber,
      taxableValue: money(totals.taxableValue),
      totalGst: money(totals.totalCgst + totals.totalSgst + totals.totalIgst),
      grandTotal: money(totals.grandTotal),
      intraState,
      itcEligibility: billItc,
      itcClaimable: billItc === 'eligible',
      warnings,
    };
  });
}

/**
 * Post the bill's double entry.
 *
 * Three shapes, and which one applies is an accounting decision, not a
 * formatting one:
 *
 *   ITC eligible    Expense Dr + Input GST Dr / Creditors Cr
 *   ITC blocked     Expense (incl. GST) Dr    / Creditors Cr
 *   Reverse charge  Expense Dr + Input GST Dr / Creditors Cr + Output GST Cr
 *
 * The blocked case is not cosmetic: the tax becomes part of the cost, which
 * changes reported expense — and therefore profit — by the tax amount.
 */
async function postBillToLedger(
  c: PoolClient,
  a: {
    firmId: string; clientId: string; voucherId: string; postingDate: string;
    fiscalYearId: string; partyId: string; creditorAccountId: string;
    lines: Array<{ accountId: string; taxableValue: bigint; cgst: bigint;
                   sgst: bigint; igst: bigint; itc: ItcEligibility }>;
    grandTotal: bigint; roundOff: bigint; isReverseCharge: boolean;
  },
): Promise<void> {
  const taxAccount = async (accountType: string, name: string) => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM accounts WHERE client_id = $1 AND account_type = $2
         AND name = $3 AND NOT is_group`,
      [a.clientId, accountType, name]);
    if (r.rowCount === 0) throw new ValidationError(`account "${name}" not in chart`, 'PB-1');
    return r.rows[0]!.id;
  };

  const entries: Array<{ accountId: string; debit?: bigint; credit?: bigint;
                         partyType?: 'supplier'; partyId?: string }> = [];

  let inputCgst = 0n, inputSgst = 0n, inputIgst = 0n;

  for (const l of a.lines) {
    const lineTax = l.cgst + l.sgst + l.igst;
    if (l.itc === 'eligible') {
      entries.push({ accountId: l.accountId, debit: l.taxableValue });
      inputCgst += l.cgst; inputSgst += l.sgst; inputIgst += l.igst;
    } else {
      // Blocked: the GST can never be recovered, so it is part of the cost.
      entries.push({ accountId: l.accountId, debit: l.taxableValue + lineTax });
    }
  }

  if (inputCgst > 0n) {
    entries.push({ accountId: await taxAccount('tax_input', 'Input CGST Credit'), debit: inputCgst });
    entries.push({ accountId: await taxAccount('tax_input', 'Input SGST Credit'), debit: inputSgst });
  }
  if (inputIgst > 0n) {
    entries.push({ accountId: await taxAccount('tax_input', 'Input IGST Credit'), debit: inputIgst });
  }

  if (a.isReverseCharge) {
    // BE-8/BE-9. Under RCM the recipient pays the GST directly, so the bill
    // creates BOTH a liability and a credit. They usually net to zero, which
    // is exactly why people skip it — but the liability must be paid in cash
    // and the credit is only claimable after that payment, so both legs have
    // to exist and be tracked.
    const supplierValue = a.lines.reduce((s, l) => s + l.taxableValue, 0n);
    entries.push({
      accountId: a.creditorAccountId, credit: supplierValue,
      partyType: 'supplier', partyId: a.partyId,
    });
    if (inputCgst > 0n) {
      entries.push({ accountId: await taxAccount('tax_output', 'Output CGST Payable'), credit: inputCgst });
      entries.push({ accountId: await taxAccount('tax_output', 'Output SGST Payable'), credit: inputSgst });
    }
    if (inputIgst > 0n) {
      entries.push({ accountId: await taxAccount('tax_output', 'Output IGST Payable'), credit: inputIgst });
    }
  } else {
    entries.push({
      accountId: a.creditorAccountId, credit: a.grandTotal,
      partyType: 'supplier', partyId: a.partyId,
    });
  }

  // Round-off polarity is INVERTED relative to sales, and that is not a
  // symmetry to be tidied away.
  //
  // On a sales invoice the rounded figure sits on the DEBIT side (Debtors), so
  // rounding up needs an extra credit. On a purchase bill the rounded figure
  // sits on the CREDIT side (Creditors), so rounding up needs an extra DEBIT.
  //
  // Reverse charge is excluded: both sides of an RCM posting use unrounded
  // values, so applying a round-off there would unbalance a balanced voucher.
  if (a.roundOff !== 0n && !a.isReverseCharge) {
    const roundAcc = await taxAccount('round_off', 'Round Off');
    if (a.roundOff > 0n) entries.push({ accountId: roundAcc, debit: a.roundOff });
    else entries.push({ accountId: roundAcc, credit: -a.roundOff });
  }

  const debitAccounts = entries.filter((e) => e.debit).map((e) => e.accountId);
  const creditAccounts = entries.filter((e) => e.credit).map((e) => e.accountId);

  for (const [i, e] of entries.entries()) {
    await c.query(
      `INSERT INTO ledger_entries
         (firm_id, client_id, voucher_id, line_no, posting_date, fiscal_year_id,
          account_id, debit, credit, party_type, party_id, against_accounts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        a.firmId, a.clientId, a.voucherId, i + 1, a.postingDate, a.fiscalYearId,
        e.accountId, e.debit ? money(e.debit) : '0', e.credit ? money(e.credit) : '0',
        e.partyType ?? null, e.partyId ?? null,
        e.debit ? creditAccounts : debitAccounts,
      ]);
  }
}

/**
 * Pay a supplier, withholding TDS where the section requires it.
 *
 *   Creditors    Dr  gross
 *       TDS Payable      Cr  withheld
 *       Bank             Cr  net
 *
 * The withheld amount is not ours — it is a liability owed to the government
 * until deposited (Lesson 6).
 */
export async function paySupplier(
  firmId: string,
  input: {
    clientId: string; partyId: string; paymentDate: string; amount: string;
    bankAccountId: string; createdBy: string;
    tdsCategory?: string; entityType?: EntityType;
  },
): Promise<{ voucherId: string; gross: string; tds: string; net: string;
             tdsComputation: TdsComputation | null }> {
  return withFirm(firmId, async (c) => {
    const sup = await c.query(
      'SELECT ledger_account_id, name FROM parties WHERE id = $1 AND client_id = $2',
      [input.partyId, input.clientId]);
    if (sup.rowCount === 0) throw new ValidationError('supplier not found', 'PB-1');

    const fy = await c.query<{ fy: string }>(
      'SELECT resolve_open_fiscal_year($1, $2) AS fy', [input.clientId, input.paymentDate]);
    const fiscalYearId = fy.rows[0]!.fy;

    let tds: TdsComputation | null = null;
    if (input.tdsCategory) {
      tds = await resolveAndComputeTds(c, {
        clientId: input.clientId, partyId: input.partyId, fiscalYearId,
        category: input.tdsCategory, entityType: input.entityType ?? 'company',
        paymentAmount: input.amount, paymentDate: input.paymentDate,
      });
    }

    const gross = paise(input.amount);
    const withheld = tds ? paise(tds.tdsAmount) : 0n;
    const net = gross - withheld;

    const number = (await c.query<{ n: string }>(
      "SELECT next_voucher_number($1, 'payment', $2) AS n",
      [input.clientId, fiscalYearId])).rows[0]!.n;

    const v = await c.query<{ id: string }>(
      `INSERT INTO vouchers
         (firm_id, client_id, voucher_type, voucher_number, posting_date,
          fiscal_year_id, narration, created_by, created_via)
       VALUES ($1,$2,'payment',$3,$4,$5,$6,$7,'ui') RETURNING id`,
      [
        firmId, input.clientId, number, input.paymentDate, fiscalYearId,
        tds && withheld > 0n
          ? `Payment to ${sup.rows[0]!.name}, TDS ${tds.code} withheld`
          : `Payment to ${sup.rows[0]!.name}`,
        input.createdBy,
      ]);
    const voucherId = v.rows[0]!.id;

    const tdsPayable = withheld > 0n
      ? (await c.query<{ id: string }>(
          `SELECT id FROM accounts WHERE client_id = $1
             AND account_type = 'tds_payable' AND NOT is_group LIMIT 1`,
          [input.clientId])).rows[0]?.id
      : undefined;

    if (withheld > 0n && !tdsPayable) {
      throw new ValidationError('TDS Payable account not in chart', 'PB-10');
    }

    const rows: Array<[string, bigint, bigint, string | null]> = [
      [sup.rows[0]!.ledger_account_id, gross, 0n, input.partyId],
    ];
    if (withheld > 0n) rows.push([tdsPayable!, 0n, withheld, null]);
    rows.push([input.bankAccountId, 0n, net, null]);

    for (const [i, [accountId, debit, credit, partyId]] of rows.entries()) {
      await c.query(
        `INSERT INTO ledger_entries
           (firm_id, client_id, voucher_id, line_no, posting_date, fiscal_year_id,
            account_id, debit, credit, party_type, party_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          firmId, input.clientId, voucherId, i + 1, input.paymentDate, fiscalYearId,
          accountId, money(debit), money(credit),
          partyId ? 'supplier' : null, partyId,
        ]);
    }

    if (tds && withheld > 0n) {
      await c.query(
        `INSERT INTO tds_deductions
           (firm_id, client_id, voucher_id, party_id, section_id, fiscal_year_id,
            payment_amount, cumulative_before, cumulative_after, taxable_base,
            rate, tds_already_deducted, tds_amount, threshold_crossed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          firmId, input.clientId, voucherId, input.partyId, tds.sectionId, fiscalYearId,
          input.amount, tds.cumulativeBefore, tds.cumulativeAfter, tds.taxableBase,
          tds.rate, tds.alreadyDeducted, tds.tdsAmount, tds.thresholdCrossed,
        ]);
    }

    return {
      voucherId, gross: money(gross), tds: money(withheld), net: money(net),
      tdsComputation: tds,
    };
  });
}
