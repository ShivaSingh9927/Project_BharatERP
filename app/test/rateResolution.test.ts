/**
 * GST rate resolution — invoicing.md §4.4, provenance.md PR-7.
 * CA review answers A3.1 (refuse an unmatched HSN) and A3.3 (date-ranging).
 * Gap: DEFECT-LOG G-23
 *
 * The test that matters here is the second one. Date-ranging only works if a
 * rate change resolves to the rate that was IN FORCE on the posting date, and
 * the original function ordered only by prefix length — so two rows sharing a
 * prefix tied, and PostgreSQL returned whichever it liked. Nothing would have
 * failed; invoices would just sometimes have used last year's rate.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, registerGstin, type SeededTenant } from '../src/seed/index.ts';
import { seedItcEligibility } from '../src/seed/tdsSections.ts';
import { createInvoice } from '../src/domain/invoicing.ts';
import { createBill } from '../src/domain/bills.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { ownerPool, withFirm, closePools } from '../src/db/pool.ts';

let t: SeededTenant;
let customer: string;
let supplier: string;

const makeGstin = (state: string, pan: string): string => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckDigit(first14);
};

/** Prefixes unique to this file, so other suites' seed rows cannot interfere. */
const CHANGED = '8801';        // a rate that changes mid-year
const SPECIFIC = '880123';     // a longer prefix under it
const UNVERIFIED_HSN = '8802';

const A = (n: string): string => t.accounts[n]!;

