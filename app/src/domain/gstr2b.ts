/**
 * Reconciling the purchase ledger against GSTR-2B.
 * Spec: bills-and-expenses.md §5 · CGST s.16(2)(aa), s.16(2)(c)
 *
 * GSTR-2B is the government's monthly statement of every invoice a supplier
 * filed AGAINST this client's GSTIN. Since s.16(2)(aa) it is not paperwork —
 * it is the gate on the money: input credit may be claimed only on an invoice
 * that actually appears here. A bill can be extracted perfectly, tie to the
 * paisa, and still carry no claimable credit because the supplier never filed
 * it.
 *
 * So there are two different facts about every purchase, and the gap between
 * them is what a CA spends the month chasing:
 *
 *   what the INVOICE claims   — extracted from the document, already in the books
 *   what the SUPPLIER filed    — what 2B says, the only thing the department sees
 *
 * This module does not fetch 2B — that needs an authenticated taxpayer session
 * and belongs behind a licensed provider. It does the RECONCILIATION, which is
 * the part with the value and the part worth testing: given the books and a 2B
 * statement, from wherever, it says of every line which of four situations it
 * is in, and never guesses when the honest answer is "a human decides".
 */

/** One invoice as GSTR-2B reports it. Provider-independent by design. */
export interface Gstr2bInvoice {
  supplierGstin: string;
  /** The supplier's own invoice number, exactly as filed. */
  invoiceNumber: string;
  /** ISO date. */
  invoiceDate: string;
  taxableValue: string;
  igst: string;
  cgst: string;
  sgst: string;
  cess: string;
  /** Total invoice value as filed. */
  total: string;
  /**
   * Whether the department itself marks this credit available. A 'no' here
   * blocks the claim even on a perfectly matched invoice — a filing after the
   * cut-off, a supplier default — and the reason travels with it.
   */
  itcAvailable: boolean;
  itcReason: string | null;
}

/** One bill from the purchase ledger, reduced to what reconciliation needs. */
export interface LedgerBill {
  voucherId: string;
  supplierGstin: string | null;
  billNumber: string;
  billDate: string;
  taxableValue: string;
  totalTax: string;
  grandTotal: string;
}

export type MatchStatus =
  /** In both, and the figures agree. Credit is safe to claim. */
  | 'matched'
  /** In both by identity, but the money differs. A human reads both. */
  | 'mismatch'
  /** Booked, but the supplier has not filed it. Credit is NOT yet available. */
  | 'in_books_only'
  /** Filed by the supplier, but not in the books. A purchase to record — or to
   *  reject, if it was never ours. */
  | 'in_2b_only';

export interface ReconLine {
  status: MatchStatus;
  supplierGstin: string | null;
  /** The books side, when there is one. */
  bill: LedgerBill | null;
  /** The 2B side, when there is one. */
  filed: Gstr2bInvoice | null;
  /** Plain-language account of the finding and what it means for the claim. */
  note: string;
}

/**
 * An invoice number, reduced to what two systems can be expected to agree on.
 *
 * This is where a reconciler earns its keep or fabricates matches. A supplier
 * files "INV/2024/0042"; the same invoice is keyed in as "INV-2024-42". They
 * are the same document and a naive comparison misses it, stranding a real
 * credit in `in_books_only`.
 *
 * The rule: upper-case, split on every non-alphanumeric, strip leading zeros
 * from each piece, rejoin. So "INV/2024/0042" and "INV-2024-42" both become
 * "INV202442". It is deliberately not more aggressive than that — collapsing
 * two genuinely different numbers into one would invent a match, and a wrong
 * match is worse than a missed one because it silently claims credit that was
 * never filed.
 *
 * The GSTIN scopes every comparison and the amounts are checked on top, so an
 * over-broad key still cannot produce a `matched` with the wrong money — it
 * would surface as a `mismatch` for a human to read.
 */
export function normaliseInvoiceNumber(raw: string): string {
  return raw
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t !== '')
    .map((t) => t.replace(/^0+(?=.)/, ''))
    .join('');
}

import { paise, money } from './tax.ts';

/** How far the money may differ and still count as agreement: one rupee, the
 *  most rounding can absorb across a whole invoice (V-10). */
const AMOUNT_TOLERANCE = 100n;

function agrees(a: string, b: string): boolean {
  const d = paise(a) - paise(b);
  return (d < 0n ? -d : d) < AMOUNT_TOLERANCE;
}

/**
 * Reconciles the books against a 2B statement.
 *
 * Pure: given both sides it returns one line per invoice on either side,
 * classified. It reads nothing and writes nothing, which is what makes it
 * testable against hand-built fixtures — the storage and the fetching are
 * someone else's job.
 *
 * The match is scoped by supplier GSTIN first, because the GSTIN is the one
 * key both sides copy from the same place and neither retypes. Within a
 * supplier, invoices are paired by normalised number; a pair whose money
 * agrees is `matched`, one whose money does not is `mismatch`. What is left
 * over on each side is the finding that costs real money: books with no filing
 * cannot claim yet, filings with no book are purchases unaccounted for.
 */
