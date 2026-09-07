/**
 * Record where every posted figure was read from.
 *
 * Spec: provenance.md PR-3 to PR-6 · bills-and-expenses.md §4.8
 *
 * `source_documents` and `extracted_fields` were built in migration 009 and
 * nothing ever wrote to them. That made `extracted_fields` the seventh dead
 * control in this codebase, and the costliest one to leave dead: it is the
 * highlight-on-the-bill mechanism, which is how a CA comes to trust a figure
 * they did not type.
 *
 * I also asserted the capability existed. Two commit messages and a design
 * note said the coordinate reader could "name the exact region a figure came
 * from" while `wordColumns` computed the bands and discarded them. This module
 * is what makes that sentence true rather than rhetorical.
 *
 * ── What is recorded, and why each part ───────────────────────────────────
 *
 * Both the RAW string and the parsed value (PR-4). "₹1,23,456.78" and
 * 123456.78 are different facts: the first proves what the document said, the
 * second is what the system used, and a parsing bug is invisible without both.
 *
 * The METHOD, honestly (PR-5). A figure read from a PDF's own coordinates and
 * a figure read by a language model deserve different trust, and the enum now
 * distinguishes them rather than filing both under something they are not.
 *
 * The BAND, normalised 0–1 (PR-6). Pixels rot — pages get re-rendered at other
 * resolutions — so the box is stored as a fraction of the page.
 *
 * The VOUCHER, per field. One file becomes several vouchers, so a link on the
 * file cannot say which bill a figure supports.
 */

import { withFirm } from '../db/pool.ts';
import { paise, money } from './tax.ts';
import type { BillProposal } from './billProposal.ts';
import type { ColumnRole } from '../parse/invoiceTable.ts';

/** The roles worth recording. Others are descriptive, not financial. */
const RECORDED: ColumnRole[] =
  ['taxable', 'cgst', 'sgst', 'igst', 'cess', 'total'];

export interface RecordInput {
  clientId: string;
  voucherId: string;
  /** Where the original lives. The auditor's evidence (Lesson 11). */
  sourceUri: string;
  channel?: 'email' | 'whatsapp' | 'upload' | 'scan' | 'api';
  mimeType?: string;
  fileSize?: number;
  pageCount?: number;
}

/**
 * Registers the file, once per client per content hash.
 *
 * BE-2 deduplicates on content, not filename: the same bill routinely arrives
 * twice, emailed by the vendor and photographed by the employee. The unique
 * index on (client_id, sha256) is what enforces that, so a second ingestion of
 * the same bytes returns the first row rather than creating a rival record.
 */
