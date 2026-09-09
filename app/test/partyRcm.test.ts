/**
 * A supplier's standing reverse-charge rate — bills-and-expenses.md BE-35.
 *
 * The rate on a reverse-charge bill is the one figure in this pipeline that no
 * arithmetic can check. Everywhere else a number is proved against the paper;
 * here the paper charges no tax, so there is nothing to prove it against. What
 * replaces the check is that a named human decided it, against a supplier,
 * before the bill arrived — which is what these tests are about.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, registerGstin, type SeededTenant } from '../src/seed/index.ts';
import { seedItcEligibility } from '../src/seed/tdsSections.ts';
import { proposeFromDocument } from '../src/domain/billProposal.ts';
import { setPartyRcmRate, partyRcmRate } from '../src/domain/partyRcm.ts';
import { formFor } from '../src/domain/billForm.ts';
import { splitDocuments } from '../src/parse/documentSplit.ts';
import { wordsToRows, type Word, type WordPage } from '../src/parse/pdfWords.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { ownerPool, closePools } from '../src/db/pool.ts';

const OUR_GSTIN = (() => {
  const f = '09AAACR1111R1Z';
  return f + gstinCheckDigit(f);
})();

let t: SeededTenant;
let purchases: string;
const party: Record<string, string> = {};

const w = (text: string, xMin: number, yMin: number,
           width = text.length * 3.3, height = 6.6): Word =>
  ({ text, xMin, xMax: xMin + width, yMin, yMax: yMin + height });

const page = (words: Word[]): WordPage[] =>
  [{ number: 1, width: 600, height: 800, rows: wordsToRows(words) }];

/** An untaxed bill naming its supplier on the page, in a stated currency. */
const untaxedPage = (name: string, amount: string, particulars = 'Cloud hosting') =>
  page([
    w(name, 40, 60),
    w('Sl', 40, 100), w('Particulars', 90, 100), w('Amount', 300, 100),
    w('1', 40, 130), w(particulars, 90, 130), w(amount, 300, 130),
    w('Total', 90, 160), w(amount, 300, 160),
  ]);

const doc = (number: string, dateLine = 'Invoice Date : 27-08-2026') =>
  splitDocuments(
    `Invoice\nInvoice Number # ${number}\n${dateLine}\n`
    + 'Reverse charge applies. VAT 0.00\n')[0]!;

