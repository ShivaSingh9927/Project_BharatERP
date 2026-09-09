/**
 * Where every posted figure came from — provenance.md PR-3 to PR-6.
 *
 * `source_documents` and `extracted_fields` existed since migration 009 and
 * nothing ever wrote to them. That made `extracted_fields` the seventh dead
 * control here, and the costliest to leave dead: it is the
 * highlight-on-the-bill mechanism, which is how a CA comes to trust a figure
 * they did not type.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, registerGstin, type SeededTenant } from '../src/seed/index.ts';
import { seedItcEligibility } from '../src/seed/tdsSections.ts';
import { proposeFromDocument, postProposal } from '../src/domain/billProposal.ts';
import { explainBill, sumRecorded } from '../src/domain/provenance.ts';
import { splitDocuments } from '../src/parse/documentSplit.ts';
import { wordsToRows, type Word, type WordPage } from '../src/parse/pdfWords.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { ownerPool, closePools } from '../src/db/pool.ts';

const gstin = (state: string, pan: string): string => {
  const f14 = `${state}${pan}1Z`;
  return f14 + gstinCheckDigit(f14);
};
const OURS = gstin('09', 'AAACP1111P');
const SUPPLIER = gstin('09', 'AAACQ2222Q');

let t: SeededTenant;
let purchases: string;
let n = 0;

const w = (text: string, xMin: number, yMin: number,
           width = text.length * 3.3, height = 6.6): Word =>
  ({ text, xMin, xMax: xMin + width, yMin, yMax: yMin + height });

/** A 600×800 page whose taxable column sits at x=150..190. */
const table = (): WordPage[] => [{
  number: 1, width: 600, height: 800,
  rows: wordsToRows([
    w('Description', 40, 100), w('Qty', 110, 100),
    w('Taxable', 150, 100), w('IGST', 240, 100), w('Total', 320, 100),
    w('Item one', 40, 130), w('1', 110, 130),
    w('600.00', 150, 130), w('108.00', 240, 130), w('708.00', 320, 130),
    w('Item two', 40, 145), w('1', 110, 145),
    w('400.00', 150, 145), w('72.00', 240, 145), w('472.00', 320, 145),
  ]),
}];

const doc = () => splitDocuments(
  `Tax Invoice\nInvoice Number # PV-${++n}\nInvoice Date : 27-08-2026\n`
  + `GSTIN - ${SUPPLIER}\nItem IGST 18 %\n`)[0]!;

