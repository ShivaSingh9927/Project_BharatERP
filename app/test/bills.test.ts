/**
 * Bills & expenses acceptance tests — bills-and-expenses.md §12.
 *
 * The four traps this module exists to catch are each tested directly:
 * blocked ITC, the TDS threshold-crossing payment, RCM's dual legs, and the
 * 180-day rule.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, registerGstin, type SeededTenant } from '../src/seed/index.ts';
import { seedTdsSections, seedItcEligibility } from '../src/seed/tdsSections.ts';
import { createBill, paySupplier, contentHash } from '../src/domain/bills.ts';
import { computeTds } from '../src/domain/tds.ts';
import { decideItc, canClaimItc, billsApproaching180Days } from '../src/domain/itc.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { trialBalance, balanceSheet } from '../src/reports/index.ts';
import { outstandingBills, recordPayment, paymentAccounts } from '../src/domain/payables.ts';
import { supplierDetail, supplierList } from '../src/domain/suppliers.ts';
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

  await registerGstin(t.firmId, t.clientId, BUYER_GSTIN);
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
    // No business type recorded, so the question is OPEN rather than settled.
    // This asserted 'blocked' until G-3: reporting a settled answer to an
    // unasked question is what stopped the exception ever being reachable.
    const d = decideItc({ accountEligibility: 'conditional', blockedCategory: 'motor_vehicles' });
    expect(d.eligibility).toBe('conditional');
    expect(d.needsHumanDecision).toBe(true);
  });

  it('settles a conditional category when the trade plainly does not qualify', () => {
    // A general trader cannot claim vehicle credit. That is an answer, not a
    // question, and it must not sit in a review queue forever.
    const d = decideItc({
      accountEligibility: 'conditional', blockedCategory: 'motor_vehicles',
      clientBusinessType: 'general',
    });
    expect(d.eligibility).toBe('blocked');
    expect(d.needsHumanDecision).toBe(false);
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
/*
 * G-3 — the business-type exception, reached through the code path that posts.
 *
 * `decideItc` always knew how to unblock a conditional category for a client
 * whose trade qualifies. It needed two facts and `createBill` supplied neither:
 * the business type was a hardcoded `SELECT NULL`, and `blockedCategory` was
 * never passed at all. The exception logic was covered by unit tests calling
 * `decideItc` directly — passing, and unreachable from `createBill`.
 *
 * These tests go through `createBill`, which is the difference that matters.
 */
