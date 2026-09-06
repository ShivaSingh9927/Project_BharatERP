/**
 * Working out what each column IS, without a header row.
 * Spec: bank-and-reconciliation.md §5.2
 *
 * Necessary because a real SBI PDF loses its header entirely in extraction —
 * only the word `Balance` survives. With nothing to match template aliases
 * against, the columns have to be identified from their contents.
 *
 * The money columns are found by ARITHMETIC, not by formatting. For each
 * candidate trio of (balance, debit, credit) columns, every row is asked a
 * single question:
 *
 *     does balance[i] − balance[i−1] equal credit[i] − debit[i] ?
 *
 * The trio that satisfies that on the most rows is the answer. This is BR-6
 * applied row by row, and it is strictly better than judging columns by how
 * they look:
 *
 *   - It works on a statement whose amounts carry no decimals. Federal Bank
 *     writes `456072`, not `4,56,072.00`, and a formatting test that required
 *     paise found NO money columns at all on it — the parse produced no
 *     balance, no debit and no credit.
 *   - It excludes numeric columns that are not money without needing a rule
 *     for each one. A serial number, a branch code and a sixteen-digit UPI
 *     reference are all perfectly good numbers, and none of them reproduces
 *     the movement of a balance.
 *   - It decides debit versus credit as a side effect, including on a layout
 *     with the columns in credit-then-debit order.
 *   - It reports how many rows agreed and how many disagreed, so a weak
 *     inference is visible rather than silent.
 */

import { parseDate, parseAmount, looksNumeric } from './values.ts';
import type { ColumnMap } from './statementFile.ts';

/** Permissive: the separator varies, and only day-first order matters here. */
const isDateish = (v: string): boolean => parseDate(v, 'dd/MM/yyyy') !== null;

const isBlankCell = (cell: string | undefined): boolean =>
  cell === undefined || cell === '' || cell === '-' || cell === '–';

interface ColumnStats {
  index: number;
  dateFraction: number;
  numericFraction: number;
  blankFraction: number;
  meanLength: number;
  maxLength: number;
}

function statsFor(rows: string[][], index: number): ColumnStats {
  let dates = 0, numbers = 0, blanks = 0, total = 0, length = 0, maxLength = 0;

  for (const row of rows) {
    const cell = row[index] ?? '';
    total++;
    if (isBlankCell(cell)) { blanks++; continue; }
    if (isDateish(cell)) dates++;
    else if (looksNumeric(cell)) numbers++;
    length += cell.length;
    maxLength = Math.max(maxLength, cell.length);
  }

  const nonBlank = Math.max(1, total - blanks);
  return {
    index,
    dateFraction: dates / nonBlank,
    numericFraction: numbers / nonBlank,
    blankFraction: blanks / Math.max(1, total),
    meanLength: length / nonBlank,
    maxLength,
  };
}

/** Cell → signed paise, or null when it is blank or not a number. */
function paiseOf(cell: string | undefined): bigint | null {
  if (isBlankCell(cell)) return null;
  try {
    const a = parseAmount(cell!);
    if (a.blank) return null;
    const [whole, frac = '00'] = a.value.split('.');
    const p = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2));
    return a.negative ? -p : p;
  } catch {
    return null;
  }
}

export interface MoneyColumns {
  balance: number | null;
  debit: number | null;
  credit: number | null;
  /** Set instead of debit/credit when one signed column carries both. */
  amount: number | null;
  agreed: number;
  disagreed: number;
  method: 'balance_arithmetic' | 'none';
}

/**
 * Score one candidate trio against the rows.
 *
 * A row is only evidence when the balance is readable on it and on the
 * previous readable row; a statement's opening-balance row, which carries a
 * balance and no amounts, therefore contributes nothing and costs nothing.
 */
function scoreTrio(
  rows: string[][], balance: number, debit: number | null, credit: number | null,
): { agreed: number; disagreed: number } {
  let agreed = 0, disagreed = 0;
  let previous: bigint | null = null;

  for (const row of rows) {
    const current = paiseOf(row[balance]);
    if (current === null) continue;

    if (previous !== null) {
      const d = debit === null ? null : paiseOf(row[debit]);
      const c = credit === null ? null : paiseOf(row[credit]);

      // A row with no amount at all is not evidence either way — it is a
      // carried-forward line or a note, not a contradiction.
      if (d !== null || c !== null) {
        const expected = (c ?? 0n) - (d ?? 0n);
        if (current - previous === expected) agreed++;
        else disagreed++;
      }
    }
    previous = current;
  }

  return { agreed, disagreed };
}

/** Same, for a single signed amount column. */
function scoreSigned(
  rows: string[][], balance: number, amount: number,
): { agreed: number; disagreed: number } {
  let agreed = 0, disagreed = 0;
  let previous: bigint | null = null;

  for (const row of rows) {
    const current = paiseOf(row[balance]);
    if (current === null) continue;
    if (previous !== null) {
      const v = paiseOf(row[amount]);
      if (v !== null) {
        const delta = current - previous;
        // Either sign convention is accepted; what matters is the magnitude
        // reproducing the movement.
        if (delta === v || delta === -v) agreed++;
        else disagreed++;
      }
    }
    previous = current;
  }

  return { agreed, disagreed };
}

/**
 * Find the balance, debit and credit columns by reproducing the balance.
 *
 * Every ordered pair is tried, so a credit-then-debit layout is found without
 * a special case.
 */
