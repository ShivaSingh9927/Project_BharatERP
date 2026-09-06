/**
 * Fixed-width layout text → a parsed statement.
 * Spec: bank-and-reconciliation.md §5.2 (BR-5)
 *
 * This was the body of `parsePdfText` and is now shared, because OCR produces
 * exactly the same kind of input. `pdftotext -layout` gives columns held apart
 * by runs of spaces; `ocrCanvas.ts` renders positioned OCR boxes into columns
 * held apart by runs of spaces. Once the units are characters, the problem is
 * identical — and it is a problem that took six defects on real HDFC and SBI
 * files to get right, so there must be exactly one implementation of it.
 *
 * The alternative was letting the OCR path do its own row and column
 * clustering. That was tried in a throwaway probe and every one of its apparent
 * OCR failures turned out to be its own: it merged `Withdrawals` and `Deposits`
 * because the two are mutually exclusive, it choked on `1,14,197.8 1` where the
 * source PDF prints a broken space, and it scored a MICR code as a balance.
 * The functions called below already handle all three.
 */

import { ValidationError } from '../domain/types.ts';
import { parseStatementTable, type ParsedStatementFile, type ColumnMap } from './statementFile.ts';
import { TEMPLATES, templateByName, candidateTemplates,
         type BankTemplate } from './bankTemplates.ts';
import type { DateFormat } from './values.ts';
import { fixedWidthToGrid, groupRows, joinWrapped } from './fixedWidth.ts';
import { inferColumnRoles, makeRowStartTest } from './columnRoles.ts';

/** Transaction-type markers that SBI prints ABOVE the dated line (§ groupRows). */
const FORWARD_MARKERS = [
  'WDL TFR', 'DEP TFR', 'TFR ', 'BY TRANSFER', 'TO TRANSFER',
];

export type LayoutSource = 'pdf' | 'ocr';

export interface ParsedLayoutStatement extends ParsedStatementFile {
  format: LayoutSource;
  /** Always 'inferred' for fixed-width input — see the comment below. */
  columnSource: 'inferred';
  pageCount: number;
}

/** Wording that differs between the two sources; the logic does not. */
const SOURCE_WORDS: Record<LayoutSource, { noun: string; empty: string }> = {
  pdf: {
    noun: 'PDF',
    empty: 'no tabular content was found in this PDF',
  },
  ocr: {
    noun: 'scanned statement',
    empty:
      'OCR read text from this image but none of it formed a table. The scan ' +
      'is probably too low-resolution, skewed, or cropped mid-table',
  },
};

export interface LayoutOptions {
  bank?: string;
  dateFormat?: DateFormat;
  /** Only changes wording and the reported format. */
  source?: LayoutSource;
}

/**
 * Parse fixed-width statement text.
 *
 * The bank is identified from the page text where possible, which supplies the
 * date format; the column POSITIONS always come from the data. BR-6 is the
 * verdict on whether the inference was right.
 */
