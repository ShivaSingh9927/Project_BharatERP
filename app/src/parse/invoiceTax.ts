/**
 * Read a document's tax profile, and let it say what kind of document it is.
 *
 * Spec: bills-and-expenses.md §4.2 · invoicing.md §3.2 (Lesson 5)
 *
 * `documentSplit.ts` separates a PDF into documents and types them from their
 * heading — except where the heading declines to choose. Amazon and Zepto both
 * head every document "Tax Invoice/Bill of Supply" or worse, leaving the body
 * to decide. This module reads the body.
 *
 * Three facts come out, and each one changes what may be posted:
 *
 *   - **Which taxes are charged.** CGST+SGST means the supply was intra-state,
 *     IGST means inter-state. That single boolean drives the whole computation
 *     (Lesson 5), and here it is being READ rather than derived, so it is also
 *     a check on the GSTIN and place of supply we derive it from elsewhere.
 *   - **Whether any tax is charged at all.** This is what resolves an
 *     unspecified heading: tax charged makes it a tax invoice, none makes it a
 *     bill of supply. Nothing else on the page distinguishes them.
 *   - **Whether reverse charge applies.** Every Indian invoice in the corpus
 *     states this explicitly, and it inverts who owes the tax.
 *
 * ── What this deliberately does NOT do ─────────────────────────────────────
 *
 * It does not read amounts, and it does not always manage rates either.
 *
 * I assumed rates were labelled in running text on every layout, the way
 * Flipkart writes "IGST: 18.0 %" and Amazon writes "18%" beside "Tax Type
 * IGST". Two of the six vendors disprove it. Blinkit puts the per-cent sign in
 * the COLUMN HEADING — "CGST (%)" — and the bare number 9.00 in the cell below.
 * Zepto names its taxes in a header row and prints "2.50%" in data rows several
 * lines lower. In both, name and rate never share a line, and no amount of
 * regex over running text will join them; that needs column geometry.
 *
 * So `charged` is THREE-valued. When the taxes are named but no rate can be
 * tied to them, it reports `unreadable` rather than `no`.
 *
 * That distinction is the whole point. Before it existed, Zepto — which
 * genuinely charges CGST 2.50% + SGST 2.50% — came back as charging nothing,
 * and its unspecified heading resolved to `bill_of_supply`. A tax invoice
 * demoted to a bill of supply silently destroys a legitimate input credit, and
 * it does so with a confident provenance trail behind it.
 *
 * Amounts wait for column detection. `unreadable` waits with them.
 */

import type { DocumentKind, DocumentSegment } from './documentSplit.ts';

/**
 * Which tax regime the document is under, read from the tax NAMES it uses.
 * This is about the nature of the supply, not about whether anything was
 * actually charged — a Bill of Supply for an intra-state supply still carries
 * CGST and SGST columns, at zero.
 */
export type TaxKind =
  | 'intra'   // CGST + SGST/UTGST — supplier and place of supply in one state
  | 'inter'   // IGST
  | 'none'    // no GST named anywhere: exempt, composition, or a foreign bill
  | 'mixed';  // both named — needs a human, see below

/**
 * Whether tax was actually charged.
 *
 * `unreadable` is not a failure to try. It means the taxes are named but every
 * rate sits in a table cell whose heading is on another line, so tying the two
 * together needs column geometry this module does not have. Reporting `no`
 * there would demote a real tax invoice to a bill of supply.
 */
export type Charged = 'yes' | 'no' | 'unreadable';

export interface TaxProfile {
  taxKind: TaxKind;
  charged: Charged;
  /** Distinct non-zero rates that could be tied to a tax name, ascending. */
  rates: string[];
  /** True/false as declared; null when the document does not say. */
  reverseCharge: boolean | null;
  /**
   * The segment's kind with an `unspecified` heading resolved by the body.
   * Any other heading is passed through — the paper's own word wins over an
   * inference whenever the paper committed to one.
   */
  resolvedKind: DocumentKind;
  /** Why `resolvedKind` came out as it did, for the audit trail (PR-7). */
  reason: string;
}

