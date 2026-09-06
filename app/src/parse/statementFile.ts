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
import { TEMPLATES, candidateTemplates, templateByName, type BankTemplate } from './bankTemplates.ts';
import type { StatementRow } from '../domain/statement.ts';
import { ValidationError } from '../domain/types.ts';
import { paise, money } from '../domain/tax.ts';

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

  const limit = Math.min(rows.length, 30);
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

    if (template.amountConvention === 'separate_dr_cr') {
      const d = parseAmount(cell(columns.debit));
      const c = parseAmount(cell(columns.credit));
      debit = d.value; credit = c.value;
    } else if (template.amountConvention === 'single_signed') {
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
      `the header row was found at line ${headerRowIndex + 1} but no data rows ` +
      'parsed beneath it — the date format is probably wrong', 'BR-5');
  }

  const preamble = rows.slice(0, headerRowIndex);
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
    bank: template.bank,
    template,
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
