/**
 * Bills & expenses acceptance tests — bills-and-expenses.md §12.
 *
 * The four traps this module exists to catch are each tested directly:
 * blocked ITC, the TDS threshold-crossing payment, RCM's dual legs, and the
 * 180-day rule.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { seedTdsSections, seedItcEligibility } from '../src/seed/tdsSections.ts';
import { createBill, paySupplier, contentHash } from '../src/domain/bills.ts';
import { computeTds } from '../src/domain/tds.ts';
import { decideItc, canClaimItc, billsApproaching180Days } from '../src/domain/itc.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { trialBalance, balanceSheet } from '../src/reports/index.ts';
import { ownerPool, withFirm, closePools } from '../src/db/pool.ts';

let t: SeededTenant;
let supplier: string;
let contractor: string;

const A = (n: string): string => {
  const id = t.accounts[n];
  if (!id) throw new Error(`missing account ${n}`);
  return id;
};

function makeGstin(state: string, pan: string, entity = '1'): string {
  const first14 = `${state}${pan}${entity}Z`;
  return first14 + gstinCheckDigit(first14);
}

const BUYER_GSTIN = makeGstin('27', 'AAPFB1111L');

beforeAll(async () => {
  await seedTdsSections();

  t = await seedTenant({
    firmName: `Bills Firm ${randomUUID().slice(0, 8)}`,
    clientName: 'Bharat Traders',
    userEmail: `bill-${randomUUID()}@test.local`,
    startYear: 2026,
  });

  await ownerPool.query(
    'UPDATE clients SET gstin = $2, state_code = $3 WHERE id = $1',
    [t.clientId, BUYER_GSTIN, '27']);
  await seedItcEligibility(t.clientId);

  const mkParty = (name: string, gstin: string | null) =>
    withFirm(t.firmId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name,
                              gstin, gst_category, state_code, ledger_account_id, created_by)
         VALUES ($1,$2,'supplier',$3,$3,$4,$5,'27',$6,$7) RETURNING id`,
        [t.firmId, t.clientId, name, gstin,
         gstin ? 'registered_regular' : 'unregistered', A('Creditors'), t.userId]);
      return r.rows[0]!.id;
    });

  supplier = await mkParty('Shree Steel Supplies', makeGstin('27', 'AABCS2222M'));
  contractor = await mkParty('Ganesh Contractors', makeGstin('27', 'AACCG3333N'));
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('TDS threshold crossing (BE-10, Lesson 6)', () => {
  const section = {
    sectionId: randomUUID(), code: '393(3)', rate: '2',
    singleThreshold: '30000', cumulativeThreshold: '100000',
    deductOnFullCumulative: true,
  };

  it('no TDS below both thresholds', () => {
    const r = computeTds({ ...section, paymentAmount: '28000',
      cumulativeBefore: '0', alreadyDeducted: '0' });
    expect(r.tdsAmount).toBe('0.00');
    expect(r.thresholdCrossed).toBe(false);
  });

  it('T-8 the crossing payment charges the FULL cumulative, not just itself', () => {
    // The trap. Paid 28,000 already; now paying 80,000. Cumulative 108,000
    // crosses the 100,000 annual threshold. Naive answer: 2% of 80,000 = 1,600.
    // Correct answer: 2% of 108,000 = 2,160.
    const r = computeTds({ ...section, paymentAmount: '80000',
      cumulativeBefore: '28000', alreadyDeducted: '0' });

    expect(r.thresholdCrossed).toBe(true);
    expect(r.taxableBase).toBe('108000.00');
    expect(r.tdsAmount).toBe('2160.00');          // NOT 1600.00
    expect(r.explanation).toMatch(/full cumulative/);
  });

  it('subsequent payments charge only themselves, no double-counting', () => {
    const r = computeTds({ ...section, paymentAmount: '50000',
      cumulativeBefore: '108000', alreadyDeducted: '2160' });
    // 2% of 158,000 = 3,160, less 2,160 already withheld = 1,000
    // which is exactly 2% of this 50,000 payment.
    expect(r.tdsAmount).toBe('1000.00');
    expect(r.thresholdCrossed).toBe(false);
  });

  it('a single large payment triggers the per-transaction threshold', () => {
    const r = computeTds({ ...section, paymentAmount: '45000',
      cumulativeBefore: '0', alreadyDeducted: '0' });
    expect(r.tdsAmount).toBe('900.00');           // 2% of 45,000
  });

  it('a no-PAN payee attracts the punitive rate', () => {
    const r = computeTds({ ...section, rate: '20', paymentAmount: '45000',
      cumulativeBefore: '0', alreadyDeducted: '0' });
    expect(r.tdsAmount).toBe('9000.00');          // 20% not 2%
  });

  it('records the arithmetic for provenance (PR-8)', () => {
    const r = computeTds({ ...section, paymentAmount: '80000',
      cumulativeBefore: '28000', alreadyDeducted: '0' });
    expect(r.explanation).toMatch(/108000\.00 × 2% = 2160\.00/);
  });
});

// ---------------------------------------------------------------------------
describe('ITC eligibility (BE-6, §6.2)', () => {
  it('eligible by default', () => {
    expect(decideItc({ accountEligibility: 'eligible' }).eligibility).toBe('eligible');
  });

  it('T-3 blocks Section 17(5) categories outright', () => {
    const d = decideItc({ accountEligibility: 'blocked', blockedCategory: 'food_beverages' });
    expect(d.eligibility).toBe('blocked');
    expect(d.reason).toMatch(/17\(5\)/);
    expect(d.needsHumanDecision).toBe(false);
  });

  it('conditional categories need a CA decision, not a guess', () => {
    const d = decideItc({ accountEligibility: 'conditional', blockedCategory: 'motor_vehicles' });
    expect(d.eligibility).toBe('blocked');
    expect(d.needsHumanDecision).toBe(true);
  });

  it('unblocks a conditional category when the business qualifies', () => {
    const d = decideItc({
      accountEligibility: 'conditional', blockedCategory: 'motor_vehicles',
      clientBusinessType: 'transport',
    });
    expect(d.eligibility).toBe('eligible');
    expect(d.needsHumanDecision).toBe(false);
  });
});

describe('ITC claimability vs eligibility (§6.3)', () => {
  it('T-4 refuses a claim when the supplier has not reported it in 2B', () => {
    const r = canClaimItc({ eligibility: 'eligible', gstr2bStatus: 'missing_in_2b' });
    expect(r.claimable).toBe(false);
    expect(r.reason).toMatch(/chase the vendor/);
  });

  it('permits a claim on an explicit CA override, with the reason recorded', () => {
    const r = canClaimItc({
      eligibility: 'eligible', gstr2bStatus: 'missing_in_2b',
      overrideReason: 'supplier confirmed late filing for the period',
    });
    expect(r.claimable).toBe(true);
    expect(r.reason).toMatch(/override/);
  });

  it('an eligible expense with a matched 2B entry is claimable', () => {
    expect(canClaimItc({ eligibility: 'eligible', gstr2bStatus: 'exact_match' }).claimable).toBe(true);
  });

  it('a blocked expense is never claimable regardless of 2B', () => {
    expect(canClaimItc({ eligibility: 'blocked', gstr2bStatus: 'exact_match' }).claimable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('bill creation and GL posting (§9)', () => {
  it('posts an ITC-eligible bill with Input GST as an asset', async () => {
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'SS/2026/001', billDate: '2026-05-05',
      lines: [{ description: 'Steel rods', hsnSac: '7214', unitPrice: '10000',
                gstRate: '18', expenseAccountId: A('Raw Materials') }],
      createdBy: t.userId,
    });

    expect(bill.itcEligibility).toBe('eligible');
    expect(bill.totalGst).toBe('1800.00');
    expect(bill.grandTotal).toBe('11800.00');

    const rows = await withFirm(t.firmId, (c) => c.query(
      `SELECT a.name, le.debit::text, le.credit::text
       FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
       WHERE le.voucher_id = $1 ORDER BY le.line_no`, [bill.voucherId]));

    const byName = Object.fromEntries(rows.rows.map((r) => [r.name, r]));
    expect(byName['Raw Materials'].debit).toBe('10000.00');    // cost excludes GST
    expect(byName['Input CGST Credit'].debit).toBe('900.00');  // GST is an asset
    expect(byName['Creditors'].credit).toBe('11800.00');
  });

  it('T-3 blocked ITC puts the GST into the expense instead', async () => {
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'SS/2026/002', billDate: '2026-05-06',
      lines: [{ description: 'Team offsite travel', unitPrice: '10000',
                gstRate: '18', expenseAccountId: A('Travel Expenses') }],
      createdBy: t.userId,
    });

    expect(bill.itcEligibility).toBe('blocked');
    expect(bill.warnings.some((w) => /added to cost/.test(w))).toBe(true);

    const rows = await withFirm(t.firmId, (c) => c.query(
      `SELECT a.name, le.debit::text FROM ledger_entries le
       JOIN accounts a ON a.id = le.account_id
       WHERE le.voucher_id = $1 AND le.debit > 0`, [bill.voucherId]));

    // 11,800 — not 10,000 — because unrecoverable tax is part of the cost.
    // This changes reported profit by the tax amount.
    expect(rows.rows.find((r) => r.name === 'Travel Expenses')!.debit).toBe('11800.00');
    expect(rows.rows.find((r) => r.name === 'Input CGST Credit')).toBeUndefined();
  });

  it('T-7 reverse charge creates BOTH a liability and a credit (BE-8/BE-9)', async () => {
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'SS/2026/003', billDate: '2026-05-07',
      isReverseCharge: true,
      lines: [{ description: 'Goods transport (GTA)', unitPrice: '10000',
                gstRate: '18', expenseAccountId: A('Freight Inward') }],
      createdBy: t.userId,
    });

    const rows = await withFirm(t.firmId, (c) => c.query(
      `SELECT a.name, le.debit::text, le.credit::text
       FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
       WHERE le.voucher_id = $1`, [bill.voucherId]));
    const byName = Object.fromEntries(rows.rows.map((r) => [r.name, r]));

    // Input credit AND output liability, both 900 each side.
    expect(byName['Input CGST Credit'].debit).toBe('900.00');
    expect(byName['Output CGST Payable'].credit).toBe('900.00');
    // The supplier is owed only the taxable value — we pay the tax to govt.
    expect(byName['Creditors'].credit).toBe('10000.00');
  });

  it('PB-2 rejects the same bill number from the same supplier twice', async () => {
    await expect(createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'SS/2026/001', billDate: '2026-05-08',
      lines: [{ description: 'Duplicate', unitPrice: '100', gstRate: '18',
                expenseAccountId: A('Raw Materials') }],
      createdBy: t.userId,
    })).rejects.toThrow();
  });

  it('PB-4 flags a vendor arithmetic error without silently correcting it', async () => {
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'SS/2026/004', billDate: '2026-05-09',
      lines: [{ description: 'Goods', unitPrice: '10555', gstRate: '18',
                expenseAccountId: A('Raw Materials') }],
      // The vendor's document says 900 each; 10,555 x 9% is 949.95.
      claimedTotals: { cgst: '900', sgst: '900' },
      createdBy: t.userId,
    });

    expect(bill.warnings.some((w) => /PB-4 tax mismatch/.test(w))).toBe(true);
    // Our computed figure is used; the document's claim is not adopted.
    expect(bill.totalGst).toBe('1899.90');
  });

  it('BE-2 content hash detects the same document arriving twice', () => {
    const bytes = Buffer.from('%PDF-1.4 vendor invoice body');
    expect(contentHash(bytes)).toBe(contentHash(Buffer.from('%PDF-1.4 vendor invoice body')));
    expect(contentHash(bytes)).not.toBe(contentHash(Buffer.from('different')));
  });
});

// ---------------------------------------------------------------------------
describe('supplier payment with TDS (Lesson 6)', () => {
  it('withholds TDS and pays the net amount', async () => {
    await createBill(t.firmId, {
      clientId: t.clientId, partyId: contractor,
      billNumber: 'GC/2026/001', billDate: '2026-06-01',
      lines: [{ description: 'Site works', unitPrice: '150000', gstRate: '18',
                expenseAccountId: A('Professional Fees') }],
      createdBy: t.userId,
    });

    const pay = await paySupplier(t.firmId, {
      clientId: t.clientId, partyId: contractor, paymentDate: '2026-06-15',
      amount: '150000', bankAccountId: A('Bank Accounts'),
      createdBy: t.userId,
      tdsCategory: 'Professional Fees', entityType: 'company',
    });

    expect(pay.tds).toBe('15000.00');            // 10% of 150,000
    expect(pay.net).toBe('135000.00');
    expect(pay.tdsComputation?.thresholdCrossed).toBe(true);

    const rows = await withFirm(t.firmId, (c) => c.query(
      `SELECT a.name, le.debit::text, le.credit::text
       FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
       WHERE le.voucher_id = $1`, [pay.voucherId]));
    const byName = Object.fromEntries(rows.rows.map((r) => [r.name, r]));

    expect(byName['Creditors'].debit).toBe('150000.00');
    expect(byName['TDS Payable'].credit).toBe('15000.00');
    expect(byName['Bank Accounts'].credit).toBe('135000.00');
  });

  it('accumulates cumulative totals across payments to the same party', async () => {
    const second = await paySupplier(t.firmId, {
      clientId: t.clientId, partyId: contractor, paymentDate: '2026-07-15',
      amount: '50000', bankAccountId: A('Bank Accounts'),
      createdBy: t.userId,
      tdsCategory: 'Professional Fees', entityType: 'company',
    });
    // Threshold already crossed, so only this payment is charged: 10% of 50,000.
    expect(second.tds).toBe('5000.00');
    expect(second.tdsComputation?.cumulativeBefore).toBe('150000.00');
  });
});

// ---------------------------------------------------------------------------
describe('180-day ITC reversal monitor (BE-7)', () => {
  it('T-5 warns before the reversal becomes mandatory', async () => {
    await withFirm(t.firmId, (c) => c.query(
      `UPDATE purchase_bills SET approval_status = 'approved'
       WHERE client_id = $1`, [t.clientId]));

    // Bill dated 5 May 2026, evaluated at 10 Oct 2026 = 158 days.
    const atRisk = await withFirm(t.firmId, (c) =>
      billsApproaching180Days(c, t.clientId, '2026-10-10'));

    const bill = atRisk.find((b) => b.billNumber === 'SS/2026/001');
    expect(bill).toBeDefined();
    expect(bill!.daysElapsed).toBeGreaterThanOrEqual(150);
    expect(bill!.breached).toBe(false);          // warned, not yet breached
    expect(Number(bill!.itcAtRisk)).toBe(1800);
  });

  it('T-6 marks bills past 180 days as breached', async () => {
    const atRisk = await withFirm(t.firmId, (c) =>
      billsApproaching180Days(c, t.clientId, '2026-12-01'));
    expect(atRisk.some((b) => b.breached)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('integrity after purchase activity', () => {
  it('books still balance', async () => {
    const tb = await trialBalance(t.firmId, t.clientId, '2027-03-31');
    expect(tb.balanced).toBe(true);
    const bs = await balanceSheet(t.firmId, t.clientId, '2027-03-31');
    expect(bs.balanced).toBe(true);
  });

  it('Input GST sits as an asset, Output GST and TDS as liabilities', async () => {
    const tb = await trialBalance(t.firmId, t.clientId, '2027-03-31');
    const find = (n: string) => tb.rows.find((r) => r.name === n);

    expect(find('Input CGST Credit')!.rootType).toBe('asset');
    expect(Number(find('Input CGST Credit')!.debit)).toBeGreaterThan(0);
    expect(find('TDS Payable')!.rootType).toBe('liability');
    expect(Number(find('TDS Payable')!.credit)).toBe(20000);   // 15,000 + 5,000
  });
});
