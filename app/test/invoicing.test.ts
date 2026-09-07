/**
 * Invoicing acceptance tests — invoicing.md §13.
 * Uses the worked examples from Lesson 5 so expected figures are hand-derived.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, registerGstin, type SeededTenant } from '../src/seed/index.ts';
import { seedGstRates } from '../src/seed/gstRates.ts';
import { createInvoice, assertValidInvoiceNumber, invoiceOutstanding } from '../src/domain/invoicing.ts';
import { validateGstin, gstinCheckDigit, isIntraState } from '../src/domain/gstin.ts';
import { computeInvoice, verifyTaxFigures, money } from '../src/domain/tax.ts';
import { postVoucher } from '../src/domain/posting.ts';
import { trialBalance, balanceSheet } from '../src/reports/index.ts';
import { ownerPool, withFirm, closePools } from '../src/db/pool.ts';

let t: SeededTenant;
let mhCustomer: string;   // Maharashtra — same state as supplier
let kaCustomer: string;   // Karnataka — inter-state
let b2cCustomer: string;  // unregistered

const A = (n: string): string => {
  const id = t.accounts[n];
  if (!id) throw new Error(`missing account ${n}`);
  return id;
};

/** Build a checksum-valid GSTIN for a given state and PAN. */
function makeGstin(stateCode: string, pan: string, entity = '1'): string {
  const first14 = `${stateCode}${pan}${entity}Z`;
  return first14 + gstinCheckDigit(first14);
}

const SUPPLIER_GSTIN = makeGstin('27', 'AAPFS4321L');   // Maharashtra

