/**
 * TDS — tax deducted at source, on the payer's side.
 * Spec: bills-and-expenses.md §7.2 (Lesson 6)
 *
 * The payer withholds a slice of what they owe and deposits it with the
 * government directly. It creates a liability for the payer (TDS Payable) and
 * an asset for the payee (TDS Receivable) — the same money seen from two
 * sides.
 *
 * Section numbers are DATA, never constants. The Income Tax Act 2025
 * renumbered the entire 194-series, so a voucher from before the change must
 * still explain itself under the numbering in force at the time.
 */

import type { PoolClient } from 'pg';
import { ValidationError } from './types.ts';
import { paise, money } from './tax.ts';

export type EntityType = 'individual' | 'company' | 'no_pan';

export interface TdsComputation {
  sectionId: string;
  code: string;
  rate: string;
  /** What the rate was applied to — the payment, or the whole cumulative. */
  taxableBase: string;
  cumulativeBefore: string;
  cumulativeAfter: string;
  alreadyDeducted: string;
  tdsAmount: string;
  /** True when this payment is the one that crossed the annual threshold. */
  thresholdCrossed: boolean;
  /** Human-readable derivation, for provenance PR-8. */
  explanation: string;
}

/**
 * Compute TDS for a payment, accounting for both thresholds.
 *
 * The trap this exists to handle (BE-10):
 *
 *   Threshold ₹30,000. Pay a vendor ₹28,000 — no TDS, below the line.
 *   Then pay ₹15,000. The naive answer is TDS on ₹15,000. The correct answer
 *   is TDS on the FULL ₹43,000, because crossing the cumulative threshold
 *   brings the whole year's payments into charge.
 *
 * Get this wrong and the client under-deducts, then owes interest and penalty.
 * It is invisible to anyone tracking payments one at a time, which is exactly
 * how it is done by hand.
 *
 * The general form that handles every case:
 *
 *   tds = (taxable_base × rate) − already_deducted_this_year
 *
 * where taxable_base is the cumulative total once the threshold is in play,
 * and the individual payment otherwise.
 */
export function computeTds(args: {
  sectionId: string;
  code: string;
  rate: string;                    // percent
  singleThreshold: string;
  cumulativeThreshold: string;
  deductOnFullCumulative: boolean;
  paymentAmount: string;
  /** Total already paid to this party under this section, this fiscal year. */
  cumulativeBefore: string;
  /** TDS already withheld from those earlier payments. */
  alreadyDeducted: string;
}): TdsComputation {
  const payment = paise(args.paymentAmount);
  const before = paise(args.cumulativeBefore);
  const after = before + payment;
  const single = paise(args.singleThreshold);
  const cumulative = paise(args.cumulativeThreshold);
  let already = paise(args.alreadyDeducted);
  const rateScaled = paise(args.rate);           // percent × 100

  const applyRate = (base: bigint): bigint => (base * rateScaled + 5000n) / 10000n;

  const nil = (why: string): TdsComputation => ({
    sectionId: args.sectionId, code: args.code, rate: args.rate,
    taxableBase: '0.00',
    cumulativeBefore: money(before), cumulativeAfter: money(after),
    alreadyDeducted: money(already), tdsAmount: '0.00',
    thresholdCrossed: false, explanation: why,
  });

  const wasAlreadyOver = cumulative > 0n && before >= cumulative;
  const crossesNow = cumulative > 0n && before < cumulative && after >= cumulative;
  const singleMet = single > 0n && payment >= single;

  let taxableBase: bigint;
  let explanation: string;

  // Once the cumulative threshold is in play — whether crossed by this payment
  // or by an earlier one — the base is always the running total, and what was
  // already withheld is subtracted. Using the individual payment as the base
  // *and* subtracting prior deductions double-counts and can drive the result
  // negative.
  if ((crossesNow || wasAlreadyOver) && args.deductOnFullCumulative) {
    taxableBase = after;
    explanation = crossesNow
      ? `cumulative ${money(before)} + ${money(payment)} = ${money(after)} crosses the ` +
        `${money(cumulative)} annual threshold, so ${args.rate}% applies to the full ` +
        `cumulative amount, not only to this payment`
      : `annual threshold ${money(cumulative)} already crossed; ${args.rate}% applies to ` +
        `the running total ${money(after)}, less tax already withheld`;
  } else if (singleMet) {
    // Only the per-transaction threshold is engaged, so earlier payments are
    // unrelated and prior deductions must NOT be netted off here.
    taxableBase = payment;
    already = 0n;
    explanation =
      `payment ${money(payment)} meets the per-transaction threshold ` +
      `${money(single)}; ${args.rate}% applies to it`;
  } else if (crossesNow) {
    // Section configured to charge only the excess over the threshold.
    taxableBase = after - cumulative;
    explanation =
      `threshold crossed; this section charges only the excess ` +
      `${money(after)} − ${money(cumulative)} = ${money(taxableBase)}`;
  } else {
    return nil(
      `no TDS: cumulative ${money(after)} is below the ${money(cumulative)} annual ` +
      `threshold and the payment is below the ${money(single)} per-transaction threshold`);
  }

  // Subtracting what was already withheld is what makes the crossing payment
  // correct without double-charging earlier ones.
  const gross = applyRate(taxableBase);
  const tds = gross - already;

  return {
    sectionId: args.sectionId,
    code: args.code,
    rate: args.rate,
    taxableBase: money(taxableBase),
    cumulativeBefore: money(before),
    cumulativeAfter: money(after),
    alreadyDeducted: money(already),
    tdsAmount: money(tds > 0n ? tds : 0n),
    thresholdCrossed: crossesNow,
    explanation:
      `${explanation}. ${money(taxableBase)} × ${args.rate}% = ${money(gross)}` +
      (already > 0n ? `, less ${money(already)} already deducted = ${money(tds)}` : ''),
  };
}

