/**
 * Fixed-width text → a grid of cells.
 * Spec: bank-and-reconciliation.md §5.1, and the PDF gap in the defect log
 *
 * A PDF statement, once its text is extracted, is not delimited data. It is
 * columns held apart by runs of spaces, and four properties of the real files
 * shape everything here:
 *
 *   1. **The column header may not survive extraction at all.** On a real SBI
 *      statement only the word `Balance` comes through. So column boundaries
 *      cannot be found from a header — they have to be found from the shape of
 *      the whole page.
 *   2. **Column positions differ between pages.** Page 1 starts at character 0,
 *      page 2 at character 1 with wider columns. Boundaries are therefore
 *      computed per page, never once for the document.
 *   3. **One transaction spans four or five physical lines**, with continuation
 *      text both above and below the line carrying the amounts.
 *   4. **Narrations wrap mid-token.** HDFC splits `YESB0PTMUPI` as `...-Y` then
 *      `ESB0PTMUPI-...`, so continuation lines must be joined with NO
 *      separator. Joining with a space corrupts the reference the matcher
 *      depends on most (BR-10).
 *
 * The approach is a whitespace-gutter histogram: a column boundary is a
 * character position that is blank on every tabular line of the page. It needs
 * no header, survives shifting layouts, and is deterministic.
 */

/** A run of this many consistently-blank characters separates two columns. */
const MIN_GUTTER = 2;

/** A tabular line has at least this many wide gaps — used to ignore prose. */
const MIN_GAPS_FOR_TABULAR = 2;
const WIDE_GAP = 3;

/** Lines that are page furniture rather than content. */
const FURNITURE = [
  // `Page No .: 1`, `Page no. 1`, `Page 1 of 3` — the punctuation varies more
  // than expected, so the separators are matched loosely.
  /^\s*page\s*(no\.?)?\s*[.:\-]*\s*\d+(\s*(of|\/)\s*\d+)?\s*$/i,
  /^\s*-+\s*$/,
  /^\s*continued\b/i,
  /computer\s+generated\s+statement/i,
  /does\s+not\s+require\s+(a\s+)?signature/i,
  /please\s+do\s+not\s+share/i,
  /registered\s+(e-?mail|mailing)/i,
];

export interface FixedWidthPage {
  /** 1-based page number as extracted. */
  pageNo: number;
  /** Character positions where each column starts. */
  boundaries: number[];
  rows: string[][];
  /** Lines dropped as page furniture, kept for transparency. */
  dropped: string[];
}

/** Split on form feeds, which is how `pdftotext` marks a page break. */
export function splitPages(text: string): string[] {
  return text.split('\f').map((p) => p.replace(/\r/g, ''));
}

const isFurniture = (line: string): boolean =>
  line.trim().length === 0 ? false : FURNITURE.some((re) => re.test(line));

/** Does this line look like part of a table rather than a sentence? */
function looksTabular(line: string): boolean {
  if (line.trim().length === 0) return false;
  const gaps = line.trimEnd().match(new RegExp(`\\S {${WIDE_GAP},}\\S`, 'g'));
  return (gaps?.length ?? 0) >= MIN_GAPS_FOR_TABULAR;
}

/**
 * Find the character positions where columns begin.
 *
 * Occupancy is counted only over lines that look tabular. Prose lines — the
 * paragraphs of small print every statement carries — span the full width and
 * would fill every position, erasing the gutters entirely.
 */