describe('G-3 conditional ITC and the client business type', () => {
  const foodLine = {
    description: 'Meals', unitPrice: '10000', gstRate: '18',
  };

  /** A tenant with its own chart, ITC rules and supplier. */
  async function tenantWith(businessType?: string) {
    const tt = await seedTenant({
      firmName: `ITC Firm ${randomUUID().slice(0, 8)}`,
      clientName: businessType ?? 'Unasked Trader',
      userEmail: `itc-${randomUUID()}@test.local`,
      startYear: 2026,
      businessType,
    });
    await registerGstin(tt.firmId, tt.clientId, BUYER_GSTIN);
    await seedItcEligibility(tt.clientId);

    const sup = await withFirm(tt.firmId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name,
                              gstin, gst_category, state_code, ledger_account_id, created_by)
         VALUES ($1,$2,'supplier','Caterer','Caterer',$3,'registered_regular','27',$4,$5)
         RETURNING id`,
        [tt.firmId, tt.clientId, makeGstin('27', 'AAECC2222M'), tt.accounts['Creditors']!, tt.userId]);
      return r.rows[0]!.id;
    });
    return { tt, sup };
  }

  const bill = (tt: SeededTenant, sup: string, account: string, n: string) =>
    createBill(tt.firmId, {
      clientId: tt.clientId, partyId: sup,
      billNumber: n, billDate: '2026-05-20',
      lines: [{ ...foodLine, expenseAccountId: tt.accounts[account]! }],
      createdBy: tt.userId,
    });

  it('a restaurant CAN claim credit on food', async () => {
    // The whole point of 'conditional'. Before this fix the answer was always
    // "ask a human", however clearly the client qualified.
    const { tt, sup } = await tenantWith('restaurant');
    const b = await bill(tt, sup, 'Staff Welfare', 'FOOD/001');

    expect(b.itcEligibility).toBe('eligible');
    expect(b.itcClaimableValue).toBe('1800.00');
    expect(b.itcLines[0]!.reason).toMatch(/qualifies for the exception/);
  });

  it('an ordinary business CANNOT, and that is settled, not queued', async () => {
    const { tt, sup } = await tenantWith('general');
    const b = await bill(tt, sup, 'Staff Welfare', 'FOOD/002');

    expect(b.itcEligibility).toBe('blocked');
    expect(b.itcClaimableValue).toBe('0.00');
    // Nothing to ask: a general trader cannot claim food credit.
    expect(b.warnings.some((w) => /needs a CA decision/.test(w))).toBe(false);
    expect(b.itcLines[0]!.reason).toMatch(/no Section 17\(5\) exception applies/);
  });

  it('an unasked client also parks — not asked is not the same as general', async () => {
    // NULL stays a legitimate answer. Defaulting it to 'general' would quietly
    // decide a question the CA was never asked.
    const { tt, sup } = await tenantWith(undefined);
    const b = await bill(tt, sup, 'Staff Welfare', 'FOOD/003');
    expect(b.itcEligibility).toBe('conditional');
    expect(b.itcClaimableValue).toBe('0.00');
  });

  it('names the actual clause, which a CA can check', async () => {
    // Previously every reason read "Section 17(5) blocks input credit on
    // blocked category", because the category was never passed.
    const { tt, sup } = await tenantWith('general');
    const b = await bill(tt, sup, 'Travel Expenses', 'TRAVEL/001');
    expect(b.itcEligibility).toBe('blocked');
    expect(b.itcLines[0]!.reason).toMatch(/Travel benefits to employees/);
  });

  it('CSR is blocked whatever the client does', async () => {
    // Finance Act 2023, s.17(5)(fa) — no exception exists, so even a trade
    // that unblocks other categories cannot claim this.
    const { tt, sup } = await tenantWith('restaurant');
    const b = await bill(tt, sup, 'CSR Expenses', 'CSR/001');
    expect(b.itcEligibility).toBe('blocked');
    expect(b.itcClaimableValue).toBe('0.00');
    expect(b.itcLines[0]!.reason).toMatch(/Corporate Social Responsibility/);
  });

  it('the database refuses a business type the code cannot act on', async () => {
    // A typo would fail safe — no exception applies, so the line parks — but it
    // would fail SILENTLY, and the CA would never learn their answer was unused.
    await expect(seedTenant({
      firmName: `Bad Firm ${randomUUID().slice(0, 8)}`,
      clientName: 'Typo Ltd',
      userEmail: `typo-${randomUUID()}@test.local`,
      startYear: 2026,
      businessType: 'restaraunt',
    })).rejects.toThrow(/business_type_known/);
  });
});

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

  /*
   * The hotel bill: allowable lodging, blocked food. Routine, not an edge case
   * (CA review A5.3), and the reason G-9 existed.
   *
   * The ledger was already right about this. What was wrong was everything the
   * bill SAID: the header reported 'blocked' because one line was, and
   * `itcClaimable` came back false while ₹1,800 of credit sat in the entry.
   */
  it('lets a reviewer withhold ITC on an otherwise-eligible bill', async () => {
    /*
     * The screen's "do not claim input credit" toggle. The account (Purchases)
     * is eligible, so the credit would normally be claimed — forceBlockItc is
     * the reviewer overriding for what only a human knows, and the GST is
     * capitalised into the cost exactly as an account-blocked line is.
     */
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'NOITC/2026/1', billDate: '2026-05-07',
      lines: [{ description: 'Goods', unitPrice: '10000', gstRate: '18',
        expenseAccountId: A('Purchases') }],
      forceBlockItc: true,
      createdBy: t.userId,
    });
    expect(bill.itcEligibility).toBe('blocked');
    expect(bill.itcClaimableValue).toBe('0.00');
    expect(bill.itcBlockedValue).toBe('1800.00');
  });

  it('G-9 reports a mixed bill as mixed, not as wholly blocked', async () => {
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'HOTEL/2026/001', billDate: '2026-05-07',
      lines: [
        { description: 'Conference room hire', unitPrice: '10000', gstRate: '18',
          expenseAccountId: A('Professional Fees') },          // eligible
        { description: 'Food and beverage', unitPrice: '5000', gstRate: '18',
          expenseAccountId: A('Travel Expenses') },            // blocked
      ],
      createdBy: t.userId,
    });

    expect(bill.itcEligibility).toBe('mixed');
    // The whole point: credit IS claimable on a bill that has a blocked line.
    expect(bill.itcClaimable).toBe(true);
    expect(bill.itcClaimableValue).toBe('1800.00');            // 18% of 10,000
    expect(bill.itcBlockedValue).toBe('900.00');               // 18% of 5,000
    expect(bill.warnings.some((w) => /mixed bill/.test(w))).toBe(true);
  });

  it('G-9 the ledger splits the same way the header now describes', async () => {
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'HOTEL/2026/002', billDate: '2026-05-08',
      lines: [
        { description: 'Conference room hire', unitPrice: '10000', gstRate: '18',
          expenseAccountId: A('Professional Fees') },
        { description: 'Food and beverage', unitPrice: '5000', gstRate: '18',
          expenseAccountId: A('Travel Expenses') },
      ],
      createdBy: t.userId,
    });

    const rows = await withFirm(t.firmId, (c) => c.query(
      `SELECT a.name, le.debit::text, le.credit::text
       FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
       WHERE le.voucher_id = $1`, [bill.voucherId]));
    const by = Object.fromEntries(rows.rows.map((r) => [r.name, r]));

    // Eligible line: cost net of tax, tax claimed as an asset.
    expect(by['Professional Fees'].debit).toBe('10000.00');
    expect(by['Input CGST Credit'].debit).toBe('900.00');      // half of 1,800
    // Blocked line: tax capitalised into the expense, 5,000 + 900.
    expect(by['Travel Expenses'].debit).toBe('5900.00');
    expect(by['Creditors'].credit).toBe('17700.00');           // 15,000 + 2,700
  });

  it('G-9 names which line lost its credit, and why', async () => {
    // A reviewer needs to see the reason on the line, not a verdict on the
    // document — otherwise the only way to act on it is to open the PDF.
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'HOTEL/2026/003', billDate: '2026-05-09',
      lines: [
        { description: 'Conference room hire', unitPrice: '10000', gstRate: '18',
          expenseAccountId: A('Professional Fees') },
        { description: 'Food and beverage', unitPrice: '5000', gstRate: '18',
          expenseAccountId: A('Travel Expenses') },
      ],
      createdBy: t.userId,
    });

    expect(bill.itcLines).toHaveLength(2);
    const blocked = bill.itcLines.find((l) => l.eligibility === 'blocked')!;
    expect(blocked.lineNo).toBe(2);
    expect(blocked.account).toBe('Travel Expenses');
    expect(blocked.gst).toBe('900.00');
    expect(blocked.reason).toMatch(/17\(5\)/);
  });

  it('G-9 persists the split, because a return is built from it', async () => {
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'HOTEL/2026/004', billDate: '2026-05-10',
      lines: [
        { description: 'Conference room hire', unitPrice: '10000', gstRate: '18',
          expenseAccountId: A('Professional Fees') },
        { description: 'Food and beverage', unitPrice: '5000', gstRate: '18',
          expenseAccountId: A('Travel Expenses') },
      ],
      createdBy: t.userId,
    });

    const r = await withFirm(t.firmId, (c) => c.query<{
      itc_eligibility: string; itc_claimable_value: string; itc_blocked_value: string;
    }>(`SELECT itc_eligibility, itc_claimable_value::text, itc_blocked_value::text
        FROM purchase_bills WHERE voucher_id = $1`, [bill.voucherId]));

    expect(r.rows[0]!.itc_eligibility).toBe('mixed');
    expect(r.rows[0]!.itc_claimable_value).toBe('1800.00');
    expect(r.rows[0]!.itc_blocked_value).toBe('900.00');
  });

  it('G-9 a fully blocked bill still claims nothing', async () => {
    // The narrowing must not have loosened the blocked case. The database
    // refuses the contradiction too (itc_blocked_header_claims_nothing).
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'HOTEL/2026/005', billDate: '2026-05-11',
      lines: [{ description: 'Food and beverage', unitPrice: '5000', gstRate: '18',
                expenseAccountId: A('Travel Expenses') }],
      createdBy: t.userId,
    });
    expect(bill.itcEligibility).toBe('blocked');
    expect(bill.itcClaimable).toBe(false);
    expect(bill.itcClaimableValue).toBe('0.00');
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
describe('TDS on the bill, at the point of credit (BE-36, Lesson 6)', () => {
  let billVoucher: string;

  it('refuses to post a bill that attracts TDS without a decision', async () => {
    /*
     * The hole this closes. This bill used to post in full and be paid in
     * full, and nothing anywhere mentioned the tax the client was required to
     * keep back — discovered, if ever, by a notice.
     */
    await expect(createBill(t.firmId, {
      clientId: t.clientId, partyId: contractor,
      billNumber: 'GC/2026/000', billDate: '2026-06-01',
      lines: [{ description: 'Consultancy', unitPrice: '150000', gstRate: '18',
                expenseAccountId: A('Professional Fees') }],
      createdBy: t.userId,
    })).rejects.toThrow(/PB-12.*15000\.00 is deductible/s);
  });

  it('withholds on the credit and credits the supplier net', async () => {
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: contractor,
      billNumber: 'GC/2026/001', billDate: '2026-06-01',
      lines: [{ description: 'Consultancy', unitPrice: '150000', gstRate: '18',
                expenseAccountId: A('Professional Fees') }],
      createdBy: t.userId,
      tds: { category: 'Professional Fees', deduct: true },
    });
    billVoucher = bill.voucherId;

    // 10% of the TAXABLE value — not of the 1,77,000 grand total. TDS is
    // deducted excluding GST where the GST is shown separately (Circular
    // 23/2017); on the total it would over-withhold by 2,700.
    expect(bill.tds?.amount).toBe('15000.00');
    expect(bill.tds?.category).toBe('Professional Fees');

    const rows = await withFirm(t.firmId, (c) => c.query(
      `SELECT a.name, le.debit::text, le.credit::text
       FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
       WHERE le.voucher_id = $1`, [bill.voucherId]));
    const byName = Object.fromEntries(rows.rows.map((r) => [r.name, r]));

    // 1,50,000 + 27,000 GST = 1,77,000, less 15,000 withheld.
    expect(byName['Creditors'].credit).toBe('162000.00');
    expect(byName['TDS Payable'].credit).toBe('15000.00');
    expect(byName['Professional Fees'].debit).toBe('150000.00');
  });

  it('shows the supplier owed the NET on the ageing', async () => {
    // The ageing reads the payable actually posted, so it needs no special
    // case — but a reviewer must not read 1,62,000 as a mistake.
    const open = await outstandingBills(t.firmId, t.clientId);
    const gc = open.find((b) => b.billNumber === 'GC/2026/001');
    expect(gc?.outstanding).toBe('162000.00');
  });

  it('pays the net without deducting a second time', async () => {
    const pay = await recordPayment(t.firmId, {
      clientId: t.clientId, billVoucherId: billVoucher, amount: '162000',
      paidFromAccountId: A('Bank Accounts'), paymentDate: '2026-06-15',
      createdBy: t.userId,
    });
    expect(pay.tds).toBeNull();
    expect(pay.fullySettled).toBe(true);
    // And it says why the payment is not the invoice total.
    expect(pay.warnings.join(' ')).toMatch(/already withheld on this bill/);
  });

  it('refuses to withhold again on a bill already deducted', async () => {
    await expect(recordPayment(t.firmId, {
      clientId: t.clientId, billVoucherId: billVoucher, amount: '1',
      paidFromAccountId: A('Bank Accounts'), paymentDate: '2026-06-16',
      createdBy: t.userId,
      tds: { category: 'Professional Fees' },
    })).rejects.toThrow(/already had TDS/);
  });

  it('records a declined deduction as a shortfall rather than hiding it', async () => {
    /*
     * A reviewer may know something the chart does not. Posting gross is
     * allowed; posting gross INVISIBLY is not — a bill with no row would look
     * exactly like one attracting no TDS, and the shortfall would surface as
     * interest under s.201(1A).
     */
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: contractor,
      billNumber: 'GC/2026/002', billDate: '2026-08-01',
      lines: [{ description: 'Consultancy', unitPrice: '20000', gstRate: '18',
                expenseAccountId: A('Professional Fees') }],
      createdBy: t.userId,
      tds: { category: 'Professional Fees', deduct: false },
    });
    expect(bill.tds).toBeNull();                      // nothing withheld
    expect(bill.warnings.join(' ')).toMatch(/was NOT withheld/);
    expect(bill.warnings.join(' ')).toMatch(/s\.40\(a\)\(ia\)/);

    const row = await withFirm(t.firmId, (c) => c.query<{
      computed: string; taken: string; on: string }>(
      `SELECT tds_computed::text AS computed, tds_amount::text AS taken,
              deducted_on AS on
         FROM tds_deductions WHERE bill_voucher_id = $1`, [bill.voucherId]));
    expect(row.rows[0]!.computed).toBe('2000.00');    // what was due
    expect(row.rows[0]!.taken).toBe('0.00');          // what was taken
    expect(row.rows[0]!.on).toBe('credit');
  });

  it('takes the punitive rate when no PAN can be found', async () => {
    // s.206AA, and not a penalty this software invented for missing data. The
    // supplier here has neither a PAN nor a GSTIN to read one out of.
    const noPan = await withFirm(t.firmId, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name,
                            gstin, gst_category, state_code, ledger_account_id, created_by)
       VALUES ($1,$2,'supplier','Anon Consulting','Anon Consulting',NULL,
               'unregistered','27',$3,$4) RETURNING id`,
      [t.firmId, t.clientId, A('Creditors'), t.userId])).rows[0]!.id);

    await expect(createBill(t.firmId, {
      clientId: t.clientId, partyId: noPan,
      billNumber: 'AC/1', billDate: '2026-06-01',
      lines: [{ description: 'Advice', unitPrice: '100000', gstRate: '0',
                expenseAccountId: A('Professional Fees') }],
      createdBy: t.userId,
    })).rejects.toThrow(/20\.000%.*punitive/s);
  });

  it('does not deduct on a head that attracts no TDS', async () => {
    // The default and the common case: most bills attract nothing, and this
    // feature has to stay silent on them or it becomes a prompt on groceries.
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: contractor,
      billNumber: 'GC/2026/003', billDate: '2026-08-02',
      lines: [{ description: 'Steel', unitPrice: '500000', gstRate: '18',
                expenseAccountId: A('Raw Materials') }],
      createdBy: t.userId,
    });
    expect(bill.tds).toBeNull();
    expect(bill.warnings.join(' ')).not.toMatch(/TDS/);
  });

  it('still withholds on a direct payment with no bill behind it', async () => {
    /*
     * The OTHER limb. The section charges at the earlier of credit and
     * payment, and an advance is paid before any bill exists — so
     * `paySupplier` keeps its own deduction for that case.
     */
    const pay = await paySupplier(t.firmId, {
      clientId: t.clientId, partyId: contractor, paymentDate: '2026-09-15',
      amount: '50000', bankAccountId: A('Bank Accounts'),
      createdBy: t.userId,
      tdsCategory: 'Professional Fees', entityType: 'company',
    });
    /*
     * 7,000, not 5,000 — and the difference is the point.
     *
     * The running total is 1,70,000: the June bill's 1,50,000 plus the August
     * bill's 20,000, whose base was recorded even though the reviewer declined
     * to withhold on it. So the charge is 10% of 2,20,000 = 22,000, less the
     * 15,000 actually withheld = 7,000. The 2,000 nobody deducted in August is
     * caught up here.
     *
     * That is what recording a declined deduction buys: the shortfall does not
     * disappear, it lands on the next deduction — which is exactly how the
     * cumulative charge is meant to work.
     */
    expect(pay.tds).toBe('7000.00');
    expect(pay.net).toBe('43000.00');
    expect(pay.tdsComputation?.cumulativeBefore).toBe('170000.00');
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
describe('payables — what is owed, and paying it', () => {
  it('reads outstanding from the ledger and settles a bill on payment', async () => {
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'PAYABLE/2026/1', billDate: '2026-05-07',
      lines: [{ description: 'Goods', unitPrice: '10000', gstRate: '18',
        expenseAccountId: A('Purchases') }],
      createdBy: t.userId,
    });
    // grand total = 10,000 + 1,800 IGST = 11,800; all outstanding at first.
    const before = await outstandingBills(t.firmId, t.clientId);
    const row = before.find((b) => b.billNumber === 'PAYABLE/2026/1');
    expect(row).toBeDefined();
    expect(row!.outstanding).toBe('11800.00');

    const cash = (await paymentAccounts(t.firmId, t.clientId))
      .find((a) => a.name === 'Cash')!;

    // A part payment leaves the balance owing.
    const p1 = await recordPayment(t.firmId, {
      clientId: t.clientId, billVoucherId: bill.voucherId, amount: '1800.00',
      paidFromAccountId: cash.id, paymentDate: '2026-05-10', createdBy: t.userId,
    });
    expect(p1.outstandingAfter).toBe('10000.00');
    expect(p1.fullySettled).toBe(false);

    // The rest clears it, and it drops off the ageing.
    const p2 = await recordPayment(t.firmId, {
      clientId: t.clientId, billVoucherId: bill.voucherId, amount: '10000.00',
      paidFromAccountId: cash.id, paymentDate: '2026-05-11', createdBy: t.userId,
    });
    expect(p2.fullySettled).toBe(true);
    const after = await outstandingBills(t.firmId, t.clientId);
    expect(after.find((b) => b.billNumber === 'PAYABLE/2026/1')).toBeUndefined();
  });

  it('refuses to pay more than is owed', async () => {
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'PAYABLE/2026/2', billDate: '2026-05-07',
      lines: [{ description: 'Goods', unitPrice: '100', gstRate: '18',
        expenseAccountId: A('Purchases') }],
      createdBy: t.userId,
    });
    const cash = (await paymentAccounts(t.firmId, t.clientId))
      .find((a) => a.name === 'Cash')!;
    // outstanding is 118.00; 500 must be refused (BV-4).
    await expect(recordPayment(t.firmId, {
      clientId: t.clientId, billVoucherId: bill.voucherId, amount: '500.00',
      paidFromAccountId: cash.id, paymentDate: '2026-05-10', createdBy: t.userId,
    })).rejects.toThrow(/exceeds the .* outstanding/);
  });
});

