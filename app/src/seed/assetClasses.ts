/**
 * Asset classes — useful lives for the books, block rates for tax.
 * Spec: bills-and-expenses.md BE-41
 *
 * ⚠️ NOT CA-REVIEWED. Every figure below is marked as such in
 * `source_citation`, and `depreciationRun` surfaces the marker on any charge
 * it computes.
 *
 * The precedent is `seedTdsSections`, where the rates were reviewed and the
 * section codes were not, and saying so was worth more than a table that
 * looked authoritative. The same applies here and matters more, because a
 * wrong useful life misstates profit every year for a decade rather than once.
 *
 * ── Two regimes, two numbers ─────────────────────────────────────────────
 *
 * `useful_life_years` / `book_method` / `residual_percent` are Companies Act
 * 2013 Schedule II and drive what POSTS to the ledger.
 *
 * `tax_block` / `tax_wdv_rate` are Income Tax Act s.32 with Appendix I rates
 * and drive the computation only. Tax depreciation works on a block of assets
 * rather than an individual one, always on written-down value, and at half
 * rate for anything put to use under 180 days in its first year.
 *
 * They disagree by design, and the gap is the add-back in the income
 * computation. Neither is a rounding of the other.
 */

import { ownerPool } from '../db/pool.ts';

const UNREVIEWED = 'NOT CA-REVIEWED — confirm the life against Companies Act ' +
  '2013 Schedule II and the rate against Income-tax Rules Appendix I';

interface Seed {
  key: string; name: string; account: string;
  /** Schedule II useful life, in years. */
  life: string;
  method: 'slm' | 'wdv';
  /** Appendix I block and its WDV rate. */
  block: string; rate: string;
  note?: string;
}

const CLASSES: Seed[] = [
  {
    key: 'computers', name: 'Computers and peripherals', account: 'Computers',
    // Schedule II splits servers (6 years) from end-user devices (3); the
    // shorter life is the safer default for an SMB whose computers are laptops.
    life: '3', method: 'slm',
    block: 'Computers including computer software', rate: '40',
    note: 'end-user devices; servers and networks have a longer life',
  },
  {
    key: 'office_equipment', name: 'Office equipment', account: 'Office Equipment',
    life: '5', method: 'slm',
    block: 'Plant and machinery (general)', rate: '15',
  },
  {
    key: 'furniture', name: 'Furniture and fittings', account: 'Furniture and Fixtures',
    life: '10', method: 'slm',
    block: 'Furniture and fittings', rate: '10',
  },
  {
    key: 'plant_machinery', name: 'Plant and machinery', account: 'Plant and Machinery',
    life: '15', method: 'slm',
    block: 'Plant and machinery (general)', rate: '15',
  },
  {
    key: 'vehicles', name: 'Motor vehicles', account: 'Vehicles',
    life: '8', method: 'slm',
    block: 'Motor cars (other than those used in a hiring business)', rate: '15',
    note: 'a vehicle used in a hiring business sits in a different block',
  },
];

export async function seedAssetClasses(): Promise<number> {
  for (const c of CLASSES) {
    await ownerPool.query(
      `INSERT INTO asset_classes
         (key, name, asset_account_name, useful_life_years, book_method,
          residual_percent, tax_block, tax_wdv_rate, effective_from,
          source_citation)
       VALUES ($1,$2,$3,$4,$5,5,$6,$7,'2014-04-01',$8)
       ON CONFLICT (key, effective_from) DO NOTHING`,
      [c.key, c.name, c.account, c.life, c.method, c.block, c.rate,
       `${UNREVIEWED}${c.note ? ` — ${c.note}` : ''}`]);
  }
  return CLASSES.length;
}