export function detectBoundaries(lines: string[]): number[] {
  const tabular = lines.filter(looksTabular);
  const measured = tabular.length > 0 ? tabular : lines.filter((l) => l.trim().length > 0);
  if (measured.length === 0) return [0];

  const width = measured.reduce((w, l) => Math.max(w, l.length), 0);
  const occupancy = new Uint16Array(width);

  for (const line of measured) {
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== ' ') occupancy[i]!++;
    }
  }

  // A position counts as a gutter if it is blank on all but a few lines, rather
  // than on every line. Requiring unanimity is too brittle: a single unusually
  // long narration reaching into a gap erases that column boundary for the
  // whole block, and the columns to its right then merge.
  const tolerance = Math.floor(measured.length * 0.05);
  const isGutter = (i: number): boolean => occupancy[i]! <= tolerance;

  const boundaries: number[] = [];
  let gutterLength = Number.MAX_SAFE_INTEGER;   // treat the left edge as a gutter

  for (let i = 0; i < width; i++) {
    if (isGutter(i)) {
      gutterLength++;
    } else {
      if (gutterLength >= MIN_GUTTER) boundaries.push(i);
      gutterLength = 0;
    }
  }

  return boundaries.length > 0 ? boundaries : [0];
}

/**
 * Split a page into blocks of consecutive non-blank lines.
 *
 * Statements are laid out as blocks — the account-holder address, the
 * transaction table, the summary grid — separated by blank lines, and each
 * block has its OWN column alignment.
 *
 * Measuring the whole page at once was the first attempt and it failed on both
 * real statements: the address block's text sits exactly where the table's
 * gutters are, so the histogram found no gap between the date and narration
 * columns and merged them into one 85-character column. Blocks are the natural
 * unit, and using them also makes the summary grid line up — its labels and
 * values are aligned with each other, not with the transaction rows.
 */
