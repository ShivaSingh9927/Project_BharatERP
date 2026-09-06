/**
 * Input Tax Credit eligibility.
 * Spec: bills-and-expenses.md §6
 *
 * Lesson 5 established ITC conceptually: GST paid to vendors is an asset,
 * claimable against GST collected. Reality adds conditions, and getting them
 * wrong costs the client cash plus interest plus penalty.
 *
 * This module answers one question — may this bill's GST be claimed? — and
 * that answer changes the GL posting, not just a report. Blocked GST becomes
 * part of the expense, which changes reported profit by the tax amount.
 */

import type { PoolClient } from 'pg';

export type ItcEligibility = 'eligible' | 'blocked' | 'conditional';

export type Gstr2bStatus =
  | 'pending' | 'exact_match' | 'suggested_match' | 'mismatch'
  | 'manual_match' | 'missing_in_2b' | 'missing_in_books' | 'amended' | 'ignored';

/**
 * Section 17(5) blocked categories, with the exception that unblocks each.
 *
 * The exceptions depend on what business the client is *in* — a transport
 * company genuinely can claim vehicle ITC — which is why these map to
 * 'conditional' rather than 'blocked' when a matching business type is set.
 * The model must not guess this; it depends on facts it cannot see.
 */
export const BLOCKED_CATEGORIES: Record<string, { label: string; unblockedFor?: string[] }> = {
  motor_vehicles:      { label: 'Motor vehicles (≤13 seats)',
                         unblockedFor: ['transport', 'driving_school', 'vehicle_dealer'] },
  food_beverages:      { label: 'Food, beverages, outdoor catering',
                         unblockedFor: ['catering', 'restaurant'] },
  beauty_health:       { label: 'Beauty treatment, health services, cosmetic surgery',
                         unblockedFor: ['healthcare', 'salon'] },
  club_membership:     { label: 'Club, health and fitness centre membership' },
  rent_a_cab_insurance:{ label: 'Rent-a-cab, life and health insurance',
                         unblockedFor: ['insurance'] },
  employee_travel:     { label: 'Travel benefits to employees (LTA)' },
  works_contract:      { label: 'Works contract for immovable property',
                         unblockedFor: ['construction', 'works_contract'] },
  personal_consumption:{ label: 'Goods or services for personal consumption' },
  lost_or_gifted:      { label: 'Goods lost, stolen, destroyed, written off, gifted, free samples' },
  composition_supplier:{ label: 'Anything purchased from a composition-scheme supplier' },
};

export interface ItcDecision {
  eligibility: ItcEligibility;
  reason: string;
  /** True when a CA must answer before the bill can post. */
  needsHumanDecision: boolean;
}

/**
 * Decide eligibility for an expense account, given the client's business type.
 *
 * BE-6 — this is the highest-value AI flag in the product. A busy junior
 * accountant claims ITC on the office Diwali sweets, the team lunch, the
 * director's car insurance. Each looks like an ordinary expense with GST on
 * it. The department disallows it later, with interest and penalty, and the
 * CA carries the blame.
 */
export function decideItc(args: {
  accountEligibility: ItcEligibility | null;
  blockedCategory?: string | null;
  clientBusinessType?: string | null;
}): ItcDecision {
  const declared = args.accountEligibility ?? 'eligible';

  if (declared === 'eligible') {
    return { eligibility: 'eligible', reason: 'no blocking category applies',
             needsHumanDecision: false };
  }

  const cat = args.blockedCategory ? BLOCKED_CATEGORIES[args.blockedCategory] : undefined;
  const label = cat?.label ?? 'blocked category';

  if (declared === 'blocked') {
    return {
      eligibility: 'blocked',
      reason: `Section 17(5) blocks input credit on ${label}`,
      needsHumanDecision: false,
    };
  }

  // conditional — the exception may or may not apply to this client
  if (cat?.unblockedFor && args.clientBusinessType
      && cat.unblockedFor.includes(args.clientBusinessType)) {
    return {
      eligibility: 'eligible',
      reason: `${label} is normally blocked, but this client's business type ` +
              `(${args.clientBusinessType}) qualifies for the exception`,
      needsHumanDecision: false,
    };
  }

  return {
    eligibility: 'blocked',
    reason: `${label} is blocked unless the client's business qualifies for the ` +
            `exception — confirm the business type`,
    needsHumanDecision: true,
  };
}

