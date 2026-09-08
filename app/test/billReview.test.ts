/**
 * The bill-review view model — bills-and-expenses.md §4.10.
 *
 * The screen turns on three states, and the reducer that names them from a
 * proposal is what these guard: blocked beats needs-answer beats ready, so a
 * document is never shown as postable when something stops it.
 */

import { describe, it, expect } from 'vitest';
import { proposalView } from '../src/domain/billReview.ts';
import type { BillProposal } from '../src/domain/billProposal.ts';

const base = (over: Partial<BillProposal> = {}): BillProposal => ({
  index: 0, pages: [1], documentNumber: 'INV-1', supplierGstin: '09AAKCC1645G1ZN',
  fileHash: 'h', taxProfile: {} as never,
  table: { readable: true, roles: [], header: [], rows: [], totals: null,
    sums: { taxable: '100.00', igst: '18.00', total: '118.00' } } as never,
  partyId: 'p', partyName: 'ACME', registration: { status: 'Active' } as never,
  blockers: [], warnings: [], confirmations: [], input: {} as never,
  readBy: 'coordinates', billDate: '2026-08-01', billDateBasis: 'read',
  llmProvenance: undefined, crossChecked: 'off',
  ...over,
});

describe('deriving the card status', () => {
  it('is ready when nothing stops it', () => {
    expect(proposalView(base()).status).toBe('ready');
  });
  it('is needs_answer when a confirmation is pending', () => {
    const p = proposalView(base({ confirmations: [
      { field: 'billDate', chose: '2026-09-01', instead: '2026-01-09', question: 'q' }] }));
    expect(p.status).toBe('needs_answer');
  });
  it('is blocked when there is a blocker, even with a confirmation', () => {
    // Blocked outranks everything — a blocked bill is never offered to post.
    const p = proposalView(base({
      blockers: ['no GSTIN'],
      confirmations: [{ field: 'billDate', chose: 'a', instead: 'b', question: 'q' }] }));
    expect(p.status).toBe('blocked');
  });
});

describe('the figures shown', () => {
  it('sums the tax components for the card', () => {
    const p = proposalView(base({ table: { readable: true, roles: [], header: [],
      rows: [], totals: null,
      sums: { taxable: '100.00', cgst: '9.00', sgst: '9.00', total: '118.00' } } as never }));
    expect(p.taxable).toBe('100.00');
    expect(p.tax).toBe('18.00');    // 9 + 9
    expect(p.total).toBe('118.00');
  });
  it('carries the read method and registration status through', () => {
    const p = proposalView(base({ readBy: 'docling' }));
    expect(p.readBy).toBe('docling');
    expect(p.registrationStatus).toBe('Active');
  });
});