beforeAll(async () => {
  await seedGstRates();

  t = await seedTenant({
    firmName: `Inv Firm ${randomUUID().slice(0, 8)}`,
    clientName: 'Shree Ram Trading',
    userEmail: `inv-${randomUUID()}@test.local`,
    startYear: 2026,
  });

  // Give the client its own GSTIN (Maharashtra).
  await registerGstin(t.firmId, t.clientId, SUPPLIER_GSTIN);

  const party = async (
    name: string, gstin: string | null, category: string, state: string | null,
  ) => withFirm(t.firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name,
                            gstin, gst_category, state_code, ledger_account_id, created_by)
       VALUES ($1,$2,'customer',$3,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [t.firmId, t.clientId, name, gstin, category, state, A('Debtors'), t.userId]);
    return r.rows[0]!.id;
  });

  mhCustomer = await party('Mumbai Traders', makeGstin('27', 'AABCM1234N'), 'registered_regular', '27');
  kaCustomer = await party('Bengaluru Systems', makeGstin('29', 'AACCB5678P'), 'registered_regular', '29');
  b2cCustomer = await party('Walk-in Customer', null, 'unregistered', '27');
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('GSTIN validation (SI-1, BE-4b)', () => {
  it('accepts a checksum-valid GSTIN', () => {
    expect(validateGstin(SUPPLIER_GSTIN).valid).toBe(true);
  });

  it('catches the real OCR misread at the layout layer', () => {
    // The exact failure the DeepSeek probe produced: AAPFS4321 -> AAFP54321.
    // A digit lands where the PAN requires a letter, so the layout check
    // rejects it before the checksum is even computed. Every arithmetic check
    // on that invoice had passed.
    const truth = makeGstin('27', 'AAPFS4321L');
    const misread = truth.replace('AAPFS4321', 'AAFP54321');
    expect(validateGstin(truth).valid).toBe(true);
    expect(validateGstin(misread).valid).toBe(false);
    expect(validateGstin(misread).reason).toMatch(/layout/i);
  });

  it('catches a layout-preserving transposition at the checksum layer', () => {
    // Swapping two letters inside the PAN keeps the shape legal, so only the
    // check digit can detect it. This is why both layers are needed.
    const truth = makeGstin('27', 'AAPFS4321L');
    const swapped = truth.replace('AAPFS', 'AAPSF');
    expect(validateGstin(swapped).valid).toBe(false);
    expect(validateGstin(swapped).reason).toMatch(/check digit/i);
  });

  it('rejects wrong length and malformed layout', () => {
    expect(validateGstin('27AAPFS4321L1Z').valid).toBe(false);
    expect(validateGstin('INVALID123456AB').valid).toBe(false);
    expect(validateGstin(null).valid).toBe(false);
  });

  it('derives intra vs inter state from the state code', () => {
    expect(isIntraState(SUPPLIER_GSTIN, '27')).toBe(true);
    expect(isIntraState(SUPPLIER_GSTIN, '29')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('tax computation (Lesson 5, invoicing.md §6)', () => {
  it('T-1 intra-state 18% splits into equal CGST and SGST', () => {
    const r = computeInvoice(
      [{ quantity: '1', unitPrice: '10000', gstRate: '18' }], true);
    expect(money(r.totalCgst)).toBe('900.00');
    expect(money(r.totalSgst)).toBe('900.00');
    expect(money(r.totalIgst)).toBe('0.00');
    expect(money(r.grandTotal)).toBe('11800.00');
  });

  it('T-2 inter-state 18% is a single IGST charge', () => {
    const r = computeInvoice(
      [{ quantity: '1', unitPrice: '10000', gstRate: '18' }], false);
    expect(money(r.totalIgst)).toBe('1800.00');
    expect(money(r.totalCgst)).toBe('0.00');
    expect(money(r.grandTotal)).toBe('11800.00');
  });

  it('T-3 rounds at line level, then sums', () => {
    const r = computeInvoice([
      { quantity: '3', unitPrice: '333.33', gstRate: '18' },
      { quantity: '7', unitPrice: '111.11', gstRate: '5' },
    ], true);
    const lineSum = r.lines.reduce((s, l) => s + l.cgst + l.sgst, 0n);
    expect(lineSum).toBe(r.totalCgst + r.totalSgst);   // header == Σ lines
  });

  it('T-20 absorbs sub-rupee difference to round off', () => {
    const r = computeInvoice([{ quantity: '1', unitPrice: '999.99', gstRate: '18' }], true);
    expect(r.grandTotal % 100n).toBe(0n);              // whole rupees
    expect(Math.abs(Number(r.roundOff))).toBeLessThanOrEqual(50);
  });

  it('charges nothing on zero-rated and exempt lines', () => {
    for (const treatment of ['zero_rated', 'exempt', 'nil_rated'] as const) {
      const r = computeInvoice(
        [{ quantity: '1', unitPrice: '10000', gstRate: '18', gstTreatment: treatment }], true);
      expect(money(r.totalCgst)).toBe('0.00');
      expect(money(r.grandTotal)).toBe('10000.00');
    }
  });

  it('T-7 independent recomputation detects a wrong tax figure (V-9, PB-4)', () => {
    const ok = verifyTaxFigures('10000', '18', true, { cgst: '900', sgst: '900' });
    expect(ok.matches).toBe(true);

    // 10,555 x 9% = 949.95. The document claiming 900 is understating tax.
    const bad = verifyTaxFigures('10555', '18', true, { cgst: '900', sgst: '900' });
    expect(bad.matches).toBe(false);
    expect(bad.expected.cgst).toBe('949.95');
    expect(bad.detail).toMatch(/computed/);
  });
});

// ---------------------------------------------------------------------------
describe('invoice numbering (Rule 46(b), invoicing.md §5)', () => {
  it('T-4 rejects a number over 16 characters', () => {
    expect(() => assertValidInvoiceNumber('INV/2026-2027/000001/A')).toThrow(/SI-9/);
  });

  it('rejects disallowed characters', () => {
    expect(() => assertValidInvoiceNumber('INV#0001')).toThrow(/SI-9/);
    expect(() => assertValidInvoiceNumber('INV 0001')).toThrow(/SI-9/);
  });

  it('accepts the FY-scoped series inside the limit', () => {
    expect(() => assertValidInvoiceNumber('INV/2026-27/0001')).not.toThrow();
  });

  it('T-8 allocates consecutively with no duplicates under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => createInvoice(t.firmId, {
        clientId: t.clientId, partyId: mhCustomer, postingDate: '2026-06-10',
        createdBy: t.userId,
        lines: [{ description: 'Widget', hsnSac: '7318', quantity: '1',
                  unitPrice: '100', incomeAccountId: A('Sales') }],
      })),
    );
    const numbers = results.map((r) => r.invoiceNumber);
    expect(new Set(numbers).size).toBe(8);             // no duplicates
    expect(numbers.every((n) => n.startsWith('INV/2026-27/'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('invoice creation and GL posting (invoicing.md §7)', () => {
  it('T-1 posts an intra-state sale as 4 ledger lines', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: mhCustomer, postingDate: '2026-07-01',
      createdBy: t.userId,
      lines: [{ description: 'Steel fasteners', hsnSac: '73181500',
                quantity: '200', unitPrice: '50', incomeAccountId: A('Sales') }],
    });

    expect(inv.intraState).toBe(true);
    expect(inv.taxableValue).toBe('10000.00');
    expect(inv.totalCgst).toBe('900.00');
    expect(inv.totalSgst).toBe('900.00');
    expect(inv.grandTotal).toBe('11800.00');

    const le = await withFirm(t.firmId, (c) => c.query(
      `SELECT count(*)::int AS n,
              SUM(debit)::text AS dr, SUM(credit)::text AS cr
       FROM ledger_entries WHERE voucher_id = $1`, [inv.voucherId]));
    expect(le.rows[0].n).toBe(4);
    expect(Number(le.rows[0].dr)).toBe(Number(le.rows[0].cr));
  });

  it('T-2 posts an inter-state sale as 3 ledger lines with IGST', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: kaCustomer, postingDate: '2026-07-02',
      createdBy: t.userId,
      lines: [{ description: 'Steel fasteners', hsnSac: '73181500',
                quantity: '200', unitPrice: '50', incomeAccountId: A('Sales') }],
    });

    expect(inv.intraState).toBe(false);
    expect(inv.totalIgst).toBe('1800.00');
    expect(inv.totalCgst).toBe('0.00');

    const le = await withFirm(t.firmId, (c) => c.query(
      'SELECT count(*)::int AS n FROM ledger_entries WHERE voucher_id = $1', [inv.voucherId]));
    expect(le.rows[0].n).toBe(3);
  });

  it('T-6 accepts a B2C invoice with no customer GSTIN', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: b2cCustomer, postingDate: '2026-07-03',
      createdBy: t.userId,
      lines: [{ description: 'Packing material', hsnSac: '48191010',
                quantity: '10', unitPrice: '120', incomeAccountId: A('Sales') }],
    });
    expect(inv.grandTotal).toBe('1416.00');            // 1200 + 18%
  });

  it('resolves the rate from the date-ranged master when not supplied', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: mhCustomer, postingDate: '2026-07-04',
      createdBy: t.userId,
      lines: [{ description: 'Branded rice', hsnSac: '10063010',
                quantity: '100', unitPrice: '50', incomeAccountId: A('Sales') }],
    });
    // HSN 1006 resolves to 5%, not the 18% default — longest prefix wins.
    expect(inv.totalCgst).toBe('125.00');
    expect(inv.grandTotal).toBe('5250.00');
  });

  it('records which rate row was used (provenance PR-7)', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: mhCustomer, postingDate: '2026-07-05',
      createdBy: t.userId,
      lines: [{ description: 'Adhesive', hsnSac: '35061000',
                quantity: '5', unitPrice: '1000', incomeAccountId: A('Sales') }],
    });
    const r = await withFirm(t.firmId, (c) => c.query(
      `SELECT gr.source_notification, gr.hsn_sac_prefix
       FROM sales_invoice_items sii JOIN gst_rates gr ON gr.id = sii.applied_rate_id
       WHERE sii.voucher_id = $1`, [inv.voucherId]));
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].hsn_sac_prefix).toBe('3506');
  });

  it('handles a mixed-rate invoice across two income accounts', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: mhCustomer, postingDate: '2026-07-06',
      createdBy: t.userId,
      lines: [
        { description: 'Goods at 18%', hsnSac: '73181500', quantity: '1',
          unitPrice: '10000', incomeAccountId: A('Sales') },
        { description: 'Service at 18%', hsnSac: '998314', quantity: '1',
          unitPrice: '5000', incomeAccountId: A('Service Income') },
      ],
    });
    expect(inv.taxableValue).toBe('15000.00');
    const le = await withFirm(t.firmId, (c) => c.query(
      'SELECT count(*)::int AS n FROM ledger_entries WHERE voucher_id = $1', [inv.voucherId]));
    expect(le.rows[0].n).toBe(5);   // debtors + 2 revenue + CGST + SGST
  });
});

