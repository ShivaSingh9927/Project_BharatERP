/**
 * Turn positioned words into a table of cells.
 *
 * Spec: bills-and-expenses.md §4.3
 *
 * With real coordinates, a column is not a run of whitespace that repeats down
 * the page — it is a horizontal band, and the header declares where the bands
 * are. Every threshold the gutter approach needed (`MIN_GUTTER`, `WIDE_GAP`,
 * the straddle test, the two-pass trim) exists only because spacing was a
 * proxy for position. None of them appear here.
 *
 * One thing carries over unchanged and deliberately: the OUTPUT shape. This
 * produces the same `{ header, rows }` the fixed-width path produces, so the
 * role mapping and both acceptance gates in `invoiceTable.ts` are reused
 * exactly. A new way of finding columns should have to pass the same exam.
 */

import type { Word, WordRow } from './pdfWords.ts';

/**
 * A column, as declared by the header words above it.
 *
 * `xMin`/`xMax` are the ASSIGNMENT band and never move once the caption is
 * read. `figMin`/`figMax` are what gets reported for provenance: the same band
 * widened to cover the figures actually placed in it.
 *
 * They have to be separate. Widening the assignment band was tried and
 * corrupted the table: one item's continuation is a single wide run of text
 * ("1. [IMEI/Serial No: ...]") that lands in the description column and spans
 * 40 to 300 points. Widening from it stretched the description band across
 * four columns, and every figure on every later row was then assigned to the
 * description instead — a three-fee invoice read 50.00 where it should have
 * read 327.96, the exact defect this reader had just been fixed for.
 */
interface Band {
  xMin: number; xMax: number;
  figMin: number; figMax: number;
  labels: string[];
}

/** Words that identify a row as the table's header. Shared with the text path. */
const HEADER_HINTS = [
  /\btaxable\b/i, /\bcgst\b/i, /\bsgst\b/i, /\bigst\b/i,
  /\bhsn\b/i, /\bsac\b/i, /\bqty\b/i, /\bdescription\b/i, /\bparticulars\b/i,
];

const HAS_DIGIT = /\d/;

export interface WordTable {
  header: string[];
  rows: string[][];
  /** Column bands, for callers that want to explain where a figure came from. */
  bands: Array<{ xMin: number; xMax: number }>;
}

function rowText(r: WordRow): string {
  return r.words.map((w) => w.text).join(' ');
}

function headerScore(r: WordRow): number {
  const t = rowText(r);
  return HEADER_HINTS.filter((h) => h.test(t)).length;
}

/**
 * Groups the caption's words into columns.
 *
 * Two wrong answers came before this one, and the measurements that settled it
 * are worth keeping.
 *
 * **One band per header word** was too fine. Blinkit's caption reads
 * "CGST (%)   CGST (INR)   SGST (%)   SGST (INR)" — four columns written as
 * eight words. Each word became its own column, two of them labelled "CGST",
 * and the rate 9.00 and the amount 499.50 landed in one each. Both mapped to
 * the `cgst` role and were summed: 508.50, on an invoice that had read
 * correctly under the fixed-width path.
 *
 * **Transitive overlap across every word** was too coarse. It assumed no word
 * in one column ever overlaps a word in another, and Amazon breaks that: its
 * figures are wide relative to the gaps, so ₹2,626.27 reaches into the column
 * beside it and bridged "Net Amount", "Tax Rate" and "Tax Amount" into one
 * column captioned "Rate Tax Amount Net".
 *
 * What separates them was measured, not guessed. Gaps between adjacent words,
 * as a fraction of the median word height — so, roughly, ems:
 *
 *     Blinkit caption    inside a column 0.23em   between columns 1.08–1.22em
 *     Amazon prose       between words   0.30em
 *     Amazon figures     between columns 0.43–0.61em
 *
 * Amazon's columns are barely further apart than its own prose spacing, which
 * is exactly why `-layout` rounded them to a single space, and why no gap
 * threshold can recover them from DATA rows.
 *
 * But its CAPTION words sit 40–60pt apart. So columns are taken from the
 * caption alone and data rows are only ever assigned into them. Amazon's
 * narrow figure gaps then never have to be resolved at all.
 */
const COLUMN_GAP_EM = 0.5;

function medianHeight(words: Word[]): number {
  const h = words.map((w) => w.yMax - w.yMin).sort((a, b) => a - b);
  return h[Math.floor(h.length / 2)] ?? 1;
}

