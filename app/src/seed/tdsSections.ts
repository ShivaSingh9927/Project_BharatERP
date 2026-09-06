/**
 * TDS section master seed.
 *
 * Spec: bills-and-expenses.md §7.2
 *
 * ── Status after the CA review (2026-09-07) ────────────────────────────────
 *
 * RATES, THRESHOLDS and BEHAVIOUR are now CA-reviewed. The SECTION CODES are
 * not, and are deliberately left marked — see the warning below.
 *
 * The review confirmed the two behaviours the schema was built around:
 *
 *   - Crossing an aggregate threshold charges TDS on the WHOLE cumulative
 *     amount, not on the excess (`deduct_on_full_cumulative = true`).
 *   - …except for Purchase of Goods, which is charged on the EXCESS over
 *     ₹50 lakh only. That exception is why this is a per-row flag rather than
 *     a global rule, and it would have been a silent over-deduction on every
 *     large purchase had the review not caught it.
 *
 * It also confirmed that the no-PAN punitive rate is "20% or the normal rate,
 * whichever is higher" — but 5%, not 20%, for Purchase of Goods. Storing the
 * punitive rate as its own row rather than hardcoding 20% is what makes that
 * expressible.
 */

import { ownerPool } from '../db/pool.ts';

/**
 * ⚠️ SECTION CODES ARE UNVERIFIED. Do not print these on a certificate.
 *
 * The Income-tax Act, 2025 renumbered the entire 194-series. The reviewer gave
 * mappings — Purchase of Goods as `393(1) Table Sl. 8(ii)`, the no-PAN rule as
 * `397(2)` — but those could not be corroborated against the bare Act, and a
 * wrong section code propagates onto every TDS certificate, return and
 * challan. They are recorded as claims to check, not as facts.
 *
 * The rates and thresholds below do NOT depend on the codes being right.
 */
const CODE_UNVERIFIED = 'CODE UNVERIFIED — confirm against the Income-tax Act, 2025';

interface Seed {
  code: string; category: string; entity: string;
  rate: string; single: string; cumulative: string;
  /** false = charge only the amount above the threshold. */
  fullOnCrossing?: boolean;
  note?: string;
}

const SECTIONS: Seed[] = [
  // Contractor payments — the classic threshold-crossing case.
  { code: '393(3) - 1006', category: 'Contractor Payments', entity: 'individual',
    rate: '1', single: '30000', cumulative: '100000' },
  { code: '393(3) - 1006', category: 'Contractor Payments', entity: 'company',
    rate: '2', single: '30000', cumulative: '100000' },
  { code: '393(3) - 1006', category: 'Contractor Payments', entity: 'no_pan',
    rate: '20', single: '30000', cumulative: '100000' },

  { code: '393(1) - 1007', category: 'Professional Fees', entity: 'individual',
    rate: '10', single: '30000', cumulative: '50000' },
  { code: '393(1) - 1007', category: 'Professional Fees', entity: 'company',
    rate: '10', single: '30000', cumulative: '50000' },
  { code: '393(1) - 1007', category: 'Professional Fees', entity: 'no_pan',
    rate: '20', single: '30000', cumulative: '50000' },

  { code: '393(1) [2(ii).D(a)] - 1008', category: 'Rent on Plant / Machinery',
    entity: 'company', rate: '2', single: '50000', cumulative: '600000' },
  { code: '393(1) [2(ii).D(b)] - 1009', category: 'Rent on Land / Building',
    entity: 'company', rate: '10', single: '50000', cumulative: '600000' },

  // ── Added on the review's advice (A1.3): common for SMB clients ──────────

  { code: CODE_UNVERIFIED, category: 'Commission or Brokerage', entity: 'individual',
    rate: '5', single: '0', cumulative: '20000' },
  { code: CODE_UNVERIFIED, category: 'Commission or Brokerage', entity: 'company',
    rate: '5', single: '0', cumulative: '20000' },
  { code: CODE_UNVERIFIED, category: 'Commission or Brokerage', entity: 'no_pan',
    rate: '20', single: '0', cumulative: '20000' },

  { code: CODE_UNVERIFIED, category: 'Interest other than on Securities',
    entity: 'individual', rate: '10', single: '0', cumulative: '10000' },
  { code: CODE_UNVERIFIED, category: 'Interest other than on Securities',
    entity: 'no_pan', rate: '20', single: '0', cumulative: '10000' },

  /*
   * Purchase of Goods — THE EXCEPTION, and the most valuable thing the review
   * corrected.
   *
   * Applies only when the BUYER's preceding-year turnover exceeded ₹10 crore,
   * which is a property of our own client and not of this table; the caller
   * must gate on it. `deduct_on_full_cumulative` is false because the charge
   * falls on the amount above ₹50 lakh only — the opposite of every other row
   * here. The no-PAN rate is 5%, not 20%.
   */
  { code: CODE_UNVERIFIED, category: 'Purchase of Goods', entity: 'individual',
    rate: '0.1', single: '0', cumulative: '5000000', fullOnCrossing: false,
    note: 'buyer turnover > Rs 10 cr; charged on the excess over Rs 50 lakh' },
  { code: CODE_UNVERIFIED, category: 'Purchase of Goods', entity: 'company',
    rate: '0.1', single: '0', cumulative: '5000000', fullOnCrossing: false,
    note: 'buyer turnover > Rs 10 cr; charged on the excess over Rs 50 lakh' },
  { code: CODE_UNVERIFIED, category: 'Purchase of Goods', entity: 'no_pan',
    rate: '5', single: '0', cumulative: '5000000', fullOnCrossing: false,
    note: 'punitive rate is 5%, NOT the usual 20%' },
];

