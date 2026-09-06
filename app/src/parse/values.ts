/**
 * Coercing bank-statement cell text into dates and amounts.
 * Spec: bank-and-reconciliation.md §5.2
 *
 * This is where silent corruption enters if you are careless, because almost
 * every wrong answer here still *looks* like a valid number or date. Two
 * specific hazards drove the design:
 *
 *   - `01/02/2026` is 1 February in India and 2 January in the US. Guessing
 *     wrong shifts a transaction into the wrong month, so the date format is
 *     always declared by the bank template and never inferred from one value.
 *   - Indian statements write amounts in ways `Number()` mangles: `1,23,456.78`
 *     (lakh grouping), `(500.00)` for negatives, `500.00 Cr`, `-`, or blank.
 *     `Number('1,23,456.78')` is NaN, and `NaN` flowing into a balance check
 *     produces a confusing failure a long way from its cause.
 */

import { ValidationError } from '../domain/types.ts';

export type DateFormat =
  | 'dd/MM/yyyy' | 'dd/MM/yy' | 'dd-MM-yyyy' | 'dd-MM-yy'
  | 'yyyy-MM-dd' | 'dd-MMM-yyyy' | 'dd MMM yyyy' | 'MM/dd/yyyy';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * A two-digit year in a bank statement is always recent — statements are not
 * historical documents. 70+ maps to 19xx only to avoid a nonsensical future
 * date; in practice everything lands in 20xx.
 */
function expandYear(y: number): number {
  if (y > 99) return y;
  return y >= 70 ? 1900 + y : 2000 + y;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Parse a cell into an ISO date, using the format the bank template declares.
 *
 * Returns null for a blank cell — callers decide whether that is fatal. It
 * usually means a continuation or subtotal row rather than a broken date.
 */
export function parseDate(raw: string, format: DateFormat): string | null {
  const s = raw.trim();
  if (s.length === 0 || s === '-') return null;

  // Strip any time component; statements often carry one and never need it.
  const datePart = s.split(/[ T](?=\d{1,2}:)/)[0]!.trim();

  const nums = datePart.match(/^(\d{1,4})[\/\-. ](\d{1,2}|[A-Za-z]{3,4})[\/\-. ](\d{1,4})$/);
  if (!nums) return null;

  const [, a, b, c] = nums;
  let day: number, month: number, year: number;

  if (/^[A-Za-z]/.test(b!)) {
    const m = MONTHS[b!.toLowerCase()];
    if (m === undefined) return null;
    day = Number(a); month = m; year = expandYear(Number(c));
  } else if (format === 'yyyy-MM-dd') {
    year = Number(a); month = Number(b); day = Number(c);
  } else if (format === 'MM/dd/yyyy') {
    month = Number(a); day = Number(b); year = expandYear(Number(c));
  } else {
    // Every remaining Indian format is day-first.
    day = Number(a); month = Number(b); year = expandYear(Number(c));
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Reject a date that does not exist rather than letting Date roll it over —
  // 31/02 silently becoming 3 March is exactly the kind of quiet corruption
  // BR-6 would then blame on the wrong row.
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;

  return `${year}-${pad(month)}-${pad(day)}`;
}

export interface ParsedAmount {
  /** Decimal string, always positive. Direction is the caller's business. */
  value: string;
  /** True when the cell itself indicated a negative or a credit suffix. */
  negative: boolean;
  blank: boolean;
}

/**
 * Parse an Indian statement amount.
 *
 * Handles lakh/crore digit grouping (`1,23,456.78`), accounting negatives
 * (`(500.00)`), a leading or trailing sign, `Dr`/`Cr` suffixes, a rupee
 * symbol, and the several ways a bank writes "nothing here" — empty, `-`,
 * `0.00`, `NIL`.
 */
export function parseAmount(raw: string): ParsedAmount {
  const s = raw.trim();

  if (s.length === 0 || s === '-' || s === '–' || /^nil$/i.test(s)) {
    return { value: '0.00', negative: false, blank: true };
  }

  let negative = false;
  let body = s;

  // Accounting parentheses.
  const paren = /^\((.*)\)$/.exec(body);
  if (paren) { negative = true; body = paren[1]!; }

  // A Dr/Cr suffix is a direction marker, not part of the number. Which one
  // means "negative" depends on the column, so only Cr is flagged here and the
  // template decides what to do with it.
  const suffix = /\s*(dr|cr)\.?$/i.exec(body);
  if (suffix) {
    if (suffix[1]!.toLowerCase() === 'cr') negative = true;
    body = body.slice(0, suffix.index);
  }

  body = body.replace(/[₹$\s]/g, '').replace(/,/g, '');

  if (body.startsWith('-')) { negative = !negative; body = body.slice(1); }
  else if (body.startsWith('+')) body = body.slice(1);

  if (body.length === 0) return { value: '0.00', negative: false, blank: true };

  if (!/^\d+(\.\d+)?$/.test(body)) {
    throw new ValidationError(`"${raw}" is not a recognisable amount`, 'BR-6');
  }

  // Two decimal places, half-up, without going through a float.
  const [whole, frac = ''] = body.split('.');
  const f3 = frac.padEnd(3, '0').slice(0, 3);
  const cents = (BigInt(whole!) * 1000n + BigInt(f3) + 5n) / 10n;
  const value = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;

  return { value, negative, blank: false };
}

/** True when the text looks like a number rather than a label. */
export function looksNumeric(raw: string): boolean {
  try {
    const p = parseAmount(raw);
    return !p.blank;
  } catch {
    return false;
  }
}
