/**
 * Read the line-item table off an invoice — and refuse it when the columns
 * cannot be trusted.
 *
 * Spec: bills-and-expenses.md §4.3 · provenance.md PR-7
 *
 * `invoiceTax.ts` reads tax NAMES from running text, which works everywhere.
 * Amounts are different: a number means nothing without knowing which column
 * it sits under, and on a real Blinkit totals row the blank columns are simply
 * absent, so counting numbers left to right lands on the wrong one.
 *
 * The gutter-histogram machinery built for bank statements solves this
 * directly. `detectBoundaries` finds the column edges from the whitespace that
 * repeats down a block of lines, and on the Blinkit table it recovers all
 * fourteen columns and puts each 499.50 correctly under CGST (INR) and SGST
 * (INR), blanks and all.
 *
 * ── It does not work everywhere, and that is the design problem ────────────
 *
 * Measured on the four Indian marketplace layouts in the corpus:
 *
 *   Flipkart   9 columns, header and totals row exact
 *   Blinkit   14 columns, header and totals row exact
 *   Zepto     partial — a four-line stacked header, and some columns merge
 *   Amazon    fails — its numeric columns are separated by ONE space, below
 *             the two-space minimum a gutter needs, and only a single row
 *             carries numbers so there is no column of them to find
 *
 * Two of four is a real result, not a failure, but it means the reader cannot
 * assume its own output is right. Publishing merged cells as amounts is far
 * worse than publishing nothing: a wrong taxable value posts, reconciles
 * against the bank, and surfaces at assessment two years later.
 *
 * ── So the columns have to prove themselves ────────────────────────────────
 *
 * Two gates, both cheap, both objective, and neither of them a heuristic about
 * layout:
 *
 *   1. **Every cell in a money column must parse as ONE amount.** A cell
 *      reading "₹2,626.27 18% IGST ₹472.73 ₹3,099.00" is proof the boundaries
 *      are wrong. This is what catches Amazon.
 *   2. **The arithmetic must tie.** taxable + cgst + sgst + igst + cess equals
 *      the row total, on every row and on the totals row.
 *
 * Gate 2 is the invoice's BR-6. An invoice, like a statement, carries its own
 * proof: if the columns were misread, the sum will not come out. Passing it is
 * strong evidence the whole table was read correctly — not just that the
 * numbers were numbers.
 *
 * Anything that fails either gate returns `readable: false` with the reason,
 * and the caller asks a human. That is the same bargain as an unmatched HSN
 * (A3.1) and an untied bank account at period close: refuse, and say why.
 */

import { detectBoundaries, sliceCells } from './fixedWidth.ts';
import { tableFromRows } from './wordColumns.ts';
import type { WordPage } from './pdfWords.ts';
import { parseAmount } from './values.ts';
import { paise, money } from '../domain/tax.ts';
import type { DocumentSegment } from './documentSplit.ts';
import type { Charged } from './invoiceTax.ts';

/** What a column holds. Only the money roles take part in the arithmetic. */
export type ColumnRole =
  | 'taxable' | 'cgst' | 'sgst' | 'igst' | 'cess' | 'total'
  | 'gross' | 'discount'          // money, but not part of the tie
  /*
   * Amazon does not put the tax's NAME in the caption. It has a "Tax Type"
   * column whose cell reads IGST or CGST, and a "Tax Amount" column beside it.
   * The same caption therefore means IGST on one row and CGST on the next, so
   * the pair has to be resolved per row rather than per column.
   *
   * Without this, Amazon's fee invoices read taxable 4.24 and total 5.00 and
   * refused, because the 0.76 of IGST between them had nowhere to go.
   */
  | 'tax_amount' | 'tax_type'
  | 'rate' | 'qty' | 'hsn' | 'description' | 'serial' | 'other';

/** Roles whose values must sum to `total`. */
const TIE_ADDENDS: ColumnRole[] = ['taxable', 'cgst', 'sgst', 'igst', 'cess'];

/** Roles that must hold exactly one amount per cell, or the columns are wrong. */
const MONEY_ROLES: ColumnRole[] =
  [...TIE_ADDENDS, 'total', 'gross', 'discount', 'tax_amount'];

export interface TableRow {
  cells: string[];
  /** Cell text by role, for roles present exactly once. */
  by: Partial<Record<ColumnRole, string>>;
}

/**
 * Where a column's figures were read from, in PDF points.
 *
 * Kept per column rather than per figure because a column IS the region: every
 * value in it shares the same horizontal band, and the page is on the segment.
 * Absent on the text and model paths, which have no geometry to offer.
 */
export interface ColumnSource {
  caption: string;
  page: number;
  xMin: number; xMax: number;
  /** Page size, so the band can be normalised 0–1 for storage (PR-6). */
  pageWidth: number; pageHeight: number;
}

export interface InvoiceTable {
  readable: boolean;
  /** Present when `readable` is false: what stopped it. */
  reason?: string;
  roles: ColumnRole[];
  header: string[];
  rows: TableRow[];
  /** The row labelled Total, when the table has one. */
  totals: TableRow | null;
  /** Sums over the item rows, by role. */
  sums: Partial<Record<ColumnRole, string>>;
  /**
   * Things the reader accepted but a human should see. A rounding difference
   * between the parts and the stated total lands here rather than in `reason`:
   * strict enough to name, not fatal enough to refuse.
   */
  warnings?: string[];
  /**
   * True when this document charges no tax and its total column IS its taxable
   * value. Callers reading figures PER ROW need to know: the sums say taxable,
   * and no column does.
   */
  taxableFromTotal?: boolean;
  /**
   * The difference the vendor rounded away, when the parts and the stated
   * total differ by less than a rupee. Signed as the document sees it:
   * stated total minus the sum of the parts.
   */
  roundOff?: string;
  /**
   * One entry per column, aligned to `roles`, when the reader knew where the
   * columns were. This is what makes PR-6 possible — bounding boxes exist only
   * at extraction time and cannot be reconstructed later.
   */
  columnSources?: ColumnSource[];
}

