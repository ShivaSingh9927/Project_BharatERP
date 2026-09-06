/**
 * GST rate master seed.
 *
 * ⚠️ THESE VALUES ARE ILLUSTRATIVE AND MUST BE VERIFIED BEFORE PRODUCTION.
 *
 * Rate slabs have been revised repeatedly since 2017, and we already found
 * that the Income Tax Act 2025 renumbered every TDS section. What matters here
 * is the *shape* — date-ranged rows with a citation — not these numbers.
 * Confirm each with the CA advisor and record the actual notification.
 *
 * Spec: invoicing.md §2.3, §4.4
 */

import { ownerPool } from '../db/pool.ts';

interface RateSeed {
  prefix: string; description: string; rate: string; cess?: string;
  from: string; notification: string;
}

const RATES: RateSeed[] = [
  { prefix: '', description: 'Default fallback rate', rate: '18',
    from: '2017-07-01', notification: 'PLACEHOLDER — verify' },
  { prefix: '99', description: 'Services (SAC)', rate: '18',
    from: '2017-07-01', notification: 'PLACEHOLDER — verify' },
  { prefix: '7318', description: 'Iron/steel fasteners', rate: '18',
    from: '2017-07-01', notification: 'PLACEHOLDER — verify' },
  { prefix: '3506', description: 'Prepared adhesives', rate: '18',
    from: '2017-07-01', notification: 'PLACEHOLDER — verify' },
  { prefix: '4819', description: 'Cartons, boxes, packing containers', rate: '18',
    from: '2017-07-01', notification: 'PLACEHOLDER — verify' },
  { prefix: '1006', description: 'Rice, branded', rate: '5',
    from: '2017-07-01', notification: 'PLACEHOLDER — verify' },
  { prefix: '3004', description: 'Medicaments', rate: '5',
    from: '2017-07-01', notification: 'PLACEHOLDER — verify' },
  { prefix: '0401', description: 'Fresh milk', rate: '0',
    from: '2017-07-01', notification: 'PLACEHOLDER — verify' },
  { prefix: '2402', description: 'Cigarettes (demerit rate + cess)', rate: '28', cess: '5',
    from: '2017-07-01', notification: 'PLACEHOLDER — verify' },
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
  await ownerPool.query(
    `INSERT INTO compliance_thresholds (key, effective_from, value, unit, source_notification)
     VALUES ('b2cl_value', '2017-07-01', 250000, 'INR', 'PLACEHOLDER — verify'),
            ('e_invoice_aato', '2023-08-01', 50000000, 'INR', 'PLACEHOLDER — verify')`);
  return n;
}
