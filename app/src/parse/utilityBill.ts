/**
 * Utility bills: documents that say what they are and carry no GST invoice.
 *
 * An electricity bill is not a tax invoice with a broken table. Supply of
 * electrical energy is exempt from GST, so the document has no taxable/tax
 * columns to find, and its supplier normally prints no GSTIN. Reading it with
 * the invoice-table machinery produced two refusals that were both true and
 * both useless — "no supplier GSTIN" and "no table header" — on the simplest
 * bill a business pays.
 *
 * The same rule as `summaryInvoice` and `chargeBlock`: the document has to
 * declare its own shape. Nothing here fires unless the text calls itself an
 * electricity bill and states exactly one current bill amount. Everything else
 * (period, due date, payable amount) is display-only context for the reviewer
 * and never reaches a posted figure.
 *
 * Only electricity today, because that is the only utility layout this was
 * checked against. Water and piped gas follow the same idea but should be
 * added from real samples, not guessed.
 */

import { parseAmount } from './values.ts';

export interface UtilityBill {
  kind: 'electricity';
  /** The provider's name as printed at the head of the bill, when found. */
  issuer: string | null;
  /** The charge for this period — what is booked as expense. */
  amount: string;
  /** Billing period, ISO dates, when printed. */
  period: { from: string; to: string } | null;
  /** ISO date, when exactly one due date is printed. */
  dueDate: string | null;
  /**
   * What the provider asks to be paid, when printed. Can differ from `amount`
   * by earlier balances, rebates, or rounding to the rupee — so it is shown
   * for payment, never booked.
   */
  payable: string | null;
  /**
   * The tariff category, when printed: a residential (domestic) connection is
   * usually a home, so whether the business should bear it is a question.
   */
  connection: 'residential' | 'non_residential' | null;
  /** The name the connection is registered in, as printed. */
  consumerName: string | null;
}

const ELECTRICITY = /\belectricity\s+bill\b/i;

/** "Current Bill Amount" values printed with paise, distinct. */
export function currentBillAmounts(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\bcurrent\s+bill\s+amount\b\s*:?\s*([\d,]+\.\d{2})/gi)) {
    try { found.add(parseAmount(m[1]!).value); }
    catch { /* malformed amount; keep looking */ }
  }
  return [...found];
}

/** Reads an electricity bill, or returns null if the text is not one. */
export function readUtilityBill(text: string): UtilityBill | null {
  if (!ELECTRICITY.test(text)) return null;
  const amounts = currentBillAmounts(text);
  if (amounts.length !== 1) return null;

  return {
    kind: 'electricity',
    issuer: issuerName(text),
    amount: amounts[0]!,
    period: billingPeriod(text),
    dueDate: single(text, /\bdue\s+date\b\s*:?[ \t]*(DATE)/gi),
    payable: payableAmount(text),
    connection: connectionCategory(text),
    consumerName: consumerName(text),
  };
}

/** Read from the "Category" field only, so a footnote cannot set it. */
function connectionCategory(text: string): UtilityBill['connection'] {
  const line = /\bcategory\b[^\n]{0,60}/i.exec(text)?.[0] ?? '';
  if (/\b(?:non[-\s]?domestic|non[-\s]?residential|commercial|industrial)\b/i.test(line)) {
    return 'non_residential';
  }
  if (/\b(?:domestic|residential)\b/i.test(line)) return 'residential';
  return null;
}

/**
 * The connection holder: the first "Name :" field that is not a father's or
 * husband's name. Shown to the reviewer to answer a question, never stored as
 * master data.
 */
function consumerName(text: string): string | null {
  const m = /(?<!husband\s*)(?<!father\s*)(?<![a-z])(?:consumer\s+)?name\s*:\s*([^\n]+?)(?=\s{2,}|\n|$)/i
    .exec(text);
  const name = m?.[1]?.trim().replace(/\s+/g, ' ') ?? '';
  return name.length >= 2 && name.length <= 80 && /[a-z]/i.test(name) ? name : null;
}

