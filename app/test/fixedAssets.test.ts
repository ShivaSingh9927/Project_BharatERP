/**
 * The asset register and depreciation — bills-and-expenses.md BE-41.
 *
 * BE-11 has been waiting for this: a bill above the capitalisation threshold
 * must ask "expense or capitalise?", and nothing asked because there was
 * nowhere to capitalise to. A ₹3,00,000 batch of laptops went to expense —
 * Lesson 2's error of principle, this year's profit understated by the whole
 * cost and the next four years' by nothing.
 *
 * The fact most of these tests are about: BOOK depreciation and TAX
 * depreciation are two different numbers for the same asset, and neither is a
 * rounding of the other.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, createFiscalYear, type SeededTenant } from '../src/seed/index.ts';
import { capitaliseAsset, assetRegister, computeDepreciation,
         postDepreciation, taxDepreciationSchedule, disposeAsset,
         assetClasses, fiscalYearOf } from '../src/domain/fixedAssets.ts';
import { trialBalance } from '../src/reports/index.ts';
import { registerGstin } from '../src/seed/index.ts';
import { seedItcEligibility } from '../src/seed/tdsSections.ts';
import { proposeFromDocument, postProposal } from '../src/domain/billProposal.ts';
import { splitDocuments } from '../src/parse/documentSplit.ts';
import { wordsToRows, type Word, type WordPage } from '../src/parse/pdfWords.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { ownerPool, closePools } from '../src/db/pool.ts';

let t: SeededTenant;
const acct: Record<string, string> = {};

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  t = await seedTenant({
    firmName: `Asset ${tag}`, clientName: `Client ${tag}`,
    userEmail: `asset-${tag}@example.test`, startYear: 2026,
    pan: 'AAACF1010F', businessType: 'general',
  });
  await createFiscalYear(t.firmId, t.clientId, 2027);

  const r = await ownerPool.query<{ id: string; name: string }>(
    `SELECT id, name FROM accounts WHERE client_id = $1 AND NOT is_group
       AND name IN ('Computers','Plant and Machinery','Accumulated Depreciation',
                    'Depreciation','Bank Accounts','Other Income',
                    'Loss on Sale of Assets')`, [t.clientId]);
  for (const a of r.rows) acct[a.name] = a.id;
});

afterAll(async () => { await closePools(); });

const legs = async (voucherId: string) => {
  const r = await ownerPool.query<{ name: string; debit: string; credit: string }>(
    `SELECT a.name, le.debit::text, le.credit::text
       FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
      WHERE le.voucher_id = $1`, [voucherId]);
  return Object.fromEntries(r.rows.map((x) => [x.name, x]));
};

// ---------------------------------------------------------------------------
describe('the class master', () => {
  it('carries both regimes, and admits it is unreviewed', async () => {
    const classes = await assetClasses(t.firmId, '2026-06-01');
    const pc = classes.find((c) => c.key === 'computers')!;
    // Three years for the books, 40% written down for tax. They disagree by
    // design and the gap is the add-back in the income computation.
    expect(pc.usefulLifeYears).toBe('3.00');
    expect(pc.bookMethod).toBe('slm');
    expect(pc.taxWdvRate).toBe('40.00');
    expect(pc.citation).toMatch(/NOT CA-REVIEWED/);
  });

  it('knows which fiscal year a date falls in', () => {
    // April to March, so January belongs to the year that started last April.
    expect(fiscalYearOf('2026-04-01')).toBe(2026);
    expect(fiscalYearOf('2027-01-15')).toBe(2026);
    expect(fiscalYearOf('2027-03-31')).toBe(2026);
    expect(fiscalYearOf('2027-04-01')).toBe(2027);
  });
});

// ---------------------------------------------------------------------------
describe('putting an asset on the register', () => {
  it('refuses a class that does not exist', async () => {
    await expect(capitaliseAsset(t.firmId, {
      clientId: t.clientId, assetClassKey: 'spaceships',
      description: 'Rocket', cost: '100000', putToUseOn: '2026-05-01',
      createdBy: t.userId,
    })).rejects.toThrow(/not an asset class in force/);
  });

  it('warns that the life it will use is unreviewed', async () => {
    // A wrong life misstates profit every year until the asset is written
    // off, so this is said before the first run rather than after it.
    const r = await capitaliseAsset(t.firmId, {
      clientId: t.clientId, assetClassKey: 'computers',
      description: 'Dell laptops x5', identifier: 'TAG-001',
      cost: '300000', putToUseOn: '2026-04-01', createdBy: t.userId,
    });
    expect(r.warnings.join(' ')).toMatch(/NOT CA-REVIEWED/);
    expect(r.warnings.join(' ')).toMatch(/misstates profit every year/);
  });

  it('shows cost, accumulated and carrying amount separately', async () => {
    // Lesson 8: accumulated depreciation is a contra-asset, so the cost stays
    // visible. What was paid and what is left are different questions.
    const reg = await assetRegister(t.firmId, t.clientId, '2026-04-30');
    const row = reg.rows.find((x) => x.identifier === 'TAG-001')!;
    expect(row.cost).toBe('300000.00');
    expect(row.accumulated).toBe('0.00');
    expect(row.carrying).toBe('300000.00');
    // Schedule II caps residual at 5%.
    expect(row.residualValue).toBe('15000.00');
  });
});

// ---------------------------------------------------------------------------
describe('book depreciation', () => {
  it('spreads cost over the life, less residual, pro-rated by days', async () => {
    /*
     * 3,00,000 with 5% residual leaves 2,85,000 over three years — 95,000 a
     * year. A full year from 1 April is 365 days, so the whole 95,000.
     */
    const d = await computeDepreciation(
      t.firmId, t.clientId, '2026-04-01', '2027-03-31');
    const line = d.lines.find((l) => l.description === 'Dell laptops x5')!;
    expect(line.days).toBe(365);
    expect(line.charge).toBe('95000.00');
    expect(line.openingWdv).toBe('300000.00');
    expect(line.closingWdv).toBe('205000.00');
  });

  it('gives an asset bought in March eleven days, not a month', async () => {
    /*
     * Schedule II depreciates from the date available for use. A machine
     * commissioned on 21 March earns eleven days of the year, and charging a
     * whole month — or a whole year — is the mistake this pro-rata exists to
     * stop.
     */
    await capitaliseAsset(t.firmId, {
      clientId: t.clientId, assetClassKey: 'plant_machinery',
      description: 'Lathe', identifier: 'TAG-002',
      cost: '1500000', putToUseOn: '2027-03-21', createdBy: t.userId,
    });
    const d = await computeDepreciation(
      t.firmId, t.clientId, '2026-04-01', '2027-03-31');
    const line = d.lines.find((l) => l.description === 'Lathe')!;
    expect(line.days).toBe(11);
    // (15,00,000 − 75,000) / 15 years = 95,000 a year; 11/365 of that.
    expect(line.charge).toBe('2863.01');
    expect(line.note).toMatch(/held 11 of 365 days/);
  });

  it('says out loud that this is not the tax figure', async () => {
    const d = await computeDepreciation(
      t.firmId, t.clientId, '2026-04-01', '2027-03-31');
    expect(d.warnings.join(' ')).toMatch(/not the tax figure/);
    expect(d.warnings.join(' ')).toMatch(/NOT .*CA-reviewed/i);
  });

  it('posts the charge against a contra-asset, not against the asset', async () => {
    const r = await postDepreciation(t.firmId, {
      clientId: t.clientId, fromDate: '2026-04-01', toDate: '2027-03-31',
      createdBy: t.userId, approvedBy: t.userId,
    });
    expect(r.total).toBe('97863.01');
    const by = await legs(r.voucherId);
    expect(by['Depreciation']!.debit).toBe('97863.01');
    expect(by['Accumulated Depreciation']!.credit).toBe('97863.01');
    // The asset account is untouched, so the register still shows what was paid.
    expect(by['Computers']).toBeUndefined();
  });

  it('refuses to charge the same period twice', async () => {
    /*
     * The guard that matters most here. Charging a year twice halves every
     * asset's life, and the voucher still balances — nothing downstream would
     * catch it.
     */
    await expect(postDepreciation(t.firmId, {
      clientId: t.clientId, fromDate: '2026-04-01', toDate: '2027-03-31',
      createdBy: t.userId, approvedBy: t.userId,
    })).rejects.toThrow(/already been charged/);
  });

  it('refuses an overlapping period, not just an identical one', async () => {
    // Inside the same fiscal year, so it is the overlap that refuses it and
    // not the cross-year guard.
    await expect(postDepreciation(t.firmId, {
      clientId: t.clientId, fromDate: '2026-06-01', toDate: '2026-12-31',
      createdBy: t.userId, approvedBy: t.userId,
    })).rejects.toThrow(/already been charged/);
  });

  it('refuses a period that crosses 31 March', async () => {
    // The life is in years, the pro-rata denominator is the year's own day
    // count, and tax reckons by year — a period spanning two mixes all three.
    await expect(computeDepreciation(
      t.firmId, t.clientId, '2027-01-01', '2027-12-31'))
      .rejects.toThrow(/crosses 31 March/);
  });

  it('charges a full leap year exactly one year, not 366 days of one', async () => {
    /*
     * 2027-28 contains 29 February. With a fixed 365 denominator a full year
     * charged 366/365 of the annual figure — 95,260.27 where the schedule says
     * 95,000 — and the total still came right because the residual cap caught
     * it at the end. That is the kind of self-correcting error that wastes an
     * afternoon.
     */
    const d = await computeDepreciation(
      t.firmId, t.clientId, '2027-04-01', '2028-03-31');
    const line = d.lines.find((l) => l.description === 'Dell laptops x5')!;
    expect(line.days).toBe(366);
    expect(line.charge).toBe('95000.00');
  });

  it('picks up from the carrying amount on the next run', async () => {
    const d = await computeDepreciation(
      t.firmId, t.clientId, '2027-04-01', '2028-03-31');
    const line = d.lines.find((l) => l.description === 'Dell laptops x5')!;
    expect(line.openingWdv).toBe('205000.00');   // 3,00,000 less 95,000
    expect(line.charge).toBe('95000.00');
  });

  it('never depreciates below the residual value', async () => {
    /*
     * Year four on a three-year asset. 2,85,000 of the 3,00,000 is
     * depreciable, so after three full years only the 15,000 residual is left
     * and the charge is nil — not another 95,000 driving it past zero, which
     * a balanced voucher would hide.
     */
    const cap = await capitaliseAsset(t.firmId, {
      clientId: t.clientId, assetClassKey: 'computers',
      description: 'Old server', identifier: 'TAG-003',
      cost: '100000', putToUseOn: '2026-04-01', createdBy: t.userId,
    });
    // Charge two years and nine months of a three-year life by hand.
    await ownerPool.query(
      `INSERT INTO depreciation_runs (firm_id, client_id, voucher_id, from_date,
                                      to_date, total, created_by)
       SELECT $1,$2,dr.voucher_id,'2020-04-01','2021-03-31',0,$3
         FROM depreciation_runs dr WHERE dr.client_id = $2 LIMIT 1`,
      [t.firmId, t.clientId, t.userId]);
    const run = await ownerPool.query<{ id: string }>(
      `SELECT id FROM depreciation_runs WHERE client_id = $1
         AND from_date = '2020-04-01'`, [t.clientId]);
    await ownerPool.query(
      `INSERT INTO depreciation_lines (run_id, asset_id, opening_wdv, charge,
                                       closing_wdv, days, method)
       VALUES ($1,$2,100000,90000,10000,365,'slm')`,
      [run.rows[0]!.id, cap.id]);

    const d = await computeDepreciation(
      t.firmId, t.clientId, '2029-04-01', '2030-03-31');
    const line = d.lines.find((l) => l.description === 'Old server');
    // 95,000 depreciable, 90,000 charged: 5,000 of room, and it says so.
    expect(line?.charge).toBe('5000.00');
    expect(line?.note).toMatch(/capped at the residual value/);
  });
});