/** Splits one caption row into bands at every gap wider than half an em. */
function bandsInRow(row: WordRow): Band[] {
  const words = [...row.words].sort((a, b) => a.xMin - b.xMin);
  const threshold = medianHeight(words) * COLUMN_GAP_EM;
  const bands: Band[] = [];

  for (const w of words) {
    const open = bands[bands.length - 1];
    if (open && w.xMin - open.xMax <= threshold) {
      open.xMax = Math.max(open.xMax, w.xMax);
      open.labels.push(w.text);
    } else {
      bands.push({ xMin: w.xMin, xMax: w.xMax,
                   figMin: w.xMin, figMax: w.xMax, labels: [w.text] });
    }
  }
  return bands;
}

/**
 * Merges per-row bands into columns by horizontal overlap, which is what
 * stacks Amazon's "Net" over "Amount" into one column without needing to know
 * how many lines its caption occupies.
 */
function columnsFrom(headerRows: WordRow[]): Band[] {
  const bands: Band[] = [];
  for (const row of headerRows) {
    for (const b of bandsInRow(row)) {
      const hits = bands.filter((x) => b.xMin <= x.xMax && b.xMax >= x.xMin);
      if (hits.length === 0) { bands.push(b); continue; }
      /*
       * Labels keep READING ORDER: earlier caption rows first, then this one.
       * Folding the new band in as the accumulator's seed reversed them —
       * Amazon's "Net Amount" came out "Amount Net", and a three-way merge
       * came out "Rate Tax Amount Net". Roles are matched order-insensitively
       * so nothing computed wrongly, but the caption is what a person reads
       * when asking where a figure came from, and backwards is not an answer.
       */
      const merged: Band = {
        xMin: Math.min(b.xMin, ...hits.map((x) => x.xMin)),
        xMax: Math.max(b.xMax, ...hits.map((x) => x.xMax)),
        figMin: Math.min(b.figMin, ...hits.map((x) => x.figMin)),
        figMax: Math.max(b.figMax, ...hits.map((x) => x.figMax)),
        labels: [...hits.flatMap((x) => x.labels), ...b.labels],
      };
      for (const x of hits) bands.splice(bands.indexOf(x), 1);
      bands.push(merged);
    }
  }
  return bands.sort((a, b) => a.xMin - b.xMin);
}

/**
 * Places a word in the band it overlaps most.
 *
 * Falls back to the nearest band by centre when a word overlaps none, because
 * a right-aligned figure can sit slightly clear of its left-aligned heading.
 * Returning a band always, rather than dropping the word, matters: a dropped
 * amount would quietly shrink a sum, and the arithmetic gate would then blame
 * the document.
 */
function bandOf(xMin: number, xMax: number, bands: Band[]): number {
  let best = -1, bestOverlap = 0;
  bands.forEach((b, i) => {
    const overlap = Math.min(xMax, b.xMax) - Math.max(xMin, b.xMin);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = i; }
  });
  if (best >= 0) return best;

  const centre = (xMin + xMax) / 2;
  let nearest = 0, nearestGap = Infinity;
  bands.forEach((b, i) => {
    const gap = centre < b.xMin ? b.xMin - centre
      : centre > b.xMax ? centre - b.xMax : 0;
    if (gap < nearestGap) { nearestGap = gap; nearest = i; }
  });
  return nearest;
}

/**
 * A totals caption, wherever in the row it landed.
 *
 * Deliberately not anchored to a column: vendors float it wherever there is
 * room — Flipkart puts it under the description, Amazon writes "TOTAL:" hard
 * against the left margin.
 */
const TOTALS_CAPTION = /^\s*(?:grand\s+)?total(?:\s+(?:qty|price|amount))?\s*:?\s*$/i;

function looksLikeTotals(cells: string[]): boolean {
  return cells.some((c) => TOTALS_CAPTION.test(c));
}

function cellsFor(r: WordRow, bands: Band[]): string[] {
  const cells: string[][] = bands.map(() => []);
  for (const w of r.words) cells[bandOf(w.xMin, w.xMax, bands)]!.push(w.text);
  return cells.map((c) => c.join(' '));
}

/**
 * Records how far the FIGURES in each column reach, for provenance only.
 *
 * A caption is narrow — "Taxable" is 23pt — while the figures beneath it are
 * wider and, being right-aligned, offset from it. A highlight drawn on the
 * caption's box misses the number it is meant to point at.
 *
 * Only amounts widen it, and only the assignment band's twin. Text is
 * irrelevant to where a figure sits, and letting it in is what broke the
 * table (see `Band`).
 */
function noteFigureExtent(bands: Band[], row: WordRow): void {
  for (const w of row.words) {
    if (!/^[₹$(]?-?[\d,]+(?:\.\d+)?\)?%?$/.test(w.text)) continue;
    const b = bands[bandOf(w.xMin, w.xMax, bands)]!;
    b.figMin = Math.min(b.figMin, w.xMin);
    b.figMax = Math.max(b.figMax, w.xMax);
  }
}