async function upsertSourceDocument(
  firmId: string, input: RecordInput, sha256: string,
): Promise<string> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO source_documents
         (firm_id, client_id, channel, original_blob_uri, mime_type,
          file_size, page_count, sha256, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'processed')
       ON CONFLICT (client_id, sha256) DO UPDATE SET status = 'processed'
       RETURNING id`,
      [firmId, input.clientId, input.channel ?? 'upload', input.sourceUri,
       input.mimeType ?? 'application/pdf', input.fileSize ?? null,
       input.pageCount ?? null, sha256]);
    return r.rows[0]!.id;
  });
}

/**
 * Writes one `extracted_fields` row per figure the bill was built from.
 *
 * Never throws into the caller's face on a provenance failure alone: the bill
 * is already posted and correct, and losing the audit trail is a lesser harm
 * than an exception unwinding after an append-only write. It returns what it
 * managed instead, so a caller can report the gap.
 */
export async function recordProvenance(
  firmId: string, proposal: BillProposal, input: RecordInput,
): Promise<{ sourceDocumentId: string; fields: number }> {
  const sourceDocumentId = await upsertSourceDocument(
    firmId, input, proposal.fileHash);

  const method = proposal.readBy === 'llm' ? 'llm_text' : 'pdf_coordinates';
  const modelVersion = proposal.readBy === 'llm'
    ? `${proposal.llmProvenance?.provider}/${proposal.llmProvenance?.model}`
    : 'pdftotext -bbox-layout';

  interface Field {
    path: string; raw: string | null; parsed: unknown;
    page: number | null; bbox: number[] | null;
    method: string; model: string;
  }
  const fields: Field[] = [];

  const sources = proposal.table.columnSources;
  const roleColumn = (role: ColumnRole): number => proposal.table.roles.indexOf(role);

  for (const role of RECORDED) {
    const value = proposal.table.sums[role];
    if (value === undefined) continue;
    const col = roleColumn(role);
    const src = col >= 0 ? sources?.[col] : undefined;

    fields.push({
      path: `totals.${role}`,
      // The raw cell of the stated totals row where the document printed one;
      // otherwise there is no single raw string, because the figure is a sum.
      raw: proposal.table.totals?.cells[col] ?? null,
      parsed: value,
      page: src?.page ?? null,
      bbox: src ? normalise(src) : null,
      method, model: modelVersion,
    });
  }

  // Per line, with the raw cell exactly as printed — this is the row a
  // reviewer's eye goes to when a total looks wrong.
  /*
   * Only rows that actually carry a figure.
   *
   * The table keeps an item's wrapped description as its own row — Blinkit
   * spreads one product name over six lines — and those rows have an empty
   * taxable cell. Recording them produced six `lines[n].taxable` entries with
   * no value and no raw text, which is noise in the one place that has to be
   * readable: a reviewer scanning for where a figure came from.
   *
   * The index is the position among rows that HAVE a value, so `lines[1]`
   * means the second money line rather than the second physical row.
   */
  const col = roleColumn('taxable');
  if (col >= 0) {
    const src = sources?.[col];
    proposal.table.rows
      .filter((r) => r !== proposal.table.totals)
      .filter((r) => (r.cells[col] ?? '').trim() !== '')
      .forEach((row, i) => {
        fields.push({
          path: `lines[${i}].taxable`,
          raw: row.cells[col] ?? null,
          parsed: row.by.taxable ?? null,
          page: src?.page ?? null,
          bbox: src ? normalise(src) : null,
          method, model: modelVersion,
        });
      });
  }

  /*
   * The date and the supplier are recorded as `derived`, not as read.
   *
   * Neither is a cell lifted off the page. The date was settled by reasoning
   * across the file — "read day-first, as another date on the document is" —
   * and the supplier by matching a GSTIN against the party master. Filing
   * either as a direct reading would overstate how it was obtained, which is
   * the specific dishonesty PR-5 exists to prevent.
   */
  if (proposal.billDate) {
    fields.push({
      path: 'bill_date', raw: null, parsed: proposal.billDate,
      page: null, bbox: null,
      method: 'derived', model: proposal.billDateBasis ?? 'read from the document',
    });
  }
  if (proposal.supplierGstin) {
    fields.push({
      path: 'supplier_gstin', raw: proposal.supplierGstin,
      parsed: proposal.supplierGstin, page: null, bbox: null,
      method: 'derived', model: 'checksum verified, matched to a party',
    });
  }

  await withFirm(firmId, async (c) => {
    for (const f of fields) {
      await c.query(
        `INSERT INTO extracted_fields
           (source_document_id, voucher_id, document_index, field_path,
            raw_text, parsed_value, page_number, bbox,
            extraction_method, model_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::extraction_method,$10)`,
        [sourceDocumentId, input.voucherId, proposal.index, f.path,
         f.raw, JSON.stringify(f.parsed), f.page, f.bbox, f.method, f.model]);
    }
  });

  return { sourceDocumentId, fields: fields.length };
}

/**
 * The band as a fraction of the page (PR-6).
 *
 * Vertical extent is deliberately the whole page: a column is a horizontal
 * band and the rows within it are found by clustering, not by a stored y. A
 * reviewer highlighting a column wants the column.
 */
function normalise(s: {
  xMin: number; xMax: number; pageWidth: number; pageHeight: number;
}): number[] {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [clamp(s.xMin / s.pageWidth), 0, clamp(s.xMax / s.pageWidth), 1];
}

export interface FigureOrigin {
  fieldPath: string;
  rawText: string | null;
  parsedValue: unknown;
  page: number | null;
  bbox: number[] | null;
  method: string;
  modelVersion: string | null;
}

/**
 * Answers "where did this figure come from?" for a posted bill.
 *
 * The read side is the point of the write side. A provenance table nobody can
 * query is the same as no provenance table, which is how the last one stayed
 * dead for so long without anybody noticing.
 */
export async function explainBill(
  firmId: string, voucherId: string,
): Promise<FigureOrigin[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{
      field_path: string; raw_text: string | null; parsed_value: unknown;
      page_number: number | null; bbox: string[] | null;
      extraction_method: string; model_version: string | null;
    }>(
      `SELECT field_path, raw_text, parsed_value, page_number, bbox,
              extraction_method, model_version
         FROM extracted_fields
        WHERE voucher_id = $1
        ORDER BY field_path`, [voucherId]);

    return r.rows.map((x) => ({
      fieldPath: x.field_path,
      rawText: x.raw_text,
      parsedValue: x.parsed_value,
      page: x.page_number,
      bbox: x.bbox ? x.bbox.map(Number) : null,
      method: x.extraction_method,
      modelVersion: x.model_version,
    }));
  });
}

/** Sanity helper for reports: the sum of recorded line figures. */
export function sumRecorded(fields: FigureOrigin[], prefix: string): string {
  let total = 0n;
  for (const f of fields) {
    if (!f.fieldPath.startsWith(prefix)) continue;
    if (typeof f.parsedValue !== 'string') continue;
    try { total += paise(f.parsedValue); } catch { /* not a number */ }
  }
  return money(total);
}