beforeAll(async () => {
  t = await seedTenant({
    firmName: `Rate Firm ${randomUUID().slice(0, 8)}`,
    clientName: 'Rate Test Ltd',
    userEmail: `rate-${randomUUID()}@test.local`,
    startYear: 2026,
    businessType: 'general',
  });
  await registerGstin(t.firmId, t.clientId, makeGstin('27', 'AAPFR1111L'));
  await seedItcEligibility(t.clientId);

  const rate = (prefix: string, from: string, r: string, note: string) =>
    ownerPool.query(
      `INSERT INTO gst_rates (hsn_sac_prefix, description, effective_from,
                              gst_rate, cess_rate, source_notification)
       VALUES ($1,$2,$3,$4,0,$5)`,
      [prefix, `test ${prefix}`, from, r, note]);

  // The pattern the review endorsed: a change is a NEW ROW, the old row stays.
  await rate(CHANGED, '2020-01-01', '12', 'Notification A (superseded)');
  await rate(CHANGED, '2026-06-01', '18', 'Notification B');
  await rate(SPECIFIC, '2020-01-01', '5', 'Notification C');
  await rate(UNVERIFIED_HSN, '2020-01-01', '18',
             'UNVERIFIED — predates the 2025-09-22 rate rationalisation');

  const party = async (
    type: 'customer' | 'supplier', name: string, acct: string, pan: string,
  ) => withFirm(t.firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name,
                            gstin, gst_category, state_code, ledger_account_id, created_by)
       VALUES ($1,$2,$3,$4,$4,$5,'registered_regular','27',$6,$7) RETURNING id`,
      [t.firmId, t.clientId, type, name, makeGstin('27', pan), A(acct), t.userId]);
    return r.rows[0]!.id;
  });

  customer = await party('customer', 'Rate Customer', 'Debtors', 'AABCP2222N');
  supplier = await party('supplier', 'Rate Supplier', 'Creditors', 'AAECS3333P');
});

afterAll(async () => { await closePools(); });

const resolve = (hsn: string, on: string) => ownerPool.query<{
  gst_rate: string; source_notification: string | null;
}>('SELECT gst_rate, source_notification FROM resolve_gst_rate($1, $2)', [hsn, on]);

// ---------------------------------------------------------------------------
describe('resolve_gst_rate', () => {
  it('returns nothing for an HSN it does not know', async () => {
    const r = await resolve('77777777', '2026-07-01');
    expect(r.rowCount).toBe(0);
  });

  it('G-23 picks the rate IN FORCE, not an arbitrary one of two', async () => {
    // The defect. Both rows match — same prefix, both with a NULL effective_to
    // — so ordering by prefix length alone was a tie and the result was
    // whichever row the planner happened to reach.
    const before = await resolve(CHANGED, '2026-05-31');
    const after = await resolve(CHANGED, '2026-06-01');

    expect(before.rows[0]!.gst_rate).toBe('12.00');
    expect(after.rows[0]!.gst_rate).toBe('18.00');
  });

  it('keeps history intact — an old date still gets the old rate', async () => {
    // The reason the superseded row is not deleted. A return being reworked for
    // an earlier period must compute with the law that applied then.
    const r = await resolve(CHANGED, '2021-03-15');
    expect(r.rows[0]!.gst_rate).toBe('12.00');
    expect(r.rows[0]!.source_notification).toMatch(/superseded/i);
  });

  it('prefers the more specific HSN over the shorter prefix', async () => {
    const r = await resolve(`${SPECIFIC}45`, '2026-07-01');
    expect(r.rows[0]!.gst_rate).toBe('5.00');
  });

  it('carries the notification, so a posted number can cite its source', async () => {
    const r = await resolve(CHANGED, '2026-07-01');
    expect(r.rows[0]!.source_notification).toBe('Notification B');
  });
});

// ---------------------------------------------------------------------------
describe('an unmatched HSN refuses to post (A3.1)', () => {
  it('on a sales invoice', async () => {
    await expect(createInvoice(t.firmId, {
      clientId: t.clientId, partyId: customer, postingDate: '2026-07-01',
      createdBy: t.userId,
      lines: [{ description: 'Mystery goods', hsnSac: '77777777', quantity: '1',
                unitPrice: '1000', incomeAccountId: A('Sales') }],
    })).rejects.toThrow(/no GST rate/);
  });

  it('on a purchase bill', async () => {
    await expect(createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'RATE/001', billDate: '2026-07-01',
      lines: [{ description: 'Mystery goods', hsnSac: '77777777',
                unitPrice: '1000', expenseAccountId: A('Purchases') }],
      createdBy: t.userId,
    })).rejects.toThrow(/no GST rate is configured/);
  });
});

// ---------------------------------------------------------------------------
describe('a bill line is never silently zero-rated (G-23)', () => {
  it('refuses a line with neither a rate nor an HSN', async () => {
    // This used to post at 0% GST. Worse than the 18% fallback the review told
    // us to remove, because 0% looks deliberate.
    await expect(createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'RATE/002', billDate: '2026-07-01',
      lines: [{ description: 'Unspecified', unitPrice: '1000',
                expenseAccountId: A('Purchases') }],
      createdBy: t.userId,
    })).rejects.toThrow(/not assumed to be zero-rated/);
  });

  it('accepts an explicit zero, because that is a stated decision', async () => {
    const b = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'RATE/003', billDate: '2026-07-01',
      lines: [{ description: 'Exempt supply', unitPrice: '1000', gstRate: '0',
                expenseAccountId: A('Purchases') }],
      createdBy: t.userId,
    });
    expect(b.totalGst).toBe('0.00');
  });

  it('resolves the rate from the master when only an HSN is given', async () => {
    const b = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'RATE/004', billDate: '2026-07-01',
      lines: [{ description: 'Goods', hsnSac: CHANGED, unitPrice: '1000',
                expenseAccountId: A('Purchases') }],
      createdBy: t.userId,
    });
    // 18% applies from 2026-06-01, and this bill is dated after that.
    expect(b.totalGst).toBe('180.00');
  });

  it('says so when the rate it used is an unverified one', async () => {
    // Every seeded HSN rate predates the 2025-09-22 rationalisation (G-19b).
    // A number taken from an unverified row has to say so where it is USED,
    // not only where it is stored.
    const b = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'RATE/005', billDate: '2026-07-01',
      lines: [{ description: 'Goods', hsnSac: UNVERIFIED_HSN, unitPrice: '1000',
                expenseAccountId: A('Purchases') }],
      createdBy: t.userId,
    });
    expect(b.warnings.some((w) => /UNVERIFIED/.test(w))).toBe(true);
    expect(b.warnings.some((w) => /Confirm the rate before filing/.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
/*
 * G-24 — the `99` catch-all, and codes that have no single right answer.
 *
 * Every one of these HSN/SAC codes was taken off a REAL invoice. The defect
 * they exposed: review answer A3.1 had us delete the empty-prefix 18% fallback,
 * and a bare `99` row at 18% was left doing the same job. `99` prefixes every
 * service there is, so no service code could fail to match, and the
 * refuse-and-ask path was unreachable for the whole services schedule.
 */
describe('G-24 service codes are not all 18%', () => {
  it('resolves a real SAC the invoice agrees with', async () => {
    // Flipkart platform fee, SAC 998599, charged at IGST 18.0% on the paper.
    const r = await resolve('998599', '2025-08-27');
    expect(r.rows[0]!.gst_rate).toBe('18.00');
  });

  it('resolves a real HSN the invoice agrees with', async () => {
    // Medicaments, HSN 30049011, charged at IGST 5.00% on the paper.
    const r = await resolve('30049011', '2025-08-27');
    expect(r.rows[0]!.gst_rate).toBe('5.00');
  });

  it('an unseeded service now refuses instead of answering 18%', async () => {
    // 9954 is construction. Under the `99` row this returned 18% with a
    // straight face; it must now fall through to no match at all.
    const r = await resolve('995411', '2026-07-01');
    expect(r.rowCount).toBe(0);
  });

  it('GTA matches a row, and that row withholds its rate', async () => {
    const r = await ownerPool.query<{
      gst_rate: string | null; requires_human_rate: boolean; human_rate_reason: string;
    }>(`SELECT gst_rate, requires_human_rate, human_rate_reason
          FROM resolve_gst_rate($1, $2)`, ['996511', '2026-07-01']);

    // Matching matters: it is the difference between "we have never heard of
    // this code" and "we know exactly what this is and why we cannot answer".
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]!.requires_human_rate).toBe(true);
    expect(r.rows[0]!.gst_rate).toBeNull();
    expect(r.rows[0]!.human_rate_reason).toMatch(/5% or 12%/);
  });

  it('the DB forbids a withholding row from carrying a rate at all', async () => {
    // The CHECK is the guarantee. Without it, `requires_human_rate` would be a
    // flag a caller could forget to read, with a stale number sitting behind
    // it — the shape of every dead control found so far.
    await expect(ownerPool.query(
      `INSERT INTO gst_rates (hsn_sac_prefix, description, effective_from,
                              gst_rate, requires_human_rate, human_rate_reason)
       VALUES ('9999', 'Contradiction', '2017-07-01', 18, true, 'why')`,
    )).rejects.toThrow(/gst_rates_refusal_ck/);
  });

  it('a bill on a GTA line refuses, and says what to go and look up', async () => {
    await expect(createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'RATE/GTA1', billDate: '2026-07-01',
      lines: [{ description: 'Road freight', hsnSac: '996511', unitPrice: '1000',
                expenseAccountId: A('Purchases') }],
      createdBy: t.userId,
    })).rejects.toThrow(/no single applicable rate.*forward charge/s);
  });

  it('...and accepts the line once a human states the rate', async () => {
    // The refusal must be an ask, not a wall. The figure is printed on the
    // vendor's invoice; the user reads it off and states it.
    const b = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'RATE/GTA2', billDate: '2026-07-01',
      lines: [{ description: 'Road freight', hsnSac: '996511', unitPrice: '1000',
                gstRate: '5', expenseAccountId: A('Purchases') }],
      createdBy: t.userId,
    });
    expect(b.totalGst).toBe('50.00');
  });
});