/**
 * Reads the table out of a page's rows, or returns null when there is no
 * header to anchor it.
 *
 * The body ends at the first row that puts non-numeric text into a band the
 * rows above it fill with figures. That is the same principle the fixed-width
 * path used — content below a table is laid out for a human and stops
 * respecting the columns — but expressed against the columns themselves rather
 * than against a straddle test, which could not see it. "Amount in Words:
 * Three Thousand Ninety-nine only" is made of small words that straddle
 * nothing, yet it lands squarely in the money bands, and that is what gives it
 * away.
 */
export function tableFromRows(rows: WordRow[]): WordTable | null {
  let headerAt = -1, best = 1;   // two hints minimum
  rows.forEach((r, i) => {
    const s = headerScore(r);
    if (s > best) { best = s; headerAt = i; }
  });
  if (headerAt < 0) return null;

  // The header runs on while the rows below it carry no digits.
  let headerEnd = headerAt;
  while (headerEnd + 1 < rows.length && !HAS_DIGIT.test(rowText(rows[headerEnd + 1]!))) {
    headerEnd++;
  }

  const bands = columnsFrom(rows.slice(headerAt, headerEnd + 1));
  const header = bands.map((b) => b.labels.join(' '));
  const numericBand = new Set<number>();
  const out: string[][] = [];
  const AMOUNT = /^[₹$(]?-?[\d,]+(?:\.\d+)?\)?%?$/;

  for (const r of rows.slice(headerEnd + 1)) {
    const cells = cellsFor(r, bands);
    if (cells.every((c) => c === '')) continue;

    /*
     * ── The truncation defect ──────────────────────────────────────────────
     *
     * This loop used to `break` on any row that put non-numeric text into a
     * band the table had been filling with figures. That ended the table at
     * the first line of an item's own continuation.
     *
     * Two real Flipkart invoices were silently under-reported because of it.
     * One has three fee lines — 50.00, 109.32 and 168.64 — each followed by
     * "1. [IMEI/Serial No: ...]" and "IGST: 18.0 %". The IMEI text runs into
     * the numeric bands, so the table stopped after the FIRST line and
     * reported a taxable value of 50.00 against a true 327.96.
     *
     * Both gates passed it. One row's 50.00 + 9.00 = 59.00 ties perfectly on
     * its own, so the arithmetic had nothing to object to — a whole-table
     * check cannot see rows that were never presented to it. A model reading
     * the same page returned all three lines, which is how this was found.
     *
     * The distinction that fixes it: a continuation line carries no amount of
     * its own, while content genuinely below the table does. So a row with
     * text where figures belong and NO figure anywhere is an item's own
     * overflow and is skipped; a row with both is the start of something else
     * — a floated "Grand Total", a signature block — and ends the table.
     */
    const contradicts = cells.some((c, i) =>
      numericBand.has(i) && c !== '' && !AMOUNT.test(c.trim()));
    const carriesAnAmount = cells.some((c) => AMOUNT.test(c.trim()));

    /*
     * A totals row is the one thing that contradicts AND carries amounts and
     * still belongs to the table — in fact it is the most valuable row on the
     * page.
     *
     * The rule above was written to keep a floated "Grand Total" out of the
     * item sums, and it did that by ending the table at the first row with
     * both text and figures. But the document's OWN stated totals row looks
     * exactly like that: a caption in a numeric band beside a set of amounts.
     * So it was discarded on 6 of the 11 readable documents, Blinkit among
     * them, even though the paper prints "Total 499.50 499.50 6549.00" plainly.
     *
     * Losing it costs the best check there is. It is the vendor's own
     * arithmetic over the same rows we just read, so comparing our sum against
     * it catches a missed or double-counted row without needing a second
     * reader at all — precisely the class of defect that got past both gates
     * last time.
     *
     * So it is kept, and it ends the table: nothing after a totals row is part
     * of the body. `gradeTable` recognises it by caption, excludes it from the
     * item sums, and checks those sums against it.
     */
    if (contradicts) {
      if (!carriesAnAmount) continue;      // an item's own wrapped text
      if (!looksLikeTotals(cells)) break;  // a signature block, a stray figure
      noteFigureExtent(bands, r);
      out.push(cells);
      break;
    }

    cells.forEach((c, i) => { if (AMOUNT.test(c.trim())) numericBand.add(i); });
    noteFigureExtent(bands, r);
    out.push(cells);
  }

  // Reported extents, not assignment bands — see `Band`.
  return { header, rows: out,
           bands: bands.map(({ figMin, figMax }) => ({ xMin: figMin, xMax: figMax })) };
}
