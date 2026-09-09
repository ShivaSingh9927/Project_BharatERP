/**
 * TDS on a purchase bill — at the point of CREDIT.
 * Spec: bills-and-expenses.md BE-36
 *
 * The engine could already compute a deduction (`tds.ts`) and withhold one on
 * a direct payment (`paySupplier`). What it could not do was notice that a
 * bill attracted TDS at all. So a ₹2,00,000 professional-fees bill posted in
 * full, was paid in full, and nothing anywhere mentioned the ₹20,000 the
 * client was required to deduct — the kind of silence that costs interest
 * under s.201(1A) and is discovered by a notice.
 *
 * ── Why the bill, and not the payment ─────────────────────────────────────
 *
 * Every section in our master charges the deduction "at the time of credit of
 * such sum to the account of the payee or at the time of payment, whichever is
 * EARLIER". Booking the bill is that credit. For a March bill paid in May,
 * deducting at payment is not merely late bookkeeping: the deduction was due in
 * March, the deposit was due in April, and the liability lands in Q4 rather
 * than Q1 of the next year.
 *
 * So the bill is the primary limb and `paySupplier` keeps the other, for the
 * advance that is paid before any bill exists. `deducted_on` records which,
 * and a unique index makes a bill deducted on credit impossible to deduct
 * again on payment.
 *
 * ── What this module will NOT decide ──────────────────────────────────────
 *
 * It proposes; a human confirms. The section follows from how the spend was
 * classified, and classification is the reviewer's own act — professional fees
 * at 10% and a contractor at 1% are the same rupees to a parser and a
 * ten-fold difference to the client. So a computed deduction becomes a
 * question, never a posting.
 */

import type { PoolClient } from 'pg';
import { resolveAndComputeTds, type EntityType, type TdsComputation }
  from './tds.ts';
import { money, paise } from './tax.ts';

/**
 * Categories this module will never propose on its own.
 *
 * s.194Q — TDS on the purchase of goods — applies only where OUR CLIENT's
 * turnover in the preceding year exceeded ₹10 crore. That is a fact about the
 * client, we do not hold it, and almost no client of the size this product
 * serves crosses it. Proposing it would put a deduction on every goods
 * purchase a kirana shop makes.
 *
 * The category stays in the master and stays usable by a caller who knows the
 * turnover test is met. What is refused is GUESSING it.
 */
const NEEDS_TURNOVER_TEST = new Set(['Purchase of Goods']);

/**
 * The payee's type, from the fourth character of their PAN.
 *
 * PAN encodes the holder's constitution in that position, and TDS rates split
 * on it: a contractor's bill is 1% for an individual or HUF and 2% for anyone
 * else. Reading it beats asking, because it is on the document the client
 * already has.
 *
 * No PAN means `no_pan`, which carries the punitive rate — and that is the
 * law (s.206AA), not a penalty this software invented for missing data. It is
 * also the safe direction: over-deducting is recoverable by the payee in their
 * return, while under-deducting is the client's own liability plus interest.
 */
export function entityTypeFromPan(pan: string | null | undefined): EntityType {
  if (!pan) return 'no_pan';
  const p = pan.trim().toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p)) return 'no_pan';
  // P is an individual; H is a Hindu Undivided Family, which the rate tables
  // group WITH individuals. Everything else — company, firm, LLP, AOP, trust,
  // local authority — takes the "other than individual/HUF" rate.
  return p[3] === 'P' || p[3] === 'H' ? 'individual' : 'company';
}

/** Why a bill's TDS could not be settled without asking. */
export interface TdsAssessment {
  category: string;
  entityType: EntityType;
  /** Null when the section resolves to no deduction on these figures. */
  computation: TdsComputation | null;
  /** The base the rate was offered on — taxable value, excluding GST. */
  base: string;
  /** Put to the reviewer, with the whole derivation shown. */
  question: string;
  /** The bill's own share of that base, for a bill spanning several heads. */
  mixedHeads: string[];
}