export function parseLayoutText(
  text: string,
  opts: LayoutOptions = {},
): ParsedLayoutStatement {
  const source = opts.source ?? 'pdf';
  const words = SOURCE_WORDS[source];

  const doc = fixedWidthToGrid(text);
  if (doc.rows.length === 0) {
    throw new ValidationError(words.empty, 'BR-3');
  }

  /*
   * Columns are ALWAYS inferred from the data here, even when the input
   * preserved a header row — which is the opposite of what the delimited and
   * spreadsheet paths do, and the opposite of what seems sensible.
   *
   * The reason is specific to fixed-width text: **a header label does not sit
   * where its values sit.** Numbers are right-aligned under a left-aligned
   * label, so on a real HDFC statement
   *
   *       Withdrawal Amt.        Deposit Amt.       Closing Balance
   *               126.80                              162,509.37
   *                                    78.00          150,238.57
   *
   * `Deposit Amt.` begins at character 162 while its values begin at 184.
   * Matching template aliases against that header therefore mapped the credit
   * column onto an empty span and the balance column onto the deposits — the
   * import came out with five debits, no credits, and a balance short by
   * exactly the credits it had lost.
   *
   * A header is still useful for identifying the BANK, which the template
   * detection does from the page text. It is simply not usable for positions.
   */
  const dated = doc.rows.filter((r) => r.length > 0);
  const inferred = inferColumnRoles(dated);
  const isRowStart = makeRowStartTest(inferred.columns.txnDate);

  const grouped = groupRows(doc.rows, isRowStart, FORWARD_MARKERS);
  if (grouped.length === 0) {
    throw new ValidationError(
      `no transaction rows were recognised in this ${words.noun}. The columns ` +
      'could not be identified from its layout — try the bank\'s spreadsheet ' +
      'export.',
      'BR-5');
  }

  // Re-infer over the transaction rows only. The first pass ran over every
  // line including preamble and summary, which skews the statistics that decide
  // which column is which.
  const refined = inferColumnRoles(grouped.map((g) => g.cells));
  const columns = refined.columns;

  // Fold each transaction's continuation lines into its narration cell, so the
  // shared builder sees one row per transaction.
  const flattened: string[][] = grouped.map((g) => {
    const cells = [...g.cells];

    // Take a continuation's text from ALL its cells, not from the narration
    // column index.
    //
    // A continuation line can be sliced with a different region's column
    // boundaries — SBI's leading `WDL TFR` marker sits above the first
    // transaction and therefore lands in the preamble region, whose columns
    // are aligned differently. Reading index `columns.narration` from it found
    // an empty cell and the marker was silently lost. A continuation line has
    // no date and no amounts by definition, so every cell on it is narration.
    const extra = g.continuations
      .map((c) => joinWrapped(c.map((cell) => cell.trim())))
      .filter((t) => t.length > 0);

    if (extra.length > 0) {
      cells[columns.narration] = joinWrapped([cells[columns.narration] ?? '', ...extra]);
    }
    return cells;
  });

  // The preamble and summary blocks are still needed — they carry the opening
  // and closing balances and the statement period — so they are put back around
  // the flattened transactions in their original order.
  const firstDated = doc.rows.findIndex((r) => r.length > 0 && isRowStart(r));
  const preamble = firstDated > 0 ? doc.rows.slice(0, firstDated) : [];
  const lastDated = doc.rows.reduce(
    (last, r, i) => (r.length > 0 && isRowStart(r) ? i : last), -1);
  const trailer = lastDated >= 0 ? doc.rows.slice(lastDated + 1) : [];

  const rebuilt = [...preamble, ...flattened, ...trailer];

  // Identify the bank from the page TEXT rather than from the column headings.
  // The name is what gives us the right date format — SBI writes 01/09/2026 in
  // its rows and 01-09-2026 in its headers, and HDFC uses two-digit years — so
  // it is worth recovering even though the header cannot be trusted for
  // positions.
  const detected = opts.bank
    ? templateByName(opts.bank)
    : candidateTemplates(text.slice(0, 4000)).find((t) => t.detect.length > 0);

  const template: BankTemplate = detected
    ?? TEMPLATES.find((t) => t.bank.startsWith('Generic (separate'))!;

  const parsed = parseStatementTable(rebuilt, {
    columns,
    dataStartRow: preamble.length,
    dateFormat: opts.dateFormat ?? template.dateFormat,
    layoutLabel: detected?.bank
      ?? `${words.noun} (columns inferred from layout)`,
    bank: opts.bank,
  });

  return {
    ...parsed,
    warnings: [
      ...doc.warnings,
      `BR-5: the columns in this ${words.noun} were inferred from the data, ` +
      'because a header label in fixed-width text does not sit where its ' +
      'values sit. The balance check is the confirmation that the inference ' +
      'was right — read it before accepting the import.'
      + (detected ? ` Identified as ${detected.bank} from the page text.` : ''),
      ...refined.notes,
      ...parsed.warnings,
    ],
    columns,
    format: source,
    columnSource: 'inferred',
    pageCount: doc.pages.length,
  };
}

export type { ColumnMap };
