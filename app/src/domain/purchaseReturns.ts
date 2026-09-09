/**
 * Returning goods to a supplier — the debit note.
 * Spec: bills-and-expenses.md BE-38
 *
 * Short delivery, damaged stock, a rate corrected after the invoice was cut.
 * Every real payables ledger has to reduce a bill that is already posted, and
 * there was no way to say it. The two things people reach for instead are both
 * wrong: deleting the bill destroys the audit trail and the GSTR-2B match, and
 * a manual journal moves the money without touching the tax or the ageing.
 *
 * ── The GST asymmetry, which is the whole difficulty ──────────────────────
 *
 * Under s.34 a CREDIT NOTE is the SUPPLIER's instrument. Only they can issue
 * one, and only theirs reduces their output liability. What the recipient
 * issues is a debit note, and it is a book document — it records that we are
 * paying less and entitles nobody to a tax adjustment.
 *
 * What the law asks of the recipient is the mirror duty: reverse the input
 * credit taken on the returned portion. So a return here does two separable
 * things, and says so:
 *
 *   - it reduces what we owe and reverses our credit, immediately, because
 *     that is our own obligation and does not wait on anyone;
 *   - it leaves the supplier's credit note OUTSTANDING, because until that
 *     arrives and shows in GSTR-2B the tax side has no support in the GST
 *     system and the supplier is still declaring the full invoice.
 *
 * ── The reversal follows the ORIGINAL line, not today's rules ─────────────
 *
 * A line whose credit was blocked had its GST capitalised into the expense, so
 * returning it takes the whole GST back out of the expense. An eligible line's
 * GST comes off the input credit instead. And the tax reversed is a slice of
 * what was actually POSTED — which on a purchase bill is the vendor's own
 * figure, not our recomputation of it (PB-4). Recomputing from the rate master
 * would reverse a different number from the one that went in.
 */

import { withFirm } from '../db/pool.ts';
import { postVoucher } from './posting.ts';
import { money, paise } from './tax.ts';
import { ValidationError } from './types.ts';
import type { ItcEligibility } from './itc.ts';

export interface ReturnLineInput {
  /** Which line of the original bill this returns. */
  billLineNo: number;
  /** The taxable value coming back — part of a line, or all of it. */
  taxableValue: string;
}

export interface CreatePurchaseReturnInput {
  clientId: string;
  billVoucherId: string;
  /** Our own debit note number. */
  noteNumber: string;
  noteDate: string;
  /** Why the goods went back. A return with no reason is the one an auditor asks about. */
  reason: string;
  lines: ReturnLineInput[];
  createdBy: string;
  approvedBy?: string;
  /** The supplier's credit note, if it has already arrived. */
  supplierCreditNote?: { number: string; date: string };
}

export interface CreatedPurchaseReturn {
  voucherId: string;
  noteNumber: string;
  taxableValue: string;
  totalGst: string;
  grandTotal: string;
  /** True while the supplier's own credit note is still outstanding. */
  awaitingSupplierCreditNote: boolean;
  warnings: string[];
  lines: Array<{ billLineNo: number; description: string; taxableValue: string;
                 gst: string; itc: ItcEligibility }>;
}

interface BillLine {
  line_no: number; description: string; hsn_sac: string | null;
  taxable_value: string; gst_rate: string;
  cgst_amount: string; sgst_amount: string; igst_amount: string;
  cess_amount: string; expense_account_id: string;
  itc_eligibility: ItcEligibility;
}

/** Proportional share of `part` of `whole`, rounded half up. */
const share = (amount: bigint, part: bigint, whole: bigint): bigint =>
  whole === 0n ? 0n : (amount * part * 2n + whole) / (whole * 2n);

/**
 * Posts a return against a bill.
 *
 *   Creditors           Dr  the whole credit note
 *       Expense head        Cr  taxable (plus GST, on a blocked line)
 *       Input CGST/SGST/IGST Cr  the credit being given back
 *
 * The Creditors debit points at the bill through `settlesVoucherId`, so the
 * ageing shows the bill as owing less without any status being maintained by
 * hand — the same mechanism a payment uses, because a return settles part of
 * what was owed just as a payment does.
 */