// ---------------------------------------------------------------------------
describe('invoice validation', () => {
  it('T-5 blocks an invoice to a party whose GSTIN fails the check digit', async () => {
    const badId = await withFirm(t.firmId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO parties (firm_id, client_id, party_type, name, gstin,
                              gst_category, state_code, ledger_account_id, created_by)
         VALUES ($1,$2,'customer','Bad GSTIN Co','27AAFP54321L1ZK',
                 'registered_regular','27',$3,$4) RETURNING id`,
        [t.firmId, t.clientId, A('Debtors'), t.userId]);
      return r.rows[0]!.id;
    });

    await expect(createInvoice(t.firmId, {
      clientId: t.clientId, partyId: badId, postingDate: '2026-07-07',
      createdBy: t.userId,
      lines: [{ description: 'X', hsnSac: '7318', quantity: '1',
                unitPrice: '100', incomeAccountId: A('Sales') }],
    })).rejects.toThrow(/SI-1/);
  });

  it('blocks a line with no HSN (SI-5) — GSTR-1 would be unfileable', async () => {
    await expect(createInvoice(t.firmId, {
      clientId: t.clientId, partyId: mhCustomer, postingDate: '2026-07-08',
      createdBy: t.userId,
      lines: [{ description: 'X', hsnSac: '  ', quantity: '1',
                unitPrice: '100', incomeAccountId: A('Sales') }],
    })).rejects.toThrow(/SI-5/);
  });

  it('rejects an invalid place of supply (SI-4)', async () => {
    await expect(createInvoice(t.firmId, {
      clientId: t.clientId, partyId: mhCustomer, postingDate: '2026-07-09',
      placeOfSupply: '99', createdBy: t.userId,
      lines: [{ description: 'X', hsnSac: '7318', quantity: '1',
                unitPrice: '100', incomeAccountId: A('Sales') }],
    })).rejects.toThrow(/SI-4/);
  });

  it('T-16 blocks a composition dealer from charging GST (SI-11)', async () => {
    const compId = await withFirm(t.firmId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO parties (firm_id, client_id, party_type, name, gstin,
                              gst_category, state_code, ledger_account_id, created_by)
         VALUES ($1,$2,'customer','Composition Dealer',$3,
                 'registered_composition','27',$4,$5) RETURNING id`,
        [t.firmId, t.clientId, makeGstin('27', 'AAACC1111Q'), A('Debtors'), t.userId]);
      return r.rows[0]!.id;
    });

    await expect(createInvoice(t.firmId, {
      clientId: t.clientId, partyId: compId, postingDate: '2026-07-10',
      documentType: 'tax_invoice', createdBy: t.userId,
      lines: [{ description: 'X', hsnSac: '7318', quantity: '1',
                unitPrice: '1000', gstRate: '18', incomeAccountId: A('Sales') }],
    })).rejects.toThrow(/SI-11/);
  });

  it('T-19 snapshots the customer name so later edits cannot rewrite history', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: mhCustomer, postingDate: '2026-07-11',
      createdBy: t.userId,
      lines: [{ description: 'X', hsnSac: '7318', quantity: '1',
                unitPrice: '100', incomeAccountId: A('Sales') }],
    });

    await withFirm(t.firmId, (c) => c.query(
      'UPDATE parties SET name = $2, legal_name = $2 WHERE id = $1',
      [mhCustomer, 'Renamed Traders Pvt Ltd']));

    const snap = await withFirm(t.firmId, (c) => c.query(
      'SELECT customer_legal_name FROM sales_invoices WHERE voucher_id = $1', [inv.voucherId]));
    expect(snap.rows[0].customer_legal_name).toBe('Mumbai Traders');
  });
});

