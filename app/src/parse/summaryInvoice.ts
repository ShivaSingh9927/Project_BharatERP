/**
 * Invoices that carry no line items on their face.
 * Spec: bills-and-expenses.md BE-18
 *
 * The reader assumed every invoice prints a table. Most do. But a large
 * supplier billing against a schedule does not: a large auto-component buyer writes "Detail as
 * per Annexure Attached" against every item field and then states the tax as
 * labelled lines —
 *
 *     Total Taxable Value : 12,34,567.00
 *     IGST                : 2,22,222.06
 *     Total Invoice Amount: 14,56,789.06
 *
 * That is a complete and self-checking tax statement; it simply is not a table.
 * The old reader went looking for columns, forced those label:value pairs into
 * a grid, and reported that the grid did not add up. It did not add up because
 * it was never a grid — and ₹70.9 lakh was refused for the shape of the page
 * rather than for anything wrong with it.
 *
 * ── Why this is not a relaxation ───────────────────────────────────────────
 *
 * A standing rule here is that a tied total proves the rows SHOWN were
 * consistent, never that all rows were read. Nothing about that changes. What
 * changes is the premise: this path is only open when the document itself
 * declares it has no item rows on its face. There are no rows to have missed,
 * because the paper says the detail lives elsewhere.
 *
 * So the declaration is the gate, and it is checked FIRST. If a document has an
 * item table that reads badly, this reader must not be reachable — otherwise it
 * becomes a way to skip a broken table by trusting its total, which is exactly
 * the failure the rule above exists to prevent.
 *
 * ── What it still has to survive ───────────────────────────────────────────
 *
 * The same gates as everything else, run by the same code: the figures are
 * assembled into a one-row table and handed to `gradeTable`. Gate 1 rejects a
 * cell that is not one amount; gate 2 requires taxable + cgst + sgst + igst +
 * cess to equal the stated total. Nothing is graded leniently here — the
 * arithmetic is simply given a fair chance to be checked.
 */

import { gradeTable, type InvoiceTable } from './invoiceTable.ts';
import type { Charged } from './invoiceTax.ts';
import { parseAmount } from './values.ts';

/**
 * The document saying, in its own words, that its items are not on this page.
 *
 * Deliberately narrow. These are phrases that refer the READER ELSEWHERE for
 * the item detail — not any mention of the word annexure, which appears in
 * terms and conditions on documents that itemise perfectly well.
 */
const ANNEXURE =
  /\b(?:as\s+per|refer(?:\s+to)?|see|vide|enclosed|attached)\b[^\n]{0,30}?\bannexur[ea]\b|\bannexur[ea]\b[^\n]{0,20}?\battached\b/i;

/**
 * Item fields whose value is a cross-reference rather than a figure. that layout
 * prints one of these for each: P.O.NO., Item Code, Quantity, HSN code, Unit
 * of Measurement — all answered "Detail as per Annexure Attached."
 */
const ITEM_FIELD =
  /\b(?:item\s*code|quantity|qty|hsn(?:\s*(?:code|\/\s*sac))?|unit\s+of\s+measure|uom|description\s+of\s+goods)\b/i;

/** How many item fields must be deferred before we believe the page has none. */
const DEFERRED_FIELDS_REQUIRED = 2;

export interface AnnexureReference {
  /** The line that told us, kept for the audit trail and the reviewer. */
  evidence: string;
  /** Item fields whose value was a cross-reference, e.g. Quantity, HSN code. */
  deferredFields: string[];
}

/**
 * Whether this document declares that its items are elsewhere.
 *
 * Two independent signals are required, because either alone is too easy to
 * trip: a document must both use annexure language AND answer at least
 * `DEFERRED_FIELDS_REQUIRED` item fields with it. A footnote mentioning an
 * annexure does not qualify; a page that defers only its P.O. number does not
 * either.
 */
