/**
 * One PDF is not one bill.
 *
 * Spec: bills-and-expenses.md §4.1
 *
 * A marketplace order arrives as a single PDF holding several documents from
 * DIFFERENT legal entities. One real Flipkart file contains a Tax Invoice from
 * Flipkart Internet Pvt Ltd (GSTIN 29…, Karnataka, IGST 18%), a Bill of Supply
 * from Flipkart India Pvt Ltd (GSTIN 07…, Delhi, CGST/SGST), a goods-transport
 * annexure, and a Tax Invoice from the actual seller (GSTIN 23…, Madhya
 * Pradesh, IGST 5%). Three suppliers, three GSTINs, three states, one file.
 *
 * Posting that as one bill would attribute the whole spend to whichever
 * supplier happened to be read first, and claim input credit against a GSTIN
 * that never charged most of it. So splitting comes before parsing, not after.
 *
 * ── How a boundary is recognised ───────────────────────────────────────────
 *
 * Two signals, and BOTH are needed.
 *
 *   1. The page opens with a document-type heading.
 *   2. The identity it declares — document number, else supplier GSTIN —
 *      differs from the document currently open.
 *
 * Signal 1 alone splits far too eagerly, because vendors repeat their
 * letterhead on every page: Kamatera prints "Invoice Number D56/(260)265975" at
 * the top of all four pages of a single invoice. Signal 2 is what recognises
 * that as the same document restating itself rather than a new one beginning.
 *
 * Signal 2 alone is not enough either, because a continuation page may mention
 * some other party's GSTIN in body text without starting anything.
 *
 * When neither side has an extractable identity we do NOT split. A missed
 * boundary yields one oversized bill that a human will notice and reject; a
 * false boundary yields two half-bills whose totals each look plausible.
 * Silence is the more dangerous failure, so the tie goes to merging.
 *
 * ── Honesty about coverage ─────────────────────────────────────────────────
 *
 * Every pattern below was read off one of seven real invoices (three Flipkart,
 * Hetzner, Kamatera, Lietparkas, Anomaly). They are evidence, not a survey.
 * A vendor whose heading we do not recognise produces ONE segment covering the
 * whole file, which is the safe direction — never a wrong split.
 */

import { extractPdfText } from './pdf.ts';

/** Document type, as the paper itself describes it. */
export type DocumentKind =
  | 'tax_invoice'      // charges GST; the only kind input credit can rest on
  | 'bill_of_supply'   // no GST charged — exempt, composition, or zero-rated
  | 'invoice'          // says "invoice" without qualifying itself; often foreign
  | 'unspecified'      // names several types at once and commits to none
  | 'unknown';         // carries no heading we recognise

export interface DocumentSegment {
  /** 0-based position within the file, in page order. */
  index: number;
  kind: DocumentKind;
  /** 1-based page numbers this document occupies. */
  pages: number[];
  text: string;
  /** First GSTIN appearing in the segment, or null for a foreign supplier. */
  supplierGstin: string | null;
  /** Invoice / bill-of-supply number, when one could be read. */
  documentNumber: string | null;
}

/**
 * Headings, most specific first — "Tax Invoice" must beat the bare "Invoice"
 * it contains, or every tax invoice would be typed as a plain one.
 *
 * The first entry is the important one, and real Amazon invoices are why it
 * exists. Amazon heads EVERY document "Tax Invoice/Bill of Supply/Cash Memo"
 * and lets the body decide which it actually is. Matching "Tax Invoice" out of
 * that string types the document by taking the first alternative off a list the
 * vendor deliberately left open.
 *
 * On the four Amazon files in the corpus that guess happens to be right: all
 * eight documents do charge GST. It would be wrong on a Bill of Supply from a
 * composition dealer — identical heading, no GST charged — and the mistake runs
 * in the expensive direction, because input credit then looks claimable on a
 * document that charged none. So a combined heading reports `unspecified`, and
 * the decision moves to whoever can read the tax table.
 */
const COMBINED_HEADING =
  /\b(?:tax\s+invoice|bill\s+of\s+supply|cash\s+memo)(?:\s*\/\s*(?:tax\s+invoice|bill\s+of\s+supply|cash\s+memo))+/i;

const HEADINGS: Array<{ kind: DocumentKind; re: RegExp }> = [
  { kind: 'unspecified',    re: COMBINED_HEADING },
  { kind: 'tax_invoice',    re: /\btax\s+invoice\b/i },
  { kind: 'bill_of_supply', re: /\bbill\s+of\s+supply\b/i },
  { kind: 'invoice',        re: /\binvoice\b/i },
];

/**
 * How far into a page a heading may sit and still count as opening it.
 *
 * Counted in non-blank lines, so a page padded with whitespace is not treated
 * differently from a tight one. Three is deliberate: Kamatera's own heading
 * sits on the third non-blank line, beneath a logo line and an address line.
 * Going wider starts catching boilerplate ("this is a computer-generated tax
 * invoice") in page footers.
 */