// ---------------------------------------------------------------------------
describe('settlement and integrity', () => {
  it('T-8/T-13 outstanding is derived from settlements, not stored', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: mhCustomer, postingDate: '2026-08-01',
      createdBy: t.userId,
      lines: [{ description: 'Goods', hsnSac: '73181500', quantity: '1',
                unitPrice: '10000', incomeAccountId: A('Sales') }],
    });

    let out = await invoiceOutstanding(t.firmId, inv.voucherId);
    expect(out.outstanding).toBe('11800.00');

    // Partial receipt of 5,000 against the invoice.
    await postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'receipt', postingDate: '2026-08-10',
      createdBy: t.userId,
      lines: [
        { accountId: A('Bank Accounts'), debit: '5000.00' },
        { accountId: A('Debtors'), credit: '5000.00', partyType: 'customer',
          partyId: mhCustomer, settlesVoucherId: inv.voucherId },
      ],
    });

    out = await invoiceOutstanding(t.firmId, inv.voucherId);
    expect(out.settled).toBe('5000.00');
    expect(out.outstanding).toBe('6800.00');
  });

  it('T-9/T-10 books still balance after all invoicing activity', async () => {
    const tb = await trialBalance(t.firmId, t.clientId, '2027-03-31');
    expect(tb.balanced).toBe(true);

    const bs = await balanceSheet(t.firmId, t.clientId, '2027-03-31');
    expect(bs.balanced).toBe(true);
  });

  it('output GST accumulates as a liability, not as revenue (Lesson 5)', async () => {
    const tb = await trialBalance(t.firmId, t.clientId, '2027-03-31');
    const cgst = tb.rows.find((r) => r.name === 'Output CGST Payable');
    expect(cgst).toBeDefined();
    expect(Number(cgst!.credit)).toBeGreaterThan(0);   // credit balance = liability
    expect(cgst!.rootType).toBe('liability');
  });
});

