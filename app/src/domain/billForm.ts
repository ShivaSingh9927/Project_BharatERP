/**
 * Turning a refusal into a form.
 * Spec: bills-and-expenses.md BE-34
 *
 * A blocked bill is a bad end. The pipeline always knows exactly WHICH fact
 * defeated it — a number, a date, the supplier, the figures — and a CA can
 * usually supply that fact in seconds by looking at the paper in front of
 * them. Showing them a wall instead is a choice, and the wrong one.
 *
 * So this reads a proposal's blockers and says what to ask for, alongside
 * everything that WAS read so the reviewer is checking rather than
 * transcribing. `ManualEntry` carries the answers back, and every answer faces
 * the same gates the readers face — figures a person types must still tie.
 *
 * Two things it deliberately does not do:
 *
 *   - It never pre-fills a field it could not read. A guessed invoice number
 *     that a reviewer clicks past is worse than an empty box, because it
 *     reconciles against nothing and nobody knows we invented it.
 *   - It never offers a form for a blocker a form cannot fix. "Two independent
 *     readings disagree" needs the document read, not a field typed; an
 *     unregistered supplier charging GST needs the master record corrected.
 *     Those stay refusals, and are reported as such.
 */

import type { BillProposal } from './billProposal.ts';

/** One thing to ask the reviewer for. */
export interface FormField {
  /** Matches the key on `ManualEntry`, so an answer names what it answers. */
  field: 'documentNumber' | 'billDate' | 'partyId' | 'figures';
  /** Put to the reviewer in their own words. */
  ask: string;
  /** The blocker this would clear, verbatim, so the reason travels with it. */
  because: string;
}

export interface BillFormView {
  index: number;
  /** What the readers did manage, so a reviewer confirms rather than retypes. */
  read: {
    documentNumber: string | null;
    supplierGstin: string | null;
    partyName: string | null;
    billDate: string | null;
    taxable: string | null;
    tax: string | null;
    total: string | null;
  };
  /** Empty when the bill is postable as it stands. */
  fields: FormField[];
  /** Blockers no form can answer. Non-empty means the bill stays refused. */
  unfixable: string[];
}

/** Which blocker a given field would clear. */
const TRIGGERS: Array<{ field: FormField['field']; re: RegExp; ask: string }> = [
  {
    field: 'documentNumber',
    re: /no invoice number could be read/i,
    ask: "The supplier's invoice number, as printed on the document. GSTR-2B "
       + 'matches on it, so a typo here shows up later as an unmatched invoice.',
  },
  {
    field: 'billDate',
    re: /the invoice date could not be read/i,
    ask: 'The invoice date. It decides which GST return period this bill falls '
       + 'in, so it is worth reading off the paper rather than guessing.',
  },
  {
    field: 'partyId',
    re: /no supplier is on file with GSTIN|no supplier on file is named on it/i,
    ask: 'Which supplier this bill is from. If they are not on file yet, add '
       + 'the vendor first — a party carries a state and a ledger account.',
  },
  {
    field: 'figures',
    re: /the line-item table could not be read|the figures entered do not hold together/i,
    ask: 'The taxable value, each tax component, and the total, as printed. '
       + 'They must add up: taxable + tax = total, checked before anything posts.',
  },
];

const money = (v: string | undefined): string | null => v ?? null;

/**
 * What to ask for, given what was refused.
 *
 * Driven off the blocker TEXT, which is not elegant. The alternative — a code
 * on every blocker — is the right shape and a wider change than this earns
 * today; the patterns are pinned by tests so a reworded blocker fails loudly
 * rather than silently dropping a field off the form.
 */
export function formFor(p: BillProposal): BillFormView {
  const fields: FormField[] = [];
  const matched = new Set<string>();

  for (const blocker of p.blockers) {
    const hit = TRIGGERS.find((t) => t.re.test(blocker));
    if (hit === undefined) continue;
    matched.add(blocker);
    if (fields.some((f) => f.field === hit.field)) continue;
    fields.push({ field: hit.field, ask: hit.ask, because: blocker });
  }

  const tax = p.table.readable
    ? (['cgst', 'sgst', 'igst', 'cess'] as const)
        .map((k) => p.table.sums[k]).filter((v) => v !== undefined).join(' + ')
    : undefined;

  return {
    index: p.index,
    read: {
      documentNumber: p.documentNumber,
      supplierGstin: p.supplierGstin,
      partyName: p.partyName,
      billDate: p.billDate ?? null,
      taxable: money(p.table.sums.taxable),
      tax: tax === undefined || tax === '' ? null : tax,
      total: money(p.table.sums.total),
    },
    fields,
    unfixable: p.blockers.filter((b) => !matched.has(b)),
  };
}

/** True when filling the form in would leave nothing standing in the way. */
export function isCompletable(p: BillProposal): boolean {
  const form = formFor(p);
  return form.fields.length > 0 && form.unfixable.length === 0;
}