const HEADING_WITHIN_LINES = 3;

const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/;

/**
 * Document-number labels seen on the corpus. The value is whatever follows,
 * up to whitespace — no invoice number on any of them contains a space.
 *
 * `#` and `:` are both optional and both appear: Flipkart writes
 * "Invoice Number # FBF0326005974791", the seller's own system writes
 * "Invoice No: FACOEY2600014257", Hetzner writes "Invoice no.: 083001108949".
 */
const NUMBER_LABELS = [
  /\bbill\s+of\s+supply\s+number\b\s*[#:]?\s*(\S+)/i,
  /\binvoice\s+(?:number|no)\b\.?\s*[#:]?\s*(\S+)/i,
  /\binvoice\s*#\s*(\S+)/i,
];

/**
 * Splits on the form feed `pdftotext` emits between pages.
 *
 * The final form feed is a terminator, not a separator, so the split leaves a
 * phantom empty page on the end. Dropping it here rather than at the call site
 * keeps page numbers honest: without this, a four-page invoice reported five.
 */
export function splitPagesFF(text: string): string[] {
  const pages = text.split('\f');
  if (pages.length > 1 && pages[pages.length - 1] === '') pages.pop();
  return pages;
}

function nonBlankHead(page: string, n: number): string {
  return page.split('\n').filter((l) => l.trim() !== '').slice(0, n).join('\n');
}

function headingOf(page: string): DocumentKind | null {
  const head = nonBlankHead(page, HEADING_WITHIN_LINES);
  for (const h of HEADINGS) if (h.re.test(head)) return h.kind;
  return null;
}

function documentNumberOf(page: string): string | null {
  for (const re of NUMBER_LABELS) {
    const m = page.match(re);
    if (m?.[1]) return m[1].replace(/[,;]+$/, '');
  }
  return null;
}

function gstinOf(page: string): string | null {
  return page.match(GSTIN_RE)?.[0] ?? null;
}

/**
 * Identity comparison. Returns true only when both sides are known AND differ —
 * an unknown on either side is not evidence of a boundary.
 *
 * Document number is checked before GSTIN because it is the stronger signal:
 * one supplier can legitimately issue two invoices inside one file (a real
 * Bathla Teletech order does exactly that, two tax invoices from the same
 * company on consecutive pages), and only the number tells them apart.
 */
function declaresNewIdentity(
  pageNumber: string | null, pageGstin: string | null,
  openNumber: string | null, openGstin: string | null,
): boolean {
  if (pageNumber && openNumber) return pageNumber !== openNumber;
  if (pageGstin && openGstin) return pageGstin !== openGstin;
  return false;
}

interface OpenDoc {
  kind: DocumentKind; pages: number[]; parts: string[];
  number: string | null; gstin: string | null;
}

/**
 * Splits the extracted text of a PDF into the documents it contains.
 *
 * Always returns at least one segment for non-empty input, so a caller never
 * has to distinguish "unsplittable" from "empty".
 */
export function splitDocuments(text: string): DocumentSegment[] {
  const pages = splitPagesFF(text);
  const out: OpenDoc[] = [];

  pages.forEach((page, i) => {
    const pageNo = i + 1;
    const open = out[out.length - 1];

    if (page.trim() === '') {
      // An interior blank page belongs to no document. Its text is kept so the
      // segment still reconstructs the original, but its number is not listed
      // as a page of the document.
      if (open) open.parts.push(page);
      return;
    }

    const heading = headingOf(page);
    const num = documentNumberOf(page);
    const gst = gstinOf(page);

    if (open === undefined
        || (heading !== null
            && declaresNewIdentity(num, gst, open.number, open.gstin))) {
      out.push({
        kind: heading ?? 'unknown', pages: [pageNo], parts: [page],
        number: num, gstin: gst,
      });
      return;
    }

    open.pages.push(pageNo);
    open.parts.push(page);
    // A continuation page may carry the identity the opening page omitted —
    // Flipkart's Bill of Supply names its GSTIN below the fold. Fill gaps, but
    // never overwrite: the first statement wins.
    open.number ??= num;
    open.gstin ??= gst;
    // A continuation page can name the kind an opening page left blank, but it
    // must never overwrite `unspecified` — that value is a deliberate refusal
    // to guess, not a gap waiting to be filled.
    if (open.kind === 'unknown' && heading !== null) open.kind = heading;
  });

  return out.map((o, index) => ({
    index,
    kind: o.kind,
    pages: o.pages,
    text: o.parts.join('\f'),
    supplierGstin: o.gstin,
    documentNumber: o.number,
  }));
}

/**
 * Reads a PDF and splits it, in one step.
 *
 * `extractPdfText` is reused rather than re-implemented so the password
 * handling, the `pdftotext` availability check and the temp-file cleanup all
 * stay in one place (G-18 is still open there, at both call sites).
 */
export function splitPdfDocuments(buffer: Buffer, password?: string): DocumentSegment[] {
  return splitDocuments(extractPdfText(buffer, password));
}
