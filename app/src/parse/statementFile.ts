/**
 * Statement file → StatementRow[].
 * Spec: bank-and-reconciliation.md §5.1, §5.2, BR-5
 *
 * The hard part is not reading the delimiter — it is finding where the actual
 * data starts and stops. A real Indian bank export looks like this:
 *
 *   Statement of account
 *   Account Number: 50100123457788
 *   Period: 01/04/2026 to 30/04/2026
 *   Opening Balance: 1,00,000.00
 *   (blank)
 *   Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance
 *   02/04/26,NEFT-...,,,50000.00,150000.00
 *   ...
 *   (blank)
 *   Closing Balance: 1,29,882.00
 *   *** End of statement ***
 *
 * Everything above the header and below the last data row must be recognised
 * and discarded — and the opening and closing balances mined out of it, since
 * they are what BR-6 checks against.
 */

import { parseDelimited, isBlankRow } from './csv.ts';
import { parseDate, parseAmount, looksNumeric, type DateFormat } from './values.ts';
import { TEMPLATES, candidateTemplates, templateByName,
         type BankTemplate, type AmountConvention } from './bankTemplates.ts';
import type { StatementRow } from '../domain/statement.ts';
import { ValidationError } from '../domain/types.ts';
import { paise, money } from '../domain/tax.ts';
import { looksLikeZip, looksLikeEncryptedOffice } from './zip.ts';
import { readXlsxSheet, decryptOfficeFile } from './xlsx.ts';
import { isPdf } from './pdf.ts';
import { isImage } from './ocr.ts';

export interface ColumnMap {
  txnDate: number;
  valueDate: number | null;
  narration: number;
  reference: number | null;
  debit: number | null;
  credit: number | null;
  amount: number | null;
  drCrFlag: number | null;
  balance: number | null;
}

