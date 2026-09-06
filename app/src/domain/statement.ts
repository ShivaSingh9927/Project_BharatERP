/**
 * Bank statement ingestion.
 * Spec: bank-and-reconciliation.md §5
 *
 * The whole module exists to guarantee one thing before a single line reaches
 * the matcher: that what we parsed is what the bank actually said.
 */

import { createHash } from 'node:crypto';
import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';
import { paise, money } from './tax.ts';
import { parseNarration } from './narration.ts';
import { parseStatementFile, type ParsedStatementFile } from '../parse/statementFile.ts';

export const PARSER_VERSION = 'statement-parser/1.0.0';

export interface StatementRow {
  txnDate: string;
  valueDate?: string;
  narration: string;
  debit?: string;
  credit?: string;
  runningBalance?: string;
}

export interface ArithmeticCheck {
  ok: boolean;
  openingBalance: string;
  totalDebits: string;
  totalCredits: string;
  computedClosing: string;
  declaredClosing: string;
  difference: string;
  /** 1-based index of the first row whose running balance disagrees. */
  firstBadRow: number | null;
  detail: string;
}

/**
 * BR-6 — the single most valuable validation in this module.
 *
 *   opening_balance + Σ credits − Σ debits == closing_balance
 *
 * If that fails, the PARSE is wrong: a row was dropped, a page was missed, a
 * digit was misread. Reject the import rather than reconciling against
 * corrupted data.
 *
 * This is the bank-statement analogue of the Trial Balance (Lesson 2): a cheap
 * deterministic checksum over the WHOLE document. It is strictly more reliable
 * than any OCR confidence score, because confidence is a model's opinion about
 * one field while this is arithmetic about all of them.
 *
 * Where a running-balance column exists, it is walked line by line — which
 * turns "the statement doesn't add up" into "row 47 is wrong", the difference
 * between a useless error and an actionable one.
 */
export function verifyStatementArithmetic(
  openingBalance: string, closingBalance: string, rows: StatementRow[],
): ArithmeticCheck {
  const opening = paise(openingBalance);
  const declared = paise(closingBalance);

  let debits = 0n;
  let credits = 0n;
  let running = opening;
  let firstBadRow: number | null = null;

  for (const [i, r] of rows.entries()) {
    const d = paise(r.debit ?? '0');
    const c = paise(r.credit ?? '0');
    debits += d;
    credits += c;
    running = running + c - d;

    if (firstBadRow === null && r.runningBalance !== undefined) {
      if (paise(r.runningBalance) !== running) firstBadRow = i + 1;
    }
  }

  const computed = opening + credits - debits;
  const difference = declared - computed;
  const ok = difference === 0n;

  return {
    ok,
    openingBalance: money(opening),
    totalDebits: money(debits),
    totalCredits: money(credits),
    computedClosing: money(computed),
    declaredClosing: money(declared),
    difference: money(difference),
    firstBadRow,
    detail: ok
      ? `${money(opening)} + ${money(credits)} − ${money(debits)} = ${money(computed)}, ` +
        'which matches the declared closing balance'
      : `${money(opening)} + ${money(credits)} − ${money(debits)} = ${money(computed)}, ` +
        `but the statement declares ${money(declared)} — a difference of ${money(difference)}` +
        (firstBadRow !== null
          ? `. The running balance first disagrees at row ${firstBadRow}, so start there.`
          : '. No running-balance column, so the failing row cannot be pinpointed.'),
  };
}

/**
 * BR-7 — content hash for deduplication.
 *
 * Hashes the line, not the file. A user importing January and then
 * January–February is normal behaviour, not an error, and the second import
 * must add only February.
 */