/**
 * Header labels, most specific first.
 *
 * A per-cent sign or the word "rate" makes a tax column a RATE column, not an
 * amount column — Blinkit prints "CGST (%)" and "CGST (INR)" side by side, and
 * adding the 9.00 from the first into the tax total would be nonsense that
 * still nearly ties.
 */
function roleOf(label: string): ColumnRole {
  const t = label.replace(/\s+/g, ' ').trim().toLowerCase();
  if (t === '') return 'other';

  const isRate = /%|\brate\b/.test(t);
  if (/\bcgst\b/.test(t))  return isRate ? 'rate' : 'cgst';
  if (/\b(?:sgst|utgst|s\/ut\s*gst)\b/.test(t)) return isRate ? 'rate' : 'sgst';
  if (/\bigst\b/.test(t))  return isRate ? 'rate' : 'igst';
  if (/\bcess\b/.test(t))  return isRate ? 'rate' : 'cess';

  // Checked before the generic rules: "Tax Type" would otherwise fall through
  // to `other`, and "Tax Amount" is exactly the ambiguous bare "amount" the
  // rule below refuses to treat as a total.
  if (/\btax\b/.test(t) && /\btype\b/.test(t))    return 'tax_type';
  if (/\btax\b/.test(t) && /\bamo?u?nt\b/.test(t)) return 'tax_amount';

  if (/\btaxable\b/.test(t))                    return 'taxable';
  if (/\bdiscount\b|\bdisc\.?\b/.test(t))       return 'discount';
  if (/\bgross\b|\bmrp\b|\bunit price\b/.test(t)) return 'gross';
  /*
   * Only an actual "total" is a total.
   *
   * This matched a bare "amount" too, and Amazon has TWO such columns —
   * "Tax Amount" and "Total Amount". Both became `total`, both were summed,
   * and a ₹9.00 invoice reported a total of ₹10.37: the tax added to the total
   * that already contained it. It passed the arithmetic gate because with no
   * taxable column there was nothing to tie against.
   *
   * A bare "Amount" is genuinely ambiguous — gross, taxable, tax or total
   * depending on the vendor — so it maps to `other` and takes no part in any
   * sum. Losing a column is recoverable; inventing a total is not.
   */
  /*
   * A total qualified as being BEFORE tax is a taxable value, whatever it is
   * called. Hetzner heads its columns "Total (excl. VAT)" and "Total", and
   * reading both as totals summed a document's value twice while leaving it
   * with no taxable figure at all — so the arithmetic had nothing to check and
   * the document was refused for it.
   */
  if (/\btotal\b/.test(t)
      && /\b(?:excl|excluding|before|net\s+of|pre)\b/.test(t)) return 'taxable';
  if (/\btotal\b/.test(t))                      return 'total';
  if (/\bnet\b/.test(t))                        return 'taxable';
  if (/\bhsn\b|\bsac\b/.test(t))                return 'hsn';
  if (/\bqty\b|\bquantity\b/.test(t))           return 'qty';
  if (/\brate\b|%/.test(t))                     return 'rate';
  if (/\bdescription\b|\bparticulars\b|\bitem\b|\bproduct\b/.test(t)) return 'description';
  if (/\bsr\b|\bsl\b|\bs\.? ?no\b/.test(t))     return 'serial';
  return 'other';
}

/** Words that identify a line as the table's header. */
const HEADER_HINTS = [
  /\btaxable\b/i, /\bcgst\b/i, /\bsgst\b/i, /\bigst\b/i,
  /\bhsn\b/i, /\bsac\b/i, /\bqty\b/i, /\bdescription\b/i, /\bparticulars\b/i,
];

/** A totals row announces itself. */
/*
 * A totals row's caption, which may carry the amount in words after it.
 *
 * A professional-fees bill writes "Total (Fifteen Thousand Rupees Only )" in
 * the particulars cell. Requiring the cell to be nothing but "Total" left that
 * row counted as a second ITEM, so a 15,000 bill summed to 30,000 and was
 * refused for stating no total that matched.
 *
 * Only a parenthesised tail is allowed. "Total Amount" and "Total Value" are
 * column captions, not totals rows, and admitting bare trailing words would
 * swallow them.
 */
const TOTAL_ROW = /^\s*(?:grand\s+)?total\b\s*:?\s*(?:\([^)]*\))?\s*$/i;

/**
 * Where the table stops — decided by geometry, not by a list of words.
 *
 * The first attempt scanned downward until it hit a phrase from a stop-list:
 * "Amount in Words", "Authorized Signatory", "Declaration". Every document
 * added a phrase. Flipkart needed "Grand Total" and "DETAILS OF GOODS
 * TRANSPORTED BY GTA"; the next vendor would need two more. A list that grows
 * once per document is not a rule, it is a record of the documents seen.
 *
 * The rule that does hold: a line belongs to the table if it RESPECTS the
 * table's columns. Text below the table is laid out for a human — a signature
 * block, a total floated to the right, a paragraph of terms — and it runs
 * straight through the column edges the rows above it observe.
 *
 * So a line is part of the table until it straddles a boundary, and the
 * boundaries come from the table itself. That is circular, so it is done
 * twice: boundaries from a generous window, trim to the lines that respect
 * them, recompute from what survived. Two passes are enough because the
 * second window contains no foreign text to distort the histogram.
 */