/**
 * A tax is "named" when it appears next to a rate or an amount column, not
 * merely mentioned. "Whether tax is payable under reverse charge" contains no
 * tax name; "IGST: 18.0 %" and "CGST (INR)" and "Tax Type IGST" do.
 *
 * UTGST is folded into SGST. They are the same half of an intra-state supply,
 * charged by a union territory instead of a state, and nothing downstream
 * treats them differently.
 */
const CGST = /\bCGST\b/i;
const SGST = /\b(?:SGST|UTGST|S\/UT\s*GST)\b/i;
const IGST = /\bIGST\b/i;

/**
 * Rates as they are written across the corpus: "18%", "18.0 %", "IGST: 5.00%",
 * "CGST 9.00" in a percentage column. The percent sign is required — without
 * it, every amount in the document would read as a rate.
 */
const RATE_WITH_PERCENT = /(\d{1,2}(?:\.\d{1,2})?)\s*%/g;

/**
 * Reverse charge, as declared. All three phrasings occur:
 *   "Whether tax is payable under reverse charge - No"     (Amazon, Blinkit)
 *   "Whether GST is payable on reverse-charge - No."       (Zepto)
 *   "Is the supply subject to reverse charge: No"          (Flipkart)
 */
const REVERSE_CHARGE =
  /(?:whether|is)\b[^\n]{0,60}?reverse[\s-]charge\b[^\n]{0,20}?[-:]\s*(yes|no)\b/i;

interface RatesNear {
  /** Non-zero rates found on a line that also names the tax. */
  nonZero: string[];
  /** True when the tax is named anywhere at all. */
  named: boolean;
  /** True when at least one rate — zero or not — shared a line with the name. */
  anyRateTied: boolean;
}

/**
 * A rate of zero is named but not charged: a Bill of Supply says "CGST 0.0 %",
 * and that explicit zero is evidence, not absence. `anyRateTied` is what
 * separates "the document told us zero" from "we could not tell".
 */
function ratesNear(text: string, name: RegExp): RatesNear {
  const nonZero: string[] = [];
  let named = false, anyRateTied = false;
  for (const line of text.split('\n')) {
    if (!name.test(line)) continue;
    named = true;
    for (const m of line.matchAll(RATE_WITH_PERCENT)) {
      anyRateTied = true;
      const r = normaliseRate(m[1]!);
      if (r !== '0') nonZero.push(r);
    }
  }
  return { nonZero, named, anyRateTied };
}

/** "18.0" and "18.00" and "18" are one rate, not three. */
function normaliseRate(raw: string): string {
  const n = raw.replace(/0+$/, '').replace(/\.$/, '');
  return n === '' || n === '.' ? '0' : n;
}

export function extractTaxProfile(segment: DocumentSegment): TaxProfile {
  const text = segment.text;

  const cgst = ratesNear(text, CGST);
  const sgst = ratesNear(text, SGST);
  const igst = ratesNear(text, IGST);

  const intra = cgst.named || sgst.named;
  const inter = igst.named;

  let taxKind: TaxKind;
  if (intra && inter) taxKind = 'mixed';
  else if (intra) taxKind = 'intra';
  else if (inter) taxKind = 'inter';
  else taxKind = 'none';

  const rates = [...new Set([...cgst.nonZero, ...sgst.nonZero, ...igst.nonZero])]
    .sort((a, b) => Number(a) - Number(b));

  const anyRateTied = cgst.anyRateTied || sgst.anyRateTied || igst.anyRateTied;
  const charged: Charged =
    taxKind === 'none' ? 'no'            // nothing named: nothing charged
    : rates.length > 0 ? 'yes'
    : anyRateTied ? 'no'                 // named, and every tied rate was zero
    : 'unreadable';                      // named, but no rate shares their line

  const rc = REVERSE_CHARGE.exec(text);
  const reverseCharge = rc ? rc[1]!.toLowerCase() === 'yes' : null;

  const { resolvedKind, reason } = resolveKind(segment.kind, taxKind, charged);
  return { taxKind, charged, rates, reverseCharge, resolvedKind, reason };
}

