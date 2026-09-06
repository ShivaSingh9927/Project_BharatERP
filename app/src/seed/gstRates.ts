/**
 * GST rate and compliance-threshold master seed.
 *
 * Spec: invoicing.md §2.3, §4.4
 *
 * ── Status after the CA review (2026-09-07) ────────────────────────────────
 *
 * The two COMPLIANCE THRESHOLDS are now confirmed and carry their real
 * notification numbers. The HSN rates are still illustrative: the reviewer did
 * not cover the September 2025 rate rationalisation (see the warning below),
 * so they remain unverified and are marked as such per row.
 *
 * What matters here is the SHAPE, and the review confirmed it (answer A3.3):
 * date-ranged rows with a citation, never a single mutable rate. A rate that
 * changes must arrive as a NEW ROW with a later `effective_from`, so that a
 * voucher posted last year still computes with the law that applied last year.
 * Overwriting would silently rewrite history — the same class of harm as an
 * editable ledger.
 *
 * It is also the answer to "a second CA might disagree": a disagreement becomes
 * a row with a citation, not a release.
 */

import { ownerPool } from '../db/pool.ts';

/**
 * ⚠️ UNVERIFIED — and there is a specific reason to distrust these.
 *
 * The GST rate structure was rationalised with effect from 22 September 2025,
 * collapsing the 12% and 28% slabs. Every rate below predates that and none of
 * it was covered by the CA review, which did not mention the rationalisation at
 * all. Treat the numbers as placeholders and re-confirm each against the
 * current notification before anything posts from them.
 *
 * Note there is deliberately NO empty-prefix fallback row. Review answer A3.1:
 * defaulting an unmatched HSN to 18% is dangerous, because it silently produces
 * a wrong liability or a wrong ITC claim and the user never sees a decision
 * being made. An unmatched HSN must refuse to post and ask a human. Seeding a
 * catch-all row would quietly reintroduce exactly that behaviour.
 */
interface RateSeed {
  prefix: string; description: string; rate: string; cess?: string;
  from: string; notification: string;
}

const UNVERIFIED = 'UNVERIFIED — predates the 2025-09-22 rate rationalisation';

const RATES: RateSeed[] = [
  { prefix: '99', description: 'Services (SAC)', rate: '18',
    from: '2017-07-01', notification: UNVERIFIED },
  { prefix: '7318', description: 'Iron/steel fasteners', rate: '18',
    from: '2017-07-01', notification: UNVERIFIED },
  { prefix: '3506', description: 'Prepared adhesives', rate: '18',
    from: '2017-07-01', notification: UNVERIFIED },
  { prefix: '4819', description: 'Cartons, boxes, packing containers', rate: '18',
    from: '2017-07-01', notification: UNVERIFIED },
  { prefix: '1006', description: 'Rice, branded', rate: '5',
    from: '2017-07-01', notification: UNVERIFIED },
  { prefix: '3004', description: 'Medicaments', rate: '5',
    from: '2017-07-01', notification: UNVERIFIED },
  { prefix: '0401', description: 'Fresh milk', rate: '0',
    from: '2017-07-01', notification: UNVERIFIED },
  { prefix: '2402', description: 'Cigarettes (demerit rate + cess)', rate: '28', cess: '5',
    from: '2017-07-01', notification: UNVERIFIED },
];

/**
 * Compliance thresholds — CONFIRMED by the CA review, with citations.
 *
 * `b2cl_value` is seeded as TWO rows on purpose. The threshold for reporting
 * invoice-wise inter-state supplies to unregistered persons really was
 * ₹2,50,000 until 31 July 2024, and a GSTR-1 being reworked for an earlier
 * period must use the figure that applied then. Keeping the superseded row is
 * the whole point of date-ranging; deleting it would be the bug.
 *
 * The ₹2,50,000 value was previously seeded as the CURRENT threshold, which was
 * simply wrong — it had been out of date for two years.
 */
interface ThresholdSeed {
  key: string; from: string; value: number; unit: string; notification: string;
}

const THRESHOLDS: ThresholdSeed[] = [
  { key: 'b2cl_value', from: '2017-07-01', value: 250000, unit: 'INR',
    notification: 'Superseded from 2024-08-01 — retained for earlier periods' },
  { key: 'b2cl_value', from: '2024-08-01', value: 100000, unit: 'INR',
    notification: 'Notification No. 12/2024-Central Tax (CA-reviewed 2026-09-07)' },
  { key: 'e_invoice_aato', from: '2023-08-01', value: 50000000, unit: 'INR',
    notification: 'Notification No. 10/2023-Central Tax (CA-reviewed 2026-09-07)' },
];

export async function seedGstRates(): Promise<number> {
  let n = 0;
  for (const r of RATES) {
    await ownerPool.query(
      `INSERT INTO gst_rates (hsn_sac_prefix, description, effective_from,
                              gst_rate, cess_rate, source_notification)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.prefix, r.description, r.from, r.rate, r.cess ?? '0', r.notification]);
    n++;
  }

  for (const t of THRESHOLDS) {
    await ownerPool.query(
      `INSERT INTO compliance_thresholds
         (key, effective_from, value, unit, source_notification)
       VALUES ($1,$2,$3,$4,$5)`,
      [t.key, t.from, t.value, t.unit, t.notification]);
  }

  return n;
}
