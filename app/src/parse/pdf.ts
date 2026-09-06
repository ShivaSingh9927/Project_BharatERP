/**
 * PDF bank statements.
 * Spec: bank-and-reconciliation.md §5.1 (BR-4), §5.2 (BR-5)
 *
 * Two decisions worth stating, because both were made against alternatives.
 *
 * **Text extraction is delegated to `pdftotext -layout`** (poppler-utils).
 * Implementing PDF text extraction means implementing font descriptors,
 * encodings and CMaps — a large, subtle body of work whose failure mode is
 * silently wrong characters. `pdftotext` is standard, packaged everywhere, and
 * already produced usable output from both real statements we have.
 *
 * **Extraction stays local.** A hosted parsing service would do this too, and
 * might reconstruct tables better. But a bank statement carries the account
 * number, the address and every counterparty the client pays, so sending them
 * to a third party is a data-protection decision for the CA firm as data
 * fiduciary — not a library choice to be made on their behalf. Local-first
 * keeps that decision theirs; a hosted fallback can be added as an explicit
 * opt-in for files this defeats.
 *
 * Everything downstream is shared with the spreadsheet and CSV paths, and BR-6
 * verifies the result whichever route produced it. That matters more here than
 * anywhere else: fixed-width parsing has the most ways to go subtly wrong, and
 * the arithmetic check is what makes a wrong parse a refusal rather than a
 * corrupt import.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

export function isPdf(buffer: Buffer): boolean {
  return buffer.length > 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Extract a PDF's text layer, preserving the visual layout.
 *
 * ⚠️ The password is passed as a command-line argument, which is visible in the
 * process list to the same user for the lifetime of the call. `pdftotext` has
 * no stdin channel for it. It is written to no file and kept in no variable
 * beyond this function (BR-4), but the exposure is real and is the reason a
 * caller should never run this as a shared service account.
 */
export function extractPdfText(buffer: Buffer, password?: string): string {
  if (!isPdf(buffer)) {
    throw new ValidationError('this file is not a PDF', 'BR-3');
  }

  const dir = mkdtempSync(join(tmpdir(), 'bharaterp-pdf-'));
  const file = join(dir, 'in.pdf');

  try {
    writeFileSync(file, buffer, { mode: 0o600 });

    const args = ['-layout', '-enc', 'UTF-8'];
    if (password) args.push('-upw', password);
    args.push(file, '-');

    const r = spawnSync('pdftotext', args, {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });

    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ValidationError(
        'PDF support needs the `pdftotext` command, which is not installed. ' +
        'Install poppler-utils (`apt install poppler-utils`), or upload the ' +
        "bank's spreadsheet export instead — it is more reliable anyway.", 'BR-3');
    }

    const stderr = (r.stderr ?? '').toString();

    if (r.status !== 0) {
      if (/incorrect password|password/i.test(stderr)) {
        throw new ValidationError(
          password
            ? 'that password did not open the PDF'
            : 'this PDF is password-protected — supply the password. Indian ' +
              'banks encrypt emailed statements by default, often with a ' +
              'PAN-and-date-of-birth pattern.',
          'BR-4');
      }
      throw new ValidationError(
        `the PDF could not be read — ${stderr.trim() || `exit code ${r.status}`}`,
        'BR-3');
    }

    const text = r.stdout ?? '';
    if (text.trim().length === 0) {
      // A scanned statement has no text layer at all. Saying so is far more
      // useful than reporting an empty parse, and it points at the fix.
      throw new ValidationError(
        'this PDF contains no text — it is almost certainly a scan or a photo. ' +
        'Reading it needs OCR, which is not built. Ask for the statement to be ' +
        'downloaded from net banking rather than scanned.', 'BR-3');
    }

    return text;
  } finally {
    // The decrypted copy must not outlive the call.
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ParsedPdfStatement extends ParsedStatementFile {
  format: 'pdf';
  /** Always 'inferred' for fixed-width input — see parsePdfText. */
  columnSource: 'inferred';
  pageCount: number;
}

/**
 * Parse a PDF statement's extracted text.
 *
 * The bank is identified from the page text where possible, which supplies the
 * date format; the column POSITIONS always come from the data. BR-6 is the
 * verdict on whether the inference was right.
 */
export function parsePdfText(
  text: string,
  opts: { bank?: string; dateFormat?: DateFormat } = {},
): ParsedPdfStatement {
  const doc = fixedWidthToGrid(text);
  if (doc.rows.length === 0) {
    throw new ValidationError('no tabular content was found in this PDF', 'BR-3');
  }

  /*
   * Columns are ALWAYS inferred from the data here, even when extraction
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
      'no transaction rows were recognised in this PDF. The columns could not ' +
      'be identified from its layout — try the bank\'s spreadsheet export.',
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
    layoutLabel: detected?.bank ?? 'PDF (columns inferred from layout)',
    bank: opts.bank,
  });

  return {
    ...parsed,
    warnings: [
      ...doc.warnings,
      'BR-5: the columns in this PDF were inferred from the data, because a ' +
      'header label in fixed-width text does not sit where its values sit. The ' +
      'balance check is the confirmation that the inference was right — read it ' +
      'before accepting the import.'
      + (detected ? ` Identified as ${detected.bank} from the page text.` : ''),
      ...refined.notes,
      ...parsed.warnings,
    ],
    columns,
    format: 'pdf',
    columnSource: 'inferred',
    pageCount: doc.pages.length,
  };
}

/** Convenience: bytes → parsed statement. */
export function parsePdfStatement(
  buffer: Buffer,
  opts: { bank?: string; dateFormat?: DateFormat; password?: string } = {},
): ParsedPdfStatement {
  return parsePdfText(extractPdfText(buffer, opts.password), opts);
}

export type { ColumnMap };