export function transactionHash(bankAccountId: string, r: StatementRow): string {
  const parts = [
    bankAccountId, r.txnDate, r.debit ?? '0', r.credit ?? '0',
    r.narration.replace(/\s+/g, ' ').trim(), r.runningBalance ?? '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export interface ImportResult {
  statementId: string;
  imported: number;
  duplicates: number;
  arithmetic: ArithmeticCheck;
  warnings: string[];
}

/**
 * Import a parsed statement.
 *
 * Order matters: arithmetic first, then gaps, then rows. Nothing is written
 * until the document has proved it adds up.
 */
export async function importStatement(
  firmId: string,
  input: {
    clientId: string;
    bankAccountId: string;
    periodFrom: string;
    periodTo: string;
    openingBalance: string;
    closingBalance: string;
    rows: StatementRow[];
    uploadedBy: string;
    sourceDocumentId?: string;
    parserVersion?: string;
  },
): Promise<ImportResult> {
  const arithmetic = verifyStatementArithmetic(
    input.openingBalance, input.closingBalance, input.rows);

  if (!arithmetic.ok) {
    throw new ValidationError(
      `statement does not reconcile against itself — ${arithmetic.detail}`, 'BR-6');
  }

  const warnings: string[] = [];

  return withFirm(firmId, async (c) => {
    const acct = await c.query<{ id: string }>(
      'SELECT id FROM bank_accounts WHERE id = $1 AND client_id = $2',
      [input.bankAccountId, input.clientId]);
    if (acct.rowCount === 0) {
      throw new ValidationError('bank account not found for this client', 'BR-2');
    }

    // BR-8 — a gap makes every subsequent reconciliation wrong, and it is
    // silent: nothing looks broken, the numbers simply stop being true.
    const prev = await c.query<{ period_to: string; closing_balance: string }>(
      `SELECT period_to::text, closing_balance::text FROM bank_statements
       WHERE bank_account_id = $1 AND period_to < $2
       ORDER BY period_to DESC LIMIT 1`,
      [input.bankAccountId, input.periodFrom]);

    if (prev.rowCount! > 0) {
      const lastEnd = new Date(prev.rows[0]!.period_to);
      const thisStart = new Date(input.periodFrom);
      const gapDays = Math.round((+thisStart - +lastEnd) / 86_400_000) - 1;
      if (gapDays > 0) {
        warnings.push(
          `BR-8: ${gapDays} day(s) missing — the previous statement ended ` +
          `${prev.rows[0]!.period_to} and this one starts ${input.periodFrom}`);
      }
      // A continuous period should also carry a continuous balance.
      if (gapDays === 0 && paise(prev.rows[0]!.closing_balance) !== paise(input.openingBalance)) {
        warnings.push(
          `BR-8: opening balance ${input.openingBalance} does not continue the previous ` +
          `statement's closing balance ${prev.rows[0]!.closing_balance}`);
      }
    }

    const parserVersion = input.parserVersion ?? PARSER_VERSION;

    const st = await c.query<{ id: string }>(
      `INSERT INTO bank_statements
         (firm_id, client_id, bank_account_id, source_document_id, period_from,
          period_to, opening_balance, closing_balance, row_count, parse_status,
          parser_version, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'parsed',$10,$11) RETURNING id`,
      [
        firmId, input.clientId, input.bankAccountId, input.sourceDocumentId ?? null,
        input.periodFrom, input.periodTo, input.openingBalance, input.closingBalance,
        input.rows.length, parserVersion, input.uploadedBy,
      ]);
    const statementId = st.rows[0]!.id;

    let imported = 0;
    let duplicates = 0;

    for (const [i, r] of input.rows.entries()) {
      const hash = transactionHash(input.bankAccountId, r);
      const parsed = parseNarration(r.narration);

      const ins = await c.query(
        `INSERT INTO bank_transactions
           (firm_id, client_id, bank_account_id, statement_id, txn_date, value_date,
            row_no, narration, debit, credit, running_balance, reference_number,
            payment_mode, counterparty_name, parser_version, content_hash, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'statement')
         ON CONFLICT (bank_account_id, content_hash) DO NOTHING`,
        [
          firmId, input.clientId, input.bankAccountId, statementId,
          r.txnDate, r.valueDate ?? null, i + 1, r.narration,
          r.debit ?? '0', r.credit ?? '0', r.runningBalance ?? null,
          parsed.reference, parsed.mode, parsed.counterparty, parserVersion, hash,
        ]);

      if (ins.rowCount === 0) duplicates++;
      else imported++;
    }

    // Reported, never silent. A user who re-uploads the same file should be
    // told the overlap was recognised, not left wondering whether it worked.
    if (duplicates > 0) {
      warnings.push(
        `BR-7: ${duplicates} of ${input.rows.length} rows already existed and were skipped`);
    }

    const unparsed = input.rows.filter((r) => !parseNarration(r.narration).matchedByRule).length;
    if (unparsed > 0) {
      warnings.push(
        `BR-9: ${unparsed} narration(s) matched no rule and need classification`);
    }

    return { statementId, imported, duplicates, arithmetic, warnings };
  });
}

/**
 * Import an uploaded statement file end to end: parse, then verify, then write.
 *
 * The parse is returned even when the import throws, because a rejected file is
 * exactly when the user most needs to see what we read — which bank layout was
 * assumed, which rows were skipped, and where the balance went wrong. Throwing
 * without that leaves them with a refusal and no way to act on it.
 */
export async function importStatementFile(
  firmId: string,
  input: {
    clientId: string;
    bankAccountId: string;
    fileText: string;
    uploadedBy: string;
    /** Overrides auto-detection (BR-5). */
    bank?: string;
    /** Overrides the stated balances, e.g. from a password-protected cover page. */
    openingBalance?: string;
    closingBalance?: string;
    sourceDocumentId?: string;
  },
): Promise<{ parse: ParsedStatementFile; result: ImportResult | null; error: string | null }> {
  const parse = parseStatementFile(input.fileText, { bank: input.bank });

  const opening = input.openingBalance ?? parse.openingBalance;
  const closing = input.closingBalance ?? parse.closingBalance;

  if (opening === null || closing === null) {
    return {
      parse, result: null,
      error:
        'BR-6 cannot be checked: this file states no opening or closing balance ' +
        'and has no running-balance column. Supply both figures from the ' +
        'statement to import it.',
    };
  }

  try {
    const result = await importStatement(firmId, {
      clientId: input.clientId,
      bankAccountId: input.bankAccountId,
      periodFrom: parse.periodFrom!,
      periodTo: parse.periodTo!,
      openingBalance: opening,
      closingBalance: closing,
      rows: parse.rows,
      uploadedBy: input.uploadedBy,
      sourceDocumentId: input.sourceDocumentId,
      parserVersion: `${PARSER_VERSION} (${parse.bank})`,
    });
    return { parse, result, error: null };
  } catch (e) {
    return { parse, result: null, error: e instanceof Error ? e.message : String(e) };
  }
}
