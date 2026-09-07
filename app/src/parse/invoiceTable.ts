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
const TOTAL_ROW = /^\s*(?:grand\s+)?total\b\s*:?\s*$/i;

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
export function readInvoiceTableFromWords(pages: WordPage[]): InvoiceTable {
  const t = tableFromRows(pages.flatMap((p) => p.rows));
  if (!t) {
    return {
      readable: false, roles: [], header: [], rows: [], totals: null, sums: {},
      reason: 'no row of words looks like a table header',
    };
  }
  const graded = gradeTable(t.header, t.rows);

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
 * The acceptance gates, shared by both paths.
 *
 * Everything here decides whether the cells can be BELIEVED, and none of it
 * knows or cares how they were located.
 */
export function gradeTable(header: string[], dataRows: string[][]): InvoiceTable {
  const roles = header.map(roleOf);

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
  const totalsRows = table.rows.filter((r) =>
    r.cells.some((c) => TOTAL_ROW.test(c)));
  table.totals = totalsRows[0] ?? null;

  const itemRows = table.rows.filter((r) => !totalsRows.includes(r));
  table.sums = sumByRole(itemRows, roles);

  // ── Gate 2: the arithmetic ties ──────────────────────────────────────────
  const tie = checkTie(table.sums);
  if (!tie.ok) return { ...table, reason: tie.detail };
  if (tie.roundOff !== undefined) {
    table.roundOff = tie.roundOff;
    table.warnings = [
      ...(table.warnings ?? []),
      `the parts sum to ${money(paise(table.sums.total!) - paise(tie.roundOff))} ` +
      `but the document states ${table.sums.total} — a ${tie.roundOff} rounding ` +
      'difference. The document prints no round-off line, so this is inferred ' +
      'from the figures, not read. Posted to Round Off; confirm it against the ' +
      'invoice before approving.',
    ];
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
  for (const role of [...TIE_ADDENDS, 'total' as const]) {
    const t = totals[role], s = sums[role];
    if (t === undefined || s === undefined || t === '') continue;
    let stated: bigint;
    try { stated = paise(parseAmount(t).value); } catch { continue; }
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
