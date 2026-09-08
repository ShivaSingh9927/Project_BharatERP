/**
 * Every plausible reading of a document, graded; at most one believed.
 * Spec: bills-and-expenses.md BE-21
 *
 * ── Why this replaces recognising layouts ──────────────────────────────────
 *
 * The readers before this one each recognised a SHAPE — a ruled grid, an
 * annexure-only invoice, charges written in prose — and every vendor layout
 * that fitted none of them needed a new module. That count grows with the
 * number of vendors, and for Indian invoices the number of vendors is
 * unbounded. Three readers in, all three ended with the identical line:
 *
 *     gradeTable(header, rows, stated, charged)
 *
 * When three modules converge on one ending, the ending is the program and the
 * rest was hand-coded search. So: stop recognising, start searching. The
 * sidecar reads the PDF four different ways and returns every table any of
 * them can see, ranked by nothing. This grades them all.
 *
 * ── What makes a search safe ───────────────────────────────────────────────
 *
 * More candidates means more chances to be wrong, so the gate must do more
 * than accept the first that passes:
 *
 *   - Every candidate faces the SAME two gates as every other reader. No
 *     candidate is trusted for coming from a smarter strategy.
 *   - Survivors are reduced to their FINANCIAL SIGNATURE — taxable, each tax
 *     head, total. Two strategies finding the same grid is not disagreement,
 *     and must not be treated as any.
 *   - If two candidates survive with DIFFERENT figures, the document is
 *     refused. Both tie arithmetically, so no check available here can say
 *     which is right, and picking one would be a coin toss with a provenance
 *     trail. This is the same discipline `deriveGstRate` applies when more
 *     than one scheduled rate fits.
 *
 * A wrong candidate is therefore not a defect in the sidecar. Too few is.
 *
 * ── Provenance ─────────────────────────────────────────────────────────────
 *
 * Cell boxes travel with every candidate and are folded into `columnSources`,
 * so a figure read this way can still be pointed at on the page (PR-3, PR-6).
 * That requirement is why the structure layer reads geometry rather than
 * asking a table model: a model returns cells, and a cell a CA cannot locate
 * is a cell they cannot check.
 */

import { gradeTable, statedTotalsInText, type InvoiceTable, type ColumnSource }
  from './invoiceTable.ts';
import type { Charged } from './invoiceTax.ts';

/** One table some strategy believed it saw. */
export interface CandidateTable {
  page: number;
  /** Which strategy found it: lines | default | text | words | ocr-words. */
  method: string;
  cells: string[][];
  /** Per cell, [x0, y0, x1, y1] in PDF points, or null where unknown. */
  boxes?: Array<Array<number[] | null>>;
  pageWidth?: number;
  pageHeight?: number;
}

export interface ParserResult {
  pages: number;
  /** `ocr` means the figures came from pixels, not from the document's text. */
  route: 'digital' | 'ocr';
  text: string;
  tables: CandidateTable[];
}

export interface ParserClient {
  read(pdf: Buffer, opts?: { ocr?: 'auto' | 'on' | 'off' }): Promise<ParserResult>;
}

/**
 * Words that make a row look like a set of column captions.
 *
 * Header rows are found by CONTENT, not by position. Position was tried first
 * and was wrong on the commonest Indian layout: a ruled invoice is one big
 * outer box, so row 0 of the table the ruling lines describe is the letterhead
 * — "GSTIN : ... TAX INVOICE ... ASPEE SPRINGS LTD ..." — and the item
 * captions sit four rows down. Grading only the first few rows found nothing
 * and refused documents whose table had been extracted perfectly.
 */
const CAPTION = /\b(?:s\.?\s?no|sr|sl|description|particulars|item|product|service|hsn|sac|qty|quantity|uom|unit|rate|price|mrp|taxable|discount|cgst|sgst|utgst|igst|cess|amount|total|value|net|gross)\b/i;

/** At most this many arrangements of one candidate are graded. Beyond a few we
 *  are no longer reading a header, we are hunting for one that happens to tie
 *  — the failure mode this whole design exists to prevent. */
const MAX_HEADER_TRIES = 4;

/**
 * Rows of a candidate worth trying as its header, best first.
 *
 * A row scores by how many DISTINCT caption words it carries. Row 0 is always
 * included as a fallback, because a table extracted from a clean grid usually
 * does put its captions there and a two-column table may carry only one
 * recognisable word.
 */