/**
 * The supplier's printed tax wins on a purchase bill — bills-and-expenses.md
 * §4.3.
 *
 * Not a concession to sloppy vendors. The credit claimed has to be the tax the
 * supplier charged, because that is the figure filed against us in GSTR-2B; a
 * ledger holding what we think they should have charged reconciles against
 * nothing. Every figure below is off a real invoice in the corpus.
 */
describe('a supplier\'s printed tax', () => {
  const line = (
    unitPrice: string, gstRate: string,
    chargedTax?: { cgst?: string; sgst?: string; igst?: string; cess?: string },
  ) => ({ quantity: '1', unitPrice, gstRate, chargedTax });

  it('is taken in place of the computed figure, and says it was', () => {
    // Amazon: 18% of 58.47 computes 10.52; the invoice prints 10.53, because
    // it was priced backwards from a round ₹69.00.
    const t = computeInvoice([line('58.47', '18', { igst: '10.53' })], false);
    expect(money(t.totalIgst)).toBe('10.53');
    expect(t.taxAsCharged).toBe(true);
    expect(money(t.grandTotal)).toBe('69.00');
  });

  it('is taken for each half of an intra-state charge', () => {
    // A Flipkart appliance: 9% of 8083.90 computes 727.55, printed 727.54
    // twice, against a stated total of 9539.00.
    const t = computeInvoice(
      [line('8083.90', '18', { cgst: '727.54', sgst: '727.54' })], true);
    expect(money(t.totalCgst)).toBe('727.54');
    expect(money(t.totalSgst)).toBe('727.54');
    expect(money(t.grandTotal)).toBe('9539.00');
    // 9538.98 rounded to the rupee: the two paise land in round-off.
    expect(money(t.roundOff)).toBe('0.02');
  });

  it('is refused when the rate cannot account for it', () => {
    // Two paise, not one: past what rounding explains, so it is a misread.
    expect(() => computeInvoice(
      [line('58.47', '18', { igst: '10.54' })], false)).toThrow(/misread/);
  });

  it('is refused when it is nowhere near the rate', () => {
    // The shape of a misread column: the rate's own figure, not the tax.
    expect(() => computeInvoice(
      [line('58.47', '18', { igst: '18.00' })], false)).toThrow(/PB-4/);
  });

  it('is ignored when the document splits the tax differently than we do', () => {
    /*
     * A document charging CGST+SGST where the place of supply computes IGST is
     * not a rounding disagreement, and deferring to it here dropped the tax to
     * zero: both printed halves went into components this calculation had at
     * nought. That disagreement is reported separately; the computation stands.
     */
    const t = computeInvoice(
      [line('1000.00', '18', { cgst: '90.00', sgst: '90.00' })], false);
    expect(money(t.totalIgst)).toBe('180.00');
    expect(money(t.totalCgst)).toBe('0.00');
    expect(t.taxAsCharged).toBe(false);
  });

  it('leaves a component the document did not print as computed', () => {
    // A document showing only IGST has not told us there is no cess.
    const t = computeInvoice(
      [{ quantity: '1', unitPrice: '100.00', gstRate: '18', cessRate: '12',
         chargedTax: { igst: '18.00' } }], false);
    expect(money(t.totalCess)).toBe('12.00');
  });

  it('is unaffected when the printed figure agrees exactly', () => {
    const t = computeInvoice([line('1000.00', '18', { igst: '180.00' })], false);
    expect(money(t.totalIgst)).toBe('180.00');
    expect(t.taxAsCharged).toBe(false);
  });
});

