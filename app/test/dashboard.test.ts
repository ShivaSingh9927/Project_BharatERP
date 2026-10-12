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
  totalPayable: '73583.20', overduePayable: '47575.00', overdueCount: 5,
  recentBills: [{ number: 'INV-1', party: 'ACME', date: '2026-03-01', total: '100.00' }],
  registrationIssues: [],
  hasRecon: true,
};

describe('the credit-at-risk headline', () => {
  it('shows the at-risk figure when a reconciliation exists', () => {
    const h = renderDashboard(base);
    expect(h).toMatch(/1,455\.08/);
    expect(h).toMatch(/Credit not yet supported/);
    expect(h).toMatch(/credit is not yet supported/);
  });

  it('prompts for a reconciliation when none has been run', () => {
    const h = renderDashboard({
      ...base, creditAtRisk: null, creditSupported: null, hasRecon: false });
    expect(h).toMatch(/Compare supplier filings/);
    // It clearly labels this as the claimed amount and says the 2B check is missing.
    expect(h).toMatch(/Input credit claimed/);
    expect(h).toMatch(/No 2B check recorded for this period/);
  });
});

describe('the payables tiles', () => {
  it('shows the total owed and the overdue slice', () => {
    const h = renderDashboard(base);
    expect(h).toMatch(/73,583\.20/);
    expect(h).toMatch(/Supplier payables/);
    expect(h).toMatch(/47,575\.00/);
    expect(h).toMatch(/5 overdue · ₹47,575\.00/);
  });
  it('reads calm when nothing is overdue', () => {
    const h = renderDashboard({ ...base, overduePayable: '0.00', overdueCount: 0 });
    expect(h).toMatch(/Nothing overdue/);
  });
});

describe('registration issues', () => {
  it('is silent when every supplier is active', () => {
    expect(renderDashboard(base)).not.toMatch(/registration that is not active/);
  });
  it('warns when a supplier is not active', () => {
    const h = renderDashboard({ ...base, registrationIssues: [
      { party: 'Gone Traders', gstin: '09AAAAA0000A1Z5', status: 'Cancelled' }] });
    expect(h).toMatch(/1 supplier GST registration issue/);
    expect(h).toMatch(/Gone Traders/);
  });
});

describe('Today owner overview', () => {
  it('uses the live dashboard data in the handoff layout and keeps actions reachable', () => {
    const h = renderDashboard({ ...base,
      displayName: 'Shiva Singh', role: 'Owner',
      obligations: [{ id: 'obligation-1', clientId: 'client-1', registrationId: null,
        kind: 'GSTR-3B', periodKey: '2026-03', identityKey: 'gstr3b:2026-03', ownerUserId: null,
        createdAt: '2026-03-01T00:00:00.000Z', workflowState: 'prepared', history: [] }],
      followUps: [{ id: 'follow-up-1', title: 'Review rent document', details: '', sourceQuestion: null,
        sourceAnswer: null, assigneeUserId: null, assigneeName: 'CA Reviewer', dueDate: null,
        priority: 'normal', status: 'open', createdBy: 'user-1', completedBy: null,
        createdAt: '2026-03-01T00:00:00.000Z', completedAt: null, blockerReason: null,
        snoozedUntil: null, sourceNexusTaskId: null, history: [] }],
      founderRequests: [{ id: 'request-1', documentId: 'document-1', question: 'Please share the rent agreement.' }],
      activity: [{ id: 'activity-1', kind: 'document_received', occurredAt: '2026-03-01T00:00:00.000Z',
        title: 'Document received', detail: 'rent-agreement.pdf', status: 'received', direction: 'incoming', href: '/documents' }],
      setup: { pan: 'ABCDE1234F', gstin: null, bankAccounts: 1, teamMembers: 2 },
    });
    expect(h).toMatch(/Good (morning|afternoon|evening), Shiva/);
    expect(h).toContain('Needs you');
    expect(h).toContain('Ask anything about this client');
    expect(h).toContain('Supplier payables');
    expect(h).toContain('GST credit');
    expect(h).toContain('Recorded compliance work');
    expect(h).toContain('deadline not recorded here');
    expect(h).toContain('Review rent document');
    expect(h).toContain('Your CA asked for information');
    expect(h).toContain('/documents?document=document-1');
    expect(h).toContain('Document received');
    expect(h).toContain('href="/gstr2b"');
    expect(h).toContain('href="/payables"');
    expect(h).toContain('href="/setup"');
    expect(h).toContain('href="/activity"');
    expect(h).toContain('href="/attention"');
    expect(h).toContain('href="/follow-ups"');
    expect(h).not.toContain('Acme Textiles');
    expect(h).not.toContain('R. Shah');
  });

  it('shows a useful calm state when no additional review data has been recorded', () => {
    const h = renderDashboard({ ...base, overdueCount: 0, overduePayable: '0.00', openReconItems: 0,
      creditAtRisk: '0.00', registrationIssues: [], obligations: [], followUps: [], activity: [] });
    expect(h).toContain('0 things need your attention');
    expect(h).toContain('No compliance timeline items have been recorded');
    expect(h).toContain('No client activity recorded yet');
  });

  it('keeps firm-only links visible to CA roles even with the Today sub-navigation removed', () => {
    const h = renderDashboard({ ...base, role: 'CA partner' });
    expect(h).toContain('href="/firm"');
    expect(h).toContain('href="/email-inbox"');
    expect(h).toContain('href="/tally"');
  });
});
