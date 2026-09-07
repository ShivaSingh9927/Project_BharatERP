/**
 * Imports of service: a bill from a supplier outside India.
 * Spec: bills-and-expenses.md §4.6 · IGST Act s.5(3), s.7(4), s.13(3), s.14
 *
 * Four invoices in the corpus are of this kind — a US company billing in
 * rupees, a Lithuanian one in dollars, a German host in euros, an Israeli one
 * in dollars. They charge no GST, and that is correct: the tax is owed by the
 * RECIPIENT under reverse charge, paid in cash rather than from credit, and
 * claimable back only after it is paid.
 *
 * ── What this module refuses to decide ────────────────────────────────────
 *
 * Whether a document IS an import of service. The evidence available — no
 * GSTIN, no GST charged — has two explanations, and they differ in whether tax
 * is owed at all:
 *
 *   a foreign supplier      → reverse charge applies, tax is owed
 *   an unregistered Indian  → s.9(4) reverse charge, in force only for
 *   supplier                  notified supplies, so usually nothing is owed
 *
 * Getting that wrong pays tax that was never due, or misses tax that was. A
 * country name in the address is not proof — plenty of Indian suppliers print
 * a foreign parent's address — and a list of country names would grow once per
 * document, which is the failure this project already learned from the
 * stop-list that decided where a table ended.
 *
 * So the classification is the human's, and it is made by an action rather
 * than a checkbox: naming the rate at which the supply is taxable IS the
 * decision that it is taxable. This module gathers the evidence for it and
 * does every piece of arithmetic that follows.
 */

import { ValidationError } from '../domain/types.ts';
import { paise, money } from '../domain/tax.ts';
import { currencyOf, currencyWasAssumed, type Currency } from './values.ts';
import type { InvoiceTable } from './invoiceTable.ts';

export interface CurrencyReading {
  /** The currency every money cell agreed on, or null when none said. */
  currency: Currency | null;
  /** True when read from a bare `$`, which several countries use. */
  assumed: boolean;
  /** Currencies seen, when the document did not use just one. */
  mixed: Currency[];
}

/**
 * Which currency the table's figures are in.
 *
 * A document must speak in ONE currency for its total to mean anything. A
 * table mixing euros and dollars has either been misread or is not a single
 * invoice, and either way its arithmetic is meaningless — the tie would pass
 * on figures that cannot legitimately be added.
 */
export function tableCurrency(table: InvoiceTable): CurrencyReading {
  const seen = new Set<Currency>();
  let assumed = false;

  for (const row of table.rows) {
    for (const cell of row.cells) {
      const c = currencyOf(cell);
      if (c === null) continue;
      seen.add(c);
      if (currencyWasAssumed(cell)) assumed = true;
    }
  }

  const list = [...seen];
  if (list.length > 1) return { currency: null, assumed, mixed: list };
  return { currency: list[0] ?? null, assumed, mixed: [] };
}

/**
 * An exchange rate, to four decimal places.
 *
 * Kept separate from `paise` because a rate is not money: 88.2050 rupees to
 * the dollar is a real quotation, and rounding it to 88.21 before multiplying
 * moves a ₹1,00,000 invoice by ₹57.
 */
function rateTenThousandths(rate: string): bigint {
  if (!/^\d+(\.\d{1,4})?$/.test(rate)) {
    throw new ValidationError(
      `"${rate}" is not a usable exchange rate — it must be a positive ` +
      'decimal with at most four places, as quoted.', 'BE-11');
  }
  const [whole, frac = ''] = rate.split('.');
  return BigInt(whole!) * 10000n + BigInt(frac.padEnd(4, '0'));
}

/**
 * Convert a foreign amount to rupees at a stated rate.
 *
 * Rule 34(2) fixes the rate for an import of service as the one applicable
 * under generally accepted accounting principles on the date of the time of
 * supply. Which rate that is, is the filer's decision and their evidence; this
 * only applies the one they give and records it, which is what PR-3 requires
 * of any figure that did not come off the document.
 */
export function toRupees(amount: string, rate: string): string {
  const p = paise(amount);
  const r = rateTenThousandths(rate);
  const neg = p < 0n;
  const a = neg ? -p : p;
  const converted = (a * r + 5000n) / 10000n;
  return money(neg ? -converted : converted);
}

/**
 * The date the tax becomes payable — IGST s.13(3).
 *
 * For a service taxed in the recipient's hands this is the EARLIER of the date
 * of payment and the sixtieth day after the supplier's invoice. It is not the
 * invoice date, and the difference decides which return the liability falls
 * in, so it is computed rather than assumed.
 *
 * Without a payment date the sixty-day limb is the one that can be known, and
 * the caller is told that a payment before it moves the date earlier.
 */
export function timeOfSupply(
  invoiceDate: string, paymentDate?: string,
): { date: string; basis: string } {
  const sixtieth = addDays(invoiceDate, 60);
  if (paymentDate !== undefined && paymentDate < sixtieth) {
    return {
      date: paymentDate,
      basis: `paid on ${paymentDate}, before the sixtieth day after the ` +
             `invoice (${sixtieth}) — IGST s.13(3)`,
    };
  }
  return {
    date: sixtieth,
    basis: `the sixtieth day after the invoice of ${invoiceDate}` +
           (paymentDate === undefined
             ? ', no payment date being known — IGST s.13(3). Paying earlier ' +
               'moves this date earlier and may move the return period.'
             : ` — IGST s.13(3)`),
  };
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d + days);
  const dt = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
