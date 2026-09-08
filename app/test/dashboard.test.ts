/**
 * The dashboard view — bills-and-expenses.md §6.
 *
 * Pure rendering, so it is tested without a database. What matters is that the
 * money-at-risk headline reads correctly whether or not a reconciliation has
 * been run.
 */

import { describe, it, expect } from 'vitest';
import { renderDashboard } from '../src/web/views.ts';

const base = {
  period: '2026-03', periods: ['2026-03', '2026-02'],
  billsPosted: 4, purchaseValue: '10721.00', creditClaimed: '1234.00',
  creditAtRisk: '1455.08', creditSupported: '19.98', openReconItems: 3,
  recentBills: [{ number: 'INV-1', party: 'ACME', date: '2026-03-01', total: '100.00' }],
  registrationIssues: [],
  hasRecon: true,
};

describe('the credit-at-risk headline', () => {
  it('shows the at-risk figure when a reconciliation exists', () => {
    const h = renderDashboard(base);
    expect(h).toMatch(/1,455\.08/);
    expect(h).toMatch(/credit booked, not yet filed/);
  });

  it('prompts for a reconciliation when none has been run', () => {
    const h = renderDashboard({
      ...base, creditAtRisk: null, creditSupported: null, hasRecon: false });
    expect(h).toMatch(/run a 2B reconciliation/);
    // Falls back to claimed credit rather than showing a 2B figure it lacks.
    expect(h).toMatch(/input credit claimed/);
  });
});

describe('registration issues', () => {
  it('is silent when every supplier is active', () => {
    expect(renderDashboard(base)).not.toMatch(/registration that is not active/);
  });
  it('warns when a supplier is not active', () => {
    const h = renderDashboard({ ...base, registrationIssues: [
      { party: 'Gone Traders', gstin: '09AAAAA0000A1Z5', status: 'Cancelled' }] });
    expect(h).toMatch(/1 supplier\(s\) with a\s+registration that is not active/);
    expect(h).toMatch(/Gone Traders/);
  });
});