// ---------------------------------------------------------------------------
describe('tax depreciation', () => {
  /*
   * Its OWN tenant, with exactly two assets.
   *
   * These are arithmetic assertions about a BLOCK, and on the shared tenant
   * they depended on how many assets earlier describes had happened to add —
   * the first version passed only because of the order the describes appear
   * in, and broke the moment a later one capitalised something. A block
   * computation needs a controlled fixture.
   */
  let tt: SeededTenant;

  beforeAll(async () => {
    const tag = randomUUID().slice(0, 8);
    tt = await seedTenant({
      firmName: `Tax ${tag}`, clientName: `Client ${tag}`,
      userEmail: `tax-${tag}@example.test`, startYear: 2026,
      pan: 'AAACG2020G', businessType: 'general',
    });
    await createFiscalYear(tt.firmId, tt.clientId, 2027);
    await capitaliseAsset(tt.firmId, {
      clientId: tt.clientId, assetClassKey: 'computers',
      description: 'Laptops', cost: '300000',
      putToUseOn: '2026-04-01', createdBy: tt.userId,
    });
    await capitaliseAsset(tt.firmId, {
      clientId: tt.clientId, assetClassKey: 'plant_machinery',
      description: 'Lathe', cost: '1500000',
      putToUseOn: '2027-03-21', createdBy: tt.userId,
    });
  });

  it('works on the block at the Appendix I rate, not on the asset', async () => {
    /*
     * 3,00,000 of computers put to use on 1 April 2026 — a full year, so the
     * full 40% and 1,20,000. The books charged 95,000 on the same asset over a
     * three-year straight line: the 25,000 gap is the add-back in the income
     * computation, and neither figure is a rounding of the other.
     */
    const s = await taxDepreciationSchedule(tt.firmId, tt.clientId, 2026);
    const computers = s.blocks.find((b) => /Computers/.test(b.block))!;
    expect(computers.rate).toBe('40.00');
    expect(computers.additionsFullRate).toBe('300000.00');
    expect(computers.depreciation).toBe('120000.00');
    expect(computers.closingWdv).toBe('180000.00');
  });

  it('halves the rate for an asset put to use under 180 days', async () => {
    /*
     * s.32 proviso, and only in the first year. The lathe went into use on
     * 21 March, so 11 days: half of 15% on 15,00,000 is 1,12,500.
     */
    const s = await taxDepreciationSchedule(tt.firmId, tt.clientId, 2026);
    const plant = s.blocks.find((b) => /Plant and machinery/.test(b.block))!;
    expect(plant.additionsHalfRate).toBe('1500000.00');
    expect(plant.additionsFullRate).toBe('0.00');
    expect(plant.depreciation).toBe('112500.00');
  });

  it('gives the full rate the following year', async () => {
    // The half rate applies in the year of acquisition alone.
    const s = await taxDepreciationSchedule(tt.firmId, tt.clientId, 2027);
    const plant = s.blocks.find((b) => /Plant and machinery/.test(b.block))!;
    expect(plant.openingWdv).toBe('1387500.00');             // 15,00,000 − 1,12,500
    expect(plant.additionsHalfRate).toBe('0.00');
    expect(plant.depreciation).toBe('208125.00');            // 15% of the WDV
  });

  it('reduces the block by sale proceeds, with no gain on the asset', async () => {
    /*
     * The divergence from the books. For tax there is no gain or loss on one
     * asset — the proceeds come off the block and it keeps depreciating at the
     * block rate.
     */
    const a = await ownerPool.query<{ id: string }>(
      `SELECT id FROM fixed_assets WHERE client_id = $1 AND description = 'Laptops'`,
      [tt.clientId]);
    const bank = await ownerPool.query<{ id: string }>(
      `SELECT id FROM accounts WHERE client_id = $1 AND name = 'Bank Accounts'
         AND NOT is_group`, [tt.clientId]);
    await disposeAsset(tt.firmId, {
      clientId: tt.clientId, assetId: a.rows[0]!.id, disposedOn: '2027-08-01',
      proceeds: '100000', receivedIntoAccountId: bank.rows[0]!.id,
      createdBy: tt.userId, approvedBy: tt.userId,
    });
    const s = await taxDepreciationSchedule(tt.firmId, tt.clientId, 2027);
    const computers = s.blocks.find((b) => /Computers/.test(b.block))!;
    expect(computers.openingWdv).toBe('180000.00');
    expect(computers.deductions).toBe('100000.00');
    expect(computers.depreciation).toBe('32000.00');   // 40% of 80,000
    expect(computers.note).toBeNull();
  });

  it('flags a block emptied by a sale rather than inventing a gain', async () => {
    // Proceeds beyond the whole block are a short-term capital gain under
    // s.50, which is a computation of its own and is not attempted here.
    const tag = randomUUID().slice(0, 8);
    const t3 = await seedTenant({
      firmName: `Empty ${tag}`, clientName: `Client ${tag}`,
      userEmail: `empty-${tag}@example.test`, startYear: 2026,
      pan: 'AAACH3030H', businessType: 'general',
    });
    await createFiscalYear(t3.firmId, t3.clientId, 2027);
    const cap = await capitaliseAsset(t3.firmId, {
      clientId: t3.clientId, assetClassKey: 'computers',
      description: 'One laptop', cost: '100000',
      putToUseOn: '2026-04-01', createdBy: t3.userId,
    });
    const bank = await ownerPool.query<{ id: string }>(
      `SELECT id FROM accounts WHERE client_id = $1 AND name = 'Bank Accounts'
         AND NOT is_group`, [t3.clientId]);
    await disposeAsset(t3.firmId, {
      clientId: t3.clientId, assetId: cap.id, disposedOn: '2027-06-01',
      proceeds: '400000', receivedIntoAccountId: bank.rows[0]!.id,
      createdBy: t3.userId, approvedBy: t3.userId,
    });
    const s = await taxDepreciationSchedule(t3.firmId, t3.clientId, 2027);
    const computers = s.blocks.find((b) => /Computers/.test(b.block))!;
    expect(computers.depreciation).toBe('0.00');
    expect(computers.note).toMatch(/short-term capital gain arises under s\.50/);
  });

  it('posts nothing, and says why', async () => {
    const before = await ownerPool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM vouchers WHERE client_id = $1`, [tt.clientId]);
    const s = await taxDepreciationSchedule(tt.firmId, tt.clientId, 2026);
    const after = await ownerPool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM vouchers WHERE client_id = $1`, [tt.clientId]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(s.warnings.join(' ')).toMatch(/Nothing here is posted/);
    expect(s.warnings.join(' ')).toMatch(/s\.32\(1\)\(iia\) is not included/);
  });
});

