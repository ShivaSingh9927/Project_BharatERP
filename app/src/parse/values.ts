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
  /** True when the cell indicated a negative: parentheses, a minus, or `Dr`. */
  negative: boolean;
  /** The Dr/Cr marker as written, for callers that need the distinction. */
  suffix: 'dr' | 'cr' | null;
  blank: boolean;
  /**
   * The currency the figure was written in, when the cell said so: an ISO code
   * or a symbol. Null when the cell carried no currency mark at all.
   *
   * Recorded rather than assumed. A figure of 44.96 means nothing until it is
   * known whether that is rupees or euros, and this parser used to strip `$`
   * and `₹` alike and return a bare number — so a euro invoice and a rupee
   * invoice produced identical output.
   */
  currency: Currency | null;
}

/** The currencies this parser can name. Not a list of what GST accepts. */
export type Currency = 'INR' | 'USD' | 'EUR' | 'GBP';

/*
 * `$` is taken as USD, and that is an assumption rather than a reading — the
 * same symbol serves the Canadian, Australian and Singapore dollar. Callers
 * converting to rupees are told which figures were assumed rather than read
 * (see `currencyWasAssumed`), because an FX rate applied to the wrong dollar
 * is wrong by a fifth, not by a rounding.
 */
const SYMBOLS: ReadonlyArray<readonly [RegExp, Currency, boolean]> = [
  [/[₹]|\bRs\.?\b|\bINR\b/i, 'INR', false],
  [/\bUSD\b/i,                   'USD', false],
  [/\bEUR\b/i,                   'EUR', false],
  [/\bGBP\b/i,                   'GBP', false],
  [/€/,                           'EUR', false],
  [/£/,                           'GBP', false],
  [/\$/,                          'USD', true],
];

/** The currency named in a piece of text, if any. */
export function currencyOf(raw: string): Currency | null {
  for (const [re, code] of SYMBOLS) if (re.test(raw)) return code;
  return null;
}

/** True when the currency was inferred from an ambiguous symbol, not read. */
export function currencyWasAssumed(raw: string): boolean {
  for (const [re, , assumed] of SYMBOLS) if (re.test(raw)) return assumed;
  return false;
}

/**
 * The shape of a money cell, currency marks and all.
 *
 * Shared with the column reader, which used its own copy accepting only `₹`
 * and `$`. A euro figure therefore did not look like an amount, so no column
 * of a Hetzner invoice was recognised as carrying money and the table was
 * refused as having no header.
 */
export const AMOUNT_SHAPE =
  /^(?:[₹$€£]|Rs\.?|INR|USD|EUR|GBP)?\s*\(?-?[\d,]+(?:\.\d+)?\)?\s*(?:INR|USD|EUR|GBP)?%?$/i;

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
    return { value: '0.00', negative: false, suffix: null, blank: true,
             currency: null };
  }

  let negative = false;
  let body = s;

  // Accounting parentheses.
  const paren = /^\((.*)\)$/.exec(body);
  if (paren) { negative = true; body = paren[1]!; }

  /*
   * A Dr/Cr suffix, as on a real SBI balance: `2,41,933.51CR` — no space.
   *
   * This was backwards, and it was backwards in the direction that loses money.
   * On an Indian statement a **CR balance means the customer HAS the money** and
   * a DR balance means the account is overdrawn. The original code flagged `Cr`
   * as negative, so a real SBI brought-forward balance of ₹2,41,933.51CR parsed
   * as **−₹2,41,933.51** — a sign flip on the opening figure that BR-6 checks
   * against, which would have reported a nonsense discrepancy of nearly ₹5 lakh
   * and blamed the parse.
   *
   * Worse, a test asserted the wrong behaviour, so it looked correct.
   */
  const marker = /\s*(dr|cr)\.?$/i.exec(body);
  let suffix: 'dr' | 'cr' | null = null;
  if (marker) {
    suffix = marker[1]!.toLowerCase() as 'dr' | 'cr';
    if (suffix === 'dr') negative = true;
    body = body.slice(0, marker.index);
  }

  /*
   * The Indian "rupees and no paise" suffix: 15,000/- means 15000.00.
   *
   * Universal on hand-written and Word-template bills — professional fees,
   * rent receipts, contractor bills — and rejected outright until now, so a
   * document whose every figure was written that way had no readable amount
   * at all and no total to check against.
   *
   * Stripped before the currency scan, not after: "Rs. 15,000/-" carries both.
   */
  body = body.replace(/\s*\/\s*-\s*$/, '');

  const currency = currencyOf(body);
  body = body
    .replace(/\b(?:INR|USD|EUR|GBP|Rs)\b\.?/gi, '')
    .replace(/[₹$€£\s]/g, '')
    .replace(/,/g, '');

  if (body.startsWith('-')) { negative = !negative; body = body.slice(1); }
  else if (body.startsWith('+')) body = body.slice(1);

  if (body.length === 0) {
    return { value: '0.00', negative: false, suffix, blank: true, currency };
  }

  if (!/^\d+(\.\d+)?$/.test(body)) {
    throw new ValidationError(`"${raw}" is not a recognisable amount`, 'BR-6');
  }

  // Two decimal places, half-up, without going through a float.
  const [whole, frac = ''] = body.split('.');
  const f3 = frac.padEnd(3, '0').slice(0, 3);
  const cents = (BigInt(whole!) * 1000n + BigInt(f3) + 5n) / 10n;
  const value = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;

  return { value, negative, suffix, blank: false, currency };
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