const NAME_NOISE = new Set(['m', 's', 'ms', 'the', 'pvt', 'private', 'ltd',
  'limited', 'llp', 'co', 'company', 'and']);

/**
 * Whether two printed names are plausibly the same party — a client's own
 * connection usually prints its name with or without "Pvt Ltd" or "M/s".
 * Deliberately loose in the safe direction: a false match only skips a
 * question that a residential connection would still raise.
 */
export function sameParty(a: string, b: string): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((w) => w !== '' && !NAME_NOISE.has(w)).join(' ');
  const x = norm(a), y = norm(b);
  if (x === '' || y === '') return false;
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
}

/**
 * The provider's name, from the head of the bill only.
 *
 * Restricted to the first few lines and to a cell that both names a power
 * utility and ends like an organisation's name, because the consumer's own
 * name and address are printed a few lines below and must never be offered as
 * the supplier. A miss returns null; the reviewer types the name instead.
 */
function issuerName(text: string): string | null {
  const head = text.split('\n').filter((l) => l.trim() !== '').slice(0, 4);
  for (const line of head) {
    for (const cell of line.split(/\s{2,}/)) {
      const name = cell.trim().replace(/\s+/g, ' ');
      if (name.length < 6 || name.length > 90) continue;
      if (!/\b(?:vidyut|power|electricity|electric|energy|bijli|discom)\b/i.test(name)) continue;
      if (!/\b(?:limited|ltd\.?|board|corporation|company|nigam)$/i.test(name)) continue;
      return name;
    }
  }
  return null;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** dd-MMM-yyyy, or day-first dd-mm-yyyy as Indian utilities print it. */
const DATE_SOURCE = String.raw`\d{1,2}[-/. ](?:[A-Za-z]{3}|\d{1,2})[-/. ]\d{4}`;

function isoDate(raw: string): string | null {
  const m = /^(\d{1,2})[-/. ]([A-Za-z]{3}|\d{1,2})[-/. ](\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const month = /\d/.test(m[2]!) ? m[2]!.padStart(2, '0') : MONTHS[m[2]!.toLowerCase()];
  if (!month || Number(month) < 1 || Number(month) > 12) return null;
  const day = m[1]!.padStart(2, '0');
  if (Number(day) < 1 || Number(day) > 31) return null;
  return `${m[3]}-${month}-${day}`;
}

function withDates(re: RegExp): RegExp {
  return new RegExp(re.source.replaceAll('DATE', DATE_SOURCE), re.flags);
}

/** The one date a labelled pattern finds, or null if none or several differ. */
function single(text: string, re: RegExp): string | null {
  const found = new Set<string>();
  for (const m of text.matchAll(withDates(re))) {
    const iso = isoDate(m[1]!);
    if (iso) found.add(iso);
  }
  return found.size === 1 ? [...found][0]! : null;
}

function billingPeriod(text: string): { from: string; to: string } | null {
  const re = withDates(
    /\b(?:bill(?:ing)?\s+(?:duration|period)|billing\s+cycle)\b[^\n\d]{0,12}(?:\d{1,2}\s*)?:?\s*(DATE)\s*(?:to|-|–)\s*(DATE)/gi);
  const found = new Map<string, { from: string; to: string }>();
  for (const m of text.matchAll(re)) {
    const from = isoDate(m[1]!), to = isoDate(m[2]!);
    if (from && to && from <= to) found.set(`${from}/${to}`, { from, to });
  }
  return found.size === 1 ? [...found.values()][0]! : null;
}

/**
 * "Payable Amount", excluding "Minimum Payable Amount" — whose footnote
 * marker would otherwise read as a figure.
 */
function payableAmount(text: string): string | null {
  const found = new Set<string>();
  for (const m of text.matchAll(
    /(?<!minimum\s+)\bpayable\s+amount\b\s*:?[ \t]*([\d,]+(?:\.\d{1,2})?)(?![\d,.])/gi)) {
    try { found.add(parseAmount(m[1]!).value); }
    catch { /* not an amount */ }
  }
  return found.size === 1 ? [...found][0]! : null;
}