/** Running totals for a party under one section, within a fiscal year. */
export async function cumulativeForParty(
  c: PoolClient, clientId: string, partyId: string,
  sectionCategory: string, fiscalYearId: string,
): Promise<{ paid: string; deducted: string }> {
  const r = await c.query<{ paid: string; deducted: string }>(
    `SELECT COALESCE(SUM(d.payment_amount), 0)::text AS paid,
            COALESCE(SUM(d.tds_amount), 0)::text     AS deducted
     FROM tds_deductions d
     JOIN tds_sections s ON s.id = d.section_id
     WHERE d.client_id = $1 AND d.party_id = $2
       AND s.category_name = $3 AND d.fiscal_year_id = $4`,
    [clientId, partyId, sectionCategory, fiscalYearId]);
  return r.rows[0]!;
}

/**
 * Resolve the section applicable to a payment, then compute the deduction.
 *
 * `entityType` matters: rates differ between individuals and companies, and a
 * payee with no valid PAN attracts a punitive higher rate.
 */
export async function resolveAndComputeTds(
  c: PoolClient,
  args: {
    clientId: string; partyId: string; fiscalYearId: string;
    category: string; entityType: EntityType;
    paymentAmount: string; paymentDate: string;
  },
): Promise<TdsComputation | null> {
  const s = await c.query(
    'SELECT * FROM resolve_tds_section($1, $2, $3)',
    [args.category, args.entityType, args.paymentDate]);

  if (s.rowCount === 0) return null;   // category not subject to TDS
  const sec = s.rows[0]!;

  const { paid, deducted } = await cumulativeForParty(
    c, args.clientId, args.partyId, args.category, args.fiscalYearId);

  return computeTds({
    sectionId: sec.section_id,
    code: sec.code,
    rate: sec.rate,
    singleThreshold: sec.single_threshold,
    cumulativeThreshold: sec.cumulative_threshold,
    deductOnFullCumulative: sec.deduct_on_full_cumulative,
    paymentAmount: args.paymentAmount,
    cumulativeBefore: paid,
    alreadyDeducted: deducted,
  });
}

/** Guard against a caller passing an unknown entity type. */
export function assertEntityType(v: string): EntityType {
  if (v !== 'individual' && v !== 'company' && v !== 'no_pan') {
    throw new ValidationError(`unknown TDS entity type "${v}"`, 'PB-10');
  }
  return v;
}
