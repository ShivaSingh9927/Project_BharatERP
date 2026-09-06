/**
 * Working out what each column IS, without a header row.
 * Spec: bank-and-reconciliation.md §5.2
 *
 * Necessary because a real SBI PDF loses its header entirely in extraction —
 * only the word `Balance` survives. With nothing to match template aliases
 * against, the columns have to be identified from their contents.
 *
 * The interesting part is telling debit from credit. Both are amount columns,
 * mostly blank, sitting side by side; nothing about the values says which is
 * which. But the **running balance** does: if the balance fell, the amount was
 * a withdrawal. So the assignment is derived from arithmetic the statement
 * itself provides, and the same evidence that decides it also verifies it —
 * a disagreement rate is reported rather than a guess.
 *
 * That is the whole design principle of this module: infer from evidence the
 * document carries, then report how strongly the evidence agreed.
 */

import { parseDate, parseAmount, looksNumeric } from './values.ts';
import type { ColumnMap } from './statementFile.ts';

/** Permissive: the separator varies, and only day-first order matters here. */
const isDateish = (v: string): boolean => parseDate(v, 'dd/MM/yyyy') !== null;

interface ColumnStats {
  index: number;
  dateFraction: number;
  amountFraction: number;
  /**
   * Fraction of values ending in a two-decimal fraction.
   *
   * This is what separates money from a reference number. A 16-digit UPI
   * reference like `0000624531110990` parses as a perfectly good number, so
   * counting "numeric" columns as amounts made the reference column a
   * candidate for the debit column. Indian statements write money with paise;
   * references have no decimal point.
   */
  decimalFraction: number;
  blankFraction: number;
  meanLength: number;
  maxLength: number;
}

function statsFor(rows: string[][], index: number): ColumnStats {
  let dates = 0, amounts = 0, decimals = 0;
  let blanks = 0, total = 0, length = 0, maxLength = 0;

  for (const row of rows) {
    const cell = row[index] ?? '';
    total++;
    if (cell === '' || cell === '-') { blanks++; continue; }
    if (isDateish(cell)) dates++;
    else if (looksNumeric(cell)) {
      amounts++;
      if (/\d\.\d{2}$/.test(cell)) decimals++;
    }
    length += cell.length;
    maxLength = Math.max(maxLength, cell.length);
  }

  const nonBlank = Math.max(1, total - blanks);
  return {
    index,
    dateFraction: dates / nonBlank,
    amountFraction: amounts / nonBlank,
    decimalFraction: decimals / nonBlank,
    blankFraction: blanks / Math.max(1, total),
    meanLength: length / nonBlank,
    maxLength,
  };
}

export interface InferredColumns {
  columns: ColumnMap;
  /** How the debit/credit assignment was decided, and how well it held. */
  directionEvidence: {
    method: 'running_balance' | 'position';
    agreed: number;
    disagreed: number;
    swapped: boolean;
  };
  notes: string[];
}

/**
 * Decide which of two candidate amount columns is the debit column.
 *
 * Walks consecutive rows that carry a balance and exactly one amount, and asks
 * whether the balance moved the way that amount implies. The column whose
 * entries coincide with FALLING balances is the debit column.
 *
 * Ties and thin evidence fall back to position — withdrawal before deposit,
 * which is the order every Indian layout seen so far uses — and say so, because
 * an unverified assumption should be visible.
 */
function decideDirection(
  rows: string[][], a: number, b: number, balance: number | null,
): { debit: number; credit: number; agreed: number; disagreed: number;
     method: 'running_balance' | 'position'; swapped: boolean } {
  if (balance === null) {
    return { debit: a, credit: b, agreed: 0, disagreed: 0,
             method: 'position', swapped: false };
  }

  let aFalls = 0, aRises = 0, bFalls = 0, bRises = 0;
  let previous: bigint | null = null;

  for (const row of rows) {
    const balCell = row[balance] ?? '';
    if (!looksNumeric(balCell)) { continue; }
    const current = amountOf(balCell);
    if (current === null) continue;

    if (previous !== null) {
      const fell = current < previous;
      const rose = current > previous;
      const inA = hasAmount(row[a]);
      const inB = hasAmount(row[b]);

      // Only rows with exactly one amount are evidence; a row with both tells
      // us nothing about which column means what.
      if (inA !== inB) {
        if (inA) { if (fell) aFalls++; else if (rose) aRises++; }
        else { if (fell) bFalls++; else if (rose) bRises++; }
      }
    }
    previous = current;
  }

  // 'a is debit' is supported when a coincides with falls and b with rises.
  const forA = aFalls + bRises;
  const forB = aRises + bFalls;

  if (forA === 0 && forB === 0) {
    return { debit: a, credit: b, agreed: 0, disagreed: 0,
             method: 'position', swapped: false };
  }

  const swapped = forB > forA;
  return {
    debit: swapped ? b : a,
    credit: swapped ? a : b,
    agreed: Math.max(forA, forB),
    disagreed: Math.min(forA, forB),
    method: 'running_balance',
    swapped,
  };
}