export async function createPurchaseReturn(
  firmId: string, input: CreatePurchaseReturnInput,
): Promise<CreatedPurchaseReturn> {
  if (input.lines.length === 0) {
    throw new ValidationError('a return has to name what is going back', 'PR-1');
  }
  if (input.reason.trim() === '') {
    throw new ValidationError(
      'say why the goods went back. A return with no reason is the one an ' +
      'auditor asks about, and by then nobody remembers.', 'PR-1');
  }

  const warnings: string[] = [];

  return withFirm(firmId, async (c) => {
    const b = await c.query<{
      party_id: string; bill_number: string; bill_date: string;
      is_reverse_charge: boolean; grand_total: string;
      creditor_account_id: string; supplier: string;
    }>(
      `SELECT pb.party_id, pb.bill_number, to_char(pb.bill_date,'YYYY-MM-DD') AS bill_date,
              pb.is_reverse_charge, pb.grand_total::text,
              p.ledger_account_id AS creditor_account_id, p.name AS supplier
         FROM purchase_bills pb JOIN parties p ON p.id = pb.party_id
        WHERE pb.voucher_id = $1 AND pb.client_id = $2`,
      [input.billVoucherId, input.clientId]);
    if (b.rowCount === 0) {
      throw new ValidationError(
        'no such bill for this client. A return has to point at the bill it ' +
        'reduces — a floating credit is one nobody can reconcile.', 'PR-1');
    }
    const bill = b.rows[0]!;

    if (input.noteDate < bill.bill_date) {
      throw new ValidationError(
        `this return is dated ${input.noteDate}, before the bill it returns ` +
        `(${bill.bill_date}). Goods cannot go back before they arrived.`, 'PR-2');
    }

    const items = await c.query<BillLine>(
      `SELECT line_no, description, hsn_sac, taxable_value::text, gst_rate::text,
              cgst_amount::text, sgst_amount::text, igst_amount::text,
              cess_amount::text, expense_account_id, itc_eligibility
         FROM purchase_bill_items WHERE voucher_id = $1 ORDER BY line_no`,
      [input.billVoucherId]);
    const byLine = new Map(items.rows.map((r) => [r.line_no, r]));

    /*
     * What has already gone back on each line.
     *
     * Cumulative, across every earlier return. Two returns of 60% each would
     * otherwise each look reasonable on its own and together credit us for
     * 120% of a line — which reverses input credit we never took and leaves
     * the supplier owing us money the bill never supported.
     */
    const prior = await c.query<{ line: number; value: string; cgst: string;
                                 sgst: string; igst: string; cess: string }>(
      `SELECT i.bill_line_no AS line,
              SUM(i.taxable_value)::text AS value,
              SUM(i.cgst_amount)::text AS cgst, SUM(i.sgst_amount)::text AS sgst,
              SUM(i.igst_amount)::text AS igst, SUM(i.cess_amount)::text AS cess
         FROM purchase_return_items i
         JOIN purchase_returns r ON r.voucher_id = i.voucher_id
        WHERE r.bill_voucher_id = $1 GROUP BY 1`,
      [input.billVoucherId]);
    const returned = new Map(prior.rows.map((r) => [r.line, r]));

    const out: Array<BillLine & {
      returnTaxable: bigint; cgst: bigint; sgst: bigint; igst: bigint; cess: bigint;
    }> = [];

    for (const l of input.lines) {
      const orig = byLine.get(l.billLineNo);
      if (orig === undefined) {
        throw new ValidationError(
          `bill ${bill.bill_number} has no line ${l.billLineNo}`, 'PR-1');
      }
      const want = paise(l.taxableValue);
      if (want <= 0n) {
        throw new ValidationError(
          `line ${l.billLineNo}: a return has to be for more than nothing`, 'PR-1');
      }

      const already = returned.get(l.billLineNo);
      const origValue = paise(orig.taxable_value);
      const goneBack = already ? paise(already.value) : 0n;
      const remaining = origValue - goneBack;

      if (want > remaining) {
        throw new ValidationError(
          `line ${l.billLineNo} of bill ${bill.bill_number} is ` +
          `${money(origValue)}` +
          (goneBack > 0n ? `, of which ${money(goneBack)} has already gone back` : '') +
          `, so ${money(want)} cannot be returned — ${money(remaining)} is left. ` +
          'Returning more than was bought would reverse credit that was never ' +
          'taken.', 'PR-3');
      }

      /*
       * The tax reversed is a slice of what was POSTED, and the LAST slice
       * takes whatever is left rather than its own share.
       *
       * Prorating every time leaves a paisa stranded on a line returned in
       * three parts: the shares round to slightly less than the whole, and the
       * input credit account keeps a balance for a line that no longer exists.
       * Giving the final return the remainder makes a fully-returned line
       * reverse exactly what went in.
       */
      const isFinal = want === remaining;
      const slice = (posted: string, priorSum: string | undefined): bigint => {
        const total = paise(posted);
        const done = priorSum === undefined ? 0n : paise(priorSum);
        return isFinal ? total - done : share(total, want, origValue);
      };

      out.push({
        ...orig,
        returnTaxable: want,
        cgst: slice(orig.cgst_amount, already?.cgst),
        sgst: slice(orig.sgst_amount, already?.sgst),
        igst: slice(orig.igst_amount, already?.igst),
        cess: slice(orig.cess_amount, already?.cess),
      });
    }

    const taxable = out.reduce((s, l) => s + l.returnTaxable, 0n);
    const tax = out.reduce((s, l) => s + l.cgst + l.sgst + l.igst + l.cess, 0n);
    const grandTotal = taxable + tax;

    // --- the entry -----------------------------------------------------------
    const taxAccount = async (name: string) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM accounts WHERE client_id = $1 AND name = $2
           AND NOT is_group LIMIT 1`, [input.clientId, name]);
      if (r.rowCount === 0) {
        throw new ValidationError(`account "${name}" not in chart`, 'PR-1');
      }
      return r.rows[0]!.id;
    };

    const lines: Array<{ accountId: string; debit?: string; credit?: string;
                         partyType?: 'supplier'; partyId?: string;
                         settlesVoucherId?: string }> = [
      {
        accountId: bill.creditor_account_id, debit: money(grandTotal),
        partyType: 'supplier', partyId: bill.party_id,
        // Points at the bill, so the ageing shows it owing less. The same
        // mechanism a payment uses: a return settles part of what was owed.
        settlesVoucherId: input.billVoucherId,
      },
    ];

    let reverseCgst = 0n, reverseSgst = 0n, reverseIgst = 0n;
    for (const l of out) {
      const lineTax = l.cgst + l.sgst + l.igst + l.cess;
      if (l.itc_eligibility === 'eligible') {
        lines.push({ accountId: l.expense_account_id, credit: money(l.returnTaxable) });
        reverseCgst += l.cgst; reverseSgst += l.sgst; reverseIgst += l.igst;
      } else {
        // Blocked: the GST went INTO the expense on the way in, so it comes
        // out of the expense on the way back. Reversing it against input
        // credit instead would credit an account that never received it.
        lines.push({
          accountId: l.expense_account_id,
          credit: money(l.returnTaxable + lineTax),
        });
      }
    }
    if (reverseCgst > 0n) {
      lines.push({ accountId: await taxAccount('Input CGST Credit'), credit: money(reverseCgst) });
      lines.push({ accountId: await taxAccount('Input SGST Credit'), credit: money(reverseSgst) });
    }
    if (reverseIgst > 0n) {
      lines.push({ accountId: await taxAccount('Input IGST Credit'), credit: money(reverseIgst) });
    }

    /*
     * A reverse-charge bill raised the liability AND the credit, so a return
     * has to unwind both. Reversing only the credit would leave the client
     * owing output tax on a supply they sent back.
     */
    if (bill.is_reverse_charge) {
      if (reverseCgst > 0n) {
        lines.push({ accountId: await taxAccount('Output CGST Payable'), debit: money(reverseCgst) });
        lines.push({ accountId: await taxAccount('Output SGST Payable'), debit: money(reverseSgst) });
      }
      if (reverseIgst > 0n) {
        lines.push({ accountId: await taxAccount('Output IGST Payable'), debit: money(reverseIgst) });
      }
      warnings.push(
        'this bill was taxed under reverse charge, so the return unwinds both ' +
        'sides: the liability the client owed on it and the credit they took. ' +
        'The self-invoice raised under s.31(3)(f) needs a matching credit ' +
        'note of the client\'s own.');
    }

    const posted = await postVoucher(firmId, {
      clientId: input.clientId,
      voucherType: 'debit_note',
      postingDate: input.noteDate,
      narration:
        `Debit note ${input.noteNumber} against bill ${bill.bill_number} — ` +
        input.reason.trim(),
      createdBy: input.createdBy,
      ...(input.approvedBy === undefined ? {} : { approvedBy: input.approvedBy }),
      createdVia: 'ui',
      lines,
    });

    await c.query(
      `INSERT INTO purchase_returns
         (voucher_id, firm_id, client_id, bill_voucher_id, party_id, note_number,
          note_date, reason, taxable_value, total_cgst, total_sgst, total_igst,
          total_cess, grand_total, supplier_credit_note, supplier_credit_note_date,
          created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [posted.id, firmId, input.clientId, input.billVoucherId, bill.party_id,
       input.noteNumber, input.noteDate, input.reason.trim(),
       money(taxable),
       money(out.reduce((s, l) => s + l.cgst, 0n)),
       money(out.reduce((s, l) => s + l.sgst, 0n)),
       money(out.reduce((s, l) => s + l.igst, 0n)),
       money(out.reduce((s, l) => s + l.cess, 0n)),
       money(grandTotal),
       input.supplierCreditNote?.number ?? null,
       input.supplierCreditNote?.date ?? null,
       input.createdBy]);

    for (const l of out) {
      await c.query(
        `INSERT INTO purchase_return_items
           (voucher_id, bill_line_no, description, hsn_sac, taxable_value,
            gst_rate, cgst_amount, sgst_amount, igst_amount, cess_amount,
            expense_account_id, itc_eligibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [posted.id, l.line_no, l.description, l.hsn_sac, money(l.returnTaxable),
         l.gst_rate, money(l.cgst), money(l.sgst), money(l.igst), money(l.cess),
         l.expense_account_id, l.itc_eligibility]);
    }

    // --- what the reviewer has to know --------------------------------------
    if (input.supplierCreditNote === undefined) {
      warnings.push(
        `the tax on this return is not settled yet. Under s.34 only ` +
        `${bill.supplier} can issue a credit note, and only theirs reduces ` +
        'their output liability — this debit note records that we are paying ' +
        'less. Until their credit note arrives and appears in GSTR-2B, they ' +
        'are still declaring the full invoice and this reversal has no support ' +
        'in the GST system. Ask them for it.');
    }

    /*
     * TDS. The deduction was computed on an amount that has just shrunk.
     *
     * Not adjusted automatically, and deliberately: the challan may already be
     * deposited, and undoing a deposited deduction is a correction statement
     * filed with the department, not a ledger entry. What this can do is make
     * sure nobody discovers it in July.
     */
    const tds = await c.query<{ amount: string; code: string; deposited: boolean }>(
      `SELECT d.tds_amount::text AS amount, s.code,
              EXISTS (SELECT 1 FROM tds_challans ch
                       WHERE ch.client_id = d.client_id
                         AND ch.period = to_char($2::date, 'YYYY-MM')) AS deposited
         FROM tds_deductions d JOIN tds_sections s ON s.id = d.section_id
        WHERE d.bill_voucher_id = $1 AND d.tds_amount > 0`,
      [input.billVoucherId, bill.bill_date]);
    const deduction = tds.rows[0];
    if (deduction !== undefined) {
      const excess = share(paise(deduction.amount), taxable, paise(bill.grand_total));
      warnings.push(
        `TDS of ${deduction.amount} was withheld under ${deduction.code} when ` +
        `this bill was booked. The amount credited to ${bill.supplier} has now ` +
        `been reduced, so roughly ${money(excess)} of that deduction sits on a ` +
        'sum no longer payable. Nothing has been adjusted here: ' +
        (deduction.deposited
          ? 'the challan for that month is already deposited, so the excess is ' +
            'set right against the next deduction for this supplier or claimed ' +
            'in their return — not by a ledger entry.'
          : 'if the challan is not yet paid, deposit the corrected figure and ' +
            'record it against the month of deduction.'));
    }

    /*
     * A return against a bill that is already paid leaves the supplier owing
     * US money — the Creditors debit turns their balance into an asset. That
     * is legitimate and it is not what the ageing was built to show, so it is
     * said out loud rather than left to be noticed.
     */
    const settled = await c.query<{ outstanding: string }>(
      `SELECT (COALESCE((SELECT SUM(le.credit - le.debit)
                           FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
                          WHERE le.voucher_id = $1 AND a.account_type = 'payable'), 0)
               - COALESCE((SELECT SUM(s.debit - s.credit) FROM ledger_entries s
                            WHERE s.settles_voucher_id = $1), 0))::text AS outstanding`,
      [input.billVoucherId]);
    const left = paise(settled.rows[0]!.outstanding);
    if (left < 0n) {
      warnings.push(
        `bill ${bill.bill_number} had already been paid, so this return leaves ` +
        `${bill.supplier} owing the client ${money(-left)}. It will show as a ` +
        'debit on their account rather than in the ageing — set it against ' +
        'their next bill, or ask for a refund.');
    }

    return {
      voucherId: posted.id,
      noteNumber: input.noteNumber,
      taxableValue: money(taxable),
      totalGst: money(tax),
      grandTotal: money(grandTotal),
      awaitingSupplierCreditNote: input.supplierCreditNote === undefined,
      warnings,
      lines: out.map((l) => ({
        billLineNo: l.line_no, description: l.description,
        taxableValue: money(l.returnTaxable),
        gst: money(l.cgst + l.sgst + l.igst + l.cess),
        itc: l.itc_eligibility,
      })),
    };
  });
}

/**
 * Records the supplier's credit note against a return.
 *
 * The moment the tax side of the return becomes supportable. Kept separate
 * from creating the return because the goods go back first and the paperwork
 * follows — pretending otherwise would either delay the book entry until the
 * supplier gets round to it, or claim support that does not exist.
 */
export async function recordSupplierCreditNote(
  firmId: string,
  input: { clientId: string; returnVoucherId: string; number: string; date: string },
): Promise<void> {
  await withFirm(firmId, async (c) => {
    const r = await c.query(
      `UPDATE purchase_returns
          SET supplier_credit_note = $3, supplier_credit_note_date = $4
        WHERE voucher_id = $1 AND client_id = $2
          AND supplier_credit_note IS NULL`,
      [input.returnVoucherId, input.clientId, input.number.trim(), input.date]);
    if (r.rowCount === 0) {
      throw new ValidationError(
        'no such return for this client, or its credit note is already ' +
        'recorded. A second credit note against one return would mean the ' +
        'supplier credited us twice, which is a new return, not an edit.',
        'PR-4');
    }
  });
}

/** A bill with what is still returnable on each line. */
export interface BillForReturn {
  voucherId: string;
  billNumber: string;
  billDate: string;
  supplier: string;
  grandTotal: string;
  lines: Array<{
    lineNo: number; description: string; hsnSac: string | null;
    taxableValue: string; returned: string; remaining: string;
    gstRate: string; itc: ItcEligibility;
  }>;
}

/**
 * The bill a reviewer is about to return against, line by line.
 *
 * `remaining` is what the form offers, and it is the original less everything
 * already sent back — so a line returned once cannot be returned again in
 * full by someone who did not know about the first note.
 */
export async function billForReturn(
  firmId: string, clientId: string, billVoucherId: string,
): Promise<BillForReturn | null> {
  return withFirm(firmId, async (c) => {
    const h = await c.query<{
      bill_number: string; bill_date: string; supplier: string; grand_total: string;
    }>(
      `SELECT pb.bill_number, to_char(pb.bill_date,'YYYY-MM-DD') AS bill_date,
              p.name AS supplier, pb.grand_total::text
         FROM purchase_bills pb JOIN parties p ON p.id = pb.party_id
        WHERE pb.voucher_id = $1 AND pb.client_id = $2`,
      [billVoucherId, clientId]);
    if (h.rowCount === 0) return null;

    const l = await c.query<{
      line_no: number; description: string; hsn_sac: string | null;
      taxable_value: string; gst_rate: string; itc_eligibility: ItcEligibility;
      returned: string;
    }>(
      `SELECT i.line_no, i.description, i.hsn_sac, i.taxable_value::text,
              i.gst_rate::text, i.itc_eligibility,
              COALESCE((SELECT SUM(ri.taxable_value)
                          FROM purchase_return_items ri
                          JOIN purchase_returns r ON r.voucher_id = ri.voucher_id
                         WHERE r.bill_voucher_id = $1
                           AND ri.bill_line_no = i.line_no), 0)::text AS returned
         FROM purchase_bill_items i
        WHERE i.voucher_id = $1 ORDER BY i.line_no`,
      [billVoucherId]);

    return {
      voucherId: billVoucherId,
      billNumber: h.rows[0]!.bill_number,
      billDate: h.rows[0]!.bill_date,
      supplier: h.rows[0]!.supplier,
      grandTotal: h.rows[0]!.grand_total,
      lines: l.rows.map((x) => ({
        lineNo: x.line_no, description: x.description, hsnSac: x.hsn_sac,
        taxableValue: x.taxable_value, returned: x.returned,
        remaining: money(paise(x.taxable_value) - paise(x.returned)),
        gstRate: x.gst_rate, itc: x.itc_eligibility,
      })),
    };
  });
}

/** A return, for a list. */
export interface PurchaseReturnRow {
  voucherId: string;
  noteNumber: string;
  noteDate: string;
  billNumber: string;
  supplier: string;
  reason: string;
  taxableValue: string;
  grandTotal: string;
  supplierCreditNote: string | null;
}

/** Every return for a client, most recent first. */
export async function purchaseReturns(
  firmId: string, clientId: string,
): Promise<PurchaseReturnRow[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{
      voucher_id: string; note_number: string; note_date: string;
      bill_number: string; supplier: string; reason: string;
      taxable_value: string; grand_total: string;
      supplier_credit_note: string | null;
    }>(
      `SELECT pr.voucher_id, pr.note_number, to_char(pr.note_date,'YYYY-MM-DD') AS note_date,
              pb.bill_number, p.name AS supplier, pr.reason,
              pr.taxable_value::text, pr.grand_total::text, pr.supplier_credit_note
         FROM purchase_returns pr
         JOIN purchase_bills pb ON pb.voucher_id = pr.bill_voucher_id
         JOIN parties p ON p.id = pr.party_id
        WHERE pr.client_id = $1
        ORDER BY pr.note_date DESC, pr.created_at DESC`,
      [clientId]);
    return r.rows.map((x) => ({
      voucherId: x.voucher_id, noteNumber: x.note_number, noteDate: x.note_date,
      billNumber: x.bill_number, supplier: x.supplier, reason: x.reason,
      taxableValue: x.taxable_value, grandTotal: x.grand_total,
      supplierCreditNote: x.supplier_credit_note,
    }));
  });
}
