/**
 * Turning a refusal into a form — bills-and-expenses.md BE-34.
 *
 * Two properties matter more than the happy path: that a field is offered only
 * where filling it in would actually clear the refusal, and that a blocker no
 * form can answer keeps the bill refused rather than quietly disappearing off
 * the list of reasons.
 */

import { describe, it, expect } from 'vitest';
import { formFor, isCompletable } from '../src/domain/billForm.ts';
import type { BillProposal } from '../src/domain/billProposal.ts';

const proposal = (blockers: string[], over: Partial<BillProposal> = {}): BillProposal => ({
  index: 0, pages: [1], documentNumber: null, supplierGstin: null,
  fileHash: 'a'.repeat(64),
  taxProfile: { taxKind: 'inter', charged: 'yes', rates: ['18'], reverseCharge: false,
                resolvedKind: 'tax_invoice', reason: 'test' },
  table: { readable: false, roles: [], header: [], rows: [], totals: null, sums: {} },
  partyId: null, partyName: null, registration: null,
  tds: null,
  blockers, warnings: [], confirmations: [], input: null,
  readBy: 'coordinates', crossChecked: 'off',
  ...over,
});

describe('what the form asks for', () => {
  it('asks for the invoice number when none could be read', () => {
    const f = formFor(proposal([
      'no invoice number could be read from this document. GSTR-2B matches on '
      + "the supplier's own number, so it cannot be left out or made up."]));
    expect(f.fields.map((x) => x.field)).toEqual(['documentNumber']);
    expect(f.unfixable).toEqual([]);
    // The reason travels with the question, so the reviewer knows why they are
    // being asked rather than just what for.
    expect(f.fields[0]?.because).toMatch(/GSTR-2B matches/);
  });

  it('asks for every field a document is missing, once each', () => {
    const f = formFor(proposal([
      'no invoice number could be read from this document.',
      'the invoice date could not be read — no date appears on this document',
      'the line-item table could not be read: the table does not add up',
      'the line-item table could not be read: column "X" holds "y"',
    ]));
    expect(f.fields.map((x) => x.field))
      .toEqual(['documentNumber', 'billDate', 'figures']);
  });

  it('keeps a blocker no form can answer, and refuses to call it completable', () => {
    /*
     * The important one. "Two readings disagree" needs the document read by a
     * human, not a field typed — and if it were dropped from the reasons, a
     * reviewer filling in the number would think they had cleared everything.
     */
    const f = formFor(proposal([
      'no invoice number could be read from this document.',
      'two independent readings of document 1 disagree — taxable: 50.00 vs 327.96.',
    ]));
    expect(f.fields.map((x) => x.field)).toEqual(['documentNumber']);
    expect(f.unfixable).toHaveLength(1);
    expect(f.unfixable[0]).toMatch(/disagree/);
  });

  it('offers no form for a bill that is already postable', () => {
    const p = proposal([]);
    expect(formFor(p).fields).toEqual([]);
    expect(isCompletable(p)).toBe(false);
  });

  it('is not completable when something unfixable remains', () => {
    expect(isCompletable(proposal([
      'no invoice number could be read from this document.',
      'an unregistered supplier cannot collect it',
    ]))).toBe(false);
  });
});

describe('what the form shows back', () => {
  it('shows what WAS read, so the reviewer checks rather than retypes', () => {
    const f = formFor(proposal(
      ['the invoice date could not be read — no date appears on this document'],
      {
        documentNumber: 'INV-42', supplierGstin: '09AAACS2222S1ZY',
        partyName: 'Near Supplier',
        table: { readable: true, roles: [], header: [], rows: [], totals: null,
                 sums: { taxable: '1000.00', igst: '180.00', total: '1180.00' } },
      }));
    expect(f.read.documentNumber).toBe('INV-42');
    expect(f.read.partyName).toBe('Near Supplier');
    expect(f.read.taxable).toBe('1000.00');
    expect(f.read.tax).toBe('180.00');
    expect(f.read.total).toBe('1180.00');
  });

  it('never pre-fills a field it could not read', () => {
    /*
     * A guessed invoice number a reviewer clicks past is worse than an empty
     * box: it reconciles against nothing and nobody knows it was invented.
     */
    const f = formFor(proposal(['no invoice number could be read from this document.']));
    expect(f.read.documentNumber).toBeNull();
    expect(f.read.taxable).toBeNull();
  });
});
