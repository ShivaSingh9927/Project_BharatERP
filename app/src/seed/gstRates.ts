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
  prefix: string; description: string; from: string; notification: string;
  /** Absent when the code has no single correct rate — see `askHuman`. */
  rate?: string;
  cess?: string;
  /**
   * Why a rate cannot be resolved from this code alone. Setting it withholds
   * the rate entirely: the DB CHECK forbids a refusing row from carrying one,
   * so there is no number a caller can read by mistake.
   */
  askHuman?: string;
}

const UNVERIFIED = 'UNVERIFIED — predates the 2025-09-22 rate rationalisation';

const RATES: RateSeed[] = [
  /*
   * Support services. 18% here is the ONE service rate with corroboration
   * beyond the seed: a real Flipkart platform-fee invoice under SAC 998599
   * charges IGST at 18.0%.
   *
   * This replaces a bare `99` row at 18%. `99` prefixes every service in the
   * scheme, so that row answered every service code that existed and made the
   * refuse-and-ask path (A3.1) unreachable for half the schedule — the same
   * defect as the empty-prefix fallback the review had us delete, one level
   * down. Narrowing to 9985 means an unseeded service now refuses, which is
   * the behaviour the review asked for.
   */
  { prefix: '9985', description: 'Support services', rate: '18',
    from: '2017-07-01', notification: UNVERIFIED },

  /*
   * Professional, technical and business services — 18%.
   *
   * Seeded as a four-digit heading, not as part of a wider net. The difference
   * between this and the `99` row it replaces is the whole point: chapter 99 is
   * every service there is, including several that are not 18% (goods transport
   * below, passenger transport, restaurant supply). A heading is narrow enough
   * that one rate can be true of all of it.
   */
  { prefix: '9983', description: 'Professional, technical and business services',
    rate: '18', from: '2017-07-01', notification: UNVERIFIED },

  /*
   * Goods Transport Agency — deliberately RATELESS.
   *
   * There is no single correct number: GTA is 5% or 12%, and which applies
   * turns on whether the supplier opted for forward charge and whether input
   * credit is taken. Both are properties of the transaction, not of the code.
   * Two invoices bearing 9965 can correctly carry different rates, so any
   * seeded figure would be a guess with a citation attached.
   */
  { prefix: '9965', description: 'Goods transport services (GTA)',
    from: '2017-07-01', notification: 'Rate depends on the transaction, not the SAC',
    askHuman:
      'Goods transport by a GTA is charged at 5% or 12%. Which one applies ' +
      'depends on whether the supplier opted to pay under forward charge and ' +
      'whether input credit is being claimed — neither is derivable from the ' +
      'SAC. Read the rate off the vendor invoice and state it on the line.' },
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
                              gst_rate, cess_rate, source_notification,
                              requires_human_rate, human_rate_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.prefix, r.description, r.from,
       r.askHuman ? null : r.rate, r.cess ?? '0', r.notification,
       r.askHuman !== undefined, r.askHuman ?? null]);
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