export function reconcile(
  bills: readonly LedgerBill[], filed: readonly Gstr2bInvoice[],
): ReconLine[] {
  const out: ReconLine[] = [];
  const filedUsed = new Set<Gstr2bInvoice>();

  // 2B invoices that CAN be matched — a supplier GSTIN and a number to key on.
  const matchable = filed.filter((f) => f.supplierGstin !== '');

  // Pass 1: by supplier GSTIN and normalised invoice number. The number is the
  // strong key when both sides spell it recognisably the same.
  const byKey = new Map<string, Gstr2bInvoice[]>();
  for (const f of matchable) {
    const k = `${f.supplierGstin}::${normaliseInvoiceNumber(f.invoiceNumber)}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(f);
  }

  const unmatchedBills: LedgerBill[] = [];
  for (const bill of bills) {
    if (bill.supplierGstin === null) {
      out.push(noGstin(bill));
      continue;
    }
    const k = `${bill.supplierGstin}::${normaliseInvoiceNumber(bill.billNumber)}`;
    const cands = (byKey.get(k) ?? []).filter((f) => !filedUsed.has(f));
    if (cands.length === 1) {
      filedUsed.add(cands[0]!);
      out.push(classify(bill, cands[0]!, false));
    } else {
      unmatchedBills.push(bill);
    }
  }

  // Pass 2: the same invoice, its number transcribed differently on the two
  // sides — "LIAC75E-26-0000050" filed, "LIAC75E260000050" keyed in. The
  // number cannot be reconciled by rule, but a supplier GSTIN with an EXACTLY
  // equal taxable value, tax, and date is that invoice to a near certainty.
  // Matched, and flagged so a human confirms the numbers are the same document.
  for (const bill of unmatchedBills) {
    const twin = matchable.find((f) =>
      !filedUsed.has(f)
      && f.supplierGstin === bill.supplierGstin
      && f.invoiceDate === bill.billDate
      && paise(f.taxableValue) === paise(bill.taxableValue)
      && paise(f.igst) + paise(f.cgst) + paise(f.sgst) + paise(f.cess)
         === paise(bill.totalTax));
    if (twin !== undefined) {
      filedUsed.add(twin);
      out.push(classify(bill, twin, true));
    } else {
      out.push({
        status: 'in_books_only', supplierGstin: bill.supplierGstin, bill,
        filed: null,
        note: `this bill is in the books but the supplier has not filed it in ` +
          `2B. Under s.16(2)(aa) the credit of ${bill.totalTax} is NOT ` +
          'available until they do — follow it up before claiming it.',
      });
    }
  }

  for (const f of filed) {
    if (filedUsed.has(f)) continue;
    out.push({
      status: 'in_2b_only', supplierGstin: f.supplierGstin, bill: null, filed: f,
      note: `the supplier filed this invoice (${f.invoiceNumber}, ` +
        `${f.invoiceDate}) but it is not in the books. Either a purchase was ` +
        'never recorded — with credit waiting to be claimed — or the invoice ' +
        'is not ours. Find the document before accepting it.',
    });
  }

  return out;
}

/** A bill with no GSTIN cannot appear in 2B at all. */
function noGstin(bill: LedgerBill): ReconLine {
  return {
    status: 'in_books_only', supplierGstin: null, bill, filed: null,
    note: 'this bill carries no supplier GSTIN, so it cannot appear in 2B — ' +
      'an import of service or an unregistered supplier. Its credit, if any, ' +
      'is claimed on another footing, not through 2B matching.',
  };
}

/**
 * Classifies a paired bill and filing: agreeing money is `matched`, disagreeing
 * money or a department block is `mismatch`. `numbersDiffer` is set when the
 * pair was found by amount rather than by number, and the note says so — the
 * credit is supported but a human should confirm it is one document.
 */
function classify(
  bill: LedgerBill, filed: Gstr2bInvoice, numbersDiffer: boolean,
): ReconLine {
  const filedTax = money(paise(filed.igst) + paise(filed.cgst)
                         + paise(filed.sgst) + paise(filed.cess));
  const moneyAgrees = agrees(bill.taxableValue, filed.taxableValue)
    && agrees(bill.totalTax, filedTax);

  const numberNote = numbersDiffer
    ? ` The invoice number is written differently on each side — books ` +
      `"${bill.billNumber}", 2B "${filed.invoiceNumber}" — but the supplier, ` +
      `date, and amounts are identical; confirm it is the same document.`
    : '';

  if (!moneyAgrees) {
    return {
      status: 'mismatch', supplierGstin: bill.supplierGstin, bill, filed,
      note: `the supplier filed this invoice, but the figures differ — books ` +
        `show taxable ${bill.taxableValue}, tax ${bill.totalTax}; 2B shows ` +
        `taxable ${filed.taxableValue}, tax ${filedTax}. Claim only what 2B ` +
        `supports; read both to see which is right.${numberNote}`,
    };
  }
  if (!filed.itcAvailable) {
    return {
      status: 'mismatch', supplierGstin: bill.supplierGstin, bill, filed,
      note: `the figures match, but 2B marks this credit NOT available` +
        (filed.itcReason ? ` — ${filed.itcReason}` : '') +
        `. The department will not allow it this period; do not claim it.${numberNote}`,
    };
  }
  return {
    status: 'matched', supplierGstin: bill.supplierGstin, bill, filed,
    note: `matched — the supplier filed this invoice and the figures agree. ` +
      `The credit of ${bill.totalTax} is supported by 2B.${numberNote}`,
  };
}
