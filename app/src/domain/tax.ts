/**
 * GST computation.
 * Spec: invoicing.md §6
 *
 * Deterministic. Pure code, no model involvement — per the harness rule, the
 * AI may propose *which* HSN or *which* account, never what the tax is.
 *
 * All arithmetic is in integer paise. Rounding happens at LINE level and the
 * lines are then summed; rounding the total instead produces per-line figures
 * that do not reconcile, and GSTR-1 reports line-level detail, so the mismatch
 * surfaces at filing time rather than quietly.
 */

import { ValidationError } from './types.ts';

export type GstTreatment = 'taxable' | 'zero_rated' | 'nil_rated' | 'exempt' | 'non_gst';

export interface TaxableLineInput {
  quantity: string;
  unitPrice: string;
  discountAmount?: string;
  gstRate: string;          // percentage, e.g. '18'
  cessRate?: string;
  gstTreatment?: GstTreatment;
}

export interface ComputedLine {
  taxableValue: bigint;
  cgst: bigint;
  sgst: bigint;
  igst: bigint;
  cess: bigint;
}

export interface ComputedInvoice {
  lines: ComputedLine[];
  taxableValue: bigint;
  totalCgst: bigint;
  totalSgst: bigint;
  totalIgst: bigint;
  totalCess: bigint;
  roundOff: bigint;
  grandTotal: bigint;
}

/** Decimal string → integer paise. Rejects anything that isn't a clean decimal. */
export function paise(v: string): bigint {
  if (!/^-?\d+(\.\d{1,4})?$/.test(v)) {
    throw new ValidationError(`"${v}" is not a valid decimal amount`, 'SI-7');
  }
  const neg = v.startsWith('-');
  const [whole, frac = ''] = (neg ? v.slice(1) : v).split('.');
  // Round to 2dp half-up when more precision was supplied.
  const f4 = frac.padEnd(4, '0').slice(0, 4);
  const asTenThousandths = BigInt(whole!) * 10000n + BigInt(f4);
  const rounded = (asTenThousandths + 50n) / 100n;
  return neg ? -rounded : rounded;
}

export const money = (p: bigint): string => {
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};

/** Half-up rounding of (amount × rate%) in paise. */
function pct(amountPaise: bigint, ratePercent: string): bigint {
  // rate is up to 2dp; scale by 100 to keep it integral
  const rateScaled = paise(ratePercent);              // e.g. '18' → 1800
  const product = amountPaise * rateScaled;           // paise × (percent × 100)
  return (product + 5000n) / 10000n;                  // ÷ 100 for percent, ÷100 for scale
}

/**
 * Compute one line's tax.
 *
 * `intraState` comes from comparing the supplier's state code with the place
 * of supply (invoicing.md §3.2). Intra-state splits the rate into two equal
 * halves; inter-state charges the whole thing as IGST.
 */
export function computeLine(line: TaxableLineInput, intraState: boolean): ComputedLine {
  const treatment = line.gstTreatment ?? 'taxable';

  const gross = (paise(line.quantity) * paise(line.unitPrice)) / 100n;
  const discount = line.discountAmount ? paise(line.discountAmount) : 0n;
  const taxableValue = gross - discount;

  if (taxableValue < 0n) {
    throw new ValidationError('discount exceeds line value', 'SI-7');
  }

  // Only 'taxable' attracts tax. Zero-rated, nil-rated, exempt and non-GST all
  // charge nothing here — they differ in the *returns*, not in the arithmetic.
  if (treatment !== 'taxable') {
    return { taxableValue, cgst: 0n, sgst: 0n, igst: 0n, cess: 0n };
  }

  const cess = line.cessRate ? pct(taxableValue, line.cessRate) : 0n;

  if (intraState) {
    // Halve the rate, not the computed tax — halving the tax would double a
    // sub-paise rounding error.
    const half = (paise(line.gstRate) / 2n);
    const halfStr = money(half);
    const cgst = pct(taxableValue, halfStr);
    return { taxableValue, cgst, sgst: cgst, igst: 0n, cess };
  }

  return { taxableValue, cgst: 0n, sgst: 0n, igst: pct(taxableValue, line.gstRate), cess };
}

/**
 * Compute a whole invoice: line-level tax, then sum, then round the grand
 * total to the nearest rupee with the difference absorbed to round-off.
 */
export function computeInvoice(
  lines: TaxableLineInput[], intraState: boolean,
): ComputedInvoice {
  if (lines.length === 0) {
    throw new ValidationError('invoice has no line items', 'SI-7');
  }

  const computed = lines.map((l) => computeLine(l, intraState));

  const sum = (f: (c: ComputedLine) => bigint) => computed.reduce((t, c) => t + f(c), 0n);

  const taxableValue = sum((c) => c.taxableValue);
  const totalCgst = sum((c) => c.cgst);
  const totalSgst = sum((c) => c.sgst);
  const totalIgst = sum((c) => c.igst);
  const totalCess = sum((c) => c.cess);

  const beforeRounding = taxableValue + totalCgst + totalSgst + totalIgst + totalCess;

  // Round to the nearest rupee. gl-engine.md V-10 caps the absorbed difference
  // at ₹1; anything larger indicates a computation fault, not a rounding one.
  const remainder = beforeRounding % 100n;
  const roundOff = remainder === 0n
    ? 0n
    : remainder >= 50n ? (100n - remainder) : -remainder;

  return {
    lines: computed,
    taxableValue,
    totalCgst,
    totalSgst,
    totalIgst,
    totalCess,
    roundOff,
    grandTotal: beforeRounding + roundOff,
  };
}

/**
 * Independent recomputation used to check a figure supplied by someone else —
 * a vendor's invoice, or a model's extraction.
 *
 * gl-engine.md V-9 and bills-and-expenses.md PB-4: never trust a submitted tax
 * amount. Recompute from taxable value × rate and compare. On mismatch the
 * document goes to the CA for adjudication; it is never silently corrected.
 */
export function verifyTaxFigures(
  taxableValue: string, gstRate: string, intraState: boolean,
  claimed: { cgst?: string; sgst?: string; igst?: string },
): { matches: boolean; expected: { cgst: string; sgst: string; igst: string }; detail?: string } {
  const tv = paise(taxableValue);
  let expCgst = 0n, expSgst = 0n, expIgst = 0n;

  if (intraState) {
    expCgst = pct(tv, money(paise(gstRate) / 2n));
    expSgst = expCgst;
  } else {
    expIgst = pct(tv, gstRate);
  }

  const gotCgst = paise(claimed.cgst ?? '0');
  const gotSgst = paise(claimed.sgst ?? '0');
  const gotIgst = paise(claimed.igst ?? '0');

  const matches = gotCgst === expCgst && gotSgst === expSgst && gotIgst === expIgst;

  return {
    matches,
    expected: { cgst: money(expCgst), sgst: money(expSgst), igst: money(expIgst) },
    detail: matches ? undefined
      : `document claims CGST ${money(gotCgst)} / SGST ${money(gotSgst)} / IGST ${money(gotIgst)}; ` +
        `computed CGST ${money(expCgst)} / SGST ${money(expSgst)} / IGST ${money(expIgst)}`,
  };
}
