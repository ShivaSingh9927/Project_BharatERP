/**
 * A client is one PAN with several GST registrations — DEFECT-LOG G-22.
 * Settled by CA review answer C1; see CA-REVIEW-ANSWERS.md.
 *
 * The point of these tests is not that the table exists. It is that the two
 * levels stay separate in the ways that cost money if they collapse:
 *
 *   - the registration decides CGST+SGST vs IGST, so the SAME sale to the SAME
 *     customer is taxed differently depending on which state billed it;
 *   - the books roll up at PAN level ACROSS registrations, because the balance
 *     sheet and the return are filed for the company, not for a state;
 *   - an unregistered client — below the GST threshold — must still be able to
 *     keep books.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, registerGstin, type SeededTenant } from '../src/seed/index.ts';
import { seedGstRates } from '../src/seed/gstRates.ts';
import { createInvoice } from '../src/domain/invoicing.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { trialBalance } from '../src/reports/index.ts';
import { ownerPool, withFirm, closePools } from '../src/db/pool.ts';

let t: SeededTenant;
let delhiReg: string;
let haryanaReg: string;
let customer: string;          // a Delhi customer

const A = (n: string): string => {
  const id = t.accounts[n];
  if (!id) throw new Error(`missing account ${n}`);
  return id;
};

function makeGstin(stateCode: string, pan: string, entity = '1'): string {
  const first14 = `${stateCode}${pan}${entity}Z`;
  return first14 + gstinCheckDigit(first14);
}

/** One PAN, two states — the case the old schema could not express. */
const PAN = 'AABCS1234K';
const DELHI = makeGstin('07', PAN);
const HARYANA = makeGstin('06', PAN);

beforeAll(async () => {
  await seedGstRates().catch(() => 0);

  t = await seedTenant({
    firmName: `Reg Firm ${randomUUID().slice(0, 8)}`,
    clientName: 'Sharma Steel Private Limited',
    userEmail: `reg-${randomUUID()}@test.local`,
    pan: PAN,
    startYear: 2026,
  });

  delhiReg = await registerGstin(t.firmId, t.clientId, DELHI);       // primary
  haryanaReg = await registerGstin(t.firmId, t.clientId, HARYANA);

  customer = await withFirm(t.firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name,
                            gstin, gst_category, state_code, ledger_account_id, created_by)
       VALUES ($1,$2,'customer',$3,$3,$4,'registered_regular','07',$5,$6) RETURNING id`,
      [t.firmId, t.clientId, 'Delhi Fabricators', makeGstin('07', 'AADCD9876Q'),
       A('Debtors'), t.userId]);
    return r.rows[0]!.id;
  });
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('the schema', () => {
  it('holds several registrations for one client, sharing a PAN', async () => {
    const r = await withFirm(t.firmId, (c) => c.query<{ gstin: string; state_code: string }>(
      'SELECT gstin, state_code FROM client_registrations WHERE client_id = $1 ORDER BY state_code',
      [t.clientId]));
    expect(r.rows.map((x) => x.state_code)).toEqual(['06', '07']);
    // Same PAN in positions 3–12 of both — that is what makes them one entity.
    expect(r.rows.every((x) => x.gstin.slice(2, 12) === PAN)).toBe(true);
  });

  it('no longer has a GSTIN on the client itself', async () => {
    // Dropped rather than deprecated: "the client's GSTIN" is not a thing that
    // exists once there can be several, and a stale read would silently produce
    // a document for the wrong state.
    const r = await ownerPool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'clients' AND column_name IN ('gstin','state_code')`);
    expect(r.rowCount).toBe(0);
  });

  it('refuses a state code that disagrees with its GSTIN', async () => {
    // The first two characters of a GSTIN ARE the state code, so the two can
    // never legitimately differ. Enforced by CHECK, not by convention.
    await expect(ownerPool.query(
      `INSERT INTO client_registrations (firm_id, client_id, gstin, state_code)
       VALUES ($1,$2,$3,'27')`,
      [t.firmId, t.clientId, makeGstin('29', 'AAECZ1111M')]))
      .rejects.toThrow(/state_code_matches_gstin/);
  });

  it('refuses a second primary registration', async () => {
    await expect(ownerPool.query(
      `INSERT INTO client_registrations
         (firm_id, client_id, gstin, state_code, is_primary)
       VALUES ($1,$2,$3,'29',true)`,
      [t.firmId, t.clientId, makeGstin('29', PAN)]))
      .rejects.toThrow(/one_primary_per_client/);
  });

  it('refuses the same GSTIN twice for one client', async () => {
    await expect(ownerPool.query(
      `INSERT INTO client_registrations (firm_id, client_id, gstin, state_code)
       VALUES ($1,$2,$3,'07')`,
      [t.firmId, t.clientId, DELHI]))
      .rejects.toThrow(/client_registrations_client_id_gstin/);
  });
});