export function annexureReference(text: string): AnnexureReference | null {
  const deferred: string[] = [];
  let evidence: string | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!ANNEXURE.test(line)) continue;
    if (evidence === null) evidence = line.replace(/\s{2,}/g, ' ');

    /*
     * The field name is whatever precedes the colon. Read from the LEFT of the
     * separator only — the phrase itself contains no field name, and scanning
     * the whole line would match "Detail" every time.
     */
    const label = line.split(/:/)[0] ?? '';
    if (ITEM_FIELD.test(label)) deferred.push(label.replace(/\s{2,}/g, ' ').trim());
  }

  if (evidence === null || deferred.length < DEFERRED_FIELDS_REQUIRED) return null;
  return { evidence, deferredFields: deferred };
}

/**
 * Labels for the figures a summary invoice states, most specific first.
 *
 * Order matters within a role. "Total Taxable Value" and "Total Basic Amount"
 * are the same figure on the that layout layout; the first found wins and the second
 * becomes a CHECK rather than a second addend (see `readLabelledTotals`).
 */
const LABELS: Array<{ role: 'taxable' | 'cgst' | 'sgst' | 'igst' | 'cess' | 'total'
                      | 'total_tax'; re: RegExp }> = [
  // Checked before `total`, which would otherwise swallow them.
  { role: 'total_tax', re: /^total\s*\(\s*gst\s*\)/i },
  { role: 'total_tax', re: /^total\s+(?:gst|tax)\b/i },
  { role: 'total',     re: /^total\s*\(\s*basic\s*am(?:oun)?t\.?\s*\+\s*gst\s*\)/i },
  { role: 'total',     re: /^total\s+invoice\s+(?:amount|value)\b/i },
  { role: 'total',     re: /^(?:grand|invoice|net)\s+total\b/i },
  { role: 'total',     re: /^total\s+amount\s+(?:payable|due)\b/i },
  { role: 'taxable',   re: /^total\s+taxable\s+(?:value|amount)\b/i },
  { role: 'taxable',   re: /^taxable\s+(?:value|amount)\b/i },
  { role: 'taxable',   re: /^total\s+basic\s+am(?:oun)?t\.?\b/i },
  { role: 'taxable',   re: /^basic\s+am(?:oun)?t\.?\b/i },
  { role: 'cgst',      re: /^(?:total\s+)?cgst\b/i },
  { role: 'sgst',      re: /^(?:total\s+)?(?:sgst|utgst)\b/i },
  { role: 'igst',      re: /^(?:total\s+)?igst\b/i },
  { role: 'cess',      re: /^(?:total\s+)?cess\b/i },
];

/**
 * A rate qualifier on a label — "IGST @ 18%", "CGST Rate". These name a
 * PERCENTAGE, not an amount, and adding one to the tax would be nonsense that
 * can still nearly tie.
 */
const RATE_QUALIFIED = /@|\brate\b|%/i;

/** A labelled figure lifted off the page, with where it came from. */
interface Labelled { role: string; label: string; value: string; line: string; }

/**
 * Reads `Label : 1,23,456.78` pairs.
 *
 * The separator is required. Without it "Total Invoice Amount 14,56,789.06"
 * cannot be told from a sentence that happens to contain a number, and this
 * reader has no column geometry to fall back on — the separator IS the
 * structure it is reading.
 */
function readLabelled(text: string): Labelled[] {
  const out: Labelled[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const sep = line.indexOf(':');
    if (sep <= 0) continue;

    const label = line.slice(0, sep).replace(/\s{2,}/g, ' ').trim();
    const rest = line.slice(sep + 1);

    /*
     * A trailing rate qualifier is stripped, not refused: that layout writes
     * "Tax Collection at Source @ : 0.00", and Indian layouts routinely park
     * "@ 18%" after the tax name. But if what remains still names a rate, the
     * figure is a percentage and takes no part in any sum.
     */
    const bare = label.replace(/\s*@\s*(?:\d{1,2}(?:\.\d{1,2})?)?\s*%?\s*$/, '').trim();
    if (RATE_QUALIFIED.test(bare)) continue;

    const hit = LABELS.find((l) => l.re.test(bare));
    if (!hit) continue;

    // Exactly one figure after the separator, or we have not understood the line.
    const nums = [...rest.matchAll(/(?:[₹]|Rs\.?|INR)?\s*(\d[\d,]*\.\d{2})\b/gi)];
    if (nums.length !== 1) continue;

    try {
      out.push({ role: hit.role, label: bare,
                 value: parseAmount(nums[0]![1]!).value,
                 line: line.replace(/\s{2,}/g, ' ') });
    } catch { /* not an amount after all */ }
  }
  return out;
}