/**
 * Would this bill attract TDS, and how much?
 *
 * Returns null when nothing on it does — which is the common case and must
 * stay silent, or the feature becomes a prompt on every grocery bill.
 *
 * ── The base is the taxable value, not the total ──────────────────────────
 *
 * TDS is deducted on the amount excluding GST wherever the GST is shown
 * separately on the invoice (CBDT Circular 23/2017). Deducting on the grand
 * total over-deducts by the rate times the tax — on ₹1,00,000 + 18% at 10%
 * that is ₹1,800 of the client's money withheld from a supplier who is owed
 * it, every bill, invisibly.
 */
export async function assessTdsOnBill(
  c: PoolClient,
  args: {
    clientId: string; partyId: string; fiscalYearId: string;
    billDate: string;
    /** Per line: the account it posts to and its taxable value. */
    lines: Array<{ expenseAccountId: string; taxableValue: string }>;
  },
): Promise<TdsAssessment | null> {
  const ids = [...new Set(args.lines.map((l) => l.expenseAccountId))];
  const acc = await c.query<{ id: string; name: string; tds_category: string | null }>(
    `SELECT id, name, tds_category FROM accounts
      WHERE client_id = $1 AND id = ANY($2::uuid[])`,
    [args.clientId, ids]);
  const categoryOf = new Map(acc.rows.map((r) => [r.id, r.tds_category]));

  /*
   * The base: only the lines whose own head attracts TDS.
   *
   * A bill mixing professional fees with reimbursed travel is real and common,
   * and deducting on the whole of it would withhold tax on a reimbursement
   * that bears none.
   */
  const byCategory = new Map<string, bigint>();
  for (const l of args.lines) {
    const cat = categoryOf.get(l.expenseAccountId) ?? null;
    if (cat === null) continue;
    byCategory.set(cat, (byCategory.get(cat) ?? 0n) + paise(l.taxableValue));
  }
  if (byCategory.size === 0) return null;

  const gated = [...byCategory.keys()].filter((k) => NEEDS_TURNOVER_TEST.has(k));
  for (const g of gated) byCategory.delete(g);

  if (byCategory.size === 0) {
    // Everything on this bill was a turnover-gated category. Say so rather
    // than returning silence, because silence here looks like "no TDS due".
    return {
      category: gated[0]!, entityType: 'company', computation: null,
      base: '0.00', mixedHeads: gated,
      question:
        `This bill is for ${gated.join(' and ')}, which attracts TDS under ` +
        's.194Q only if your client\'s turnover in the preceding year exceeded ' +
        '₹10 crore. This software does not hold that figure, so it has ' +
        'deducted nothing. If the turnover test is met, the deduction has to ' +
        'be made by hand.',
    };
  }

  /*
   * More than one TDS head on one bill is not deducted automatically.
   *
   * Each would resolve its own section, its own rate and its own running
   * threshold, and a single bill producing two deductions is a shape nothing
   * downstream — certificate, return, challan — is built for yet. Raised for a
   * human, who can split the bill.
   */
  if (byCategory.size > 1) {
    const heads = [...byCategory.keys()].sort();
    return {
      category: heads[0]!, entityType: 'company', computation: null,
      base: money([...byCategory.values()].reduce((a, b) => a + b, 0n)),
      mixedHeads: heads,
      question:
        `This bill covers ${heads.join(' and ')}, which are deducted under ` +
        'different TDS sections at different rates. One bill cannot carry two ' +
        'deductions here, so nothing has been withheld — split it into one ' +
        'bill per head, or deduct by hand.',
    };
  }

  const [category, base] = [...byCategory.entries()][0]!;
  const pan = await c.query<{ pan: string | null; gstin: string | null; name: string }>(
    'SELECT pan, gstin, name FROM parties WHERE id = $1 AND client_id = $2',
    [args.partyId, args.clientId]);
  const party = pan.rows[0];
  /*
   * The PAN column, or the one inside the GSTIN.
   *
   * A GSTIN is <state><PAN><entity><Z><check> by construction, so a registered
   * supplier's PAN is already on file whether or not anybody typed it into its
   * own column. Without this, a supplier with a perfectly good GSTIN and an
   * empty `pan` field would take the s.206AA punitive rate — 20% instead of
   * 10% — on every bill, which is the client's own money withheld from a
   * vendor who is owed it.
   */
  const panOnFile = party?.pan ?? party?.gstin?.slice(2, 12) ?? null;
  const entityType = entityTypeFromPan(panOnFile);

  const computation = await resolveAndComputeTds(c, {
    clientId: args.clientId, partyId: args.partyId,
    fiscalYearId: args.fiscalYearId, category, entityType,
    paymentAmount: money(base), paymentDate: args.billDate,
  });

  if (computation === null) {
    // The category is on the account but no section covers it on this date.
    return null;
  }

  const withheld = paise(computation.tdsAmount);
  const noPan = entityType === 'no_pan';

  const question = withheld > 0n
    ? `TDS of ${computation.tdsAmount} is deductible on this bill — ` +
      `${category}, ${computation.code}, at ${computation.rate}%` +
      (noPan
        ? ` (the punitive rate: no valid PAN is on file for ` +
          `${party?.name ?? 'this supplier'} — not in their record and not ` +
          'inside a GSTIN — and s.206AA requires it. Getting their PAN brings ' +
          'this down)'
        : '') +
      `. ${computation.explanation}. The base is the taxable value ` +
      `${money(base)}, excluding GST, per Circular 23/2017.` +
      (computation.thresholdCrossed
        ? ' THIS bill is the one that crosses the annual threshold, so the ' +
          'deduction falls on the whole year\'s credits and not only on this ' +
          'amount.'
        : '') +
      ' Deducting it credits the supplier net and raises TDS Payable. ' +
      'Confirm the classification is right, or post without deducting.'
    : `No TDS is deductible on this bill: ${computation.explanation}. ` +
      `Recorded so the running total for ${category} stays right — the ` +
      'payment that crosses the threshold has to deduct on everything ' +
      'credited before it.';

  return { category, entityType, computation, base: money(base), question,
           mixedHeads: [] };
}