// ---------------------------------------------------------------------------
describe('disposing of an asset', () => {
  let assetId: string;

  beforeAll(async () => {
    const r = await capitaliseAsset(t.firmId, {
      clientId: t.clientId, assetClassKey: 'computers',
      description: 'Spare laptop', identifier: 'TAG-004',
      cost: '60000', putToUseOn: '2026-04-01', createdBy: t.userId,
    });
    assetId = r.id;
  });

  it('refuses proceeds with nowhere to land', async () => {
    // They would balance the voucher and lose the cash.
    await expect(disposeAsset(t.firmId, {
      clientId: t.clientId, assetId, disposedOn: '2027-06-01',
      proceeds: '20000', createdBy: t.userId, approvedBy: t.userId,
    })).rejects.toThrow(/say where the money went/);
  });

  it('takes the cost off, and warns when nothing was ever charged on it', async () => {
    /*
     * This asset was added after the depreciation run, so nothing has ever
     * been charged on it — its whole 60,000 comes off at once and the 30,000
     * sale is a 30,000 loss. Arithmetically right and probably not what the
     * client means, so it is SAID: the gain or loss depends entirely on
     * depreciation that has not been run.
     *
     * The loss goes to its own head rather than being parked in Other Income,
     * where a debit would understate both income and expense.
     */
    const r = await disposeAsset(t.firmId, {
      clientId: t.clientId, assetId, disposedOn: '2027-06-01',
      proceeds: '30000', receivedIntoAccountId: acct['Bank Accounts']!,
      createdBy: t.userId, approvedBy: t.userId,
    });
    expect(r.carrying).toBe('60000.00');
    expect(r.gain).toBe('-30000.00');
    expect(r.warnings.join(' ')).toMatch(/no depreciation had been charged/);

    const by = await legs(r.voucherId);
    expect(by['Bank Accounts']!.debit).toBe('30000.00');
    expect(by['Computers']!.credit).toBe('60000.00');
    expect(by['Loss on Sale of Assets']!.debit).toBe('30000.00');
    // Nothing accumulated, so no contra-asset leg at all.
    expect(by['Accumulated Depreciation']).toBeUndefined();
  });

  it('brings the accumulated depreciation back out when there is some', async () => {
    // The laptops HAVE been depreciated, so disposing of them takes the cost
    // off and the depreciation charged against it with it — which is the point
    // of holding it as a contra-asset (Lesson 8).
    const laptops = await ownerPool.query<{ id: string }>(
      `SELECT id FROM fixed_assets WHERE client_id = $1 AND identifier = 'TAG-001'`,
      [t.clientId]);
    const r = await disposeAsset(t.firmId, {
      clientId: t.clientId, assetId: laptops.rows[0]!.id, disposedOn: '2027-09-01',
      proceeds: '210000', receivedIntoAccountId: acct['Bank Accounts']!,
      createdBy: t.userId, approvedBy: t.userId,
    });
    expect(r.carrying).toBe('205000.00');        // 3,00,000 less 95,000
    expect(r.gain).toBe('5000.00');
    const by = await legs(r.voucherId);
    expect(by['Accumulated Depreciation']!.debit).toBe('95000.00');
    expect(by['Computers']!.credit).toBe('300000.00');
    expect(by['Other Income']!.credit).toBe('5000.00');
  });

  it('says the tax treatment is nothing like the book one', async () => {
    // For tax there is no gain or loss on one asset: the proceeds come off the
    // block and the block keeps depreciating.
    const r = await capitaliseAsset(t.firmId, {
      clientId: t.clientId, assetClassKey: 'computers',
      description: 'Second spare', cost: '40000',
      putToUseOn: '2026-04-01', createdBy: t.userId,
    });
    const d = await disposeAsset(t.firmId, {
      clientId: t.clientId, assetId: r.id, disposedOn: '2027-07-01',
      proceeds: '50000', receivedIntoAccountId: acct['Bank Accounts']!,
      createdBy: t.userId, approvedBy: t.userId,
    });
    expect(d.warnings.join(' ')).toMatch(/for tax there is no gain or loss on a single asset/);
    expect(d.warnings.join(' ')).toMatch(/comes off the block/);
  });

  it('will not sell the same asset twice', async () => {
    await expect(disposeAsset(t.firmId, {
      clientId: t.clientId, assetId, disposedOn: '2027-08-01',
      proceeds: '0', createdBy: t.userId, approvedBy: t.userId,
    })).rejects.toThrow(/already disposed of/);
  });

  it('drops out of the carrying total once gone', async () => {
    const reg = await assetRegister(t.firmId, t.clientId, '2027-12-31');
    const row = reg.rows.find((x) => x.identifier === 'TAG-004')!;
    expect(row.disposedOn).toBe('2027-06-01');
    expect(row.carrying).toBe('0.00');
  });

});