export interface ParsedStatementFile {
  bank: string;
  template: BankTemplate;
  headerRowIndex: number;
  columns: ColumnMap;
  rows: StatementRow[];
  /** Mined from the preamble/trailer where present; null when absent. */
  openingBalance: string | null;
  closingBalance: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  skippedRows: Array<{ index: number; reason: string; text: string }>;
  warnings: string[];
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * First heading matching one of the aliases, on a token boundary.
 *
 * Boundaries are not optional. A plain substring test makes the two-letter
 * aliases catastrophic: `cr` matches inside "des**cr**iption", so a narration
 * column gets claimed as the credit column and every amount read from it
 * throws. Real bug, found by a test — and the failure surfaced as
 * `"OPENING" is not a recognisable amount`, a long way from its cause.
 */
function findColumn(headings: string[], aliases: string[] | undefined): number | null {
  if (!aliases) return null;
  // Longest alias first, so 'withdrawal amount' beats a bare 'amount'.
  for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`);
    const i = headings.findIndex((h) => re.test(h));
    if (i >= 0) return i;
  }
  return null;
}

function mapColumns(headings: string[], t: BankTemplate): ColumnMap | null {
  const txnDate = findColumn(headings, t.columns.txnDate);
  const narration = findColumn(headings, t.columns.narration);
  if (txnDate === null || narration === null) return null;

  const debit = findColumn(headings, t.columns.debit);
  const credit = findColumn(headings, t.columns.credit);
  const amount = findColumn(headings, t.columns.amount);
  const drCrFlag = findColumn(headings, t.columns.drCrFlag);

  // Without somewhere to read the money from, the template does not apply.
  //
  // `amount_plus_type` must also find its Dr/Cr column. Omitting that check let
  // the Kotak template — which needs the flag to know the direction — claim a
  // plain signed-amount file it could not read, then skip every row for having
  // "no Dr/Cr marker". A template that cannot determine direction has not
  // matched, however well its other columns line up.
  const hasMoney =
    t.amountConvention === 'separate_dr_cr' ? debit !== null || credit !== null
    : t.amountConvention === 'amount_plus_type' ? amount !== null && drCrFlag !== null
    : amount !== null;
  if (!hasMoney) return null;

  return {
    txnDate, narration, debit, credit, amount, drCrFlag,
    valueDate: findColumn(headings, t.columns.valueDate),
    reference: findColumn(headings, t.columns.reference),
    balance: findColumn(headings, t.columns.balance),
  };
}

/**
 * Locate the header row.
 *
 * Scored rather than pattern-matched, because the header is not reliably the
 * first row, the widest row, or the row containing "Date". The row that
 * resolves the most template columns is the header — that is the definition
 * that actually holds across banks.
 */
function findHeaderRow(
  rows: string[][], templates: BankTemplate[], namedBanks: Set<string>,
): { index: number; template: BankTemplate; columns: ColumnMap } | null {
  let best: { index: number; template: BankTemplate; columns: ColumnMap; score: number } | null = null;

  // 60, not 30. An OCR'd statement turns every line of prose into its own row,
  // so the transactions table can start well below where a CSV's would — on a
  // real sample the header sat at row 33 and was never reached. Scanning
  // further is safe because a data row is excluded by the numeric-cell test
  // below, not by being far down the file.
  const limit = Math.min(rows.length, 60);
  for (let i = 0; i < limit; i++) {
    const row = rows[i]!;
    if (isBlankRow(row) || row.length < 3) continue;

    // A header row is text, not numbers. Skip anything that looks like data,
    // which prevents locking onto the first transaction row.
    const numericCells = row.filter((c) => looksNumeric(c)).length;
    if (numericCells > 1) continue;

    const headings = row.map(norm);

    for (const t of templates) {
      const columns = mapColumns(headings, t);
      if (!columns) continue;

      // Priority dominates the resolved-column count, because a generic
      // template declares looser aliases and will therefore always resolve MORE
      // columns than the specific one that actually fits. Counting columns
      // first made every file parse as "Generic" — the bank templates could
      // never win. A named bank found in the file text outranks both.
      const score = (namedBanks.has(t.bank) ? 100_000 : 0)
        + t.priority * 100
        + Object.values(columns).filter((v) => v !== null).length;

      if (!best || score > best.score) best = { index: i, template: t, columns, score };
    }
  }

  return best;
}

/**
 * Pull a labelled amount out of the preamble or trailer.
 *
 * Returns a CLEAN decimal string, not the raw cell. Returning the raw cell was
 * a bug: `1,00,000.00` flowed onwards and blew up much later inside `paise()`
 * as `"1,00,000.00" is not a valid decimal amount` — an error about the
 * arithmetic check, pointing nowhere near the parser that produced it. Coerce
 * at the boundary where the format is known.
 */
function clean(raw: string): string {
  const a = parseAmount(raw);
  return a.negative ? `-${a.value}` : a.value;
}

/**
 * Pull a labelled amount out of the text surrounding the transactions.
 *
 * Three layouts, all real, and the third only became apparent from an actual
 * HDFC statement:
 *
 *   1. label and value in one cell     `Opening Balance: 1,00,000.00`
 *   2. label and value on one row      `Opening Balance: | 1,00,000.00`
 *   3. label and value in a SUMMARY GRID, on different rows:
 *
 *        Opening Balance | Dr Count | Cr Count | Debits | Credits | Closing Bal
 *                   0.00 |        0 |        1 |   0.00 | 25,000.00 | 25,000.00
 *
 * Case 3 broke the original implementation completely — it looked for a number
 * on the label's own row, found none, and returned null. On a real HDFC
 * statement that meant `openingBalance` came back null and BR-6, the check the
 * whole import rests on, silently could not run.
 *
 * The fix is to carry the label's COLUMN INDEX down to the following rows, so
 * the value is read from beneath its own heading rather than from wherever a
 * number happens to appear.
 */
function mineLabel(rows: string[][], labels: string[]): string | null {
  const lower = labels.map((l) => l.toLowerCase());

  for (const [r, row] of rows.entries()) {
    for (const label of lower) {
      const col = row.findIndex((c) => norm(c).includes(label));
      if (col < 0) continue;

      // Case 1 — the value shares the label's cell.
      const inCell = /[\d,]+\.\d{2}|\b\d+\b/.exec(
        norm(row[col]!).slice(norm(row[col]!).indexOf(label) + label.length));
      if (inCell) {
        try { return clean(inCell[0]); } catch { /* keep looking */ }
      }

      // Case 2 — a numeric cell elsewhere on the same row. Nearest to the
      // right of the label first; a summary grid puts other labels' values
      // further away.
      for (let i = col + 1; i < row.length; i++) {
        if (looksNumeric(row[i]!)) return clean(row[i]!);
      }
      for (let i = col - 1; i >= 0; i--) {
        if (looksNumeric(row[i]!)) return clean(row[i]!);
      }

      // Case 3 — a value row beneath the heading row, read at the same index.
      for (let below = r + 1; below <= Math.min(r + 2, rows.length - 1); below++) {
        const cell = rows[below]![col];
        if (cell !== undefined && looksNumeric(cell)) return clean(cell);
      }
    }
  }
  return null;
}

function mineDateRange(
  rows: string[][], format: DateFormat,
): { from: string | null; to: string | null } {
  for (const row of rows) {
    const joined = row.join(' ');
    // `From : 01/07/2026   To : 22/07/2026` is how HDFC writes it — the colon
    // is optional and so is the space, which the original pattern did not allow.
    if (!/period|statement\s+(from|for)|\bfrom\s*:?\s*\d/i.test(joined)) continue;
    const dates = joined.match(/\d{1,4}[\/\-. ][\w]{2,4}[\/\-. ]\d{2,4}/g) ?? [];
    const parsed = dates.map((d) => parseDate(d, format)).filter((d): d is string => d !== null);
    if (parsed.length >= 2) return { from: parsed[0]!, to: parsed[parsed.length - 1]! };
  }
  return { from: null, to: null };
}

/**
 * Parse a statement file.
 *
 * Deliberately does NOT verify the arithmetic — that is `importStatement`'s job
 * (BR-6), and keeping them separate means a parse can be inspected and
 * corrected before anything is written. Nothing here touches the database.
 */
export function parseStatementFile(
  text: string,
  opts: { bank?: string; dateFormat?: DateFormat } = {},
): ParsedStatementFile {
  const { rows } = parseDelimited(text);
  return parseStatementTable(rows, opts);
}

/**
 * Parse an already-tabulated statement.
 *
 * This is where all the layout intelligence lives, and it is deliberately
 * independent of how the rows were obtained — delimited text, a spreadsheet, or
 * eventually a PDF. Everything downstream of "I have a grid of strings" is
 * identical across formats, so it must not be written twice.
 */
export function parseStatementTable(
  rows: string[][],
  opts: {
    bank?: string;
    dateFormat?: DateFormat;
    /**
     * Supply the column map directly, bypassing header detection.
     *
     * The PDF path needs this: a real SBI statement loses its header row in
     * extraction, so the columns are inferred from the data instead
     * (`columnRoles.ts`). Everything after that point — balance mining, period
     * mining, skipped-row reporting, BR-6 — is identical, and must not be
     * written a second time just because the columns arrived differently.
     */
    columns?: ColumnMap;
    /** Where the data begins when the columns were supplied. */
    dataStartRow?: number;
    /** Label for the layout when no template was matched. */
    layoutLabel?: string;
  } = {},
): ParsedStatementFile {
  if (rows.length === 0) throw new ValidationError('the file contains no rows', 'BR-3');

  const warnings: string[] = [];

  // BR-5: auto-detect, but an explicit choice always wins.
  //
  // Every template is a candidate regardless, because the bank's NAME is often
  // absent from an export while its column layout is still distinctive. The
  // name, when present, simply outranks everything else.
  let templates: BankTemplate[];
  let namedBanks: Set<string>;

  if (opts.bank) {
    const named = templateByName(opts.bank);
    if (!named) throw new ValidationError(`no template for bank "${opts.bank}"`, 'BR-5');
    templates = [named, ...TEMPLATES.filter((t) => t !== named)];
    namedBanks = new Set([named.bank]);
  } else {
    const preambleText = rows.slice(0, 12).map((r) => r.join(' ')).join(' ');
    templates = TEMPLATES;
    namedBanks = new Set(candidateTemplates(preambleText)
      .filter((t) => t.detect.length > 0)
      .map((t) => t.bank));
  }

  // Columns supplied by the caller win outright — there is nothing to detect.
  if (opts.columns) {
    return buildFromColumns(rows, opts.columns, {
      dataStartRow: opts.dataStartRow ?? 0,
      template: (opts.bank ? templateByName(opts.bank) : undefined) ?? TEMPLATES[TEMPLATES.length - 1]!,
      bankLabel: opts.layoutLabel ?? opts.bank ?? 'inferred layout',
      dateFormat: opts.dateFormat,
      warnings,
    });
  }

  const found = findHeaderRow(rows, templates, namedBanks);
  if (!found) {
    throw new ValidationError(
      'could not find a header row — no row resolved a date and a narration ' +
      'column. Check that this is a statement export and not a summary.', 'BR-5');
  }

  const { index: headerRowIndex, template, columns } = found;
  const dateFormat = opts.dateFormat ?? template.dateFormat;

  if (!opts.bank && namedBanks.size === 0) {
    warnings.push(
      `BR-5: the bank could not be identified from this file, so the ` +
      `"${template.bank}" layout was inferred from the column headings alone. ` +
      'Confirm the bank if the import fails its balance check.');
  } else if (!namedBanks.has(template.bank)) {
    // The file names a bank we have a template for, but that template did not
    // fit — which usually means the bank has changed its export format. Worth
    // saying out loud, because it is the case BR-5's manual override exists for
    // and it will keep recurring as banks revise their downloads.
    warnings.push(
      `BR-5: this file appears to be from ${[...namedBanks].join(' / ')}, but that ` +
      `template did not match its columns — the "${template.bank}" layout was used ` +
      'instead. The bank may have changed its export format.');
  }

  return buildFromColumns(rows, columns, {
    dataStartRow: headerRowIndex + 1,
    template, bankLabel: template.bank,
    dateFormat: opts.dateFormat, warnings,
  });
}

/**
 * Build the parsed result once the columns are known.
 *
 * Shared by every input format. The column map may have come from a matched
 * header (delimited text, a spreadsheet) or from inference over the data
 * itself (a PDF whose header did not survive extraction) — and beyond this
 * point nothing cares which, so nothing here is written twice.
 */
function buildFromColumns(
  rows: string[][],
  columns: ColumnMap,
  a: {
    dataStartRow: number;
    template: BankTemplate;
    bankLabel: string;
    dateFormat?: DateFormat;
    warnings: string[];
  },
): ParsedStatementFile {
  const dateFormat = a.dateFormat ?? a.template.dateFormat;
  const headerRowIndex = a.dataStartRow - 1;
  const warnings = a.warnings;

  // Derived from the columns, not from the template. An inferred layout has no
  // template to speak for it, and the columns are the more direct evidence:
  // if a debit or credit column was identified, the file separates them.
  const convention: AmountConvention =
    columns.debit !== null || columns.credit !== null ? 'separate_dr_cr'
    : columns.amount !== null && columns.drCrFlag !== null ? 'amount_plus_type'
    : 'single_signed';

  const out: StatementRow[] = [];
  const skippedRows: ParsedStatementFile['skippedRows'] = [];

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (isBlankRow(row)) continue;

    const cell = (idx: number | null): string =>
      idx === null || idx >= row.length ? '' : row[idx]!;

    const txnDate = parseDate(cell(columns.txnDate), dateFormat);
    if (txnDate === null) {
      // Trailer lines, subtotals and continuation text all land here. They are
      // recorded rather than dropped silently, so a genuinely missing
      // transaction can be told apart from a decorative row.
      skippedRows.push({
        index: i + 1,
        reason: 'no parsable date in the date column',
        text: row.join(' | ').slice(0, 120),
      });
      continue;
    }

    let debit = '0.00';
    let credit = '0.00';

    if (convention === 'separate_dr_cr') {
      const d = parseAmount(cell(columns.debit));
      const c = parseAmount(cell(columns.credit));
      debit = d.value; credit = c.value;
    } else if (convention === 'single_signed') {
      const a = parseAmount(cell(columns.amount));
      if (a.negative) debit = a.value; else credit = a.value;
    } else {
      const a = parseAmount(cell(columns.amount));
      const flag = cell(columns.drCrFlag).trim().toLowerCase();
      if (flag.startsWith('d')) debit = a.value;
      else if (flag.startsWith('c')) credit = a.value;
      else {
        skippedRows.push({
          index: i + 1,
          reason: `amount ${a.value} has no Dr/Cr marker`,
          text: row.join(' | ').slice(0, 120),
        });
        continue;
      }
    }

    if (debit === '0.00' && credit === '0.00') {
      skippedRows.push({
        index: i + 1, reason: 'zero amount on both sides',
        text: row.join(' | ').slice(0, 120),
      });
      continue;
    }

    const bal = columns.balance !== null ? parseAmount(cell(columns.balance)) : null;

    out.push({
      txnDate,
      valueDate: parseDate(cell(columns.valueDate), dateFormat) ?? undefined,
      narration: cell(columns.narration) || '(no narration)',
      debit, credit,
      runningBalance: bal && !bal.blank
        ? (bal.negative ? `-${bal.value}` : bal.value)
        : undefined,
    });
  }

  if (out.length === 0) {
    throw new ValidationError(
      headerRowIndex >= 0
        ? `the header row was found at line ${headerRowIndex + 1} but no data ` +
          'rows parsed beneath it — the date format is probably wrong'
        : 'no data rows parsed with the supplied column map — the date format ' +
          'or the column positions are wrong',
      'BR-5');
  }

  const preamble = rows.slice(0, Math.max(0, headerRowIndex));
  const trailer = rows.slice(headerRowIndex + 1).filter((r) =>
    parseDate(r[columns.txnDate] ?? '', dateFormat) === null);

  // Both are searched in the preamble AND the trailer. HDFC puts the opening
  // balance in a STATEMENT SUMMARY block at the FOOT of the statement, so
  // looking only above the transactions — as this originally did — finds
  // nothing on a real file.
  const OPENING = ['opening balance', 'opening bal', 'balance b/f', 'brought forward'];
  const CLOSING = ['closing balance', 'closing bal', 'balance c/f', 'carried forward'];

  let openingBalance = mineLabel(preamble, OPENING) ?? mineLabel(trailer, OPENING);
  let closingBalance = mineLabel(trailer, CLOSING) ?? mineLabel(preamble, CLOSING);

  /*
   * The opening balance is often the FIRST ROW OF THE TABLE, not a preamble or
   * summary line — IndusInd labels it `Brought Forward`, Bank of Baroda labels
   * it `Opening Balance`, and in both cases it is a dated row carrying a
   * balance and no amounts.
   *
   * Searching only above and below the transactions missed it on both, and
   * missing it means BR-6 cannot run at all. Two of five sample layouts do
   * this, so it is a normal case rather than an oddity.
   *
   * Such a row is skipped as a transaction — correctly, since no money moved —
   * so it is recovered here from the skipped rows.
   */
  if (openingBalance === null && columns.balance !== null) {
    const carried = skippedRows.find((sk) =>
      OPENING.some((label) => sk.text.toLowerCase().includes(label)));

    if (carried) {
      const row = rows[carried.index - 1];
      const cell = row?.[columns.balance];
      if (cell !== undefined && looksNumeric(cell)) {
        openingBalance = clean(cell);
        warnings.push(
          `the opening balance was taken from the "${carried.text.trim().slice(0, 40)}" ` +
          'row inside the table, which is where some banks put it');
      }
    }
  }

  // Where the file states no balances, the running-balance column can supply
  // them: the opening is the first row's balance backed out by its own
  // movement. This is what makes BR-6 possible on a bare export.
  if (openingBalance === null && out[0]?.runningBalance !== undefined) {
    const first = out[0]!;
    // paise/money, never Number() — a float here would put a rounding artefact
    // straight into the figure BR-6 checks against, and money() gets the sign
    // right for balances under ₹1, which naive BigInt division does not.
    const open = paise(first.runningBalance!) - paise(first.credit ?? '0')
      + paise(first.debit ?? '0');
    openingBalance = money(open);
    warnings.push(
      'the file states no opening balance, so it was derived from the first ' +
      'row\'s running balance');
  }
  if (closingBalance === null) {
    const last = out[out.length - 1]!;
    if (last.runningBalance !== undefined) {
      closingBalance = last.runningBalance;
      warnings.push(
        'the file states no closing balance, so the last row\'s running balance ' +
        'was used');
    }
  }

  if (openingBalance === null || closingBalance === null) {
    warnings.push(
      'BR-6 cannot run: this file carries neither stated balances nor a running ' +
      'balance column, so the parse cannot be checked arithmetically. Treat the ' +
      'import as unverified.');
  }

  if (skippedRows.length > 0) {
    warnings.push(
      `${skippedRows.length} row(s) were not read as transactions — review them ` +
      'before accepting the import');
  }

  const { from, to } = mineDateRange(preamble, dateFormat);

  return {
    bank: a.bankLabel,
    template: a.template,
    headerRowIndex,
    columns,
    rows: out,
    openingBalance,
    closingBalance,
    periodFrom: from ?? out[0]!.txnDate,
    periodTo: to ?? out[out.length - 1]!.txnDate,
    skippedRows,
    warnings,
  };
}

/**
 * Parse a statement from raw file BYTES, whatever format it arrived in.
 *
 * The single entry point a CA's upload should reach. Format is detected from
 * content, never from the file extension — SBI's export is named `.xlsx` while
 * actually being an encrypted OLE container, so trusting the extension gets the
 * answer wrong on the first real file we tried.
 *
 * Order of attempts:
 *   1. encrypted Office container → decrypt with the supplied password, then
 *      read as a spreadsheet
 *   2. zip → spreadsheet
 *   3. anything else → treat as delimited text
 */
export async function parseStatementBytes(
  buffer: Buffer,
  opts: {
    bank?: string;
    dateFormat?: DateFormat;
    password?: string;
    /**
     * Read the document with OCR.
     *
     * Opt-in, never a fallback, and never reached when a text layer already
     * exists. Two different reasons converge on the same requirement:
     *
     *   - **Every figure is a reading of pixels**, not a value the bank
     *     published. Measured on samples, PaddleOCR misread no digits but did
     *     misread a Dr/Cr direction marker; a mangled marker is the P-14
     *     sign-inversion class. Nothing here is safe to post unverified.
     *   - **It is slow** — roughly a minute per page on CPU.
     *
     * With the default local provider there is no third-party transfer, so the
     * data-protection objection does not apply; choosing `llamaparse` instead
     * reintroduces it deliberately.
     */
    ocr?: boolean;
    /**
     * `paddleocr` (default) runs locally and nothing leaves the machine.
     * `llamaparse` uploads the document to a hosted service — a DPDP Act
     * decision for the firm as data fiduciary, so it is never a fallback and
     * never inferred.
     */
    ocrProvider?: 'paddleocr' | 'llamaparse';
    ocrApiKey?: string;
  } = {},
): Promise<ParsedStatementFile & {
  format: 'xlsx' | 'xlsx_encrypted' | 'pdf' | 'delimited' | 'ocr';
}> {
  if (looksLikeEncryptedOffice(buffer)) {
    if (!opts.password) {
      // BR-4: password-protected statements are the norm, not an edge case.
      // Prompt for it; never store it.
      throw new ValidationError(
        'this spreadsheet is password-protected — supply the password to open ' +
        'it. Indian banks encrypt emailed statements by default, usually with ' +
        'a PAN-and-date-of-birth pattern.', 'BR-4');
    }
    const plain = await decryptOfficeFile(buffer, opts.password);
    const parsed = parseStatementTable(readXlsxSheet(plain), opts);
    return { ...parsed, format: 'xlsx_encrypted' };
  }

  if (looksLikeZip(buffer)) {
    const parsed = parseStatementTable(readXlsxSheet(buffer), opts);
    return { ...parsed, format: 'xlsx' };
  }

  if (isPdf(buffer)) {
    // Imported lazily: the PDF route shells out to an external binary, and the
    // CSV and spreadsheet paths must not depend on it being present.
    const { parsePdfStatement } = await import('./pdf.ts');
    try {
      const parsed = parsePdfStatement(buffer, opts);
      return { ...parsed, format: 'pdf' };
    } catch (e) {
      // A scan has no text layer. OCR is offered only if the caller already
      // asked for it — the alternative, quietly uploading the document on
      // failure, would make a third-party transfer the consequence of a bad
      // scan rather than of anyone's decision.
      const scanned = e instanceof Error && /contains no text/.test(e.message);
      if (!scanned || !opts.ocr) throw e;
      return { ...(await parseViaOcr(buffer, opts)), format: 'ocr' };
    }
  }

  if (isImage(buffer)) {
    if (!opts.ocr) {
      throw new ValidationError(
        'this is an image, so reading it needs OCR, which must be enabled ' +
        'deliberately per import. Every figure it produces is a reading of ' +
        'pixels rather than a value the bank published, and it takes about a ' +
        "minute per page. Prefer the bank's spreadsheet or PDF export where " +
        'one exists.', 'BR-3');
    }
    return { ...(await parseViaOcr(buffer, opts)), format: 'ocr' };
  }

  return { ...parseStatementFile(buffer.toString('utf8'), opts), format: 'delimited' };
}

/** The warning every OCR'd statement carries, whichever engine read it. */
const OCR_PREAMBLE =
  'This statement was read by OCR from an image, so every figure in it is a ' +
  'machine reading of pixels rather than a value the bank published. Check the ' +
  'row-level balance report before accepting anything: where a figure is ' +
  'wrong, the arithmetic names the row.';

/**
 * Parse a scanned document through OCR.
 *
 * The two providers differ in more than accuracy, so they take different routes
 * through the parser rather than being hidden behind one interface:
 *
 * **PaddleOCR (default, local)** reports positioned text boxes. Those are
 * rendered onto a character canvas and handed to `parseLayoutText` — the same
 * function the PDF path uses, because `pdftotext -layout` output and a rendered
 * OCR canvas are the same problem in the same units. That reuse is deliberate:
 * a throwaway probe that did its own row and column clustering produced four
 * apparent OCR failures that were all its own, and the shared code already
 * handles every one of them.
 *
 * **LlamaParse (opt-in, hosted)** returns markdown tables, which are already
 * delimited, so the fixed-width apparatus is bypassed entirely.
 *
 * What OCR changes is not the layout problem but the *digit* problem — hence the
 * blunt warning on the way out.
 */
async function parseViaOcr(
  buffer: Buffer,
  opts: {
    bank?: string;
    dateFormat?: DateFormat;
    ocrProvider?: 'paddleocr' | 'llamaparse';
    ocrApiKey?: string;
    password?: string;
  },
): Promise<ParsedStatementFile> {
  // Both imported lazily: one shells out to Python, the other reaches the
  // network, and neither may be a load-bearing dependency of the CSV path.
  if ((opts.ocrProvider ?? 'paddleocr') === 'paddleocr') {
    const { paddleOcrDocument } = await import('./paddle.ts');
    const { parseLayoutText } = await import('./layout.ts');
    const { summariseRepairs } = await import('./ocrGlyphs.ts');

    const ocr = paddleOcrDocument(buffer, {
      password: opts.password,
      fileName: 'statement',
    });

    const parsed = parseLayoutText(ocr.canvas.text, { ...opts, source: 'ocr' });

    return {
      ...parsed,
      warnings: [
        OCR_PREAMBLE,
        `Read locally by ${ocr.version} — nothing was sent to a third party. ` +
        `${ocr.pageCount} page(s), ${(ocr.elapsedMs / 1000).toFixed(0)}s, mean ` +
        `confidence ${(ocr.meanConfidence * 100).toFixed(1)}%.`,
        ...summariseRepairs(ocr.canvas.repairs),
        ...ocr.warnings,
        ...parsed.warnings,
      ],
    };
  }

  const { ocrDocument } = await import('./ocr.ts');
  const ocr = await ocrDocument(buffer, { apiKey: opts.ocrApiKey });
  const parsed = parseStatementTable(ocr.grid, opts);

  return {
    ...parsed,
    warnings: [
      OCR_PREAMBLE,
      `⚠️ This document was UPLOADED to ${ocr.provider}, a third-party service ` +
      'outside India, which is a DPDP Act decision for the firm as data ' +
      'fiduciary. The local reader would not have sent it anywhere. ' +
      `${ocr.elapsedMs}ms.`,
      ...parsed.warnings,
    ],
  };
}