/**
 * Whether to round to the rupee is the supplier's decision — gl-engine.md V-10.
 *
 * Both of these are real documents. Rounding unconditionally posted the second
 * one at 521.00 with 36 paise of round-off it never printed.
 */
describe('rounding a bill to the total its document states', () => {
  const line = (unitPrice: string, gstRate: string, chargedTax?: object) =>
    ({ quantity: '1', unitPrice, gstRate, chargedTax }) as never;

  it('rounds to the nearest rupee when nothing is stated', () => {
    // An invoice we are raising: no document to defer to.
    const t = computeInvoice([line('8083.90', '18', { cgst: '727.54', sgst: '727.54' })], true);
    expect(money(t.grandTotal)).toBe('9539.00');
    expect(money(t.roundOff)).toBe('0.02');
  });

  it('takes a stated whole-rupee total, absorbing the difference', () => {
    const t = computeInvoice(
      [line('8083.90', '18', { cgst: '727.54', sgst: '727.54' })], true, '9539.00');
    expect(money(t.grandTotal)).toBe('9539.00');
    expect(money(t.roundOff)).toBe('0.02');
  });

  it('leaves a stated total that is not a whole rupee alone', () => {
    // 496.54 + 24.82 = 521.36, and the document says 521.36. Nothing to round.
    const t = computeInvoice([line('496.54', '5', { igst: '24.82' })], false, '521.36');
    expect(money(t.grandTotal)).toBe('521.36');
    expect(money(t.roundOff)).toBe('0.00');
  });

  it('refuses a stated total more than a rupee from its parts', () => {
    // Deferring this far would let a misread total rewrite the bill.
    expect(() => computeInvoice(
      [line('496.54', '5', { igst: '24.82' })], false, '531.36')).toThrow(/misread/);
  });
});