// ---------------------------------------------------------------------------
describe('the registration decides the tax', () => {
  const line = {
    description: 'Steel sections', hsnSac: '7318', quantity: '10',
    unitPrice: '1000',
  };

  it('bills intra-state from Delhi to a Delhi customer — CGST + SGST', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, registrationId: delhiReg, partyId: customer,
      postingDate: '2026-07-01', createdBy: t.userId,
      lines: [{ ...line, incomeAccountId: A('Sales') }],
    });
    expect(inv.totalCgst).not.toBe('0.00');
    expect(inv.totalSgst).not.toBe('0.00');
    expect(inv.totalIgst).toBe('0.00');
  });

  it('bills the SAME sale inter-state from Haryana — IGST', async () => {
    // Same customer, same goods, same amount. Only the registration differs,
    // and the tax is a different tax. This is the whole reason the registration
    // has to be part of the document rather than a property of the client.
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, registrationId: haryanaReg, partyId: customer,
      postingDate: '2026-07-02', createdBy: t.userId,
      lines: [{ ...line, incomeAccountId: A('Sales') }],
    });
    expect(inv.totalIgst).not.toBe('0.00');
    expect(inv.totalCgst).toBe('0.00');
    expect(inv.totalSgst).toBe('0.00');
  });

  it('stamps the issuing registration and its GSTIN onto the invoice', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, registrationId: haryanaReg, partyId: customer,
      postingDate: '2026-07-03', createdBy: t.userId,
      lines: [{ ...line, incomeAccountId: A('Sales') }],
    });
    const r = await withFirm(t.firmId, (c) =>
      c.query<{ registration_id: string; supplier_gstin: string }>(
        'SELECT registration_id, supplier_gstin FROM sales_invoices WHERE voucher_id = $1',
        [inv.voucherId]));
    expect(r.rows[0]!.registration_id).toBe(haryanaReg);
    expect(r.rows[0]!.supplier_gstin).toBe(HARYANA);
  });

  it('defaults to the primary registration when none is named', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: customer,
      postingDate: '2026-07-04', createdBy: t.userId,
      lines: [{ ...line, incomeAccountId: A('Sales') }],
    });
    const r = await withFirm(t.firmId, (c) => c.query<{ registration_id: string }>(
      'SELECT registration_id FROM sales_invoices WHERE voucher_id = $1', [inv.voucherId]));
    expect(r.rows[0]!.registration_id).toBe(delhiReg);
  });

  it('refuses a registration belonging to a different client', async () => {
    const other = await seedTenant({
      firmName: `Other Firm ${randomUUID().slice(0, 8)}`,
      clientName: 'Someone Else Ltd',
      userEmail: `other-${randomUUID()}@test.local`,
      startYear: 2026,
    });
    const foreign = await registerGstin(other.firmId, other.clientId,
      makeGstin('29', 'AAFCO4321R'));

    await expect(createInvoice(t.firmId, {
      clientId: t.clientId, registrationId: foreign, partyId: customer,
      postingDate: '2026-07-05', createdBy: t.userId,
      lines: [{ ...line, incomeAccountId: A('Sales') }],
    })).rejects.toThrow(/does not belong to this client/);
  });
});

// ---------------------------------------------------------------------------
describe('the books are one set, at PAN level', () => {
  it('rolls both registrations into a single trial balance', async () => {
    // The reason G-22 mattered. Under the old shape Delhi and Haryana were two
    // clients, so this report could not exist — and neither could a balance
    // sheet for the company that actually files the return.
    const tb = await trialBalance(t.firmId, t.clientId, '2026-07-31');
    expect(tb.balanced).toBe(true);

    const sales = tb.rows.find((r) => r.name === 'Sales');
    expect(sales).toBeDefined();
    // Four invoices of ₹10,000 were raised above, from two different states,
    // and all of them belong to this one company.
    expect(Number(sales!.credit)).toBe(40000);
  });

  it('can still separate the states, which is what GST returns need', async () => {
    const r = await withFirm(t.firmId, (c) => c.query<{ registration_id: string; n: string }>(
      `SELECT registration_id, count(*)::text AS n FROM sales_invoices
       WHERE client_id = $1 GROUP BY registration_id`, [t.clientId]));
    const byReg = new Map(r.rows.map((x) => [x.registration_id, Number(x.n)]));
    expect(byReg.get(delhiReg)).toBe(2);      // one billed, one defaulted
    expect(byReg.get(haryanaReg)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('a client below the GST threshold', () => {
  it('has no registration and can still keep books', async () => {
    // An unregistered SMB is a legitimate client, not an error state. Sales
    // invoicing refuses (there is no GSTIN to print), but the ledger works —
    // which is why purchase_bills.registration_id is nullable and
    // sales_invoices.registration_id is not.
    const small = await seedTenant({
      firmName: `Small Firm ${randomUUID().slice(0, 8)}`,
      clientName: 'Tiny Trader',
      userEmail: `small-${randomUUID()}@test.local`,
      startYear: 2026,
    });

    const regs = await withFirm(small.firmId, (c) => c.query(
      'SELECT 1 FROM client_registrations WHERE client_id = $1', [small.clientId]));
    expect(regs.rowCount).toBe(0);

    const tb = await trialBalance(small.firmId, small.clientId, '2026-07-31');
    expect(tb.balanced).toBe(true);
  });

  it('cannot raise a tax invoice, and says why', async () => {
    const small = await seedTenant({
      firmName: `Small Firm ${randomUUID().slice(0, 8)}`,
      clientName: 'Tiny Trader Two',
      userEmail: `small2-${randomUUID()}@test.local`,
      startYear: 2026,
    });
    const party = await withFirm(small.firmId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name,
                              gstin, gst_category, state_code, ledger_account_id, created_by)
         VALUES ($1,$2,'customer','X','X',NULL,'unregistered','07',$3,$4) RETURNING id`,
        [small.firmId, small.clientId, small.accounts['Debtors']!, small.userId]);
      return r.rows[0]!.id;
    });

    await expect(createInvoice(small.firmId, {
      clientId: small.clientId, partyId: party,
      postingDate: '2026-07-01', createdBy: small.userId,
      lines: [{ description: 'x', hsnSac: '7318', quantity: '1', unitPrice: '10',
                incomeAccountId: small.accounts['Sales']! }],
    })).rejects.toThrow(/no primary GST registration/);
  });
});