/**
 * Whether ITC may actually be CLAIMED, distinct from whether it is eligible.
 *
 * Eligibility is about the nature of the expense (§6.2). Claimability adds the
 * Section 16(2) conditions — chiefly that the supplier actually reported the
 * sale to GSTN, which is what GSTR-2B matching establishes (§6.3).
 *
 * A client can hold a perfect invoice on a perfectly eligible expense and
 * still be denied credit because their vendor never filed.
 */
export function canClaimItc(args: {
  eligibility: ItcEligibility;
  gstr2bStatus: Gstr2bStatus;
  overrideReason?: string;
}): { claimable: boolean; reason: string } {
  if (args.eligibility === 'blocked') {
    return { claimable: false, reason: 'input credit is blocked for this expense' };
  }
  if (args.eligibility === 'conditional') {
    return { claimable: false, reason: 'eligibility unresolved — needs a CA decision' };
  }

  switch (args.gstr2bStatus) {
    case 'exact_match':
    case 'manual_match':
      return { claimable: true, reason: 'matched in GSTR-2B' };

    case 'suggested_match':
      return { claimable: false, reason: 'suggested match — review before claiming' };

    case 'mismatch':
      return { claimable: false, reason: 'values differ from GSTR-2B — investigate' };

    case 'missing_in_2b':
      // PB-8. The supplier has not reported the sale, so Section 16(2)(c) is
      // unsatisfied. A CA may override where the supplier simply filed late,
      // but it must be a recorded decision.
      return args.overrideReason
        ? { claimable: true, reason: `not in 2B; claimed on CA override — ${args.overrideReason}` }
        : { claimable: false, reason: 'not reported by the supplier in GSTR-2B — chase the vendor' };

    case 'pending':
      return { claimable: false, reason: 'GSTR-2B for the period is not yet available' };

    default:
      return { claimable: false, reason: `2B status "${args.gstr2bStatus}" does not permit a claim` };
  }
}

/**
 * Bills at risk under the 180-day rule.
 *
 * BE-7 — if the client has not paid a vendor within 180 days of the invoice
 * date, previously-claimed ITC must be reversed with interest, and re-claimed
 * only when payment eventually happens.
 *
 * This is a silent, expensive trap that manual bookkeeping misses constantly,
 * and it is almost free to detect once the data is structured. The point is to
 * warn BEFORE the reversal becomes mandatory, not to report it afterwards.
 */
export async function billsApproaching180Days(
  c: PoolClient, clientId: string, asOf: string, warnFromDay = 150,
): Promise<Array<{
  voucherId: string; billNumber: string; supplier: string;
  billDate: string; daysElapsed: number; itcAtRisk: string; breached: boolean;
}>> {
  const r = await c.query(
    `SELECT pb.voucher_id                              AS "voucherId",
            pb.bill_number                             AS "billNumber",
            pb.supplier_legal_name                     AS supplier,
            pb.bill_date::text                         AS "billDate",
            ($2::date - pb.bill_date)                  AS "daysElapsed",
            (pb.total_cgst + pb.total_sgst + pb.total_igst)::text AS "itcAtRisk",
            ($2::date - pb.bill_date) > 180            AS breached
     FROM purchase_bills pb
     WHERE pb.client_id = $1
       AND pb.itc_eligibility = 'eligible'
       AND pb.approval_status = 'approved'
       AND ($2::date - pb.bill_date) >= $3
       -- unpaid: nothing in the ledger settles this bill for its full value
       AND COALESCE((SELECT SUM(le.debit - le.credit)
                     FROM ledger_entries le
                     WHERE le.settles_voucher_id = pb.voucher_id), 0) < pb.grand_total
     ORDER BY "daysElapsed" DESC`,
    [clientId, asOf, warnFromDay]);
  return r.rows;
}
