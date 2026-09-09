/**
 * The asset register, and depreciation.
 * Spec: bills-and-expenses.md BE-41 (and BE-11, which was waiting for it)
 *
 * BE-11 says a bill above the capitalisation threshold must ask "expense or
 * capitalise?" and never default silently. Nothing asked, because there was
 * nowhere to capitalise TO — so a ₹3,00,000 batch of laptops went to expense.
 * That is Lesson 2's error of principle: this year's profit understated by the
 * whole cost, and the next four years' understated by nothing.
 *
 * ── Two regimes, and they disagree by design ─────────────────────────────
 *
 * BOOK depreciation follows Companies Act 2013 Schedule II: a useful life per
 * class, straight line or written down, residual capped at 5%, pro-rata from
 * the date the asset was available for use. This is what POSTS.
 *
 * TAX depreciation follows Income Tax Act s.32 with Appendix I rates: a BLOCK
 * of assets rather than individual ones, always written-down value, and half
 * the rate for anything put to use under 180 days in its first year. This
 * never posts — it is a computation, and the gap between the two is the main
 * add-back in the income computation and where the deferred tax item comes
 * from.
 *
 * Computing one and calling it "depreciation" would be telling a CA something
 * false, so they are separate functions returning separate numbers, and the
 * schedule reports both side by side.
 */

import { withFirm } from '../db/pool.ts';
import { postVoucher } from './posting.ts';
import { money, paise } from './tax.ts';
import { ValidationError } from './types.ts';

/** Whole days from `a` to `b`, inclusive of both. */
function daysInclusive(a: string, b: string): number {
  if (b < a) return 0;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;
}

/**
 * Days in the fiscal year a date falls in — 365, or 366 when it contains a
 * 29 February.
 *
 * The denominator for every pro-rata, and it has to be this rather than a
 * constant 365. With 365 fixed, a full year from 1 April 2027 to 31 March 2028
 * is 366 days and charges 366/365 of the annual figure — so a CA looking at a
 * plain full year sees 95,260.27 where the schedule says 95,000, and has to
 * work out whether we are wrong. The total still came right because the
 * residual cap catches it at the end, which is exactly the kind of
 * self-correcting error that wastes an afternoon.
 */
function daysInFiscalYear(date: string): number {
  const fy = fiscalYearOf(date);
  return daysInclusive(`${fy}-04-01`, `${fy + 1}-03-31`);
}

/** The later of two ISO dates. */
const later = (a: string, b: string): string => (a > b ? a : b);
/** The earlier of two ISO dates. */
const earlier = (a: string, b: string): string => (a < b ? a : b);

/**
 * The Indian fiscal year a date falls in, as its starting year.
 * April to March, so 2027-02-01 belongs to FY2026-27.
 */
export function fiscalYearOf(date: string): number {
  const y = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= 4 ? y : y - 1;
}

export interface AssetClass {
  key: string;
  name: string;
  assetAccountName: string;
  usefulLifeYears: string;
  bookMethod: 'slm' | 'wdv';
  residualPercent: string;
  taxBlock: string;
  taxWdvRate: string;
  /** The review marker, carried through so a charge can admit its provenance. */
  citation: string | null;
}

/** Every class in force on a date. */
export async function assetClasses(
  firmId: string, asOf: string,
): Promise<AssetClass[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{
      key: string; name: string; asset_account_name: string;
      useful_life_years: string; book_method: 'slm' | 'wdv';
      residual_percent: string; tax_block: string; tax_wdv_rate: string;
      source_citation: string | null;
    }>(
      `SELECT DISTINCT ON (key) key, name, asset_account_name,
              useful_life_years::text, book_method, residual_percent::text,
              tax_block, tax_wdv_rate::text, source_citation
         FROM asset_classes
        WHERE effective_from <= $1::date
          AND (effective_to IS NULL OR effective_to >= $1::date)
        ORDER BY key, effective_from DESC`, [asOf]);
    return r.rows.map((x) => ({
      key: x.key, name: x.name, assetAccountName: x.asset_account_name,
      usefulLifeYears: x.useful_life_years, bookMethod: x.book_method,
      residualPercent: x.residual_percent, taxBlock: x.tax_block,
      taxWdvRate: x.tax_wdv_rate, citation: x.source_citation,
    }));
  });
}