function straddles(line: string, boundaries: number[]): boolean {
  for (const b of boundaries) {
    if (b <= 0 || b >= line.length) continue;
    if (line[b - 1] !== ' ' && line[b] !== ' ') return true;
  }
  return false;
}

/** How far below the header to look before trimming. */
const REGION_WINDOW = 40;

/**
 * A header can occupy several lines. Flipkart splits "Gross Amount ₹" across
 * two, Zepto stacks four. A continuation line carries no digits at all — every
 * data row carries at least one — which separates the rest of the caption from
 * the first item without needing to know how tall the header is.
 */
const HAS_DIGIT = /\d/;

/**
 * Finds the header line: the one matching the most header words. Ties go to
 * the earliest, because a document may restate its columns in a continuation.
 */
function findHeaderLine(lines: string[]): number {
  let best = -1, bestScore = 1;   // require at least 2 hints
  lines.forEach((l, i) => {
    const score = HEADER_HINTS.filter((h) => h.test(l)).length;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/**
 * Reads the table out of a document segment.
 *
 * Never throws on a badly-formed table: a batch of twenty bills should not stop
 * because one of them has an unreadable layout.
 */
export function readInvoiceTable(segment: DocumentSegment): InvoiceTable {
  const empty: InvoiceTable = {
    readable: false, roles: [], header: [], rows: [], totals: null, sums: {},
  };

  const all = segment.text.split('\n');
  const headerAt = findHeaderLine(all);
  if (headerAt < 0) {
    return { ...empty, reason: 'no line in the document looks like a table header' };
  }

  // The region runs from the header to the last line that still has a number
  // in it, with a short tolerance for the wrapped description lines that sit
  // between item rows.
  const window = all.slice(headerAt, headerAt + REGION_WINDOW)
    .filter((l) => l.trim() !== '');

  // Pass 1: boundaries from everything nearby, then keep only the lines that
  // respect them. Pass 2: boundaries from what survived, and trim again.
  let region = trimToColumns(window, detectBoundaries(window));
  let boundaries = detectBoundaries(region);
  region = trimToColumns(region, boundaries);
  boundaries = detectBoundaries(region);

  let headerLines = 1;
  for (let i = 1; i < region.length && !HAS_DIGIT.test(region[i]!); i++) headerLines++;

  if (region.length <= headerLines) {
    return { ...empty, reason: 'the table header has no rows beneath it' };
  }

  /*
   * Every header line contributes to the caption of its column. Joining them
   * per column is what turns Flipkart's "Gross" over "Amount ₹" back into
   * "Gross Amount ₹" — and, more importantly, stops the second header line
   * being read as a data row whose Gross cell contains the word "Amount".
   */
  const headerRows = region.slice(0, headerLines)
    .map((l) => sliceCells(l, boundaries).map((c) => c.trim()));
  const header = headerRows[0]!.map((_, c) =>
    headerRows.map((r) => r[c] ?? '').filter((x) => x !== '').join(' '));

  const dataRows = region.slice(headerLines)
    .map((l) => sliceCells(l, boundaries).map((c) => c.trim()))
    .filter((cells) => cells.some((c) => c !== ''));

  return gradeTable(header, dataRows);
}

/**
 * Reads the table from positioned words instead of reconstructed spacing.
 *
 * The only difference from the path above is HOW the cells were found. Both
 * then face the same two gates, which is the point: a new way of locating
 * columns should prove itself against the same exam, not against a looser one
 * written to suit it.
 */
export function readInvoiceTableFromWords(
  pages: WordPage[], chargedByDocument: Charged = 'no',
): InvoiceTable {
  const allRows = pages.flatMap((p) => p.rows);
  const t = tableFromRows(allRows);
  // The page as text, so a total floated outside the table can still check it.
  const text = allRows
    .map((r) => r.words.map((w) => w.text).join(' ')).join('\n');
  if (!t) {
    return {
      readable: false, roles: [], header: [], rows: [], totals: null, sums: {},
      reason: 'no row of words looks like a table header',
    };
  }
  const graded = gradeTable(
    t.header, t.rows, statedTotalsInText(text), chargedByDocument,
    labelledTotalsInText(text));

  /*
   * The bands were computed and discarded until now, which made a documented
   * claim about provenance false. The page is whichever one held the table —
   * `tableFromRows` works over the segment's rows, and a table does not
   * straddle pages in this corpus.
   */
  const page = pages[0];
  if (page) {
    graded.columnSources = t.bands.map((b, i) => ({
      caption: graded.header[i] ?? '',
      page: page.number,
      xMin: b.xMin, xMax: b.xMax,
      pageWidth: page.width, pageHeight: page.height,
    }));
  }
  return graded;
}

/**
 * Every figure the running text calls a total.
 *
 * Not every document states its total inside the table. Three foreign
 * suppliers in the corpus float it to the right of the page instead — "Total
 * ₹929.00", "Total $9.56", "Total: 11.09 USD" — where the geometry rule that
 * ends a table correctly excludes it, leaving the item rows with nothing to be
 * checked against.
 *
 * The figures come back as decimal strings; which one is right is the caller's
 * problem, and a document usually states the same total several ways
 * ("Subtotal", "Total", "Amount due") which is a help rather than a hindrance.
 *
 * Deliberately not used to SUPPLY a total — only to check one. A label picked
 * off free text is far weaker evidence than a column, and the difference
 * between checking and trusting is the whole design here.
 */
export function statedTotalsInText(text: string): string[] {
  const LABEL =
    /\b(?:sub\s*total|grand\s+total|total\s+amount|amount\s+(?:due|payable)|total)\b/i;
  const out = new Set<string>();

  for (const line of text.split('\n')) {
    if (!LABEL.test(line)) continue;
    // Everything after the label, so "Total 44.96" is read and a line that
    // merely mentions the word in a sentence contributes nothing.
    const after = line.slice(line.search(LABEL));
    for (const m of after.matchAll(
      /(?:[₹$€£]|Rs\.?|INR|USD|EUR|GBP)\s*([\d,]+\.\d{2})|([\d,]+\.\d{2})\s*(?:INR|USD|EUR|GBP)/gi)) {
      try { out.add(parseAmount(m[1] ?? m[2] ?? '').value); } catch { /* not one */ }
    }
  }
  return [...out];
}

/**
 * Figures the document LABELS as its total, currency symbol or not.
 *
 * Deliberately separate from `statedTotalsInText`, which requires a currency
 * marker because it also feeds the untaxed-document check — where a looser
 * scan would surface more candidates, raise the largest, and start refusing
 * documents that read correctly. This one is used for exactly one decision
 * (adjudicating an apparent round-off) and is compared only for EXACT equality
 * against a figure already derived from the table, so a spurious match cannot
 * introduce a number of its own.
 *
 * "Invoice Value" and "Item Total" earn their place here: an Indian invoice
 * routinely prints its payable that way, with no ₹ in front of it.
 */
const TOTAL_LABEL =
  /\b(?:sub\s*total|grand\s+total|item\s+total|total\s+amount|invoice\s+value|invoice\s+total|amount\s+(?:due|payable)|net\s+payable|total\s+payable|total)\b/i;

export function labelledTotalsInText(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    if (!TOTAL_LABEL.test(line)) continue;
    const after = line.slice(line.search(TOTAL_LABEL));
    for (const m of after.matchAll(/(?<![\d.])([\d,]+\.\d{2})(?![\d%])/g)) {
      try { out.add(parseAmount(m[1]!).value); } catch { /* not one */ }
    }
  }
  return [...out];
}

/**
 * A money column whose cells are all percentages is a RATE column, whatever
 * its caption says.
 *
 * Zepto prints a rate column and an amount column for each tax and captions
 * the first pair "CGST" and "S/UT GST" — no per-cent sign anywhere in the
 * heading, though every cell beneath reads "2.50%". Read from the caption
 * alone those are tax amounts, so 2.50 was about to be added to the tax on the
 * bill; what actually happened is that gate 1 refused the whole table, because
 * "0.00%" does not parse as an amount.
 *
 * The cells are the better evidence and they are unanimous. A column mixing
 * figures and percentages is NOT reclassified — that is a misread boundary,
 * which is exactly what gate 1 exists to catch, and quietly relabelling it
 * would hide the fault.
 */
function resolveRateColumns(dataRows: string[][], roles: ColumnRole[]): void {
  for (const [i, role] of roles.entries()) {
    if (!MONEY_ROLES.includes(role)) continue;

    let seen = 0, pct = 0;
    for (const row of dataRows) {
      const cell = row[i]?.trim();
      if (cell === undefined || cell === '') continue;
      seen++;
      if (/%$/.test(cell)) pct++;
    }
    if (seen > 0 && pct === seen) roles[i] = 'rate';
  }
}

/**
 * CGST never travels alone.
 *
 * A supply taxed at CGST is taxed at SGST or UTGST in the same breath — there
 * is no such thing as a central-only intra-state supply. So a table with a
 * CGST amount column and no state counterpart has lost the counterpart's
 * caption, not found a document without one.
 *
 * Zepto stacks its heading over three lines and the "S/UT" of "S/UT GST Amt."
 * sits on the top one, which lands in a neighbouring band; the column arrives
 * captioned "GST Amt." and classified as nothing at all, so its 1.36 was
 * dropped and the bill no longer added up.
 *
 * This is a guess, and it is a safe one because gate 2 checks it immediately:
 * if the column is really a COMBINED GST amount rather than the state half,
 * the arithmetic comes out over by the central half and the table is refused.
 * A guess the gates can catch is a different thing from a guess they cannot.
 */
function resolveLoneCgst(header: string[], roles: ColumnRole[]): void {
  if (!roles.includes('cgst') || roles.includes('sgst')) return;

  const candidates = header
    .map((h, i) => ({ h: h.toLowerCase(), i }))
    .filter(({ h, i }) =>
      roles[i] === 'other' && /\bgst\b/.test(h) && /\bam(?:oun)?t\b/.test(h)
      && !/\bc\s*gst\b|\bigst\b|\bcess\b/.test(h));

  if (candidates.length === 1) roles[candidates[0]!.i] = 'sgst';
}

/**
 * A bare "Amount" column, on a table where nothing else could be the total.
 *
 * `roleOf` sends a bare "Amount" to `other` on purpose, and that rule stays:
 * Amazon prints "Tax Amount" beside "Total Amount", and reading either as the
 * total once turned a 9.00 invoice into 10.37.
 *
 * But a foreign supplier's invoice is "Description, Quantity, Unit Price,
 * Amount" and nothing else. There is no tax, no column called total, and
 * exactly one column of money — so the ambiguity the rule guards against
 * cannot arise, and refusing the document left it with no figure at all.
 *
 * All three conditions are required. Any tax column means the document is an
 * Indian tax invoice and the caution applies; a column already called total
 * means there is a better candidate; and more than one bare "Amount" is the
 * Amazon case exactly.
 *
 * Mutates `roles` in place, which is ugly and keeps the decision in one place
 * rather than threading a second array through every caller.
 */
function resolveBareAmount(
  header: string[], roles: ColumnRole[], dataRows: readonly string[][] = [],
): void {
  const taxed: ColumnRole[] =
    ['cgst', 'sgst', 'igst', 'cess', 'tax_amount', 'tax_type', 'taxable'];
  if (roles.some((r) => taxed.includes(r) || r === 'total')) return;

  /*
   * The caption must BEGIN with the word, not consist of it.
   *
   * A professional-fees bill heads its money column "Amount Rs.(Prof. fees)",
   * and requiring the cell to be nothing but "Amount" left that document with
   * no figure at all. Leading position is what does the work: "Tax Amount" and
   * "Reimbursement Amount" both carry the word and neither is the document's
   * value, and both are excluded by having something in front of it. (The tax
   * ones never reach here anyway — the guard above returns first.)
   */
  const bare = /^\s*(?:amount|value)\b/iu;

  /*
   * And it must actually hold money. An empty column cannot be the total, and
   * a column of prose — "Amount in Words" — would otherwise be promoted and
   * then fail gate 1, refusing a document over a caption.
   *
   * This also settles the common pair of an amount column beside an empty
   * "Reimbursement Amount": one of them carries figures, so there is exactly
   * one candidate and no ambiguity to guard against.
   */
  const holdsMoney = (i: number) => dataRows.some((r) => {
    const cell = r[i]?.trim();
    if (cell === undefined || cell === '') return false;
    try { parseAmount(cell); return true; } catch { return false; }
  });

  const candidates = header
    .map((h, i) => ({ h, i }))
    .filter(({ h, i }) => roles[i] === 'other' && bare.test(h)
                          && (dataRows.length === 0 || holdsMoney(i)));

  if (candidates.length === 1) roles[candidates[0]!.i] = 'total';
}

/**
 * The acceptance gates, shared by both paths.
 *
 * Everything here decides whether the cells can be BELIEVED, and none of it
 * knows or cares how they were located.
 */
export function gradeTable(
  header: string[], dataRows: string[][],
  /** Figures the surrounding text calls a total — see `statedTotalsInText`. */
  statedTotals: readonly string[] = [],
  /**
   * Whether the DOCUMENT charges tax, read from its running text by
   * `invoiceTax.ts` — which does not depend on the columns being found.
   *
   * Only 'no' unlocks the untaxed path below, and the distinction is one this
   * code got wrong. See the note there.
   */
  chargedByDocument: Charged = 'no',
  /**
   * Figures the document labels as its total, currency optional — see
   * `labelledTotalsInText`. Used for one decision only: telling a vendor who
   * rounds every line apart from a vendor who rounds the bill.
   */
  labelledTotals: readonly string[] = [],
): InvoiceTable {
  const roles = header.map(roleOf);
  resolveBareAmount(header, roles, dataRows);
  resolveRateColumns(dataRows, roles);
  resolveLoneCgst(header, roles);

  const table: InvoiceTable = {
    readable: false, roles, header,
    rows: dataRows.map((cells) => ({ cells, by: byRole(cells, roles) })),
    totals: null, sums: {},
  };

  // ── Gate 1: one amount per money cell ────────────────────────────────────
  const bad = firstUnparseableMoneyCell(table.rows, roles);
  if (bad) {
    return {
      ...table,
      reason: `column "${header[bad.col] || bad.col}" should hold one amount per ` +
              `row but holds ${JSON.stringify(bad.text)}. The column boundaries ` +
              'are wrong, so no figure from this table can be trusted.',
    };
  }

  /*
   * A document may state its totals MORE THAN ONCE. One real Flipkart page
   * prints a "Total" row for the table and a floated "Grand Total" beneath it,
   * both carrying 28014.00.
   *
   * Excluding only the first left the second counted as an item, so the total
   * column summed to 56028.00 and the table was refused — a correct document
   * rejected because a restatement was read as a second sale.
   *
   * All of them are excluded from the item sums; the first is kept as the
   * figure to check those sums against.
   */
  /*
   * Nothing after the totals block belongs to this table.
   *
   * Hetzner prints a second table directly below the first — a tax-code
   * summary with the same captions and the same column positions — so the
   * geometry test that ends a table saw no break and read both as one. The
   * summary restates the invoice, and its 44.96 was added to the 44.96 above
   * it: a 44.96 invoice with a total column summing to 89.92.
   *
   * A table states its total at the end. The block is allowed to run on,
   * because documents do state totals twice — a Flipkart page prints "Total"
   * and then "Grand Total" — but the first row after it that is NOT a totals
   * row starts something else.
   */
  const firstTotal = table.rows.findIndex((r) =>
    r.cells.some((c) => TOTAL_ROW.test(c)));
  if (firstTotal >= 0) {
    let end = firstTotal;
    while (end + 1 < table.rows.length
           && table.rows[end + 1]!.cells.some((c) => TOTAL_ROW.test(c))) end++;
    table.rows = table.rows.slice(0, end + 1);
  }

  const totalsRows: TableRow[] = table.rows.filter((r) =>
    r.cells.some((c) => TOTAL_ROW.test(c)));
  table.totals = totalsRows[0] ?? null;

  let itemRows = table.rows.filter((r) => !totalsRows.includes(r));

  /*
   * A row that restates the sum of the rows above it is a totals row, even
   * with nothing written in it to say so.
   *
   * Zepto prints its totals TWICE: once as a bare line of figures with every
   * label column empty, and once below as "Item Total". Only the second says
   * what it is, so the first was counted as an item and every figure on the
   * bill doubled — a 243.02 invoice reporting a taxable value of 473.84. The
   * arithmetic still nearly tied, because both sides doubled together, which
   * is how it got as far as it did.
   *
   * Three conditions, and all three are needed. It must be LAST, because a
   * total comes after the things it totals. It must carry no serial and no
   * description, because an item identifies itself. And its total must equal
   * the sum of the others exactly — which is what stops a two-line invoice of
   * equal halves losing its second line.
   */
  if (itemRows.length > 1) {
    const last = itemRows[itemRows.length - 1]!;
    const rest = itemRows.slice(0, -1);
    const identified = (last.by.serial ?? '').trim() !== ''
      || (last.by.description ?? '').trim() !== '';

    if (!identified) {
      /*
       * Matched on the TAXABLE value, not the total.
       *
       * Zepto rounds each line's total to a whole rupee, so its item totals
       * sum to 243.00 while the restating row says 243.02 — the unrounded
       * figure. Comparing totals therefore missed by two paise and the row was
       * kept as an item, doubling the bill. Taxable values are not rounded per
       * line, so they match exactly, and an exact match is a far stronger
       * signal than a total within some tolerance.
       */
      const on: ColumnRole = last.by.taxable !== undefined ? 'taxable' : 'total';
      const mine = last.by[on];
      const restated = sumByRole(rest, roles)[on];
      let same = false;
      try {
        same = mine !== undefined && restated !== undefined
          && paise(parseAmount(mine).value) === paise(restated);
      } catch { same = false; }
      if (same) {
        totalsRows.unshift(last);
        table.totals = totalsRows[0]!;
        itemRows = rest;
      }
    }
  }

  table.sums = sumByRole(itemRows, roles);

  // ── Gate 2: the arithmetic ties ──────────────────────────────────────────
  const tie = checkTie(table.sums);
  if (!tie.ok) return { ...table, reason: tie.detail };
  if (tie.roundOff !== undefined) {
    const columnSum = table.sums.total!;
    const parts = paise(columnSum) - paise(tie.roundOff);

    /*
     * Before inventing a round-off, ask whether the document states the parts
     * sum as a total in its own words.
     *
     * `sums.total` is a SUM OF A COLUMN, and some vendors round every line to
     * the rupee: a Zepto grocery bill prints line totals of 57.00, 14.00,
     * 25.00 … which add to a whole-rupee 243.00, while the same page prints
     * "Item Total 243.02" and "Invoice Value 243.02" — the figure the customer
     * actually pays. Taking the column sum for the document's stated total
     * manufactured a two-paise round-off and posted a total the invoice does
     * not print anywhere.
     *
     * A figure the document LABELS as its total is a statement; a column sum
     * is our arithmetic. Where the label agrees with the parts, the parts were
     * right and there was never a rounding decision to record.
     *
     * Note this is not something two independent readers can catch. Both read
     * the same table and both take its column sum, so they agree — and agree
     * wrongly. Cross-checking catches misreading, never mis-scoping.
     *
     * Exact equality only. Anything looser would let a stray figure elsewhere
     * on the page overwrite a total the columns agree on.
     */
    const labelled = [...statedTotals, ...labelledTotals].some((t) => {
      try { return paise(t) === parts; } catch { return false; }
    });
    if (labelled) {
      table.sums.total = money(parts);
      table.warnings = [
        ...(table.warnings ?? []),
        `the total column sums to ${columnSum} because this vendor rounds each ` +
        `line, but the document states ${money(parts)} as its total. The stated ` +
        'figure is the one posted — it is what the supplier is owed and what ' +
        'GSTR-2B will carry.',
      ];
    } else {
      table.roundOff = tie.roundOff;
      table.warnings = [
        ...(table.warnings ?? []),
        `the parts sum to ${money(parts)} but the document states ${columnSum} — ` +
        `a ${tie.roundOff} rounding difference. The document prints no round-off ` +
        'line, so this is inferred from the figures, not read. Posted to Round ' +
        'Off; confirm it against the invoice before approving.',
      ];
    }
  }

  if (table.totals) {
    const stated = checkStated(table.totals.by, table.sums);
    if (!stated.ok) return { ...table, reason: stated.detail };
  }

  /*
   * A table with no money column read passes both gates trivially — there is
   * nothing to fail on. Two documents came back `readable` with every sum
   * empty, which is the worst possible answer: a confident yes carrying no
   * figures. `readable` has to mean a figure was actually recovered.
   */
  /*
   * On a document that charges no tax, the total IS the taxable value.
   *
   * The rule below demands both, because a total with nothing beside it is
   * unchecked. That reasoning holds only where tax exists to check it against.
   * An import of service carries one money column and no tax at all — there is
   * no second figure anywhere on the paper — so demanding one refused four
   * perfectly legible invoices for missing something they cannot have.
   *
   * What replaces the tie as the check is the document's own totals row: the
   * item rows must sum to the total it states. `checkStated` has already
   * established that above, and without a totals row there is no check and the
   * figure stays refused.
   */
  /*
   * "No tax column was found" is NOT "this document charges no tax", and
   * conflating them cost a real invoice.
   *
   * An Amazon invoice separates its numeric columns by a single space, below
   * what a gutter can detect, so the coordinate reader recovers no tax column
   * from it — a known limitation, and the reason the model exists as a
   * fallback. Judged on its columns alone that document looked untaxed, so its
   * net amount of 2626.27 was taken as the whole bill and the 472.73 of IGST
   * on the paper vanished. It was caught only because the model read the same
   * page and disagreed.
   *
   * The document's own text settles it. `invoiceTax` reads the tax NAMES from
   * running text, which works whether or not the columns can be found, and
   * only an explicit 'no' unlocks this. 'unreadable' does not: a document
   * whose tax could not be determined is exactly the one not to assume about.
   */
  const untaxed = chargedByDocument === 'no' && !roles.some((r) =>
    (['cgst', 'sgst', 'igst', 'cess', 'tax_amount'] as ColumnRole[]).includes(r));
  if (untaxed && table.sums.total !== undefined
      && table.sums.taxable === undefined) {
    const inTable = table.totals !== null;
    /*
     * The LARGEST figure the document calls a total, not any of them.
     *
     * Kamatera bills in sections and states a total for each: "Total Monthly
     * Recurring Services (Current Month): 6.00 USD", and two more below it.
     * Matching any stated total accepted the first section's 6.00 as the whole
     * of an 11.09 invoice — two thirds of the document missing, and a check
     * that reported success. This is the blindness gate 2 already has, arrived
     * at from a new direction.
     *
     * A section total is smaller than the invoice's, so requiring the largest
     * refuses that. Where the largest is something else entirely — arrears
     * carried forward, a gross before discount — the item rows will not equal
     * it and the document is refused, which is the direction to fail in.
     */
    const largest = statedTotals.reduce<string | null>(
      (a, b) => (a === null || paise(b) > paise(a) ? b : a), null);
    const inText = largest !== null && paise(largest) === paise(table.sums.total);

    if (!inTable && !inText) {
      return {
        ...table,
        reason: 'this document charges no tax, so nothing in the table checks ' +
          `its figures, and no total stated anywhere on it matches the ${table.sums.total} ` +
          `the item rows sum to` +
          (statedTotals.length > 0
            ? ` — the largest it states is ${largest}. A row was probably missed.`
            : ', and it states no total at all. There is nothing here to verify against.'),
      };
    }

    table.sums.taxable = table.sums.total;
    table.taxableFromTotal = true;
    table.warnings = [
      ...(table.warnings ?? []),
      'this document charges no tax, so its total is taken as the taxable ' +
      `value. The item rows sum to ${table.sums.total}, which is the total ` +
      `the document states ${inTable ? 'in its totals row' : 'on the page'}; ` +
      'nothing else on the document checks that figure.',
    ];
  }

  if (table.sums.total === undefined || table.sums.taxable === undefined) {
    /*
     * `readable` has to mean VERIFIED, not merely parsed.
     *
     * Both of the weak answers this rejects were real. First a table with no
     * money column at all came back readable with every sum empty — a
     * confident yes carrying no figures. Then, after that was closed, Amazon
     * came back readable with a total and nothing else, which passes the tie
     * only because there is nothing on the other side of it to disagree.
     *
     * A figure no arithmetic checked is exactly what this module exists to
     * avoid producing, so both a taxable value and a total are required. A
     * purchase bill needs the taxable value regardless — input credit is
     * claimed on it, not on the gross.
     */
    return {
      ...table,
      reason: table.sums.total === undefined && table.sums.taxable === undefined
        ? 'the columns parsed, but no taxable value or total was found in any ' +
          'of them — there is nothing here to post.'
        : `only ${table.sums.total !== undefined ? 'a total' : 'a taxable value'} ` +
          'was recovered. With one side of the sum missing nothing checks the ' +
          'other, and an unchecked figure is what this reader exists to refuse.',
    };
  }

  return { ...table, readable: true };
}

/**
 * Keeps the header and every following line that respects the column edges,
 * stopping at the first that does not. Stopping rather than skipping is
 * deliberate: a table has one contiguous body, and a line that resumes the
 * alignment further down belongs to the next block, not this one.
 */
function trimToColumns(lines: string[], boundaries: number[]): string[] {
  const out: string[] = [];
  for (const [i, l] of lines.entries()) {
    if (i > 0 && straddles(l, boundaries)) break;
    out.push(l);
  }
  return out;
}

/** Cell text by role, for roles appearing exactly once in the header. */
function byRole(cells: string[], roles: ColumnRole[]): Partial<Record<ColumnRole, string>> {
  const counts = new Map<ColumnRole, number>();
  for (const r of roles) counts.set(r, (counts.get(r) ?? 0) + 1);
  const out: Partial<Record<ColumnRole, string>> = {};
  roles.forEach((r, i) => {
    if (counts.get(r) === 1 && cells[i] !== undefined) out[r] = cells[i]!;
  });
  return out;
}

function firstUnparseableMoneyCell(
  rows: TableRow[], roles: ColumnRole[],
): { col: number; text: string } | null {
  for (const row of rows) {
    for (let c = 0; c < roles.length; c++) {
      if (!MONEY_ROLES.includes(roles[c]!)) continue;
      const text = row.cells[c] ?? '';
      if (text === '') continue;
      // A label leaking into a money column ("Total") is not a failure — the
      // totals row puts its own caption somewhere. A SECOND NUMBER is.
      if (TOTAL_ROW.test(text)) continue;
      try { parseAmount(text); } catch { return { col: c, text }; }
    }
  }
  return null;
}

/**
 * Which tax the row's "Tax Type" cell names, or null when it names none.
 *
 * Returning null rather than guessing is what keeps the arithmetic honest: an
 * unattributed tax amount is simply left out, the sum then falls short of the
 * total, and gate 2 refuses the table. Silently folding it into IGST would
 * make the tie pass on an assumption nobody checked.
 */
function namedTaxOf(
  row: TableRow, roles: ColumnRole[],
): 'cgst' | 'sgst' | 'igst' | 'cess' | null {
  const i = roles.indexOf('tax_type');
  const t = i >= 0 ? (row.cells[i] ?? '') : '';
  if (/\bigst\b/i.test(t)) return 'igst';
  if (/\bcgst\b/i.test(t)) return 'cgst';
  if (/\b(?:sgst|utgst)\b/i.test(t)) return 'sgst';
  if (/\bcess\b/i.test(t)) return 'cess';
  return null;
}

function sumByRole(
  rows: TableRow[], roles: ColumnRole[],
): Partial<Record<ColumnRole, string>> {
  const acc = new Map<ColumnRole, bigint>();
  for (const row of rows) {
    for (let c = 0; c < roles.length; c++) {
      const role = roles[c]!;
      if (!MONEY_ROLES.includes(role)) continue;
      const text = row.cells[c] ?? '';
      if (text === '' || TOTAL_ROW.test(text)) continue;
      let p: bigint;
      try { p = paise(parseAmount(text).value); } catch { continue; }

      // A "Tax Amount" is credited to whichever tax its row names.
      let target = role;
      if (role === 'tax_amount') {
        const named = namedTaxOf(row, roles);
        if (named === null) continue;   // unnamed tax: leave the tie to fail
        target = named;
      }
      acc.set(target, (acc.get(target) ?? 0n) + p);
    }
  }
  const out: Partial<Record<ColumnRole, string>> = {};
  for (const [role, v] of acc) out[role] = money(v);
  return out;
}

/**
 * The invoice's BR-6: the parts must add up to the whole.
 *
 * Skipped, not failed, when the table has no total column or no taxable
 * column — a document that never stated a total cannot contradict one. That is
 * a weaker position and `readable` still depends on gate 1, but it is honest:
 * refusing a table for not containing a column it never had would reject
 * perfectly good layouts.
 */
function checkTie(sums: Partial<Record<ColumnRole, string>>):
  { ok: boolean; detail?: string; roundOff?: string } {
  if (sums.total === undefined || sums.taxable === undefined) return { ok: true };

  let expected = 0n;
  for (const role of TIE_ADDENDS) {
    if (sums[role] !== undefined) expected += paise(sums[role]!);
  }
  const stated = paise(sums.total);
  if (expected === stated) return { ok: true };

  const round = asRoundOff(expected, stated);
  if (round !== null) return { ok: true, roundOff: round };

  const parts = TIE_ADDENDS.filter((r) => sums[r] !== undefined)
    .map((r) => `${r} ${sums[r]}`).join(' + ');
  return {
    ok: false,
    detail: `the table does not add up: ${parts} = ${money(expected)}, but the ` +
            `total column sums to ${sums.total}. Either a column was misread or ` +
            'the document is inconsistent — both need a human.',
  };
}

/**
 * A rounding difference, or not a rounding difference. There is no third answer.
 *
 * Vendors round the payable total to the nearest rupee and print only the
 * rounded figure — a real invoice in the corpus states 9539.00 against parts
 * that sum to 9538.98, and prints no round-off line anywhere, so the two paise
 * cannot be read, only inferred. Refusing that document is wrong; it is
 * correct and internally consistent.
 *
 * What this deliberately is NOT is a tolerance. "Within 50 paise" would be a
 * hole in the only exact check this module has: the same corpus contains
 * ₹5.00 platform fees, where 50 paise is a tenth of the document, and a
 * misread landing inside the window would pass in silence. So the difference
 * has to be explained, not merely be small:
 *
 *   - the stated total must BE a whole rupee, because that is what rounding to
 *     the nearest rupee produces. 5.37 against parts of 5.35 is not a
 *     round-off, it is a misread, and it still refuses.
 *   - the parts must round to exactly that rupee. 9535.00 stated against
 *     9538.98 read fails: the difference is under four rupees but the parts
 *     round to 9539, not 9535.
 *   - and the gap must be under a rupee, which the two rules above already
 *     imply and this states so the bound is visible.
 *
 * Anything that survives all three is reported, never swallowed: the caller
 * records it against the bill and puts a warning in front of the approver.
 */
function asRoundOff(expected: bigint, stated: bigint): string | null {
  if (stated % 100n !== 0n) return null;

  const gap = stated - expected;
  if (gap <= -100n || gap >= 100n) return null;

  const nearestRupee = ((expected + 50n) / 100n) * 100n;
  if (nearestRupee !== stated) return null;

  return money(gap);
}

/** A stated totals row must agree with the item rows it claims to total. */
function checkStated(
  totals: Partial<Record<ColumnRole, string>>,
  sums: Partial<Record<ColumnRole, string>>,
): { ok: boolean; detail?: string } {
  /*
   * A stated total may agree with the sum of the PARTS instead of the sum of
   * the total column, and both are correct answers.
   *
   * Zepto rounds each line to a whole rupee: its seven lines total 243.00 in
   * the total column, while the row restating them says 243.02 — taxable plus
   * tax, unrounded. Insisting on the total column refused a document whose
   * arithmetic is perfectly sound.
   *
   * Still exact. The alternative is computed, not tolerated, so a row that
   * actually went missing still fails both comparisons.
   */
  const partsSum = TIE_ADDENDS
    .filter((r) => sums[r] !== undefined)
    .reduce((acc, r) => acc + paise(sums[r]!), 0n);

  for (const role of [...TIE_ADDENDS, 'total' as const]) {
    const t = totals[role], s = sums[role];
    if (t === undefined || s === undefined || t === '') continue;
    let stated: bigint;
    try { stated = paise(parseAmount(t).value); } catch { continue; }
    if (role === 'total' && stated === partsSum) continue;
    if (stated !== paise(s)) {
      return {
        ok: false,
        detail: `the totals row claims ${role} ${money(stated)} but the item ` +
                `rows sum to ${s}. A row was missed, double-counted, or misread.`,
      };
    }
  }
  return { ok: true };
}