export function findMoneyColumns(rows: string[][], candidates: number[]): MoneyColumns {
  let best: MoneyColumns = {
    balance: null, debit: null, credit: null, amount: null,
    agreed: 0, disagreed: 0, method: 'none',
  };

  const better = (agreed: number, disagreed: number): boolean =>
    agreed - disagreed > best.agreed - best.disagreed;

  for (const balance of candidates) {
    const others = candidates.filter((c) => c !== balance);

    for (const debit of others) {
      for (const credit of others) {
        if (debit === credit) continue;
        const { agreed, disagreed } = scoreTrio(rows, balance, debit, credit);
        if (agreed >= 2 && better(agreed, disagreed)) {
          best = { balance, debit, credit, amount: null, agreed, disagreed,
                   method: 'balance_arithmetic' };
        }
      }
    }

    // A single signed column, checked only if no pair did better — a pair that
    // reproduces the balance is always the stronger reading.
    for (const amount of others) {
      const { agreed, disagreed } = scoreSigned(rows, balance, amount);
      if (agreed >= 2 && better(agreed, disagreed)) {
        best = { balance, debit: null, credit: null, amount, agreed, disagreed,
                 method: 'balance_arithmetic' };
      }
    }
  }

  return best;
}

export interface InferredColumns {
  columns: ColumnMap;
  directionEvidence: {
    method: 'balance_arithmetic' | 'position' | 'none';
    agreed: number;
    disagreed: number;
  };
  notes: string[];
}

/**
 * Infer every column's role from the data rows alone.
 *
 * `rows` should be the transaction rows only — a preamble or summary block
 * would skew every statistic.
 */
export function inferColumnRoles(rows: string[][]): InferredColumns {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const stats = Array.from({ length: width }, (_, i) => statsFor(rows, i));
  const notes: string[] = [];

  // --- dates -------------------------------------------------------------
  const dateCols = stats.filter((s) => s.dateFraction >= 0.8).map((s) => s.index);
  const txnDate = dateCols[0] ?? 0;
  const valueDate = dateCols[1] ?? null;
  if (dateCols.length === 0) {
    notes.push('no column parsed consistently as dates; assuming the first');
  }

  // --- money, by arithmetic ---------------------------------------------
  const numericCols = stats
    .filter((s) => s.numericFraction >= 0.7 && !dateCols.includes(s.index))
    .map((s) => s.index);

  const money = findMoneyColumns(rows, numericCols);

  let { balance, debit, credit, amount } = money;

  if (money.method === 'balance_arithmetic') {
    notes.push(
      `money columns identified by reproducing the running balance: ` +
      `${money.agreed} row(s) agreed, ${money.disagreed} disagreed`);
    if (money.disagreed > 0) {
      notes.push(
        `${money.disagreed} row(s) do not reconcile against the balance column — ` +
        'the statement-level check will report the total effect');
    }
  } else {
    // Nothing reproduced a balance. Fall back to shape, and say so clearly:
    // without the arithmetic there is no confirmation that these are the money
    // columns at all.
    const shaped = stats.filter(
      (s) => s.numericFraction >= 0.7
        && !dateCols.includes(s.index)
        && s.maxLength <= 18);
    balance = [...shaped].reverse().find((s) => s.blankFraction <= 0.2)?.index ?? null;
    const movement = shaped
      .filter((s) => s.index !== balance && s.blankFraction > 0.2)
      .map((s) => s.index);
    debit = movement[0] ?? null;
    credit = movement[1] ?? null;
    amount = movement.length === 1 ? movement[0]! : null;
    if (movement.length === 1) { debit = null; credit = null; }
    notes.push(
      'no column reproduced the running balance, so the money columns were ' +
      'guessed from their shape. This parse is unverified — check the balance ' +
      'figures line by line.');
  }

  // --- narration ---------------------------------------------------------
  const usedByMoney = new Set([balance, debit, credit, amount]
    .filter((v): v is number => v !== null));

  const textCols = stats.filter(
    (s) => !dateCols.includes(s.index)
      && !usedByMoney.has(s.index)
      && s.numericFraction < 0.5);

  const narration = textCols.length > 0
    ? textCols.reduce((best, s) => (s.maxLength > best.maxLength ? s : best)).index
    : Math.min(txnDate + 1, Math.max(0, width - 1));

  // --- reference ---------------------------------------------------------
  // Whatever is left and carries content. A serial number or branch code can
  // land here, which is harmless: the reference is advisory, and the narration
  // parser extracts the UTR it actually matches on.
  const used = new Set([...usedByMoney, ...dateCols, narration]);
  const reference = stats.find((s) => !used.has(s.index) && s.maxLength > 0)?.index ?? null;

  return {
    columns: {
      txnDate, valueDate, narration, reference,
      debit, credit, amount,
      drCrFlag: null,
      balance,
    },
    directionEvidence: {
      method: money.method === 'balance_arithmetic' ? 'balance_arithmetic' : 'position',
      agreed: money.agreed,
      disagreed: money.disagreed,
    },
    notes,
  };
}

/** Is this row the start of a transaction — i.e. does it carry a date? */
export function makeRowStartTest(txnDateColumn: number): (cells: string[]) => boolean {
  return (cells) => isDateish(cells[txnDateColumn] ?? '');
}