export interface CapitaliseInput {
  clientId: string;
  assetClassKey: string;
  description: string;
  identifier?: string;
  /**
   * What goes on the balance sheet.
   *
   * NOT the invoice total. GST recoverable as input credit is not part of the
   * cost; GST that s.17(5) blocks IS, because it can never be recovered — the
   * same distinction `createBill` already makes when it capitalises blocked
   * tax into the expense.
   */
  cost: string;
  /**
   * When it became available for use, which Schedule II depreciates from and
   * which is not always the invoice date: a machine delivered in March and
   * commissioned in May depreciates from May.
   */
  putToUseOn: string;
  sourceVoucherId?: string;
  partyId?: string;
  usefulLifeYears?: string;
  bookMethod?: 'slm' | 'wdv';
  createdBy: string;
}

/**
 * Puts an asset on the register.
 *
 * Records only. The ledger entry that created the asset is the bill (or the
 * opening entry) that bought it — capitalising does not post anything, because
 * the money already moved when the bill was booked. What this adds is the
 * knowledge that the debit sitting in Computers is a thing with a life, rather
 * than a number nobody will depreciate.
 */
export async function capitaliseAsset(
  firmId: string, input: CapitaliseInput,
): Promise<{ id: string; warnings: string[] }> {
  if (input.description.trim() === '') {
    throw new ValidationError('an asset needs a description', 'FA-1');
  }
  if (paise(input.cost) <= 0n) {
    throw new ValidationError('an asset has to cost something', 'FA-1');
  }

  return withFirm(firmId, async (c) => {
    const cls = await c.query<{ name: string; citation: string | null }>(
      `SELECT name, source_citation AS citation FROM asset_classes
        WHERE key = $1 AND effective_from <= $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY effective_from DESC LIMIT 1`,
      [input.assetClassKey, input.putToUseOn]);
    if (cls.rowCount === 0) {
      throw new ValidationError(
        `"${input.assetClassKey}" is not an asset class in force on ` +
        `${input.putToUseOn}. The class decides both the useful life and the ` +
        'tax block, so it cannot be guessed.', 'FA-1');
    }

    const r = await c.query<{ id: string }>(
      `INSERT INTO fixed_assets
         (firm_id, client_id, asset_class_key, description, identifier, cost,
          source_voucher_id, party_id, put_to_use_on, useful_life_years,
          book_method, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [firmId, input.clientId, input.assetClassKey, input.description.trim(),
       input.identifier ?? null, input.cost, input.sourceVoucherId ?? null,
       input.partyId ?? null, input.putToUseOn,
       input.usefulLifeYears ?? null, input.bookMethod ?? null,
       input.createdBy]);

    const warnings: string[] = [];
    const citation = cls.rows[0]!.citation;
    if (citation !== null && /NOT CA-REVIEWED/i.test(citation)) {
      warnings.push(
        `the useful life and tax rate for ${cls.rows[0]!.name} are on file but ` +
        `not reviewed — ${citation}. A wrong life misstates profit every year ` +
        'until the asset is written off, so confirm it before the first ' +
        'depreciation run.');
    }
    return { id: r.rows[0]!.id, warnings };
  });
}

interface AssetRow {
  id: string; description: string; identifier: string | null;
  asset_class_key: string; cost: string; put_to_use_on: string;
  disposed_on: string | null; disposal_proceeds: string | null;
  life: string; method: 'slm' | 'wdv'; residual: string;
  class_name: string; account_name: string;
  tax_block: string; tax_rate: string; charged: string;
}

/** Every asset with its class settings resolved and depreciation to date. */
async function assetsWithSettings(
  c: import('pg').PoolClient, clientId: string, asOf: string,
): Promise<AssetRow[]> {
  const r = await c.query<AssetRow>(
    `SELECT fa.id, fa.description, fa.identifier, fa.asset_class_key,
            fa.cost::text,
            to_char(fa.put_to_use_on,'YYYY-MM-DD') AS put_to_use_on,
            to_char(fa.disposed_on,'YYYY-MM-DD') AS disposed_on,
            fa.disposal_proceeds::text,
            -- The asset's own override, else the class in force when it was
            -- put to use. Not the class in force today: a life that changed in
            -- 2026 does not retrospectively re-depreciate a 2024 machine.
            COALESCE(fa.useful_life_years, ac.useful_life_years)::text AS life,
            COALESCE(fa.book_method, ac.book_method) AS method,
            COALESCE(fa.residual_percent, ac.residual_percent)::text AS residual,
            ac.name AS class_name, ac.asset_account_name AS account_name,
            ac.tax_block, ac.tax_wdv_rate::text AS tax_rate,
            COALESCE((SELECT SUM(dl.charge) FROM depreciation_lines dl
                       JOIN depreciation_runs dr ON dr.id = dl.run_id
                      WHERE dl.asset_id = fa.id AND dr.to_date <= $2::date), 0)::text
              AS charged
       FROM fixed_assets fa
       JOIN LATERAL (
         SELECT * FROM asset_classes
          WHERE key = fa.asset_class_key
            AND effective_from <= fa.put_to_use_on
            AND (effective_to IS NULL OR effective_to >= fa.put_to_use_on)
          ORDER BY effective_from DESC LIMIT 1
       ) ac ON true
      WHERE fa.client_id = $1
      ORDER BY fa.put_to_use_on, fa.created_at`,
    [clientId, asOf]);
  return r.rows;
}

export interface RegisterRow {
  id: string;
  description: string;
  identifier: string | null;
  className: string;
  cost: string;
  putToUseOn: string;
  /** Depreciation charged to date. */
  accumulated: string;
  /** Cost less accumulated — what the balance sheet carries. */
  carrying: string;
  /** The floor it may not depreciate below. */
  residualValue: string;
  disposedOn: string | null;
  disposalProceeds: string | null;
}

/** The register as at a date, disposals included and marked. */
export async function assetRegister(
  firmId: string, clientId: string, asOf: string,
): Promise<{ rows: RegisterRow[]; totalCost: string; totalCarrying: string }> {
  return withFirm(firmId, async (c) => {
    const assets = await assetsWithSettings(c, clientId, asOf);
    let totalCost = 0n, totalCarrying = 0n;
    const rows = assets.map((a) => {
      const cost = paise(a.cost);
      const acc = paise(a.charged);
      const carrying = a.disposed_on !== null && a.disposed_on <= asOf
        ? 0n : cost - acc;
      totalCost += a.disposed_on !== null && a.disposed_on <= asOf ? 0n : cost;
      totalCarrying += carrying;
      return {
        id: a.id, description: a.description, identifier: a.identifier,
        className: a.class_name, cost: money(cost),
        putToUseOn: a.put_to_use_on, accumulated: money(acc),
        carrying: money(carrying),
        residualValue: money((cost * paise(a.residual)) / 10000n),
        disposedOn: a.disposed_on, disposalProceeds: a.disposal_proceeds,
      };
    });
    return { rows, totalCost: money(totalCost), totalCarrying: money(totalCarrying) };
  });
}

export interface DepreciationLine {
  assetId: string;
  description: string;
  className: string;
  method: 'slm' | 'wdv';
  openingWdv: string;
  charge: string;
  closingWdv: string;
  days: number;
  note: string | null;
}

export interface DepreciationComputation {
  fromDate: string;
  toDate: string;
  lines: DepreciationLine[];
  total: string;
  warnings: string[];
}

/**
 * Book depreciation for a period, computed and not posted.
 *
 * Pro-rated by DAYS held in the period, because Schedule II depreciates from
 * the date an asset is available for use — a laptop bought on 20 March earns
 * eleven days of depreciation in that year, not a month and not a year.
 *
 * The charge is capped so an asset never falls below its residual value. That
 * cap is what stops a rounding drift over a fifteen-year life from writing an
 * asset past zero, which no arithmetic downstream would catch because the
 * voucher still balances.
 */
export async function computeDepreciation(
  firmId: string, clientId: string, fromDate: string, toDate: string,
): Promise<DepreciationComputation> {
  if (toDate < fromDate) {
    throw new ValidationError('the period ends before it begins', 'FA-2');
  }
  /*
   * One fiscal year at a time.
   *
   * Depreciation is annual by construction: the life is in years, the pro-rata
   * denominator is the year's own day count, and the tax side reckons by year
   * as well. A period crossing 31 March would mix two of each, so it is
   * refused rather than averaged.
   */
  if (fiscalYearOf(fromDate) !== fiscalYearOf(toDate)) {
    throw new ValidationError(
      `${fromDate} to ${toDate} crosses 31 March, so it spans two fiscal ` +
      'years. Depreciation is reckoned by year — the life, the pro-rata and ' +
      'the tax block all are — so run each year separately.', 'FA-2');
  }
  return withFirm(firmId, async (c) => {
    /*
     * Charged BEFORE this period, not up to its end.
     *
     * Using depreciation up to `toDate` would include a charge already made
     * for this very period on a re-run and quietly produce zero, hiding the
     * duplicate instead of refusing it.
     */
    const assets = await assetsWithSettings(c, clientId, fromDate);
    const lines: DepreciationLine[] = [];
    const warnings = new Set<string>();
    let total = 0n;

    for (const a of assets) {
      if (a.put_to_use_on > toDate) continue;                  // not yet in use
      if (a.disposed_on !== null && a.disposed_on < fromDate) continue;

      const cost = paise(a.cost);
      const residual = (cost * paise(a.residual)) / 10000n;
      const already = paise(a.charged);
      const opening = cost - already;
      if (opening <= residual) continue;                        // fully written down

      // The window the asset was actually held for, inside this period.
      const start = later(a.put_to_use_on, fromDate);
      const end = a.disposed_on === null ? toDate : earlier(a.disposed_on, toDate);
      const days = daysInclusive(start, end);
      if (days <= 0) continue;

      const life = Number(a.life);
      let charge: bigint;
      let note: string | null = null;

      const yearDays = BigInt(daysInFiscalYear(toDate));

      if (a.method === 'slm') {
        // (cost − residual) spread evenly over the life, then by days.
        const annual = (cost - residual) * 1000n / BigInt(Math.round(life * 1000));
        charge = (annual * BigInt(days) * 2n + yearDays) / (yearDays * 2n);
      } else {
        /*
         * The written-down rate implied by the life and the residual:
         *   r = 1 − (residual / cost) ^ (1 / life)
         *
         * Floating point is used for the RATE and nowhere else — the money
         * stays in integer paise, and the result is rounded once. A rate is a
         * ratio; only the rupees have to be exact.
         */
        const ratio = Number(residual) / Number(cost);
        const r = 1 - Math.pow(ratio > 0 ? ratio : 0.00001, 1 / life);
        charge = (opening * BigInt(Math.round(r * 1_000_000)) * BigInt(days))
                 / (1_000_000n * yearDays);
        note = `written down at ${(r * 100).toFixed(2)}% a year`;
      }

      // Never below the residual floor.
      const room = opening - residual;
      if (charge > room) {
        charge = room;
        note = (note ? note + '; ' : '') +
          'capped at the residual value, so this is the last charge';
      }
      if (charge <= 0n) continue;

      if (days < daysInclusive(fromDate, toDate)) {
        note = (note ? note + '; ' : '') +
          `held ${days} of ${daysInclusive(fromDate, toDate)} days in the period`;
      }

      total += charge;
      lines.push({
        assetId: a.id, description: a.description, className: a.class_name,
        method: a.method, openingWdv: money(opening), charge: money(charge),
        closingWdv: money(opening - charge), days, note,
      });
    }

    if (lines.length > 0) {
      warnings.add(
        'the useful lives behind these figures are on file but NOT ' +
        'CA-reviewed. A wrong life misstates profit every year until the asset ' +
        'is written off — confirm them against Companies Act 2013 Schedule II ' +
        'before this run is relied on.');
      warnings.add(
        'this is the BOOK charge and it is not the tax figure. Tax ' +
        'depreciation runs on a block of assets at Appendix I rates and comes ' +
        'out differently; the gap is the add-back in the income computation. ' +
        'The tax schedule is a separate report.');
    }

    return { fromDate, toDate, lines, total: money(total),
             warnings: [...warnings] };
  });
}

/**
 * Posts a period's book depreciation.
 *
 *   Depreciation              Dr  the charge
 *       Accumulated Depreciation  Cr
 *
 * A contra-asset, not a reduction of the asset account (Lesson 8): the cost
 * stays visible on the face of the register, which is what lets anyone see
 * what was paid as against what is left.
 *
 * A period may be charged ONCE. The unique constraint is the guard, because
 * running a month twice halves every asset's life and the voucher still
 * balances — nothing downstream would notice.
 */
export async function postDepreciation(
  firmId: string,
  input: {
    clientId: string; fromDate: string; toDate: string;
    createdBy: string; approvedBy: string;
  },
): Promise<{ voucherId: string; total: string; lines: number; warnings: string[] }> {
  const computed = await computeDepreciation(
    firmId, input.clientId, input.fromDate, input.toDate);
  if (computed.lines.length === 0) {
    throw new ValidationError(
      `nothing to depreciate between ${input.fromDate} and ${input.toDate} — ` +
      'either no asset was in use, or everything is already written down to ' +
      'its residual value.', 'FA-2');
  }

  return withFirm(firmId, async (c) => {
    const existing = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM depreciation_runs
        WHERE client_id = $1
          AND from_date <= $3::date AND to_date >= $2::date`,
      [input.clientId, input.fromDate, input.toDate]);
    if (Number(existing.rows[0]!.n) > 0) {
      throw new ValidationError(
        'depreciation has already been charged for a period overlapping ' +
        `${input.fromDate} to ${input.toDate}. Charging it twice halves every ` +
        'asset\'s life, and the voucher would still balance — so nothing ' +
        'downstream would catch it.', 'FA-3');
    }

    const account = async (name: string) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM accounts WHERE client_id = $1 AND name = $2
           AND NOT is_group LIMIT 1`, [input.clientId, name]);
      if (r.rowCount === 0) {
        throw new ValidationError(`account "${name}" not in chart`, 'FA-1');
      }
      return r.rows[0]!.id;
    };

    const posted = await postVoucher(firmId, {
      clientId: input.clientId,
      voucherType: 'depreciation',
      postingDate: input.toDate,
      narration:
        `Depreciation for ${input.fromDate} to ${input.toDate} — ` +
        `${computed.lines.length} asset(s)`,
      createdBy: input.createdBy,
      approvedBy: input.approvedBy,
      createdVia: 'ui',
      lines: [
        { accountId: await account('Depreciation'), debit: computed.total },
        { accountId: await account('Accumulated Depreciation'), credit: computed.total },
      ],
    });

    const run = await c.query<{ id: string }>(
      `INSERT INTO depreciation_runs
         (firm_id, client_id, voucher_id, from_date, to_date, total, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [firmId, input.clientId, posted.id, input.fromDate, input.toDate,
       computed.total, input.createdBy]);

    for (const l of computed.lines) {
      await c.query(
        `INSERT INTO depreciation_lines
           (run_id, asset_id, opening_wdv, charge, closing_wdv, days, method, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [run.rows[0]!.id, l.assetId, l.openingWdv, l.charge, l.closingWdv,
         l.days, l.method, l.note]);
    }

    return { voucherId: posted.id, total: computed.total,
             lines: computed.lines.length, warnings: computed.warnings };
  });
}

export interface TaxBlockRow {
  block: string;
  rate: string;
  openingWdv: string;
  /** Put to use for 180 days or more in the year — full rate. */
  additionsFullRate: string;
  /** Put to use for under 180 days — half rate, s.32 proviso. */
  additionsHalfRate: string;
  /** Sale proceeds, which reduce the block rather than producing a gain. */
  deductions: string;
  depreciation: string;
  closingWdv: string;
  note: string | null;
}

/**
 * Tax depreciation for a fiscal year — the block-of-assets computation.
 *
 * Nothing here posts. It is the schedule a CA fills in by hand every year, and
 * it differs from the books in three ways that all matter:
 *
 *   - the unit is the BLOCK, not the asset. Individual assets have no written
 *     down value of their own for tax, which is why a disposal produces no
 *     gain or loss — the proceeds simply come off the block;
 *   - the method is always written-down value at the Appendix I rate,
 *     whatever the books do;
 *   - an asset put to use for under 180 days in its first year gets HALF the
 *     rate, and only in that year.
 *
 * Computed by walking forward from the first asset rather than storing a
 * closing balance, so the figure is always consistent with the register as it
 * stands. Slower and self-correcting: an asset entered late lands in the right
 * year instead of quietly distorting every year after it.
 */
export async function taxDepreciationSchedule(
  firmId: string, clientId: string, fiscalYear: number,
): Promise<{ fiscalYear: string; blocks: TaxBlockRow[]; total: string;
             warnings: string[] }> {
  return withFirm(firmId, async (c) => {
    const end = `${fiscalYear + 1}-03-31`;
    const assets = await assetsWithSettings(c, clientId, end);
    const warnings: string[] = [];

    // Block state, carried forward year by year.
    const wdv = new Map<string, bigint>();
    const rateOf = new Map<string, string>();
    const first = assets.length === 0 ? fiscalYear
      : Math.min(...assets.map((a) => fiscalYearOf(a.put_to_use_on)));

    let rows: TaxBlockRow[] = [];
    for (let fy = first; fy <= fiscalYear; fy++) {
      const yearStart = `${fy}-04-01`;
      const yearEnd = `${fy + 1}-03-31`;
      const acc = new Map<string, { full: bigint; half: bigint; out: bigint }>();

      for (const a of assets) {
        rateOf.set(a.tax_block, a.tax_rate);
        const bucket = acc.get(a.tax_block)
          ?? { full: 0n, half: 0n, out: 0n };

        if (a.put_to_use_on >= yearStart && a.put_to_use_on <= yearEnd) {
          // The 180-day test: days from being put to use to the year end.
          const held = daysInclusive(a.put_to_use_on, yearEnd);
          if (held < 180) bucket.half += paise(a.cost);
          else bucket.full += paise(a.cost);
        }
        if (a.disposed_on !== null
            && a.disposed_on >= yearStart && a.disposed_on <= yearEnd) {
          bucket.out += paise(a.disposal_proceeds ?? '0');
        }
        acc.set(a.tax_block, bucket);
      }

      rows = [];
      for (const [block, b] of [...acc.entries()].sort()) {
        const opening = wdv.get(block) ?? 0n;
        const rate = paise(rateOf.get(block) ?? '0');   // percent × 100

        /*
         * Proceeds come off the FULL-rate side first, and the block cannot go
         * below zero. A block driven to nil by a sale bears no depreciation at
         * all that year, and the excess is a short-term capital gain — which is
         * a computation of its own and is flagged rather than guessed at.
         */
        let fullBase = opening + b.full - b.out;
        let halfBase = b.half;
        let note: string | null = null;
        if (fullBase < 0n) {
          halfBase += fullBase;
          fullBase = 0n;
          note = 'sale proceeds exceeded the block';
        }
        if (halfBase < 0n) {
          note = 'sale proceeds exceeded the whole block — a short-term ' +
                 'capital gain arises under s.50 and is not computed here';
          halfBase = 0n;
        }

        const dep = (fullBase * rate + 5000n) / 10000n
                  + (halfBase * rate + 10000n) / 20000n;
        const closing = fullBase + halfBase - dep;
        wdv.set(block, closing);

        if (fy === fiscalYear) {
          rows.push({
            block, rate: rateOf.get(block) ?? '0',
            openingWdv: money(opening),
            additionsFullRate: money(b.full),
            additionsHalfRate: money(b.half),
            deductions: money(b.out),
            depreciation: money(dep),
            closingWdv: money(closing),
            note,
          });
          if (note !== null) warnings.push(`${block}: ${note}`);
        }
      }
    }

    const total = rows.reduce((s, r) => s + paise(r.depreciation), 0n);
    if (rows.length > 0) {
      warnings.push(
        'these are the Appendix I rates on file and they are NOT CA-reviewed. ' +
        'Nothing here is posted — tax depreciation is a computation, and the ' +
        'difference between it and the book charge is the add-back in the ' +
        'income computation.');
      warnings.push(
        'additional depreciation under s.32(1)(iia) is not included, and nor ' +
        'is any restriction particular to the client\'s business. Both are ' +
        'judgements about the client rather than facts about the asset.');
    }
    return { fiscalYear: `${fiscalYear}-${String((fiscalYear + 1) % 100).padStart(2, '0')}`,
             blocks: rows, total: money(total), warnings };
  });
}

/**
 * Sells or scraps an asset.
 *
 *   Bank / Cash               Dr  proceeds
 *   Accumulated Depreciation  Dr  what was charged on it
 *       Fixed asset               Cr  its cost
 *       Other Income              Cr  a gain
 *   or
 *   Loss on Sale of Assets    Dr  a loss
 *
 * Both sides of the accumulated depreciation come off, which is the point of
 * holding it as a contra-asset: the asset leaves the books at cost and the
 * depreciation that was charged against it leaves with it.
 */
export async function disposeAsset(
  firmId: string,
  input: {
    clientId: string; assetId: string; disposedOn: string;
    /** Zero for something scrapped. */
    proceeds: string;
    /** Where the money arrived. Omit when there was none. */
    receivedIntoAccountId?: string;
    createdBy: string; approvedBy: string;
  },
): Promise<{ voucherId: string; carrying: string; proceeds: string;
             gain: string; warnings: string[] }> {
  return withFirm(firmId, async (c) => {
    const assets = await assetsWithSettings(c, input.clientId, input.disposedOn);
    const a = assets.find((x) => x.id === input.assetId);
    if (a === undefined) {
      throw new ValidationError('no such asset for this client', 'FA-1');
    }
    if (a.disposed_on !== null) {
      throw new ValidationError(
        `this asset was already disposed of on ${a.disposed_on}. Selling it ` +
        'twice would take its cost off the books twice.', 'FA-4');
    }
    if (input.disposedOn < a.put_to_use_on) {
      throw new ValidationError(
        'an asset cannot be disposed of before it was put to use', 'FA-4');
    }

    const proceeds = paise(input.proceeds);
    if (proceeds < 0n) {
      throw new ValidationError('proceeds cannot be negative', 'FA-4');
    }
    if (proceeds > 0n && input.receivedIntoAccountId === undefined) {
      throw new ValidationError(
        'say where the money went. Proceeds with nowhere to land would ' +
        'balance the voucher and lose the cash.', 'FA-4');
    }

    const cost = paise(a.cost);
    const accumulated = paise(a.charged);
    const carrying = cost - accumulated;
    const gain = proceeds - carrying;

    const account = async (name: string) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM accounts WHERE client_id = $1 AND name = $2
           AND NOT is_group LIMIT 1`, [input.clientId, name]);
      if (r.rowCount === 0) {
        throw new ValidationError(`account "${name}" not in chart`, 'FA-1');
      }
      return r.rows[0]!.id;
    };

    const lines: Array<{ accountId: string; debit?: string; credit?: string }> = [];
    if (proceeds > 0n) {
      lines.push({ accountId: input.receivedIntoAccountId!, debit: money(proceeds) });
    }
    if (accumulated > 0n) {
      lines.push({
        accountId: await account('Accumulated Depreciation'),
        debit: money(accumulated),
      });
    }
    lines.push({ accountId: await account(a.account_name), credit: money(cost) });
    if (gain > 0n) {
      lines.push({ accountId: await account('Other Income'), credit: money(gain) });
    } else if (gain < 0n) {
      lines.push({
        accountId: await account('Loss on Sale of Assets'), debit: money(-gain),
      });
    }

    const posted = await postVoucher(firmId, {
      clientId: input.clientId,
      voucherType: 'journal',
      postingDate: input.disposedOn,
      narration:
        `${proceeds > 0n ? 'Sold' : 'Scrapped'} ${a.description}` +
        (a.identifier ? ` (${a.identifier})` : '') +
        `, carrying ${money(carrying)}` +
        (gain === 0n ? '' : gain > 0n
          ? `, gain ${money(gain)}` : `, loss ${money(-gain)}`),
      createdBy: input.createdBy,
      approvedBy: input.approvedBy,
      createdVia: 'ui',
      lines,
    });

    await c.query(
      `UPDATE fixed_assets
          SET disposed_on = $2, disposal_proceeds = $3, disposal_voucher_id = $4
        WHERE id = $1 AND client_id = $5`,
      [input.assetId, input.disposedOn, money(proceeds), posted.id, input.clientId]);

    const warnings: string[] = [
      /*
       * The divergence a CA will be asked about. For tax there is no gain or
       * loss on one asset: the proceeds come off the block and depreciation
       * carries on at the block rate. The book gain or loss recorded above is
       * therefore an add-back or a deduction in the income computation.
       */
      `for tax there is no gain or loss on a single asset — the ${money(proceeds)} ` +
      'comes off the block and the block keeps depreciating. So the book ' +
      (gain >= 0n ? `gain of ${money(gain)}` : `loss of ${money(-gain)}`) +
      ' recorded here is adjusted in the income computation, not reported as ' +
      'it stands.',
    ];
    if (a.disposed_on === null && paise(a.charged) === 0n) {
      warnings.push(
        'no depreciation had been charged on this asset, so its whole cost is ' +
        'coming off at once. If it was in use for a period that has not been ' +
        'depreciated yet, run that first — the gain or loss depends on it.');
    }

    return { voucherId: posted.id, carrying: money(carrying),
             proceeds: money(proceeds),
             gain: money(gain), warnings };
  });
}
