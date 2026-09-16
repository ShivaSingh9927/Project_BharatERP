import { describe, expect, it } from 'vitest';
import { renderAssistantRuns, renderPayables, renderSales, renderShell } from '../src/web/views.ts';

describe('Ask Bharat shell', () => {
  it('is available on every CA screen with page context and read-only wording', () => {
    const html = renderShell({
      session: { clientName: 'Shree Ram Trading Company', displayName: 'CA' },
      accounts: [], active: 'reconcile', body: '<h1>Reconcile</h1>',
    });
    expect(html).toContain('id="ask-toggle"');
    expect(html).toContain('Shree Ram Trading Company · Reconcile');
    expect(html).toContain('How many bank transactions need reconciliation?');
    expect(html).toContain('Read-only preview. It cannot post or change the books.');
    expect(html).toContain("fetch('/api/assistant'");
  });

  it('shows the CA an evidence-bearing AI run log', () => {
    const html = renderAssistantRuns([{
      question: 'Which suppliers are unpaid?', page: 'payables', routingMode: 'deepseek',
      intent: 'payables', provider: 'deepseek', model: 'deepseek-chat',
      answer: 'You owe suppliers ₹117.00.', evidence: ['Payable ledger settlements'],
      supported: true, durationMs: 44, createdAt: '2026-09-16T00:00:00.000Z',
    }]);
    expect(html).toContain('Ask Bharat AI log');
    expect(html).toContain('DeepSeek · payables');
    expect(html).toContain('Payable ledger settlements');
  });

  it('opens an AI-prepared payment as a review-only draft', () => {
    const html = renderPayables({
      bills: [{ voucherId: 'bill-1', billNumber: 'ES-1', supplierName: 'Campus E-Shop',
        billDate: '2026-09-01', dueDate: '2026-09-01', grandTotal: '117.00',
        outstanding: '117.00', daysOverdue: 1, bucket: 'd0_30' }],
      accounts: [{ id: 'bank-1', name: 'Bank Accounts' }], today: '2026-09-16',
      draftVoucherId: 'bill-1',
    });
    expect(html).toContain('AI-prepared draft');
    expect(html).toContain('Approve and record payment');
    expect(html).toContain('It has not posted anything.');
  });

  it('marks an AI invoice draft as unposted and carries only safe prefill data', () => {
    const html = renderSales({
      today: '2026-09-16',
      desk: {
        customers: [{ id: 'customer-1', name: 'ABC Traders', legalName: null, gstin: null,
          gstCategory: 'unregistered', stateCode: '27', phone: null }],
        registrations: [{ id: 'reg-1', gstin: '27ABCDE1234F1Z5', stateCode: '27', primary: true }],
        incomeAccounts: [{ id: 'income-1', name: 'Sales' }], invoices: [],
      },
      draft: { customerId: 'customer-1', amount: '10000.00', gstRate: '18' },
    });
    expect(html).toContain('AI-prepared draft.');
    expect(html).toContain('It has not posted anything.');
    expect(html).toContain('"customerId":"customer-1"');
  });
});