/**
 * A heading that committed is believed. A heading that did not is decided by
 * whether tax was actually charged — and if that cannot be read, it stays
 * undecided.
 *
 * The asymmetry is deliberate. If a document says "Bill of Supply" and we find
 * GST on it, that is a contradiction to raise with a human, not something to
 * silently overrule — overruling the paper is how a wrong claim gets a
 * confident provenance trail. Only `unspecified` is ours to decide, and only
 * when the body actually answers.
 */
function resolveKind(
  heading: DocumentKind, taxKind: TaxKind, charged: Charged,
): { resolvedKind: DocumentKind; reason: string } {
  if (heading !== 'unspecified') {
    return { resolvedKind: heading, reason: `the document is headed "${heading}"` };
  }
  if (charged === 'unreadable') {
    return {
      resolvedKind: 'unspecified',
      reason: `the heading names several document types, and ${taxKind === 'intra'
        ? 'CGST/SGST are' : taxKind === 'inter' ? 'IGST is' : 'GST columns are'} ` +
        'present but their rates sit in table cells this parser cannot yet tie ' +
        'to them. Whether it is a tax invoice or a bill of supply is unresolved.',
    };
  }
  if (charged === 'no') {
    return {
      resolvedKind: 'bill_of_supply',
      reason: 'the heading names several document types; no GST is charged ' +
              'anywhere on it, which makes it a bill of supply',
    };
  }
  return {
    resolvedKind: 'tax_invoice',
    reason: `the heading names several document types; ${taxKind === 'intra'
      ? 'CGST and SGST are' : taxKind === 'inter' ? 'IGST is' : 'both CGST/SGST and IGST are'} ` +
            'charged, which makes it a tax invoice',
  };
}

/**
 * Contradictions worth a human's attention. Returned rather than thrown: one
 * bad document in a batch should not stop the other twelve.
 */
export function taxProfileWarnings(
  segment: DocumentSegment, profile: TaxProfile,
): string[] {
  const w: string[] = [];

  if (segment.kind === 'bill_of_supply' && profile.charged === 'yes') {
    // Not overruled — flagged. A bill of supply charging GST is either a
    // mislabelled document or a supplier error, and either way input credit
    // must not be claimed on our guess about which.
    w.push(`document ${segment.documentNumber ?? segment.index} is headed ` +
           '"Bill of Supply" but names GST rates. A bill of supply charges no ' +
           'GST — check the paper before claiming any credit.');
  }

  if (segment.kind === 'tax_invoice' && profile.charged === 'no'
      && profile.taxKind === 'none') {
    w.push(`document ${segment.documentNumber ?? segment.index} is headed ` +
           '"Tax Invoice" but no GST rate appears on it.');
  }

  if (profile.resolvedKind === 'unspecified') {
    w.push(`document ${segment.documentNumber ?? segment.index} does not say ` +
           'whether it is a tax invoice or a bill of supply, and its rates ' +
           'could not be read. Do not claim input credit on it unread.');
  }

  if (profile.taxKind === 'mixed' && profile.rates.length > 0) {
    // Legal on one document only in unusual cases, and never a thing to assume.
    w.push(`document ${segment.documentNumber ?? segment.index} names both ` +
           'CGST/SGST and IGST at non-zero rates. One supply is intra-state or ' +
           'inter-state, not both — read the paper.');
  }

  if (profile.reverseCharge === true) {
    w.push(`document ${segment.documentNumber ?? segment.index} declares tax ` +
           'payable under reverse charge. The recipient owes the tax; the ' +
           'supplier has not charged it.');
  }

  return w;
}