/**
 * Writes the deduction against the bill that made it.
 *
 * The unique index on `bill_voucher_id` is what makes double deduction
 * impossible rather than merely unlikely: a bill deducted on credit cannot be
 * deducted again when it is paid, whatever the payment path does.
 */
export async function recordTdsDeduction(
  c: PoolClient,
  a: {
    firmId: string; clientId: string; voucherId: string;
    billVoucherId: string | null; partyId: string; fiscalYearId: string;
    deductedOn: 'credit' | 'payment';
    computation: TdsComputation;
    /**
     * What was actually withheld, when a reviewer declined the deduction the
     * section required. Defaults to the computed figure.
     *
     * The row is written either way. A declined deduction that left no row
     * would make the bill indistinguishable from one attracting no TDS, and
     * the shortfall would be discovered by a notice rather than by us.
     */
    withheld?: string;
  },
): Promise<void> {
  await c.query(
    `INSERT INTO tds_deductions
       (firm_id, client_id, voucher_id, bill_voucher_id, party_id, section_id,
        fiscal_year_id, payment_amount, cumulative_before, cumulative_after,
        taxable_base, rate, tds_already_deducted, tds_computed, tds_amount,
        threshold_crossed, deducted_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [a.firmId, a.clientId, a.voucherId, a.billVoucherId, a.partyId,
     a.computation.sectionId, a.fiscalYearId,
     // `payment_amount` is the base credited or paid under this section — it is
     // what `cumulativeForParty` sums, so a bill-time deduction and a
     // payment-time one feed the same running threshold.
     a.computation.cumulativeAfter === a.computation.cumulativeBefore
       ? '0.00'
       : money(paise(a.computation.cumulativeAfter)
               - paise(a.computation.cumulativeBefore)),
     a.computation.cumulativeBefore, a.computation.cumulativeAfter,
     a.computation.taxableBase, a.computation.rate,
     a.computation.alreadyDeducted,
     a.computation.tdsAmount,                        // what the section required
     a.withheld ?? a.computation.tdsAmount,          // what was actually taken
     a.computation.thresholdCrossed, a.deductedOn]);
}