export function splitBlocks(lines: string[]): Array<{ start: number; lines: string[] }> {
  const blocks: Array<{ start: number; lines: string[] }> = [];
  let current: string[] = [];
  let start = 0;

  for (const [i, line] of lines.entries()) {
    if (line.trim().length === 0) {
      if (current.length > 0) { blocks.push({ start, lines: current }); current = []; }
    } else {
      if (current.length === 0) start = i;
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push({ start, lines: current });

  return blocks;
}

/**
 * Lines that begin with something date-shaped — i.e. transaction rows.
 *
 * An optional leading **serial number** is allowed before the date, because
 * some layouts print one and the consequence of missing it is not a missing
 * row — it is a silently mis-sliced table.
 *
 * Bank of Baroda prints `Serial No` as its first column, so its rows read
 * `2    01-06-2022   01-06-2022   UPI/...`. Without this prefix none of them
 * counts as dated, `pageToGrid` finds the table nowhere near where it is, and
 * the header plus the opening-balance row get measured as one region while the
 * transactions get measured as another. The two regions then disagree about
 * where the columns are by exactly one column, so the opening row's
 * description landed in the debit column and its balance in the credit column.
 *
 * The serial is bounded to four digits and must be followed by whitespace, so
 * an amount or a reference cannot pose as one.
 */
const DATED_LINE = /^\s*(?:\d{1,4}\s+)?\d{1,2}[/\-. ][A-Za-z0-9]{2,4}[/\-. ]\d{2,4}\b/;

export const isDatedLine = (line: string): boolean => DATED_LINE.test(line);

/**
 * Move a split point off the middle of a token.
 *
 * Column boundaries are computed for the page as a whole, but a single line can
 * disagree with them — and when it does, a naive slice cuts a value in half.
 *
 * The case that exposed this: on a real Axis statement the widest debit on the
 * page was `30000.00`, every other one being five or six characters. Money is
 * right-aligned, so it grows LEFTWARD, and its first two characters sat to the
 * left of a boundary derived from the narrower values. The gutter histogram
 * allowed that because its 5% tolerance means a position occupied by only one
 * line still counts as blank. The slice produced
 *
 *     ["06-05-2025", "KASIM /UPI/HDFC BANK LTD      3000", "0.00", …]
 *
 * so the row had no readable amount, was dropped as unparseable, and the
 * statement came out ₹30,000 short — with BR-6 reporting a single bad row.
 *
 * The token is given to whichever cell holds most of it, and a tie goes to the
 * RIGHT because the overflow that causes this is a right-aligned number
 * reaching back into the gutter of the column before it. A left-aligned
 * narration spilling rightwards keeps its majority on the left and so stays
 * where it was.
 */
function snapToTokenEdge(line: string, at: number): number {
  if (at <= 0 || at >= line.length) return at;
  if (line[at - 1] === ' ' || line[at] === ' ') return at;

  let start = at;
  while (start > 0 && line[start - 1] !== ' ') start--;
  let end = at;
  while (end < line.length && line[end] !== ' ') end++;

  return end - at >= at - start ? start : end;
}

/** Slice a line at the given boundaries, without cutting through a value. */
export function sliceCells(line: string, boundaries: number[]): string[] {
  // Snapped first, then forced non-decreasing: two adjacent boundaries landing
  // in the same token would otherwise cross and produce a negative-width slice.
  const splits: number[] = [];
  for (const b of boundaries) {
    const snapped = snapToTokenEdge(line, b);
    splits.push(Math.max(snapped, splits[splits.length - 1] ?? 0));
  }

  return splits.map((start, i) => {
    const end = i + 1 < splits.length ? splits[i + 1]! : line.length;
    return line.slice(start, end).trim();
  });
}

/**
 * Turn one page of fixed-width text into a grid.
 *
 * Blank lines are preserved as empty rows, because the blank line between the
 * transactions and the summary block is load-bearing — it is how the summary
 * is recognised as separate.
 */
export function pageToGrid(pageText: string, pageNo: number): FixedWidthPage {
  const all = pageText.split('\n');
  const dropped: string[] = [];
  const kept: string[] = [];

  for (const line of all) {
    if (isFurniture(line)) dropped.push(line.trim());
    else kept.push(line);
  }

  // Segment the page into preamble / table / trailer, and measure each
  // separately. Three attempts got here:
  //
  //   1. Measure the whole page — fails, because the address block's text sits
  //      where the table's gutters are and merges the date and narration
  //      columns into one 85-character column.
  //   2. Measure blocks separated by blank lines — fails, because HDFC puts
  //      blank lines BETWEEN transaction rows. The header ends up in its own
  //      block, so the table is measured without it, and a column that is
  //      empty on every transaction (the deposit column on a month of
  //      withdrawals) reads as a gutter and vanishes — shifting the closing
  //      balance one column left, under "Deposit Amt.".
  //   3. Measure the table as the span from the first dated line to the last,
  //      INCLUDING the header line above it. The header is exactly the line
  //      that pins down columns no transaction happens to fill.
  const firstDated = kept.findIndex(isDatedLine);
  const lastDated = kept.reduce((last, l, i) => (isDatedLine(l) ? i : last), -1);

  const rows: string[][] = [];
  const allBoundaries: number[][] = [];

  const emit = (lines: string[]): void => {
    if (lines.length === 0) return;
    const boundaries = detectBoundaries(lines);
    allBoundaries.push(boundaries);
    for (const line of lines) {
      rows.push(line.trim().length === 0 ? [] : sliceCells(line, boundaries));
    }
    rows.push([]);
  };

  if (firstDated < 0) {
    emit(kept);                                    // a page with no transactions
  } else {
    // Pull in the nearest non-blank line above the first transaction — the
    // header, when extraction preserved one.
    let tableStart = firstDated;
    for (let i = firstDated - 1; i >= 0 && i >= firstDated - 3; i--) {
      if (kept[i]!.trim().length === 0) continue;
      if (looksTabular(kept[i]!) && !isDatedLine(kept[i]!)) tableStart = i;
      break;
    }

    emit(kept.slice(0, tableStart));
    emit(kept.slice(tableStart, lastDated + 1));
    emit(kept.slice(lastDated + 1));
  }

  // The widest region's boundaries describe the page for reporting purposes.
  const boundaries = allBoundaries.reduce(
    (best, b) => (b.length > best.length ? b : best), [0]);

  return { pageNo, boundaries, rows, dropped };
}

export interface FixedWidthDocument {
  pages: FixedWidthPage[];
  /** Every page's rows in order, padded to a common width. */
  rows: string[][];
  warnings: string[];
}

/**
 * Convert a whole extracted document to a grid.
 *
 * Pages are measured independently and then reconciled to a common width. When
 * two pages disagree about how many columns they have — which real statements
 * do — the difference is reported rather than silently reshaped, because a
 * wrong column count moves money between the debit and credit columns.
 */
export function fixedWidthToGrid(text: string): FixedWidthDocument {
  const pageTexts = splitPages(text);
  const pages = pageTexts
    .map((t, i) => pageToGrid(t, i + 1))
    .filter((p) => p.rows.some((r) => r.length > 0));

  const warnings: string[] = [];
  const counts = new Map<number, number[]>();

  for (const p of pages) {
    const n = p.boundaries.length;
    counts.set(n, [...(counts.get(n) ?? []), p.pageNo]);
  }

  if (counts.size > 1) {
    const summary = [...counts.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([n, ps]) => `${n} columns on page${ps.length > 1 ? 's' : ''} ${ps.join(', ')}`)
      .join('; ');
    warnings.push(
      `the pages do not agree on their column count — ${summary}. Column ` +
      'positions shift between pages in some bank layouts; check the balance ' +
      'figures carefully.');
  }

  const width = pages.reduce(
    (w, p) => Math.max(w, p.rows.reduce((x, r) => Math.max(x, r.length), 0)), 0);

  const rows: string[][] = [];
  for (const p of pages) {
    for (const r of p.rows) {
      if (r.length === 0) { rows.push([]); continue; }
      const padded = [...r];
      while (padded.length < width) padded.push('');
      rows.push(padded);
    }
  }

  return { pages, rows, warnings };
}

// ---------------------------------------------------------------------------
// Row grouping
// ---------------------------------------------------------------------------

export interface GroupedRow {
  cells: string[];
  /** Continuation text belonging to this row, in document order. */
  continuations: string[][];
}

/**
 * Merge continuation lines into the transaction line they belong to.
 *
 * The default is to attach a continuation to the row ABOVE it, which is right
 * almost always. The exception is real and specific: SBI prints a transaction
 * *type* marker on its own line ABOVE the dated line —
 *
 *     ⋮
 *                        WDL TFR          ← belongs to the row BELOW
 *     01/09/2026  ...    UPI/DR/...  5,000.00  2,36,933.51
 *                        /ICCLMF@ybl/Collect  ← belongs to the row ABOVE
 *
 * so `forwardMarkers` names the prefixes that attach downward instead. It is a
 * per-bank list rather than a clever heuristic, because the two cases are
 * genuinely indistinguishable from the text alone and guessing would corrupt
 * the narration that drives mode and party detection.
 */
export function groupRows(
  rows: string[][],
  isRowStart: (cells: string[]) => boolean,
  forwardMarkers: string[] = [],
): GroupedRow[] {
  const out: GroupedRow[] = [];
  let pending: string[][] = [];        // continuations awaiting the NEXT row

  const attachesForward = (cells: string[]): boolean => {
    const text = cells.join(' ').trim().toUpperCase();
    return forwardMarkers.some((m) => text.startsWith(m.toUpperCase()));
  };

  for (const row of rows) {
    if (row.length === 0) continue;

    if (isRowStart(row)) {
      out.push({ cells: row, continuations: pending });
      pending = [];
      continue;
    }

    if (row.every((c) => c === '')) continue;

    if (attachesForward(row)) {
      pending.push(row);
    } else if (out.length > 0) {
      out[out.length - 1]!.continuations.push(row);
    }
    // A continuation before any row start and with no marker has nothing to
    // attach to; it is preamble, and the caller still has the raw grid.
  }

  return out;
}

/**
 * Join a cell's wrapped fragments.
 *
 * NO separator, because HDFC wraps mid-token: `...PTYBL-Y` followed by
 * `ESB0PTMUPI-...` is the single token `YESB0PTMUPI`. Inserting a space would
 * split the reference that BR-10 relies on. Where a bank wraps on word
 * boundaries instead the result reads slightly run-together, which costs
 * nothing — the raw text is stored verbatim anyway (BR-11).
 */
export function joinWrapped(parts: string[]): string {
  return parts.filter((p) => p.length > 0).join('');
}