/*
 * Salary is deliberately absent.
 *
 * The review listed it as a missing category, and as a category it is right —
 * it is the most common deduction an SMB makes. But it cannot live in this
 * table. Salary TDS is deducted at the employee's AVERAGE rate of tax on
 * estimated annual income, after exemptions, declared investments and the
 * employee's choice of regime. There is no rate to store and no threshold to
 * cross; there is an annual computation per employee, recomputed as
 * declarations change. It needs a payroll module. Adding a row here would
 * produce a number that looks authoritative and is arbitrary.
 */

export async function seedTdsSections(): Promise<number> {
  for (const s of SECTIONS) {
    await ownerPool.query(
      `INSERT INTO tds_sections
         (code, category_name, entity_type, effective_from, rate,
          single_threshold, cumulative_threshold, deduct_on_full_cumulative,
          source_citation)
       VALUES ($1,$2,$3,'2026-04-01',$4,$5,$6,$7,$8)
       ON CONFLICT (category_name, entity_type, effective_from) DO NOTHING`,
      [s.code, s.category, s.entity, s.rate, s.single, s.cumulative,
       s.fullOnCrossing ?? true,
       `CA-reviewed 2026-09-07${s.note ? ` — ${s.note}` : ''}`]);
  }
  return SECTIONS.length;
}

/**
 * Tag expense accounts with ITC eligibility.
 * Spec: bills-and-expenses.md §6.2 (Section 17(5))
 *
 * ⚠️ This is ACCOUNT-level, and the review (A5.3) says that is not good enough.
 * A hotel bill with allowable lodging and blocked food is routine, and marking
 * the whole bill blocked is described as a harsh UX that will frustrate users.
 * Per-LINE eligibility is wanted from day one. Recorded as gap G-9; this
 * function is the interim behaviour, not the intended one.
 */
export async function seedItcEligibility(clientId: string): Promise<void> {
  // CSR was added to the blocked list by the Finance Act 2023 — s.17(5)(fa).
  // Confirmed by the review (A5.1) as missing from our list.
  const blocked = ['Travel Expenses', 'CSR Expenses'];
  const conditional: string[] = [];           // populated once vehicle/insurance accounts exist

  await ownerPool.query(
    `UPDATE accounts SET itc_eligibility = 'eligible'
     WHERE client_id = $1 AND root_type = 'expense' AND NOT is_group`,
    [clientId]);
  await ownerPool.query(
    `UPDATE accounts SET itc_eligibility = 'blocked'
     WHERE client_id = $1 AND name = ANY($2)`, [clientId, blocked]);
  if (conditional.length) {
    await ownerPool.query(
      `UPDATE accounts SET itc_eligibility = 'conditional'
       WHERE client_id = $1 AND name = ANY($2)`, [clientId, conditional]);
  }
}