const propose = (
  segment: ReturnType<typeof doc>, pages: WordPage[],
  extra: Partial<Parameters<typeof proposeFromDocument>[1]> = {},
) =>
  proposeFromDocument(t.firmId,
    { clientId: t.clientId, createdBy: t.userId, expenseAccountId: purchases,
      ...extra },
    segment, pages, 'b'.repeat(64));

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  t = await seedTenant({
    firmName: `Rcm ${tag}`, clientName: `Client ${tag}`,
    userEmail: `rcm-${tag}@example.test`, startYear: 2026,
    pan: 'AAACR1111R', businessType: 'general',
  });
  await seedItcEligibility(t.clientId);
  await registerGstin(t.firmId, t.clientId, OUR_GSTIN, { primary: true });

  const acc = async (name: string) => (await ownerPool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE client_id = $1 AND name = $2`,
    [t.clientId, name])).rows[0]!.id;
  purchases = await acc('Purchases');
  const creditors = await acc('Creditors');

  // Three suppliers, one of each kind that matters here.
  for (const [name, category, state, gst] of [
    ['Foreign Host', 'overseas', null, null],
    // A second overseas supplier, kept for the date-range tests alone so they
    // cannot leave a rate lying in force under the bills tested further down.
    ['Ranged Vendor', 'overseas', null, null],
    ['Vakil Associates', 'unregistered', '09', null],
    ['Near Supplier', 'registered_regular', '09',
     `09AAACS2222S1Z${gstinCheckDigit('09AAACS2222S1Z')}`],
  ] as const) {
    const r = await ownerPool.query<{ id: string }>(
      `INSERT INTO parties (firm_id, client_id, party_type, name, gstin,
                            gst_category, state_code, ledger_account_id, created_by)
       VALUES ($1,$2,'supplier',$3,$4,$5,$6,$7,$8) RETURNING id`,
      [t.firmId, t.clientId, name, gst, category, state, creditors, t.userId]);
    party[name] = r.rows[0]!.id;
  }
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('what may be written against a supplier', () => {
  const set = (over: Record<string, unknown> = {}) => setPartyRcmRate(t.firmId, {
    clientId: t.clientId, partyId: party['Foreign Host']!, rate: '18',
    provision: 'igst_5_3', supply: 'cloud hosting',
    effectiveFrom: '2026-04-01', setBy: t.userId, ...over,
  } as Parameters<typeof setPartyRcmRate>[1]);

  it('refuses a number that is not a GST rate', async () => {
    // The rate is unverifiable against the document, so a typo here would
    // travel straight into a liability the client pays in cash.
    await expect(set({ rate: '13' })).rejects.toThrow(/not a GST rate/);
  });

  it('refuses a rate with no stated reason', async () => {
    // The reason IS the evidence — there will never be any other.
    await expect(set({ supply: '   ' })).rejects.toThrow(/say what this supplier supplies/i);
  });

  it('refuses a rate against a registered supplier', async () => {
    /*
     * Their invoice charges GST in the ordinary way and the credit is claimed
     * from the document. A reverse-charge rate here would tax the same supply
     * twice — and a row sitting in the master looking effective is worse than
     * no row at all, so it is refused rather than ignored later.
     */
    await expect(set({ partyId: party['Near Supplier'] }))
      .rejects.toThrow(/tax the same supply twice/);
  });

  it('refuses to call an Indian supplier an import of service', async () => {
    await expect(set({ partyId: party['Vakil Associates'] }))
      .rejects.toThrow(/not an import of service/);
  });

  it('will not carry s.9(4), which has been suspended since 2017', async () => {
    // A row claiming it would assert a liability that does not exist. Refused
    // by the database as well as by the type.
    await expect(ownerPool.query(
      `INSERT INTO party_rcm_rates (firm_id, client_id, party_id, gst_rate,
                                    provision, supply, effective_from)
       VALUES ($1,$2,$3,18,'cgst_9_4','anything','2026-04-01')`,
      [t.firmId, t.clientId, party['Foreign Host']]))
      .rejects.toThrow(/party_rcm_provision_ck/);
  });
});

// ---------------------------------------------------------------------------
describe('resolving the rate as of the bill date', () => {
  const ranged = () => party['Ranged Vendor']!;
  it('does not apply to a bill dated before it took effect', async () => {
    await setPartyRcmRate(t.firmId, {
      clientId: t.clientId, partyId: ranged(), rate: '18',
      provision: 'igst_5_3', supply: 'cloud hosting',
      effectiveFrom: '2026-04-01', setBy: t.userId,
    });
    expect(await partyRcmRate(t.firmId, t.clientId, ranged(),
                              '2026-03-31')).toBe('none');
    const on = await partyRcmRate(t.firmId, t.clientId, ranged(),
                                  '2026-04-01');
    expect(typeof on === 'string' ? on : on.rate).toBe('18');
  });

  it('keeps the old rate for an old bill when the rate changes', async () => {
    /*
     * The reason this is date-ranged rather than a column on `parties`. The
     * 2025-09-22 rationalisation collapsed two slabs; a bill from before it
     * was charged at the rate then in force, and overwriting the master would
     * silently reprice history — and leave last quarter's return citing a rate
     * no row could produce.
     */
    await setPartyRcmRate(t.firmId, {
      clientId: t.clientId, partyId: ranged(), rate: '5',
      provision: 'igst_5_3', supply: 'cloud hosting',
      effectiveFrom: '2026-07-01', setBy: t.userId,
    });
    const before = await partyRcmRate(t.firmId, t.clientId,
                                      ranged(), '2026-06-30');
    const after = await partyRcmRate(t.firmId, t.clientId,
                                     ranged(), '2026-07-01');
    expect(typeof before === 'string' ? before : before.rate).toBe('18');
    expect(typeof after === 'string' ? after : after.rate).toBe('5');
  });

  it('refuses to choose when two ranges cover the same day', async () => {
    // Written straight into the table, which is the only way to get here:
    // the setter closes the previous range. If it has happened, the rate for
    // that bill is genuinely undecided and picking one would invent it.
    await ownerPool.query(
      `INSERT INTO party_rcm_rates (firm_id, client_id, party_id, gst_rate,
                                    provision, supply, effective_from)
       VALUES ($1,$2,$3,12,'cgst_9_3','overlapping','2026-05-01')`,
      [t.firmId, t.clientId, party['Vakil Associates']]);
    await ownerPool.query(
      `INSERT INTO party_rcm_rates (firm_id, client_id, party_id, gst_rate,
                                    provision, supply, effective_from)
       VALUES ($1,$2,$3,18,'cgst_9_3','overlapping','2026-06-01')`,
      [t.firmId, t.clientId, party['Vakil Associates']]);
    expect(await partyRcmRate(t.firmId, t.clientId, party['Vakil Associates']!,
                              '2026-08-01')).toBe('ambiguous');
    await ownerPool.query(
      `DELETE FROM party_rcm_rates WHERE party_id = $1`,
      [party['Vakil Associates']]);
  });
});

// ---------------------------------------------------------------------------
describe('a bill priced from the party record', () => {
  it('names the party record when no rate is on file', async () => {
    /*
     * The refusal has to say where the fix lives. It used to say "supply the
     * rate", which a reviewer cannot do from a screen — the only route was a
     * command-line flag.
     */
    const p = await propose(doc('FH/1'), untaxedPage('Foreign Host', '100.00'));
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/Set the rate on Foreign Host's party record/);
    // And it is not offered as a form field: this is master data, and a form
    // that wrote it would price every future bill from a box on one screen.
    expect(formFor(p).fields.map((f) => f.field)).not.toContain('fxRate');
    expect(formFor(p).unfixable.join(' ')).toMatch(/party record/);
  });

  it('posts the bill once the rate is on the supplier', async () => {
    await setPartyRcmRate(t.firmId, {
      clientId: t.clientId, partyId: party['Foreign Host']!, rate: '18',
      provision: 'igst_5_3', supply: 'cloud hosting',
      notification: 'IGST Act s.5(3)',
      effectiveFrom: '2026-01-01', setBy: t.userId,
    });
    const p = await propose(doc('FH/2'), untaxedPage('Foreign Host', '100.00'));
    expect(p.blockers).toEqual([]);
    expect(p.input?.isReverseCharge).toBe(true);
    expect(p.input?.lines[0]?.gstRate).toBe('18');
    // The tax is OURS to compute here, not the supplier's to have charged.
    expect(p.input?.claimedTotals).toBeUndefined();
  });

  it('says on the bill where the rate came from and who decided it', async () => {
    /*
     * Not decoration. This figure cannot be checked against the paper, so the
     * provenance sentence is the whole of its defence a year later.
     */
    const p = await propose(doc('FH/3'), untaxedPage('Foreign Host', '100.00'));
    const said = p.warnings.join(' ');
    expect(said).toMatch(/18% reverse-charge rate on this bill was taken from Foreign Host's party record/);
    expect(said).toMatch(/cloud hosting/);
    expect(said).toMatch(/IGST Act s\.5\(3\)/);
    expect(said).toMatch(/not read from this document, which charges no tax/);
    expect(said).toMatch(/no arithmetic can confirm/);
  });

  it("lets the filer's own rate outrank the master for one document", async () => {
    // A flag or a form answer is a decision about the document in front of
    // them; the master is the standing default for when nobody made one.
    const p = await propose(doc('FH/4'), untaxedPage('Foreign Host', '100.00'),
      { reverseCharge: { rate: '5' } });
    expect(p.input?.lines[0]?.gstRate).toBe('5');
    expect(p.warnings.join(' ')).toMatch(/supplied by the filer for this document/);
  });

  it('taxes an unregistered advocate under s.9(3) when the record says so', async () => {
    /*
     * s.9(4) is suspended; s.9(3) is not, and it does not care about the
     * supplier's registration. An advocate's fee is taxed in the client's
     * hands whether or not the advocate is registered, so a plain expense
     * would understate a liability payable in cash.
     */
    const before = await propose(doc('VA/1'),
      untaxedPage('Vakil Associates', '10,000/-', 'Legal fees'));
    expect(before.input?.isReverseCharge).not.toBe(true);
    expect(before.warnings.join(' ')).toMatch(/s\.9\(4\)/);

    await setPartyRcmRate(t.firmId, {
      clientId: t.clientId, partyId: party['Vakil Associates']!, rate: '18',
      provision: 'cgst_9_3', supply: 'legal services by an advocate',
      effectiveFrom: '2026-01-01', setBy: t.userId,
    });
    const after = await propose(doc('VA/2'),
      untaxedPage('Vakil Associates', '10,000/-', 'Legal fees'));
    expect(after.blockers).toEqual([]);
    expect(after.input?.isReverseCharge).toBe(true);
    expect(after.input?.lines[0]?.gstRate).toBe('18');
    expect(after.warnings.join(' ')).toMatch(/taxed in the recipient's hands under s\.9\(3\)/);
    // And it stops asking the question it used to ask on every legal bill.
    expect(after.confirmations.map((c) => c.field)).not.toContain('reverse_charge_9_3');
  });

  it('still refuses a foreign bill until the exchange rate is supplied', async () => {
    /*
     * The rate can be a standing decision; the exchange rate cannot. Rule
     * 34(2) fixes it as the rate applicable on the date of the time of supply,
     * so a figure held against the party would be wrong for every bill but
     * one. It is asked per document — and unlike the RCM rate, it IS a form
     * field, because it is a fact about this bill.
     */
    const p = await propose(doc('FH/5'), untaxedPage('Foreign Host', '$100.00'));
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/no exchange rate was given/);
    expect(formFor(p).fields.map((f) => f.field)).toContain('fxRate');

    const filled = await propose(doc('FH/6'), untaxedPage('Foreign Host', '$100.00'),
      { manual: { fxRate: '88.20' } });
    expect(filled.blockers).toEqual([]);
    expect(filled.input?.lines[0]?.unitPrice).toBe('8820.00');
    expect(filled.warnings.join(' ')).toMatch(/converted from USD at 88.20/);
  });
});
