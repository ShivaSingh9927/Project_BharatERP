/**
 * Proposing purchase bills from a read document — bills-and-expenses.md §4.4.
 *
 * Almost every test here is about what does NOT get posted. That is the point
 * of the module: reading a figure is the easy half, and deciding whether it is
 * safe to act on is the half that matters.
 *
 * Word boxes and document text are constructed rather than taken from a PDF,
 * so no real invoice content enters the repository. Geometry follows the real
 * measurements (see `pdfWords.test.ts`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, registerGstin, type SeededTenant } from '../src/seed/index.ts';
import { seedItcEligibility } from '../src/seed/tdsSections.ts';
import { proposeFromDocument, postProposal, deriveGstRate,
         llmExtractionEnabled, enableLlmExtraction, llmSettings,
         compareReadings } from '../src/domain/billProposal.ts';
import type { LlmClient } from '../src/parse/llmTable.ts';
import { splitDocuments } from '../src/parse/documentSplit.ts';
import { wordsToRows, type Word, type WordPage } from '../src/parse/pdfWords.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { ownerPool, closePools } from '../src/db/pool.ts';

const gstin = (state: string, pan: string): string => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckDigit(first14);
};

const OUR_GSTIN  = gstin('09', 'AAACC1111C');   // Uttar Pradesh — the client
const SAME_STATE = gstin('09', 'AAACS2222S');   // a UP supplier
const FAR_STATE  = gstin('20', 'AAACF3333F');   // a Jharkhand supplier
const UNKNOWN    = gstin('27', 'AAACU4444U');   // never added as a party

let t: SeededTenant;
let purchases: string;

const w = (text: string, xMin: number, yMin: number,
           width = text.length * 3.3, height = 6.6): Word =>
  ({ text, xMin, xMax: xMin + width, yMin, yMax: yMin + height });

/** A minimal readable table: taxable, IGST or CGST/SGST, and a total. */
const page = (words: Word[]): WordPage[] =>
  [{ number: 1, width: 600, height: 800, rows: wordsToRows(words) }];

const interStateTable = (taxable: string, tax: string, total: string) => page([
  w('Qty', 40, 100), w('Taxable', 90, 100), w('IGST', 200, 100), w('Total', 280, 100),
  w('1', 40, 130), w(taxable, 90, 130), w(tax, 200, 130), w(total, 280, 130),
]);

const intraStateTable = () => page([
  w('Qty', 40, 100), w('Taxable', 90, 100), w('CGST', 200, 100),
  w('SGST', 260, 100), w('Total', 330, 100),
  w('1', 40, 130), w('1000.00', 90, 130), w('90.00', 200, 130),
  w('90.00', 260, 130), w('1180.00', 330, 130),
]);

/**
 * A document fixture. Carries an unambiguous invoice date because the date is
 * now read rather than supplied — a fixture without one is blocked, which is
 * the behaviour tested separately below.
 *
 * The date sits inside the seeded fiscal year on purpose. With today's date
 * hardcoded that never mattered; now that the real date is used, `V-6: no
 * fiscal year covers posting date` fires — another control that only had
 * something to bite on once the field stopped being a placeholder.
 */
const doc = (supplier: string | null, number: string, taxLine: string,
             dateLine = 'Invoice Date : 27-08-2026') =>
  splitDocuments(
    `Tax Invoice\nInvoice Number # ${number}\n${dateLine}\n`
    + (supplier ? `GSTIN - ${supplier}\n` : '')
    + `${taxLine}\nWhether tax is payable under reverse charge - No`)[0]!;

