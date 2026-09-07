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
  /**
   * The tax the supplier actually printed on this line, when the line came off
   * a document rather than being priced here.
   *
   * On a purchase bill the vendor's figure wins. We are not auditing their
   * arithmetic; we are recording their document, and the input credit claimed
   * has to be the tax they charged — that is the figure that will appear
   * against us in GSTR-2B. Real invoices in the corpus differ from
   * `taxable x rate` by a paisa because the vendor priced backwards from a
   * round-rupee total: Amazon prints 10.53 on a taxable 58.47 where 18% gives
   * 10.52, and a Flipkart appliance prints 727.54 twice where 9% gives 727.55.
   *
   * Substituted only within `CHARGED_TAX_SLACK` below, so the printed rate
   * still has to explain the printed tax. A figure the rate cannot account for
   * is a misread, not a vendor's rounding, and it is refused.
   */
  chargedTax?: { cgst?: string; sgst?: string; igst?: string; cess?: string };
}

/**
 * How far a supplier's printed tax may sit from the computed figure: one
 * paisa per component per line.
 *
 * This is a rounding difference or it is nothing. A vendor rounding at a
 * different point in the same calculation can be out by a paisa; being out by
 * two means the rate printed does not produce the tax printed, and no amount
 * of deference to the document makes that safe to claim credit on.
 */
const CHARGED_TAX_SLACK = 1n;

export interface ComputedLine {
  taxableValue: bigint;
  cgst: bigint;
  sgst: bigint;
  igst: bigint;
  cess: bigint;
  /**
   * True when a component was taken from the supplier's document instead of
   * this computation, so the caller can say so rather than implying the
   * figures were derived.
   */
  taxAsCharged?: boolean;
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
  /** True when any line's tax came from the supplier's document (see above). */
  taxAsCharged: boolean;
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

  let derived: ComputedLine;
  if (intraState) {
    // Halve the rate, not the computed tax — halving the tax would double a
    // sub-paise rounding error.
    const half = (paise(line.gstRate) / 2n);
    const halfStr = money(half);
    const cgst = pct(taxableValue, halfStr);
    derived = { taxableValue, cgst, sgst: cgst, igst: 0n, cess };
  } else {
    derived = {
      taxableValue, cgst: 0n, sgst: 0n,
      igst: pct(taxableValue, line.gstRate), cess,
    };
  }

  return line.chargedTax
    ? preferCharged(derived, line.chargedTax, intraState)
    : derived;
}

/**
 * Takes the supplier's printed tax in place of the computed figure, having
 * first checked the computation can account for it.
 *
 * The check is the whole value of this function. Deferring to a document
 * without it would mean any misread figure became the tax, and the arithmetic
 * gates upstream cannot catch that — a wrong tax that the vendor's own total
 * happens to agree with ties perfectly.
 *
 * A component the supplier did not print is left as computed rather than
 * treated as zero: an invoice that shows only a combined tax figure has not
 * told us there is no SGST.
 */
function preferCharged(
  derived: ComputedLine,
  charged: NonNullable<TaxableLineInput['chargedTax']>,
  intraState: boolean,
): ComputedLine {
  const out: ComputedLine = { ...derived };
  let substituted = false;

  /*
   * GST is only deferred to when the document and this computation agree on
   * the SHAPE of the tax — both a centre/state pair, or both a single IGST
   * charge.
   *
   * When they disagree, the difference is not the supplier rounding at a
   * different point; it is a disagreement about the place of supply, which is
   * an entirely different question and already reported as its own warning.
   * Substituting across it did real damage: a document printing CGST 90 + SGST
   * 90 against a computed IGST 180 dropped both halves into components this
   * calculation had put at zero, and the tax on the bill fell to nothing.
   *
   * So the split is left as computed and the disagreement stays visible.
   * Cess has no split and is always compared.
   */
  const chargedIntra =
    (charged.cgst !== undefined && charged.cgst !== '')
    || (charged.sgst !== undefined && charged.sgst !== '');
  const chargedInter = charged.igst !== undefined && charged.igst !== '';
  const sameShape = chargedIntra === intraState && chargedInter === !intraState;

  const components = sameShape
    ? (['cgst', 'sgst', 'igst', 'cess'] as const)
    : (['cess'] as const);

  for (const k of components) {
    const printed = charged[k];
    if (printed === undefined || printed === '') continue;
    const p = paise(printed);
    const diff = p > derived[k] ? p - derived[k] : derived[k] - p;
    if (diff > CHARGED_TAX_SLACK) {
      throw new ValidationError(
        `the document charges ${k.toUpperCase()} of ${printed} on a taxable ` +
        `value of ${money(derived.taxableValue)}, but the rate on it produces ` +
        `${money(derived[k])}. A paisa apart is the supplier rounding at a ` +
        'different point and is accepted; this is further apart than the rate ' +
        'can explain, so either the tax or the rate was misread.',
        'PB-4');
    }
    if (p !== derived[k]) { out[k] = p; substituted = true; }
  }

  if (substituted) out.taxAsCharged = true;
  return out;
}

/**
 * Compute a whole invoice: line-level tax, then sum, then round the grand
 * total to the nearest rupee with the difference absorbed to round-off.
 */
export function computeInvoice(
  lines: TaxableLineInput[], intraState: boolean,
  /**
   * The grand total printed on the supplier's document, when this invoice came
   * off one. Given, it decides the rounding instead of the nearest-rupee rule
   * below — see `resolveRounding`.
   */
  statedGrandTotal?: string,
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

  const roundOff = resolveRounding(beforeRounding, statedGrandTotal);

  return {
    lines: computed,
    taxableValue,
    totalCgst,
    totalSgst,
    totalIgst,
    totalCess,
    roundOff,
    grandTotal: beforeRounding + roundOff,
    taxAsCharged: computed.some((c) => c.taxAsCharged === true),
  };
}

/**
 * How much to absorb into round-off.
 *
 * With nothing stated — an invoice we are raising — the nearest rupee, which
 * is what Indian practice does and what this always did. gl-engine.md V-10
 * caps the absorbed difference at ₹1; more than that is a computation fault,
 * not a rounding one.
 *
 * With a total stated, THAT total is the answer and the difference is whatever
 * it takes to reach it. Rounding is the supplier's decision and it was being
 * made for them: an invoice stating 521.36 was posted at 521.00 with 36 paise
 * of invented round-off, because the nearest-rupee rule ran regardless of what
 * the document said. Vendors in the corpus do both — one states 9539.00
 * against parts of 9538.98, another states 521.36 and means it — and only the
 * document can say which.
 *
 * Still capped at a rupee. A stated total further than that from the parts is
 * not a rounding decision, and deferring to it would let a misread total
 * rewrite the bill.
 */
function resolveRounding(beforeRounding: bigint, stated?: string): bigint {
  if (stated === undefined || stated === '') {
    const remainder = beforeRounding % 100n;
    return remainder === 0n ? 0n
      : remainder >= 50n ? (100n - remainder) : -remainder;
  }

  const diff = paise(stated) - beforeRounding;
  if (diff <= -100n || diff >= 100n) {
    throw new ValidationError(
      `the document states a total of ${stated} but its parts come to ` +
      `${money(beforeRounding)} — ${money(diff > 0n ? diff : -diff)} apart. ` +
      'Rounding absorbs less than a rupee (V-10); a gap this size means a ' +
      'figure was misread, and the bill is not posted on it.',
      'PB-4');
  }
  return diff;
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