function plausibleHeaderRows(cells: string[][]): number[] {
  const scored: Array<{ i: number; score: number }> = [];
  for (let i = 0; i < cells.length - 1; i++) {
    const words = new Set<string>();
    for (const c of cells[i]!) {
      for (const m of c.matchAll(new RegExp(CAPTION, 'gi'))) {
        words.add(m[0]!.toLowerCase());
      }
    }
    if (words.size >= 2) scored.push({ i, score: words.size });
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const out = scored.slice(0, MAX_HEADER_TRIES).map((s) => s.i);
  if (!out.includes(0) && cells.length >= 2) out.push(0);
  return out;
}

/** The figures a reading commits to. Two readings agreeing on all of these are
 *  the same reading, however differently they were found. */
function signature(t: InvoiceTable): string {
  const g = (k: keyof typeof t.sums) => t.sums[k] ?? '-';
  return [g('taxable'), g('cgst'), g('sgst'), g('igst'), g('cess'), g('total')].join('|');
}

/** Column bands, derived from the cell boxes, so a figure keeps its region. */
function columnSourcesFor(
  c: CandidateTable, header: string[],
): ColumnSource[] | undefined {
  if (!c.boxes || !c.pageWidth || !c.pageHeight) return undefined;
  const out: ColumnSource[] = [];
  for (let col = 0; col < header.length; col++) {
    let xMin = Infinity, xMax = -Infinity;
    for (const row of c.boxes) {
      const b = row[col];
      if (!b) continue;
      xMin = Math.min(xMin, b[0]!);
      xMax = Math.max(xMax, b[2]!);
    }
    if (!isFinite(xMin) || !isFinite(xMax)) return undefined;
    out.push({
      caption: header[col] ?? '', page: c.page,
      xMin, xMax, pageWidth: c.pageWidth, pageHeight: c.pageHeight,
    });
  }
  return out;
}

export interface CandidateVerdict {
  table: InvoiceTable;
  /** Which strategy produced the accepted reading, for the audit trail. */
  method?: string;
  /** Distinct readings that survived. More than one is a refusal. */
  survivors: number;
}

/**
 * Grades every candidate and returns the single reading that survives.
 *
 * Nothing here prefers one strategy over another. The ruling-line reader is
 * usually right and the word-row reconstruction usually is not, but ranking
 * them would reintroduce exactly the judgement this design removes: if the
 * arithmetic cannot tell two readings apart, neither can a preference order,
 * and the honest answer is to refuse.
 */
export function gradeCandidates(
  tables: readonly CandidateTable[],
  pages: readonly number[],
  chargedByDocument: Charged,
  segmentText: string,
): CandidateVerdict | null {
  const stated = statedTotalsInText(segmentText);
  const onThesePages = tables.filter((t) => pages.includes(t.page));
  if (onThesePages.length === 0) return null;

  const survivors = new Map<string, { table: InvoiceTable; method: string }>();
  let closestMiss: { table: InvoiceTable; method: string } | null = null;

  for (const c of onThesePages) {
    for (const h of plausibleHeaderRows(c.cells)) {
      const header = c.cells[h];
      const rows = c.cells.slice(h + 1);
      if (header === undefined || rows.length === 0) continue;
      const graded = gradeTable(header, rows, stated, chargedByDocument);
      if (graded.readable) {
        const src = columnSourcesFor(c, header);
        if (src) graded.columnSources = src;
        const key = signature(graded);
        if (!survivors.has(key)) survivors.set(key, { table: graded, method: c.method });
        break;   // this candidate has spoken; other header rows are not new readings
      }
      if (closestMiss === null && graded.reason !== undefined) {
        closestMiss = { table: graded, method: c.method };
      }
    }
  }

  if (survivors.size === 1) {
    const only = [...survivors.values()][0]!;
    return { table: only.table, method: only.method, survivors: 1 };
  }

  if (survivors.size > 1) {
    const shown = [...survivors.values()].slice(0, 3).map(
      (s) => `${s.method} reads taxable ${s.table.sums.taxable ?? '-'} and total ` +
             `${s.table.sums.total ?? '-'}`);
    return {
      survivors: survivors.size,
      table: {
        readable: false, roles: [], header: [], rows: [], totals: null, sums: {},
        reason:
          `${survivors.size} different readings of this document each add up: ` +
          `${shown.join('; ')}. They cannot all be right and no arithmetic here ` +
          'can choose between them, so the figures need a human.',
      },
    };
  }

  return closestMiss === null ? null
    : { table: closestMiss.table, method: closestMiss.method, survivors: 0 };
}

const DEFAULT_URL = 'http://127.0.0.1:8423';

export function parserHttpClient(baseUrl = DEFAULT_URL): ParserClient {
  return {
    async read(pdf, opts) {
      const r = await fetch(`${baseUrl}/extract`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/pdf',
          'X-OCR': opts?.ocr ?? 'auto',
        },
        body: new Uint8Array(pdf),
      });
      if (!r.ok) {
        throw new Error(
          `the structure reader returned HTTP ${r.status}. The bill is ` +
          'unaffected; this document simply was not read by it.');
      }
      return await r.json() as ParserResult;
    },
  };
}

/**
 * A client only if the sidecar is configured AND reachable — checked once, so
 * a firm that has not started it is not punished with a failed fetch per
 * document.
 */
export async function parserClientFromEnv(): Promise<ParserClient | null> {
  const url = process.env['PARSER_URL'] ?? DEFAULT_URL;
  if (process.env['PARSER_ENABLED'] !== '1' && process.env['PARSER_URL'] === undefined) {
    return null;
  }
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
  } catch {
    return null;
  }
  return parserHttpClient(url);
}