const propose = () => proposeFromDocument(t.firmId,
  { clientId: t.clientId, createdBy: t.userId, expenseAccountId: purchases },
  doc(), table(), 'b'.repeat(64));

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  t = await seedTenant({
    firmName: `Prov ${tag}`, clientName: `Client ${tag}`,
    userEmail: `prov-${tag}@example.test`, startYear: 2026,
    pan: 'AAACP1111P', businessType: 'general',
  });
  await seedItcEligibility(t.clientId);
  await registerGstin(t.firmId, t.clientId, OURS, { primary: true });
  purchases = (await ownerPool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE client_id = $1 AND name = 'Purchases'`,
    [t.clientId])).rows[0]!.id;
  const creditors = (await ownerPool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE client_id = $1 AND name = 'Creditors'`,
    [t.clientId])).rows[0]!.id;
  await ownerPool.query(
    `INSERT INTO parties (firm_id, client_id, party_type, name, gstin,
                          gst_category, state_code, ledger_account_id, created_by)
     VALUES ($1,$2,'supplier','Prov Supplier',$3,'registered_regular','09',$4,$5)`,
    [t.firmId, t.clientId, SUPPLIER, creditors, t.userId]);
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('a posted bill can say where its figures came from', () => {
  it('records every money total with its column band', async () => {
    const p = await propose();
    const bill = await postProposal(t.firmId, p,
      { approvedBy: t.userId, sourceUri: 'file:///tmp/example.pdf' });

    const fields = await explainBill(t.firmId, bill.voucherId);
    const paths = fields.map((f) => f.fieldPath);
    expect(paths).toContain('totals.taxable');
    expect(paths).toContain('totals.igst');
    expect(paths).toContain('totals.total');
  });

  it('stores the band as a fraction of the page, not in pixels', async () => {
    /*
     * PR-6. Pixels rot: pages get re-rendered at other resolutions, and a box
     * in points is meaningless against a different rendering. The taxable
     * column sits at x=150..190 on a 600pt page, so 0.25..0.317.
     */
    const p = await propose();
    const bill = await postProposal(t.firmId, p, { approvedBy: t.userId });
    const fields = await explainBill(t.firmId, bill.voucherId);
    const taxable = fields.find((f) => f.fieldPath === 'totals.taxable')!;

    expect(taxable.page).toBe(1);
    expect(taxable.bbox![0]).toBeCloseTo(150 / 600, 2);
    // Covers the caption and every figure placed under it.
    expect(taxable.bbox![2]).toBeGreaterThanOrEqual((150 + 19.8) / 600);
    for (const v of taxable.bbox!) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of taxable.bbox!) expect(v).toBeLessThanOrEqual(1);
  });

  it('widens the band to the figures, not just the caption', async () => {
    /*
     * The band starts as the caption's extent, which is right for assigning
     * words and wrong for handing a reviewer. "Taxable" is 23pt wide while
     * "₹13,047.46" beneath it is wider and, being right-aligned, offset — so a
     * highlight drawn on the caption alone misses the number it points at.
     */
    const wide: WordPage[] = [{
      number: 1, width: 600, height: 800,
      rows: wordsToRows([
        w('Description', 40, 100), w('Qty', 110, 100),
        w('Taxable', 150, 100), w('IGST', 260, 100), w('Total', 340, 100),
        w('Item', 40, 130), w('1', 110, 130),
        w('13047.46', 150, 130, 60), w('2348.54', 260, 130),
        w('15396.00', 340, 130),
      ]),
    }];
    const p = await proposeFromDocument(t.firmId,
      { clientId: t.clientId, createdBy: t.userId, expenseAccountId: purchases },
      doc(), wide, 'd'.repeat(64));
    /*
     * 13,047.46 on a goods head is above the capitalisation threshold, so
     * BE-11 now asks whether it is stock or an asset. It is stock here, and
     * the question has to be answered before anything posts.
     */
    const cap = p.confirmations.find((c) => c.field.startsWith('capitalise_'))!;
    const bill = await postProposal(t.firmId, p, {
      approvedBy: t.userId, confirm: { [cap.field]: cap.chose },
    });
    const taxable = (await explainBill(t.firmId, bill.voucherId))
      .find((f) => f.fieldPath === 'totals.taxable')!;

    // The caption ends at 150 + 7×3.3 = 173.1; the figure ends at 210.
    expect(taxable.bbox![2]).toBeCloseTo(210 / 600, 2);
  });

  it('keeps the raw string as well as the parsed value', async () => {
    // PR-4. "600.00" and 600.00 are different facts: the first proves what the
    // document said, the second is what the system used, and a parsing bug is
    // invisible without both.
    const p = await propose();
    const bill = await postProposal(t.firmId, p, { approvedBy: t.userId });
    const lines = (await explainBill(t.firmId, bill.voucherId))
      .filter((f) => f.fieldPath.startsWith('lines['));

    expect(lines).toHaveLength(2);
    expect(lines[0]!.rawText).toBe('600.00');
    expect(sumRecorded(lines, 'lines[')).toBe('1000.00');
  });

  it('records only rows that carry a figure', async () => {
    /*
     * The table keeps an item's wrapped description as its own row — Blinkit
     * spreads one product name over six lines. Recording those produced six
     * `lines[n].taxable` entries with no value and no raw text, which is noise
     * in the one place that has to stay readable.
     */
    const pages: WordPage[] = [{
      number: 1, width: 600, height: 800,
      rows: wordsToRows([
        w('Description', 40, 100), w('Qty', 110, 100),
        w('Taxable', 150, 100), w('IGST', 240, 100), w('Total', 320, 100),
        w('Item one', 40, 130), w('1', 110, 130),
        w('1000.00', 150, 130), w('180.00', 240, 130), w('1180.00', 320, 130),
        w('continued description text', 40, 145),
      ]),
    }];
    const p = await proposeFromDocument(t.firmId,
      { clientId: t.clientId, createdBy: t.userId, expenseAccountId: purchases },
      doc(), pages, 'c'.repeat(64));
    const bill = await postProposal(t.firmId, p, { approvedBy: t.userId });
    const lines = (await explainBill(t.firmId, bill.voucherId))
      .filter((f) => f.fieldPath.startsWith('lines['));
    expect(lines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('honesty about how a value was obtained', () => {
  it('names the reader, not something it was not', async () => {
    /*
     * PR-5 exists because a value fetched from the IRP and a value read off a
     * photo deserve different trust. The enum had no name for either of our
     * readers, and filing the coordinate reader under `ocr_vlm` would have
     * claimed an image was examined when none was.
     */
    const p = await propose();
    const bill = await postProposal(t.firmId, p, { approvedBy: t.userId });
    const fields = await explainBill(t.firmId, bill.voucherId);
    const taxable = fields.find((f) => f.fieldPath === 'totals.taxable')!;

    expect(taxable.method).toBe('pdf_coordinates');
    expect(taxable.modelVersion).toBe('pdftotext -bbox-layout');
  });

  it('marks the date and the GSTIN as derived, not as read', async () => {
    // Neither is a cell lifted off the page: the date was settled by reasoning
    // across the file, the supplier by matching a GSTIN to the party master.
    const p = await propose();
    const bill = await postProposal(t.firmId, p, { approvedBy: t.userId });
    const fields = await explainBill(t.firmId, bill.voucherId);

    const date = fields.find((f) => f.fieldPath === 'bill_date')!;
    expect(date.method).toBe('derived');
    expect(date.parsedValue).toBe('2026-08-27');
    expect(date.modelVersion).toMatch(/27-08-2026/);

    expect(fields.find((f) => f.fieldPath === 'supplier_gstin')!.method)
      .toBe('derived');
  });
});

// ---------------------------------------------------------------------------
describe('the source document', () => {
  it('is registered once per content hash, not per filename', async () => {
    /*
     * BE-2. The same bill routinely arrives twice — emailed by the vendor and
     * photographed by the employee. Two ingestions of the same bytes must not
     * become two rival records of the same evidence.
     */
    const before = await ownerPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM source_documents
        WHERE client_id = $1 AND sha256 = $2`, [t.clientId, 'b'.repeat(64)]);

    const p = await propose();
    await postProposal(t.firmId, p, { approvedBy: t.userId });

    const after = await ownerPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM source_documents
        WHERE client_id = $1 AND sha256 = $2`, [t.clientId, 'b'.repeat(64)]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n === '0' ? '1' : before.rows[0]!.n);
  });
});

// ---------------------------------------------------------------------------
describe('a provenance failure does not unwind a posted bill', () => {
  it('reports the gap as a warning instead of throwing', async () => {
    /*
     * The ledger is append-only, so by the time provenance is written the
     * voucher exists and is correct. Throwing past a completed write would
     * leave the caller with a posted bill and an exception to explain, and no
     * way to un-post it. Losing the trail is the lesser harm, and it is said
     * out loud rather than swallowed.
     */
    const p = await propose();
    // A voucher id that cannot satisfy the foreign key.
    const broken = { ...p, fileHash: 'not-a-valid-sha' + 'x'.repeat(50) };
    const bill = await postProposal(t.firmId, broken, { approvedBy: t.userId });

    expect(bill.grandTotal).toBe('1180.00');
    const recorded = await explainBill(t.firmId, bill.voucherId);
    // Either it recorded, or it warned. Never thrown, and never silent.
    expect(recorded.length > 0 || bill.warnings.some((x) => /read from/.test(x)))
      .toBe(true);
  });
});