// ---------------------------------------------------------------------------
describe('BE-11: a bill that turns out to be an asset', () => {
  /*
   * The rule that has been in the spec since the beginning and never fired,
   * because there was nowhere to capitalise to. What it prevents is Lesson 2's
   * error of principle: a ₹3,00,000 batch of laptops posted to Purchases
   * understates this year's profit by the whole cost and the next four years'
   * by nothing.
   */
  let tb: SeededTenant;
  let purchases: string;

  const w = (text: string, xMin: number, yMin: number): Word =>
    ({ text, xMin, xMax: xMin + text.length * 3.3, yMin, yMax: yMin + 6.6 });

  const page = (taxable: string, tax: string, total: string): WordPage[] => [{
    number: 1, width: 600, height: 800,
    rows: wordsToRows([
      w('Qty', 40, 100), w('Taxable', 90, 100), w('IGST', 200, 100), w('Total', 280, 100),
      w('1', 40, 130), w(taxable, 90, 130), w(tax, 200, 130), w(total, 280, 130),
    ]),
  }];

  const SUPPLIER = (() => {
    const f = '09AABCS7070S1Z';
    return f + gstinCheckDigit(f);
  })();

  const doc = (number: string) => splitDocuments(
    `Tax Invoice\nInvoice Number # ${number}\nInvoice Date : 15-05-2026\n`
    + `GSTIN - ${SUPPLIER}\nIGST 18 %\n`
    + 'Whether tax is payable under reverse charge - No')[0]!;

  beforeAll(async () => {
    const tag = randomUUID().slice(0, 8);
    tb = await seedTenant({
      firmName: `Cap ${tag}`, clientName: `Client ${tag}`,
      userEmail: `cap-${tag}@example.test`, startYear: 2026,
      pan: 'AAACJ4040J', businessType: 'general',
    });
    await seedItcEligibility(tb.clientId);
    await registerGstin(tb.firmId, tb.clientId,
      (() => { const f = '09AAACJ4040J1Z'; return f + gstinCheckDigit(f); })(),
      { primary: true });
    const a = await ownerPool.query<{ id: string; name: string }>(
      `SELECT id, name FROM accounts WHERE client_id = $1 AND NOT is_group
         AND name IN ('Purchases','Creditors')`, [tb.clientId]);
    const by = Object.fromEntries(a.rows.map((x) => [x.name, x.id]));
    purchases = by['Purchases']!;
    await ownerPool.query(
      `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name,
                            gstin, gst_category, state_code, ledger_account_id,
                            created_by)
       VALUES ($1,$2,'supplier','Tech Vendor','Tech Vendor',$3,
               'registered_regular','09',$4,$5)`,
      [tb.firmId, tb.clientId, SUPPLIER, by['Creditors'], tb.userId]);
  });

  const propose = (number: string) => proposeFromDocument(tb.firmId,
    { clientId: tb.clientId, createdBy: tb.userId, expenseAccountId: purchases },
    doc(number), page('300000.00', '54000.00', '354000.00'), 'e'.repeat(64));

  it('asks about a big line on a goods head', async () => {
    const p = await propose('TV/1');
    const q = p.confirmations.find((c) => c.field === 'capitalise_1');
    expect(q).toBeDefined();
    expect(q!.question).toMatch(/300000\.00 on Purchases/);
    expect(q!.instead).toMatch(/capitalise it as a fixed asset/);
  });

  it('refuses "capitalise" with no class, rather than expensing it anyway', async () => {
    /*
     * The reviewer said this is an asset. Posting it to Purchases regardless
     * would overrule them silently, and the class is what decides the life and
     * the tax block — it cannot be guessed.
     */
    const p = await propose('TV/2');
    const q = p.confirmations.find((c) => c.field === 'capitalise_1')!;
    await expect(postProposal(tb.firmId, p, {
      approvedBy: tb.userId, confirm: { capitalise_1: q.instead },
    })).rejects.toThrow(/no asset class was given/);
  });

  it('moves the debit to the asset head and puts it on the register', async () => {
    const p = await propose('TV/3');
    const q = p.confirmations.find((c) => c.field === 'capitalise_1')!;
    const bill = await postProposal(tb.firmId, p, {
      approvedBy: tb.userId, confirm: { capitalise_1: q.instead },
      capitalise: [{ lineNo: 1, assetClassKey: 'computers',
                     identifier: 'LAP-2026-01' }],
    });

    const rows = await ownerPool.query<{ name: string; debit: string }>(
      `SELECT a.name, le.debit::text FROM ledger_entries le
         JOIN accounts a ON a.id = le.account_id
        WHERE le.voucher_id = $1 AND le.debit > 0`, [bill.voucherId]);
    const heads = rows.rows.map((x) => x.name);
    // On the balance sheet, not in the P&L.
    expect(heads).toContain('Computers');
    expect(heads).not.toContain('Purchases');
    /*
     * Capital goods credit is claimable under s.16, so the GST is still input
     * credit and not capitalised into the cost. CGST+SGST rather than IGST
     * because supplier and client are both in state 09 — the split follows the
     * states, not what the document's running text happens to say.
     */
    expect(heads.some((h) => /^Input (C|S|I)GST Credit$/.test(h))).toBe(true);

    const reg = await assetRegister(tb.firmId, tb.clientId, '2026-05-31');
    const asset = reg.rows.find((x) => x.identifier === 'LAP-2026-01')!;
    expect(asset.cost).toBe('300000.00');
    expect(asset.putToUseOn).toBe('2026-05-15');
    expect(bill.warnings.join(' ')).toMatch(/capitalised as Computers/);
    expect(bill.warnings.join(' ')).toMatch(/will not reduce profit this period/);

    // And it can be traced to the bill that bought it, which is the first
    // thing an auditor asks and the thing a spreadsheet never knows.
    const src = await ownerPool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM fixed_assets
        WHERE client_id = $1 AND source_voucher_id = $2`,
      [tb.clientId, bill.voucherId]);
    expect(src.rows[0]!.n).toBe('1');
  });

  it('leaves it as a cost when the answer is expense', async () => {
    const p = await propose('TV/4');
    const q = p.confirmations.find((c) => c.field === 'capitalise_1')!;
    const bill = await postProposal(tb.firmId, p, {
      approvedBy: tb.userId, confirm: { capitalise_1: q.chose },
    });
    const rows = await ownerPool.query<{ name: string }>(
      `SELECT a.name FROM ledger_entries le
         JOIN accounts a ON a.id = le.account_id
        WHERE le.voucher_id = $1 AND le.debit > 0`, [bill.voucherId]);
    expect(rows.rows.map((x) => x.name)).toContain('Purchases');
    const reg = await assetRegister(tb.firmId, tb.clientId, '2026-05-31');
    expect(reg.rows.length).toBe(1);          // only the one from before
  });
});

// ---------------------------------------------------------------------------
describe('the books after all of it', () => {
  it('still balance', async () => {
    const tb = await trialBalance(t.firmId, t.clientId, '2028-03-31');
    expect(Number(tb.totalDebit)).toBeCloseTo(Number(tb.totalCredit), 2);
  });
});