const hasAmount = (cell: string | undefined): boolean =>
  cell !== undefined && cell !== '' && cell !== '-' && looksNumeric(cell);

function amountOf(cell: string): bigint | null {
  try {
    const a = parseAmount(cell);
    if (a.blank) return null;
    const [whole, frac = '00'] = a.value.split('.');
    const p = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2));
    return a.negative ? -p : p;
  } catch {
    return null;
  }
}

/**
 * Infer every column's role from the data rows alone.
 *
 * `rows` should be the transaction rows only — preamble and summary blocks
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

  // --- balance -----------------------------------------------------------
  // Rightmost amount column that is almost always populated. A debit or credit
  // column is blank about half the time; a running balance never is.
  // A money column must look like money: mostly numeric AND written with
  // paise. Without the decimal test a 16-digit reference number qualifies as
  // an amount, and on a real HDFC statement it became a candidate for the
  // debit column.
  const amountCols = stats.filter(
    (s) => s.amountFraction >= 0.7
      && s.decimalFraction >= 0.6
      && !dateCols.includes(s.index));

  const balance = [...amountCols]
    .reverse()
    .find((s) => s.blankFraction <= 0.2)?.index ?? null;

  if (balance === null) notes.push('no running-balance column found');

  // --- narration ---------------------------------------------------------
  // The widest text column that is neither a date nor an amount.
  const textCols = stats.filter(
    (s) => !dateCols.includes(s.index)
      && s.index !== balance
      && s.amountFraction < 0.5);

  const narration = textCols.length > 0
    ? textCols.reduce((best, s) => s.maxLength > best.maxLength ? s : best).index
    : Math.min(txnDate + 1, width - 1);

  // --- debit / credit ----------------------------------------------------
  const movementCols = amountCols
    .filter((s) => s.index !== balance && s.index !== narration)
    .map((s) => s.index)
    .sort((x, y) => x - y);

  let debit: number | null = null;
  let credit: number | null = null;
  let directionEvidence: InferredColumns['directionEvidence'] = {
    method: 'position', agreed: 0, disagreed: 0, swapped: false,
  };

  if (movementCols.length >= 2) {
    const [a, b] = [movementCols[0]!, movementCols[movementCols.length - 1]!];
    const decided = decideDirection(rows, a, b, balance);
    debit = decided.debit;
    credit = decided.credit;
    directionEvidence = {
      method: decided.method, agreed: decided.agreed,
      disagreed: decided.disagreed, swapped: decided.swapped,
    };

    if (decided.method === 'running_balance') {
      notes.push(
        `debit/credit decided from the running balance: ${decided.agreed} row(s) ` +
        `agreed, ${decided.disagreed} disagreed` +
        (decided.swapped ? ' (the columns are in credit-then-debit order)' : ''));
      if (decided.disagreed > 0) {
        notes.push(
          `${decided.disagreed} row(s) contradict the chosen debit/credit ` +
          'assignment — the balance check will catch it if this is wrong');
      }
    } else {
      notes.push(
        'the running balance gave no usable evidence, so debit/credit was ' +
        'assigned by position (withdrawal before deposit)');
    }
  } else if (movementCols.length === 1) {
    // A single signed amount column.
    debit = null;
    credit = null;
    notes.push('only one amount column found besides the balance');
  }

  // --- reference ---------------------------------------------------------
  const used = new Set([txnDate, valueDate, narration, debit, credit, balance]
    .filter((v): v is number => v !== null));
  const reference = stats.find((s) => !used.has(s.index) && s.maxLength > 0)?.index ?? null;

  return {
    columns: {
      txnDate, valueDate, narration, reference,
      debit, credit,
      amount: movementCols.length === 1 ? movementCols[0]! : null,
      drCrFlag: null,
      balance,
    },
    directionEvidence,
    notes,
  };
}

/** Is this row the start of a transaction — i.e. does it carry a date? */
export function makeRowStartTest(txnDateColumn: number): (cells: string[]) => boolean {
  return (cells) => isDateish(cells[txnDateColumn] ?? '');
}
