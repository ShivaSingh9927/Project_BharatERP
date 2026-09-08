/**
 * Invoices that state their charges as prose rather than as a grid.
 * Spec: bills-and-expenses.md BE-19, BE-20
 *
 * A travel agent, a consultant, a contractor — a great many Indian vendors —
 * do not print a tax table. They print a charge, then add to it in words:
 *
 *     Mr. ...        HOTEL BOOKING                    1,10,925.00
 *                                Add: Service Charge          0.00
 *                                Add: IGST@18.00%        19,967.00
 *                                Total Payable :      1,30,892.00
 *
 * That is the same three facts every invoice states — a taxable value, a tax,
 * and a total — laid out down the page instead of across it. The column reader
 * finds a "Standard Charges" caption it has no role for, no total column at
 * all, and reports that there is nothing here to post. There is; it is just
 * not in a grid.
 *
 * ── What makes this safe ───────────────────────────────────────────────────
 *
 * The arithmetic, and only the arithmetic. This reader has no column geometry
 * and cannot be sure which figures on the page are charges — so it does not
 * try to be sure. It takes every line carrying exactly one amount, sums them,
 * and requires the sum to equal the total the document itself states. A stray
 * figure swept in from the hotel details makes the sum wrong, and a wrong sum
 * is refused. The gate is not a formality here; it is the entire safeguard.
 *
 * Two further checks, because a tie alone can be a coincidence:
 *
 *   - The tax must agree with the rate the document prints beside it. "IGST@18%"
 *     on a base of 1,10,925 should be about 19,966.50, and it says 19,967.00 —
 *     the vendor rounded to the rupee, which is within tolerance. A gap wider
 *     than a rupee means a figure was misread, not rounded, and refuses.
 *   - There must BE an addition naming a tax with a rate. Without one this is
 *     not the shape being read and the reader declines rather than guessing.
 */

import type { Charged } from './invoiceTax.ts';
import { gradeTable, type InvoiceTable } from './invoiceTable.ts';
import { parseAmount } from './values.ts';

/**
 * An amount as Indian invoices print it: grouped, always two decimals.
 *
 * A figure trailed by a per-cent sign is a RATE and is not one. Without that
 * exclusion "Add: IGST@18.00%  19,967.00" reads as a line carrying two amounts,
 * so it is discarded as not understood — and the invoice then has no tax
 * addition at all and is declined. The vendor who writes "18%" was read while
 * the one who writes "18.00%" was not, which is no kind of rule.
 */
const AMOUNT = /(?:[₹]|Rs\.?|INR)?\s*(\d[\d,]*\.\d{2})(?!\d)(?!\s*%)/gi;

/**
 * The line that adds something to the running charge. "Add:" is near-universal
 * on this layout; "Plus" and a bare tax name with a rate also occur.
 */
const ADDITION = /^(?:add|plus)\s*[:.]?\s*(.+)$/i;

/**
 * The document's own final figure.
 *
 * Matched anywhere on the line, not anchored to its start: the label routinely
 * shares a line with the amount in words. An earlier attempt trimmed the line
 * back to the first occurrence of "total|net|amount|grand" and then anchored —
 * which broke on "ONE LAKHS THIRTY THOUSAND EIGHT HUNDRED NI**NET**Y-TWO ONLY
 * Total Payable", where the substring hides inside a spelled-out number.
 */
const PAYABLE =
  /\b(?:total\s+payable|net\s+payable|amount\s+payable|grand\s+total|total\s+amount\s+due)\b/i;

/** A caption over the column the base charges sit in. */
const CHARGE_HEADER =
  /\b(?:standard\s+charges|total\s+charges|charges|fare|basic\s+fare|amount)\b/i;

/** How far a stated tax may sit from the rate it prints, in paise. A vendor
 *  rounding to the whole rupee is ordinary; more than that is a misreading. */
const RATE_TOLERANCE = 100n;

const p = (v: string): bigint => {
  const [whole, frac = '00'] = v.split('.');
  const sign = whole!.startsWith('-') ? -1n : 1n;
  return sign * (BigInt(whole!.replace('-', '')) * 100n + BigInt(frac.padEnd(2, '0')));
};
const money = (v: bigint): string => {
  const neg = v < 0n, a = neg ? -v : v;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};

/** Which head an addition belongs to, or null when it is not a tax. */
function taxHead(label: string): 'cgst' | 'sgst' | 'igst' | 'cess' | null {
  if (/\bcgst\b/i.test(label)) return 'cgst';
  if (/\b(?:sgst|utgst)\b/i.test(label)) return 'sgst';
  if (/\bigst\b/i.test(label)) return 'igst';
  if (/\bcess\b/i.test(label)) return 'cess';
  return null;
}

/** Every amount on a line, as parsed values. */
function amountsIn(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(AMOUNT)) {
    try { out.push(parseAmount(m[1]!).value); } catch { /* not one */ }
  }
  return out;
}

interface Addition { label: string; head: ReturnType<typeof taxHead>;
                     rate: string | null; value: string; line: string; }

export interface ChargeBlock {
  table: InvoiceTable;
  /** Every line that contributed a figure — the provenance for PR-7. */
  evidence: string[];
}