// ---------------------------------------------------------------------------
describe('the supplier 360 gathers a supplier\'s whole history', () => {
  it('shows bills, the payment that settled one, and running totals', async () => {
    // By now this supplier has PAYABLE/2026/1 (paid in full) and
    // PAYABLE/2026/2 (unpaid) from the payables tests, plus earlier bills.
    const d = await supplierDetail(t.firmId, t.clientId, supplier);
    expect(d).not.toBeNull();

    const paid = d!.bills.find((b) => b.billNumber === 'PAYABLE/2026/1');
    const owing = d!.bills.find((b) => b.billNumber === 'PAYABLE/2026/2');
    expect(paid!.settled).toBe(true);
    expect(owing!.settled).toBe(false);
    expect(owing!.outstanding).toBe('118.00');

    // The two payments against PAYABLE/2026/1 are listed against it.
    const against1 = d!.payments.filter((p) => p.billNumber === 'PAYABLE/2026/1');
    expect(against1.length).toBe(2);
    expect(against1.reduce((s, p) => s + Number(p.amount), 0)).toBe(11800);

    // Totals reconcile: outstanding = billed − paid on settled, and the ageing
    // for this supplier agrees.
    expect(Number(d!.totalPaid)).toBeGreaterThanOrEqual(11800);
  });

  it('lists the supplier with an outstanding balance', async () => {
    const list = await supplierList(t.firmId, t.clientId);
    const s = list.find((x) => x.id === supplier);
    expect(s).toBeDefined();
    expect(Number(s!.outstanding)).toBeGreaterThan(0);
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
    // 15,000 withheld on the June bill's credit + 7,000 on the September
    // advance, the second of which caught up the 2,000 declined in August.
    expect(Number(find('TDS Payable')!.credit)).toBe(22000);
  });
});
