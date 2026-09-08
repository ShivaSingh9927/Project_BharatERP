/**
 * Docling as a fourth reader — machine-learned table structure, behind the
 * same gates as everyone else.
 * Spec: bills-and-expenses.md §4.9 · provenance.md PR-7
 *
 * Two documents in the corpus defeat the deterministic readers for reasons of
 * geometry alone: Amazon separates its numeric columns by a single space,
 * below what a gutter can find, and Kamatera prints its charges in three
 * stacked sub-tables. Both were reaching the model — the one reader that sends
 * the document out of the building.
 *
 * Docling reads both, on-premise and deterministically, from a table model
 * rather than from whitespace. So it slots in AHEAD of the model and behind
 * the coordinate reader:
 *
 *     coordinates  →  Docling  →  language model
 *
 * The order is the trust order. Coordinates are free, instant, and can name
 * the region a figure came from. Docling is none of those — it is a second
 * process, seconds not milliseconds, and offers no bounding box — but it stays
 * on the premises, which the model does not. The model earns its turn last,
 * only where even Docling cannot read.
 *
 * Like every reader here, this one DECIDES NOTHING. It returns cells; whether
 * they can be believed is settled by `gradeTable`, the same two gates the
 * coordinate and model paths face. A machine-learned reader is exactly the
 * kind that can be fluently wrong, so it is trusted no further than its
 * arithmetic ties.
 */

import { gradeTable, type InvoiceTable } from './invoiceTable.ts';
import { statedTotalsInText } from './invoiceTable.ts';
import type { Charged } from './invoiceTax.ts';

/** One table Docling found, with the page it sat on. */
export interface DoclingTable {
  page: number;
  /** cells[0] is the header row; the rest are data rows. */
  cells: string[][];
}

/**
 * The sidecar, behind an interface so tests run without a running service and
 * without the ~800 MB of models it loads.
 */
export interface DoclingClient {
  /** OCR is off for digital PDFs and on for scans — see the sidecar. */
  read(pdf: Buffer, opts?: { ocr?: boolean }): Promise<DoclingTable[]>;
}

/**
 * Grades every candidate table on the segment's pages and returns the first
 * that passes.
 *
 * Docling returns EVERY table on a page — an Amazon page carries a line-item
 * table, a tax summary, and a consignment note. Rather than guess which is the
 * bill, each is put through the same exam and the first readable one is taken.
 * A tax summary does not tie against a total it does not contain, so it fails
 * gate 2 and is passed over; the real table ties and is kept.
 *
 * `chargedByDocument` and the page text are threaded through for the same
 * reasons the coordinate reader needs them: a document that charges no tax is
 * checked against the total it states rather than against a tie it cannot
 * have.
 */
export function readInvoiceTableFromDocling(
  tables: DoclingTable[],
  pages: number[],
  chargedByDocument: Charged,
  segmentText: string,
): InvoiceTable | null {
  const stated = statedTotalsInText(segmentText);
  const candidates = tables.filter((t) => pages.includes(t.page));

  let best: InvoiceTable | null = null;
  for (const t of candidates) {
    if (t.cells.length < 2) continue;
    const header = t.cells[0]!;
    const rows = t.cells.slice(1);
    const graded = gradeTable(header, rows, stated, chargedByDocument);
    if (graded.readable) return graded;
    // Keep the closest miss to explain a refusal, if nothing reads.
    if (best === null && graded.reason !== undefined) best = graded;
  }
  return best;
}

const DEFAULT_URL = 'http://127.0.0.1:8422';

/** A client for the running sidecar. */
export function doclingHttpClient(baseUrl = DEFAULT_URL): DoclingClient {
  return {
    async read(pdf, opts) {
      const r = await fetch(`${baseUrl}/extract`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/pdf',
          'X-OCR': opts?.ocr ? 'on' : 'off',
        },
        body: new Uint8Array(pdf),
      });
      if (!r.ok) {
        throw new Error(
          `the Docling reader returned HTTP ${r.status}. The bill is ` +
          'unaffected; this document simply was not read by it.');
      }
      const body = await r.json() as { tables?: DoclingTable[] };
      return body.tables ?? [];
    },
  };
}

/**
 * A client only if the sidecar is configured AND reachable.
 *
 * Reachability is checked once, here, so a firm that has not started the
 * service is not punished with a failed fetch on every document. Absent, the
 * pipeline simply falls through to the model as it did before Docling existed.
 */
export async function doclingClientFromEnv(): Promise<DoclingClient | null> {
  const url = process.env['DOCLING_URL'] ?? DEFAULT_URL;
  if (process.env['DOCLING_ENABLED'] !== '1' && process.env['DOCLING_URL'] === undefined) {
    return null;
  }
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
  } catch {
    return null;
  }
  return doclingHttpClient(url);
}