/**
 * Reads a prose charge block, or returns null when the document is not one.
 *
 * Null means "not this shape, carry on". A table with `readable: false` means
 * "this IS a charge block and it does not hold together" — a real refusal
 * about this document.
 */
export function readChargeBlock(
  text: string, charged: Charged = 'no',
): ChargeBlock | null {
  const lines = text.split('\n').map((l) => l.replace(/\s{2,}/g, '  ').trimEnd());

  // ── Locate the three regions ─────────────────────────────────────────────
  const headerAt = lines.findIndex((l) => CHARGE_HEADER.test(l) && amountsIn(l).length === 0);
  const firstAdd = lines.findIndex((l, i) => i > headerAt && ADDITION.test(l.trim())
                                             && amountsIn(l).length === 1);
  const payableAt = lines.findIndex(
    (l, i) => i > headerAt && PAYABLE.test(l) && amountsIn(l).length >= 1);
  if (headerAt < 0 || firstAdd < 0 || payableAt < 0 || payableAt < firstAdd) return null;

  // ── The additions ────────────────────────────────────────────────────────
  const additions: Addition[] = [];
  for (let i = firstAdd; i < payableAt; i++) {
    const m = ADDITION.exec(lines[i]!.trim());
    if (!m) continue;
    const amounts = amountsIn(lines[i]!);
    if (amounts.length !== 1) continue;
    const label = m[1]!.replace(AMOUNT, '').replace(/\s{2,}/g, ' ').trim();
    const rate = /(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(label)?.[1] ?? null;
    additions.push({ label, head: taxHead(label), rate,
                     value: amounts[0]!, line: lines[i]!.trim() });
  }

  // No addition names a tax with a rate — this is not the shape being read.
  if (!additions.some((a) => a.head !== null)) return null;

  /*
   * The base charges: lines between the caption and the first addition that
   * carry EXACTLY ONE amount.
   *
   * Deliberately unselective. Anything swept in that does not belong makes the
   * sum wrong, and a wrong sum is refused below — which is a better guard than
   * a cleverer rule that might be confidently wrong. Note this also means a
   * genuine item grid cannot slip through here: its rows carry several amounts
   * each, so none of them is counted, the base comes to nothing, and it fails.
   */
  const baseLines: string[] = [];
  let base = 0n;
  for (let i = headerAt + 1; i < firstAdd; i++) {
    const amounts = amountsIn(lines[i]!);
    if (amounts.length !== 1) continue;
    base += p(amounts[0]!);
    baseLines.push(lines[i]!.trim());
  }
  if (base === 0n) return null;

  const payableLine = lines[payableAt]!;
  const payable = amountsIn(payableLine).at(-1)!;

  // ── Fold the additions in ────────────────────────────────────────────────
  const tax: Record<'cgst' | 'sgst' | 'igst' | 'cess', bigint> =
    { cgst: 0n, sgst: 0n, igst: 0n, cess: 0n };
  let taxable = base;
  const rates: string[] = [];
  for (const a of additions) {
    if (a.head === null) {
      /*
       * A non-tax addition — a service charge, a handling fee. It is part of
       * what the customer is being charged for the supply, so it belongs in
       * the taxable value, and the rate check below is what confirms the
       * vendor treated it the same way.
       */
      taxable += p(a.value);
    } else {
      tax[a.head] += p(a.value);
      if (a.rate !== null) rates.push(a.rate);
    }
  }

  const evidence = [...baseLines, ...additions.map((a) => a.line), payableLine.trim()];

  // ── The rate must explain the tax ────────────────────────────────────────
  const totalTax = tax.cgst! + tax.sgst! + tax.igst! + tax.cess!;
  if (rates.length > 0) {
    const combined = rates.reduce((s, r) => s + Number(r), 0);
    const expected = (taxable * BigInt(Math.round(combined * 100))) / 10000n;
    const gap = totalTax > expected ? totalTax - expected : expected - totalTax;
    if (gap > RATE_TOLERANCE) {
      return {
        evidence,
        table: {
          readable: false, roles: [], header: [], rows: [], totals: null, sums: {},
          reason: `this invoice states its charges in words rather than a table, ` +
                  `and the tax does not follow the rate it prints: ${combined}% of ` +
                  `${money(taxable)} is ${money(expected)}, but the document adds ` +
                  `${money(totalTax)}. A figure has been misread.`,
        },
      };
    }
  }

  /*
   * Graded by the same code as every other reader, as a table of one row, so
   * the tie against the document's own Total Payable is checked exactly as it
   * would be for a grid.
   */
  const header = ['Description', 'Taxable Value'];
  const row = ['Charges as stated on the invoice', money(taxable)];
  for (const [head, caption] of [['cgst', 'CGST'], ['sgst', 'SGST'],
                                 ['igst', 'IGST'], ['cess', 'Cess']] as const) {
    if (tax[head]! === 0n) continue;   // a head the document never charged
    header.push(caption); row.push(money(tax[head]!));
  }
  header.push('Total');
  row.push(payable);

  const table = gradeTable(header, [row], [payable], charged);
  table.warnings = [
    ...(table.warnings ?? []),
    'this invoice states its charges in words rather than in a table — the ' +
    'taxable value is the sum of the charges listed, and it ties to the total ' +
    'the document states.',
  ];
  return { table, evidence };
}