export interface SummaryInvoice {
  table: InvoiceTable;
  reference: AnnexureReference;
  /** Every labelled figure that fed the table — the provenance for PR-7. */
  evidence: string[];
}

/**
 * Reads a summary-only invoice, or returns null when the document is not one.
 *
 * Null means "not applicable, carry on"; a table with `readable: false` means
 * "this IS a summary invoice and it does not add up" — a real refusal the
 * caller should report, not swallow.
 */
export function readSummaryInvoice(
  text: string, charged: Charged = 'no',
): SummaryInvoice | null {
  const reference = annexureReference(text);
  if (reference === null) return null;

  const found = readLabelled(text);
  if (found.length === 0) return null;

  /*
   * One value per role. A role stated twice with the SAME figure is a
   * restatement and harmless — that layout prints its taxable value as both "Total
   * Basic Amount" and "Total Taxable Value". Stated twice with DIFFERENT
   * figures, we have misread a label, and guessing which is right is exactly
   * the coin toss this codebase refuses elsewhere.
   */
  const byRole = new Map<string, Labelled>();
  const conflicts: string[] = [];
  for (const f of found) {
    const seen = byRole.get(f.role);
    if (seen === undefined) { byRole.set(f.role, f); continue; }
    if (seen.value !== f.value) {
      conflicts.push(`"${seen.label}" says ${seen.value} but "${f.label}" says ${f.value}`);
    }
  }

  const value = (r: string) => byRole.get(r)?.value;
  const taxable = value('taxable');
  const total = value('total');
  if (taxable === undefined || total === undefined) return null;

  if (conflicts.length > 0) {
    return {
      reference, evidence: found.map((f) => f.line),
      table: {
        readable: false, roles: [], header: [], rows: [], totals: null, sums: {},
        reason: 'this invoice states its totals without a line-item table, and ' +
                `the labelled figures disagree: ${conflicts.join('; ')}. ` +
                'One of the labels has been misread.',
      },
    };
  }

  /*
   * When the document also states its total tax, check it against the parts.
   * Free evidence: it is an independent statement of the same fact, and a
   * disagreement means a component was misread even if the grand total still
   * happens to tie.
   */
  const warnings: string[] = [];
  const statedTax = value('total_tax');
  if (statedTax !== undefined) {
    const parts = (['cgst', 'sgst', 'igst', 'cess'] as const)
      .reduce((s, r) => s + BigInt(Math.round(Number(value(r) ?? '0') * 100)), 0n);
    const stated = BigInt(Math.round(Number(statedTax) * 100));
    if (parts !== stated) {
      return {
        reference, evidence: found.map((f) => f.line),
        table: {
          readable: false, roles: [], header: [], rows: [], totals: null, sums: {},
          reason: `this invoice states its tax twice and the two disagree: the ` +
                  `components add to ${(Number(parts) / 100).toFixed(2)} but the ` +
                  `document says ${statedTax}. A component has been misread.`,
        },
      };
    }
  }

  /*
   * Hand the figures to the SAME grader every other reader faces, as a table of
   * one row. This is the point of the whole design: no second arithmetic
   * implementation to drift out of step, and gate 2 decides here exactly as it
   * decides for a Flipkart grid.
   */
  const header = ['Description', 'Taxable Value'];
  const row = ['As per annexure attached', taxable];
  for (const [role, caption] of [['cgst', 'CGST'], ['sgst', 'SGST'],
                                 ['igst', 'IGST'], ['cess', 'Cess']] as const) {
    const v = value(role);
    if (v !== undefined) { header.push(caption); row.push(v); }
  }
  header.push('Total');
  row.push(total);

  const table = gradeTable(header, [row], [total], charged);
  table.warnings = [
    ...(table.warnings ?? []), ...warnings,
    'this invoice carries no line items on its face — it states "' +
    reference.evidence + '". The tax stated on the document has been checked ' +
    'and ties, but the item detail is in a separate annexure this software has ' +
    'not seen.',
  ];
  return { table, reference, evidence: found.map((f) => f.line) };
}