const propose = (segment: ReturnType<typeof doc>, pages: WordPage[],
                 llm?: LlmClient) =>
  proposeFromDocument(t.firmId,
    { clientId: t.clientId, createdBy: t.userId, expenseAccountId: purchases, llm },
    segment, pages, 'a'.repeat(64));

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  t = await seedTenant({
    firmName: `Proposal ${tag}`, clientName: `Client ${tag}`,
    userEmail: `proposal-${tag}@example.test`, startYear: 2026,
    pan: 'AAACC1111C', businessType: 'general',
  });
  await seedItcEligibility(t.clientId);
  await registerGstin(t.firmId, t.clientId, OUR_GSTIN, { primary: true });

  purchases = (await ownerPool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE client_id = $1 AND name = 'Purchases'`,
    [t.clientId])).rows[0]!.id;

  const creditors = (await ownerPool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE client_id = $1 AND name = 'Creditors'`,
    [t.clientId])).rows[0]!.id;

  for (const [name, g] of [['Near Supplier', SAME_STATE], ['Far Supplier', FAR_STATE]] as const) {
    await ownerPool.query(
      `INSERT INTO parties (firm_id, client_id, party_type, name, gstin,
                            gst_category, state_code, ledger_account_id, created_by)
       VALUES ($1,$2,'supplier',$3,$4,'registered_regular',$5,$6,$7)`,
      [t.firmId, t.clientId, name, g, g.slice(0, 2), creditors, t.userId]);
  }
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('deriveGstRate', () => {
  it('picks the scheduled rate that produces the tax', () => {
    expect(deriveGstRate('1000.00', '180.00')).toBe('18');
    expect(deriveGstRate('222.86', '11.14')).toBe('5');
  });

  it('does not invent a rate that is not on the schedule', () => {
    /*
     * The defect this closes. A real Flipkart platform fee of 4.24 carries
     * 0.76 of IGST and the document says 18%. Plain division gives 17.92%,
     * which reproduces 0.76 exactly — 4.24 x 17.92% = 0.7598 and
     * 4.24 x 18% = 0.7632, and both round to the same paise.
     *
     * The tax would still have posted correctly, but the rate is a filed field
     * and 17.92% is not a rate that exists.
     */
    expect(deriveGstRate('4.24', '0.76')).toBe('18');
  });

  it('believes the rate printed on the document over the schedule', () => {
    expect(deriveGstRate('4.24', '0.76', ['18'])).toBe('18');
  });

  it('tests candidates line by line, because the vendor rounds that way', () => {
    /*
     * A real Flipkart invoice with three fees at 18%: 50.00 -> 9.00,
     * 109.32 -> 19.68, 168.64 -> 30.36. They sum to a taxable value of 327.96
     * and a tax of 59.04 — but 327.96 x 18% is 59.0328, which rounds to 59.03.
     *
     * Derived from the aggregate, no scheduled rate explained the document and
     * a perfectly correct bill was refused. Each line was rounded in its own
     * right before being added, so candidates have to be tested the same way.
     */
    expect(deriveGstRate(['50.00', '109.32', '168.64'], '59.04')).toBe('18');
    expect(deriveGstRate('327.96', '59.03')).toBe('18');      // the aggregate

    /*
     * The aggregate now also answers 18, because a paisa is forgiven, and this
     * assertion used to be `toBeNull()`.
     *
     * That is a real loss of signal and the right trade. The paisa was never
     * telling us the RATE — 18 is the answer either way — it was telling us
     * where the vendor rounded, and refusing the document over it meant
     * refusing invoices that were correct. What replaces exactness as the
     * safeguard is uniqueness: a tax that fits two scheduled rates within a
     * paisa still returns null.
     */
    expect(deriveGstRate('327.96', '59.04')).toBe('18');
  });

  it('computes an intra-state rate as two halves rounded separately', () => {
    /*
     * An intra-state supply is taxed at 9% for the centre and 9% for the
     * state, each rounded in its own right. On 105.94 that is 9.53 + 9.53 =
     * 19.06, while a single 18% charge gives 19.07 — a real Flipkart invoice
     * sits on exactly that paisa. Computing it as one charge made 18% look
     * wrong and refused a perfectly good bill.
     */
    expect(deriveGstRate('105.94', '19.06', [], true)).toBe('18');
    expect(deriveGstRate('105.94', '19.07', [], false)).toBe('18');

    /*
     * Reading the split off the paisa no longer works either, and should not
     * have been relied on. Whether a supply is intra-state or inter-state is
     * decided by the place of supply, not by which rounding a tax figure
     * happens to match — this project already got that backwards once and
     * blocked bills over it. The rate comes back correct; the split is settled
     * elsewhere and disagreements about it are warned about in their own right.
     */
    expect(deriveGstRate('105.94', '19.06', [], false)).toBe('18');
  });

  it('refuses a rate it cannot pick uniquely, which is what bounds the slack', () => {
    /*
     * Uniqueness doing the work exactness used to. On a taxable value this
     * small the scheduled rates are only paise apart: 0.25% of 2.00 is 0.01
     * and so is 0.50% — nothing here distinguishes them, so nothing is
     * returned. This is the case that made allowing slack look dangerous, and
     * it is refused rather than guessed.
     */
    expect(deriveGstRate('2.00', '0.01')).toBeNull();
  });

  it('reports zero tax as a zero rate, not as unknown', () => {
    // A bill of supply charges nothing, and that is a stated fact.
    expect(deriveGstRate('66.00', '0')).toBe('0');
  });

  it('refuses a rate that does not divide back to the exact paise', () => {
    /*
     * `createBill` recomputes tax from this rate, so an approximate one
     * produces a bill that disagrees with the paper by a rounding error nobody
     * could explain a year later. A tax that will not divide cleanly usually
     * means two rates on one document.
     */
    expect(deriveGstRate('1000.00', '123.45')).toBeNull();
  });

  it('refuses when there is no taxable value to divide by', () => {
    expect(deriveGstRate('0.00', '180.00')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('what will not be posted', () => {
  it('refuses an unknown supplier instead of creating one', () => {
    /*
     * A party carries a GSTIN, a state and a ledger account. Creating one from
     * a PDF would put an unreviewed master record behind every future bill
     * from that vendor.
     */
    return propose(doc(UNKNOWN, 'P1', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00')).then((p) => {
      expect(p.input).toBeNull();
      expect(p.blockers.join(' ')).toMatch(/no supplier is on file with GSTIN/);
    });
  });

  it('refuses a GSTIN that fails its check digit, even if a party matched', async () => {
    // Nothing else catches a corrupted identifier: every arithmetic test
    // passes on a transposed GSTIN.
    const broken = SAME_STATE.slice(0, 14) + (SAME_STATE[14] === 'A' ? 'B' : 'A');
    const p = await propose(doc(broken, 'P2', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/is not valid/);
  });

  it('refuses a document with no supplier GSTIN, pointing at reverse charge', async () => {
    // A foreign supplier: a valid bill, an import of service, and one whose
    // tax the recipient owes. Not an error — just not postable unattended.
    const p = await propose(doc(null, 'P3', 'Subscription 929.00'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/import of service/);
  });

  it('refuses when the table did not tie', async () => {
    const p = await propose(doc(SAME_STATE, 'P4', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '9999.00'));
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/could not be read.*does not add up/s);
  });

  it('refuses when no single rate explains the figures', async () => {
    const p = await propose(doc(SAME_STATE, 'P5', 'IGST 18 %'),
      interStateTable('1000.00', '123.45', '1123.45'));
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/no single GST rate explains/);
  });

  it('refuses a document that never said which kind it is', async () => {
    // An Amazon or Zepto heading naming three document types, whose rates
    // could not be read. Input credit must not rest on that.
    const seg = splitDocuments(
      `Tax Invoice/Bill of Supply/Cash Memo\nInvoice Number : P6\n`
      + `GSTIN - ${SAME_STATE}\nSR HSN Qty CGST S/UT GST\n1 30049011 1 2.50% 2.50%`)[0]!;
    const p = await propose(seg, intraStateTable());
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/does not say whether it is a tax invoice/);
  });
});

// ---------------------------------------------------------------------------
describe('posting a ready proposal', () => {
  it('posts one line per item row, so the rounding matches the vendor', async () => {
    /*
     * Not one aggregate line. The vendor rounds each line's tax before adding,
     * so a single line of 327.96 at 18% computes 59.03 where the document says
     * 59.04 — and PB-4 would reject a bill that is entirely correct.
     */
    const threeFees = page([
      w('Description', 40, 100), w('Taxable', 150, 100),
      w('IGST', 230, 100), w('Total', 300, 100),
      w('Credit Card Fee', 40, 130), w('50.00', 150, 130),
      w('9.00', 230, 130), w('59.00', 300, 130),
      w('Protect Promise Fee', 40, 145), w('109.32', 150, 145),
      w('19.68', 230, 145), w('129.00', 300, 145),
      w('Offer Handling Fee', 40, 160), w('168.64', 150, 160),
      w('30.36', 230, 160), w('199.00', 300, 160),
    ]);
    const p = await propose(doc(SAME_STATE, 'P30', 'IGST 18 %'), threeFees);
    expect(p.blockers).toEqual([]);
    expect(p.input!.lines).toHaveLength(3);
    expect(p.input!.lines.map((l) => l.unitPrice))
      .toEqual(['50.00', '109.32', '168.64']);

    const bill = await postProposal(t.firmId, p,
      { approvedBy: t.userId });
    expect(bill.taxableValue).toBe('327.96');
    expect(bill.totalGst).toBe('59.04');       // not 59.03
  });

  it('normalises a printed rupee symbol out of a line amount', async () => {
    /*
     * The per-line change broke four whole files with
     * `SI-7: "₹66.00" is not a valid decimal amount`. The aggregate path had
     * been getting normalisation for free by going through `table.sums`; the
     * per-line cells arrive exactly as printed.
     */
    const withSymbols = page([
      w('Description', 40, 100), w('Taxable', 150, 100),
      w('IGST', 230, 100), w('Total', 300, 100),
      w('Example', 40, 130), w('₹100.00', 150, 130),
      w('₹18.00', 230, 130), w('₹118.00', 300, 130),
    ]);
    const p = await propose(doc(SAME_STATE, 'P31', 'IGST 18 %'), withSymbols);
    expect(p.blockers).toEqual([]);
    expect(p.input!.lines[0]!.unitPrice).toBe('100.00');
  });

  it('posts, and the figures match the document', async () => {
    const p = await propose(doc(SAME_STATE, 'P10', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.blockers).toEqual([]);
    expect(p.partyName).toBe('Near Supplier');

    const bill = await postProposal(t.firmId, p,
      { approvedBy: t.userId });
    expect(bill.taxableValue).toBe('1000.00');
    expect(bill.totalGst).toBe('180.00');
    expect(bill.grandTotal).toBe('1180.00');
  });

  it('cannot post without naming a human approver (AT-13)', async () => {
    /*
     * Not this module's rule: `vouchers_ai_needs_approver_ck` is a database
     * CHECK that refuses any `ai_proposal` voucher with no approver. The first
     * version of this code omitted it and Postgres rejected all eleven real
     * documents — the control working exactly as designed against the first
     * path that tried to skirt it.
     */
    const p = await propose(doc(SAME_STATE, 'P11', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.input!.createdVia).toBe('ai_proposal');
    expect(p.input!.approvedBy).toBeUndefined();
  });

  it('refuses to post a blocked proposal at all', async () => {
    const p = await propose(doc(UNKNOWN, 'P12', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'));
    await expect(postProposal(t.firmId, p,
      { approvedBy: t.userId }))
      .rejects.toThrow(/not ready to post/);
  });

  it('carries the document’s printed figures through for PB-4 to re-check', async () => {
    // The rate this module derives is verified by code that did not derive it.
    const p = await propose(doc(SAME_STATE, 'P13', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.input!.claimedTotals).toMatchObject({
      igst: '180.00', grandTotal: '1180.00',
    });
  });
});

// ---------------------------------------------------------------------------
describe('the tax split is warned about, not blocked', () => {
  it('accepts CGST+SGST from an out-of-state supplier, with a warning', async () => {
    /*
     * This was a blocker, and it was wrong. A real Flipkart invoice from a
     * Jharkhand supplier charges CGST and SGST to a client registered in UP,
     * and it is correct: the split follows the supplier's state against the
     * PLACE OF SUPPLY, not against the recipient's registration. Blocking it
     * refused a perfectly good bill.
     *
     * It stays a warning because the other explanations — a supplier master
     * with the wrong state, or a vendor charging the wrong tax — survive every
     * arithmetic check, and claiming CGST+SGST on an inter-state supply is a
     * claim against the wrong government.
     */
    const p = await propose(
      doc(FAR_STATE, 'P20', 'Item CGST 9 % SGST 9 %'), intraStateTable());
    expect(p.blockers).toEqual([]);
    expect(p.warnings.join(' ')).toMatch(/check the place of supply/);

    const bill = await postProposal(t.firmId, p,
      { approvedBy: t.userId });
    expect(bill.grandTotal).toBe('1180.00');
  });

  it('says nothing when the split agrees with the states', async () => {
    const p = await propose(
      doc(SAME_STATE, 'P21', 'Item CGST 9 % SGST 9 %'), intraStateTable());
    expect(p.warnings.join(' ')).not.toMatch(/place of supply/);
  });
});

// ---------------------------------------------------------------------------
/*
 * The model is a fallback, and it is off until a firm says otherwise.
 *
 * Uploading a client's invoice is a DPDP decision belonging to the firm as data
 * fiduciary. A default that exported documents would be making that decision
 * for them, so no row means no.
 */
describe('a model as extractor of last resort', () => {
  /** Returns a table that ties, and records whether it was asked at all. */
  const spyLlm = (): LlmClient & { calls: number } => {
    const c = {
      provider: 'test', model: 'test-model', calls: 0,
      async complete() {
        c.calls++;
        return JSON.stringify({
          header: ['Description', 'Taxable Value', 'IGST', 'Total'],
          rows: [['Example', '1000.00', '180.00', '1180.00']],
        });
      },
    };
    return c;
  };

  /** A table geometry the coordinate path cannot read: two amounts in a cell. */
  const unreadable = () => page([
    w('Qty', 40, 100), w('Taxable', 90, 100), w('Total', 220, 100),
    w('1', 40, 130), w('1000.00 180.00', 90, 130), w('1180.00', 220, 130),
  ]);

  it('is off for a firm that has not switched it on', async () => {
    expect(await llmExtractionEnabled(t.firmId)).toBe(false);
  });

  it('is not called when the firm has not consented', async () => {
    // The check that must not fail open. Passing a client is not consent.
    const llm = spyLlm();
    const p = await propose(doc(SAME_STATE, 'L1', 'IGST 18 %'), unreadable(), llm);
    expect(llm.calls).toBe(0);
    expect(p.input).toBeNull();
    expect(p.readBy).toBe('coordinates');
  });

  it('is not called when the coordinates already read the table', async () => {
    /*
     * Order matters. The coordinate path is deterministic, free, keeps the
     * document in the building and can point at the region a figure came from
     * (PR-7). A model can do none of those, so it only gets a turn where the
     * cheaper answer is unavailable.
     */
    await enableLlmExtraction(t.firmId,
      { provider: 'test', model: 'test-model', enabledBy: t.userId });
    const llm = spyLlm();
    const p = await propose(doc(SAME_STATE, 'L2', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'), llm);
    expect(llm.calls).toBe(0);
    expect(p.readBy).toBe('coordinates');
    expect(p.blockers).toEqual([]);
  });

  it('reads a document the coordinates refused, once consent exists', async () => {
    const llm = spyLlm();
    const p = await propose(doc(SAME_STATE, 'L3', 'IGST 18 %'), unreadable(), llm);
    expect(llm.calls).toBe(1);
    expect(p.readBy).toBe('llm');
    expect(p.blockers).toEqual([]);
    expect(p.table.sums.taxable).toBe('1000.00');
  });

  it('says on the record that the document left the building', async () => {
    const p = await propose(doc(SAME_STATE, 'L4', 'IGST 18 %'), unreadable(), spyLlm());
    expect(p.llmProvenance).toEqual({ provider: 'test', model: 'test-model' });
    expect(p.warnings.join(' ')).toMatch(/sent to a third party/);
  });

  it('posts what the model read, through the same gates', async () => {
    const p = await propose(doc(SAME_STATE, 'L5', 'IGST 18 %'), unreadable(), spyLlm());
    const bill = await postProposal(t.firmId, p,
      { approvedBy: t.userId });
    expect(bill.taxableValue).toBe('1000.00');
    expect(bill.totalGst).toBe('180.00');
  });

  it('stays blocked when the model returns figures that do not tie', async () => {
    const liar: LlmClient = {
      provider: 'test', model: 'test-model',
      async complete() {
        return JSON.stringify({
          header: ['Description', 'Taxable Value', 'IGST', 'Total'],
          rows: [['Example', '1000.00', '180.00', '9999.00']],
        });
      },
    };
    const p = await propose(doc(SAME_STATE, 'L6', 'IGST 18 %'), unreadable(), liar);
    expect(p.input).toBeNull();
    expect(p.readBy).toBe('coordinates');   // the attempt did not replace it
  });

  it('records who switched it on, because the CHECK demands it', async () => {
    const r = await ownerPool.query<{ enabled_by: string; provider: string }>(
      `SELECT enabled_by, llm_provider AS provider FROM firm_ai_settings
       WHERE firm_id = $1`, [t.firmId]);
    expect(r.rows[0]!.enabled_by).toBe(t.userId);
    expect(r.rows[0]!.provider).toBe('test');
  });

  it('cannot be switched on anonymously', async () => {
    // `llm_extraction_is_attributed` — an unattributed decision to export
    // client documents is what the table exists to prevent.
    await expect(ownerPool.query(
      `INSERT INTO firm_ai_settings (firm_id, llm_extraction) VALUES ($1, true)`,
      [t.firmId])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
/*
 * Cross-check: ask two readers and refuse to post when they differ.
 *
 * Built because a model disagreed with two readings that gate 2 had passed, and
 * on both the coordinate reader was wrong. A three-fee Flipkart invoice read a
 * taxable value of 50.00 against a true 327.96, and one row's 50.00 + 9.00 =
 * 59.00 ties perfectly on its own — so no internal check could have caught it.
 */
describe('cross-check', () => {
  const readsAs = (taxable: string, igst: string, total: string): LlmClient => ({
    provider: 'test', model: 'test-model',
    async complete() {
      return JSON.stringify({
        header: ['Description', 'Taxable Value', 'IGST', 'Total'],
        rows: [['Example', taxable, igst, total]],
      });
    },
  });

  const silent: LlmClient = {
    provider: 'test', model: 'test-model',
    async complete() { return JSON.stringify({ header: [], rows: [] }); },
  };

  it('is a separate switch from extraction', async () => {
    // Extraction sends documents we could not read; cross-check sends ones we
    // read perfectly well. Strictly more client data leaves the building, so
    // consenting to the first must not enrol a firm in the second.
    await enableLlmExtraction(t.firmId,
      { provider: 'test', model: 'test-model', enabledBy: t.userId });
    expect(await llmSettings(t.firmId))
      .toEqual({ extraction: true, crossCheck: false });
  });

  it('cannot be switched on without extraction', async () => {
    await expect(ownerPool.query(
      `UPDATE firm_ai_settings SET llm_extraction = false, llm_cross_check = true
       WHERE firm_id = $1`, [t.firmId])).rejects.toThrow();
  });

  it('confirms a reading both readers agree on', async () => {
    await enableLlmExtraction(t.firmId, {
      provider: 'test', model: 'test-model', enabledBy: t.userId, crossCheck: true });
    const p = await propose(doc(SAME_STATE, 'X1', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'),
      readsAs('1000.00', '180.00', '1180.00'));
    expect(p.crossChecked).toBe('agreed');
    expect(p.blockers).toEqual([]);
  });

  it('BLOCKS when the two readings differ', async () => {
    /*
     * The disagreement blocks rather than warns. When this was measured, both
     * readings tied arithmetically — 50.00 + 9.00 = 59.00 and 327.96 + 59.04 =
     * 387.00 are each internally consistent — so nothing available can pick
     * the right one. We know one is wrong and cannot know which; posting
     * either would be a coin toss carrying a provenance trail.
     */
    const p = await propose(doc(SAME_STATE, 'X2', 'IGST 18 %'),
      interStateTable('50.00', '9.00', '59.00'),
      readsAs('327.96', '59.04', '387.00'));
    expect(p.crossChecked).toBe('disagreed');
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/two independent readings.*disagree/);
    expect(p.blockers.join(' ')).toMatch(/taxable: 50\.00 vs 327\.96/);
  });

  it('does not treat a model that cannot read as dissent', async () => {
    // It refuses 6 of 24 documents in the corpus, including a mainstream
    // Indian format. Silence as dissent would block bills we read correctly.
    const p = await propose(doc(SAME_STATE, 'X3', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'), silent);
    expect(p.crossChecked).toBe('unavailable');
    expect(p.blockers).toEqual([]);
  });

  it('records "unavailable" rather than calling it agreement', async () => {
    // Nobody confirmed the figures. That is worth knowing and is not the same
    // fact as a second reader having checked them.
    const p = await propose(doc(SAME_STATE, 'X4', 'IGST 18 %'),
      interStateTable('1000.00', '180.00', '1180.00'), silent);
    expect(p.crossChecked).not.toBe('agreed');
  });
});

// ---------------------------------------------------------------------------
describe('compareReadings', () => {
  const table = (sums: Record<string, string>) =>
    ({ readable: true, roles: [], header: [], rows: [], totals: null, sums }) as never;

  it('says nothing when every figure matches', () => {
    expect(compareReadings(
      table({ taxable: '100.00', total: '118.00' }),
      table({ taxable: '100.00', total: '118.00' }))).toEqual([]);
  });

  it('names each figure that differs', () => {
    expect(compareReadings(
      table({ taxable: '50.00', total: '59.00' }),
      table({ taxable: '327.96', total: '387.00' })))
      .toEqual(['taxable: 50.00 vs 327.96', 'total: 59.00 vs 387.00']);
  });

  it('counts a column one reader missed entirely as a difference', () => {
    // The truncation defect could equally have shown up this way — one reader
    // finding a CGST column the other never saw.
    expect(compareReadings(
      table({ taxable: '100.00' }),
      table({ taxable: '100.00', cgst: '9.00' })))
      .toEqual(['cgst: not found vs 9.00']);
  });
});

// ---------------------------------------------------------------------------
/*
 * The date, read off the document.
 *
 * It used to be today's, with a comment telling a reviewer to correct it. A
 * wrong date lands the bill in the wrong GST return period, which is a
 * correction to two filings rather than one edit — and nothing downstream can
 * tell that a plausible date is the wrong one.
 */
describe('the invoice date', () => {
  it('is read from the document, not from the clock', async () => {
    const p = await propose(
      doc(SAME_STATE, 'D1', 'IGST 18 %', 'Invoice Date : 27-08-2026'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.billDate).toBe('2026-08-27');
    expect(p.input!.billDate).toBe('2026-08-27');
  });

  it('records how the date was settled', async () => {
    const p = await propose(
      doc(SAME_STATE, 'D2', 'IGST 18 %', 'Invoice Date : 03-Jun-2026'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.billDate).toBe('2026-06-03');
    expect(p.billDateBasis).toMatch(/read as "03-Jun-2026"/);
  });

  it('blocks an ambiguous date rather than picking a reading', async () => {
    /*
     * "04.09.2026" is 4 September or 9 April. Those are different return
     * periods. "Indian invoices are day-first" is true and is exactly the kind
     * of assumption that has produced every wrong answer here so far.
     */
    const p = await propose(
      doc(SAME_STATE, 'D3', 'IGST 18 %', 'Invoice Date : 04.09.2026'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/could be 2026-09-04 or 2026-04-09/);
  });

  it('resolves an ambiguous date from an unambiguous one on the same document', async () => {
    // What rescues Amazon: its signature block prints a year-first
    // `2026.09.03`, so the 09 in `04.09.2026` is the month.
    const p = await propose(
      doc(SAME_STATE, 'D4', 'IGST 18 %',
          'Invoice Date : 04.09.2026\nDigitally signed Date: 2026.09.03 22:21:45 UTC'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.billDate).toBe('2026-09-04');
    expect(p.billDateBasis).toMatch(/day-first/);
  });

  it('blocks a document with no date at all', async () => {
    const p = await propose(
      doc(SAME_STATE, 'D5', 'IGST 18 %', 'no date here'),
      interStateTable('1000.00', '180.00', '1180.00'));
    expect(p.input).toBeNull();
    expect(p.blockers.join(' ')).toMatch(/no date appears/);
  });

  it('lets a reviewer override what was read', async () => {
    // The parser can be right and still not be what the reviewer wants — a
    // date corrected on the paper by hand, say.
    const p = await propose(
      doc(SAME_STATE, 'D6', 'IGST 18 %', 'Invoice Date : 27-08-2026'),
      interStateTable('1000.00', '180.00', '1180.00'));
    const bill = await postProposal(t.firmId, p,
      { approvedBy: t.userId, billDate: '2026-09-01' });
    expect(bill.grandTotal).toBe('1180.00');
  });
});
