/**
 * TDS section master seed.
 *
 * ⚠️ PLACEHOLDER VALUES — VERIFY WITH THE CA ADVISOR BEFORE PRODUCTION.
 *
 * The Income Tax Act 2025 renumbered the entire 194-series, so both the codes
 * and the rates here need confirming. What is being committed is the SHAPE:
 * date-ranged rows, per entity type, with both a per-transaction and an annual
 * threshold, plus a flag for whether crossing charges the full cumulative.
 *
 * Spec: bills-and-expenses.md §7.2
 */

import { ownerPool } from '../db/pool.ts';

interface Seed {
  code: string; category: string; entity: string;
  rate: string; single: string; cumulative: string;
  fullOnCrossing?: boolean;
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
];

export async function seedTdsSections(): Promise<number> {
  for (const s of SECTIONS) {
    await ownerPool.query(
      `INSERT INTO tds_sections
         (code, category_name, entity_type, effective_from, rate,
          single_threshold, cumulative_threshold, deduct_on_full_cumulative,
          source_citation)
       VALUES ($1,$2,$3,'2026-04-01',$4,$5,$6,$7,'PLACEHOLDER — verify')
       ON CONFLICT (category_name, entity_type, effective_from) DO NOTHING`,
      [s.code, s.category, s.entity, s.rate, s.single, s.cumulative,
       s.fullOnCrossing ?? true]);
  }
  return SECTIONS.length;
}

/**
 * Tag expense accounts with ITC eligibility.
 * Spec: bills-and-expenses.md §6.2 (Section 17(5))
 */
export async function seedItcEligibility(clientId: string): Promise<void> {
  const blocked = ['Travel Expenses'];        // employee travel benefits
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
