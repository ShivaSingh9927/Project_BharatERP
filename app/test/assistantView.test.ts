import { describe, expect, it } from 'vitest';
import { renderAssistantRuns, renderClientSetup, renderDocumentInbox, renderEmailInbox, renderImport, renderNexus, renderPayables, renderQueue, renderReceivables, renderSales, renderShell } from '../src/web/views.ts';

describe('document class review UI', () => {
  const document = {
    id: 'doc-1', originalName: 'statement.pdf', mimeType: 'application/pdf', size: 1024,
    hash: 'a'.repeat(64), status: 'received', receivedAt: '2026-10-01T00:00:00.000Z',
    linkedVoucherId: null, available: true, reviewNote: null, reviewUpdatedAt: null,
    classSuggestion: { documentClass: 'bank_statement', subtype: null, confidence: 72,
      rationale: 'Bank header found.', evidence: ['ACCOUNT STATEMENT'], provider: 'deepseek', model: 'deepseek-chat' },
    classConfirmation: null,
  };
  it('does not offer a workflow action until a human confirms or corrects the suggestion', () => {
    const pending = renderDocumentInbox([document], false, [], { enabled: true, available: true });
    expect(pending).toContain('Nexus suggestion');
    expect(pending).toContain('Confirm class');
    expect(pending).not.toContain('/import?document=doc-1');

    const confirmed = renderDocumentInbox([{ ...document,
      classConfirmation: { documentClass: 'bank_statement', confirmedAt: '2026-10-01T00:01:00.000Z' },
    }], false, [], { enabled: true, available: true });
    expect(confirmed).toContain('/import?document=doc-1');
    expect(confirmed).toContain('Continue to statement preview');
  });
});

describe('Ask Bharat shell', () => {
  it('shows the CA a local Unassigned email queue and client references', () => {
    const html = renderEmailInbox({
      clients: [{ id: 'client-1', name: 'ABC Traders', token: 'a'.repeat(20) }],
      messages: [{ id: 'email-1', sender: 'vendor@example.test', recipients: ['inbox@example.test'],
        subject: 'Invoice', bodyText: 'Please see attached.', receivedAt: '2026-10-01T00:00:00.000Z',
        status: 'unassigned', suggestedClientId: null, routingReason: 'No verified client match',
        clientId: null, clientName: null, routingMethod: null, processingError: null,
        attachmentCount: 1, attachmentNames: ['invoice.pdf'], documentIds: [] }],
    });
    expect(html).toContain('Unassigned · 1');
    expect(html).toContain('inbox+aaaaaaaaaaaaaaaaaaaa');
    expect(html).toContain('data-id="email-1"');
    expect(html).toContain('Trust this sender');
    expect(html).toContain("fetch('/api/email-inbox/sample'");
    const caShell = renderShell({ session: { clientName: 'ABC Traders', role: 'ca_staff',
      boundClientId: null }, accounts: [], active: 'email-inbox', body: html });
    const founderShell = renderShell({ session: { clientName: 'ABC Traders', role: 'owner',
      boundClientId: 'client-1' }, accounts: [], active: 'nexus', body: '' });
    expect(caShell).toContain('href="/email-inbox"');
    expect(founderShell).not.toContain('href="/email-inbox"');
  });
  it('gives the agent a dedicated client-scoped chat with saved exchanges', () => {
    const html = renderNexus('Acme & Co', [{
      question: '<Where are my files?>', page: 'nexus', routingMode: 'deterministic',
      intent: 'documents', provider: null, model: null,
      answer: 'Three files were received.', evidence: ['Client document inbox'],
      supported: true, durationMs: 15, createdAt: '2026-10-01T00:00:00.000Z',
    }]);
    expect(html).toContain('Bharat Nexus');
    expect(html).toContain('Acme &amp; Co');
    expect(html).toContain('&lt;Where are my files?&gt;');
    expect(html).toContain('Three files were received.');
    expect(html).toContain("fetch('/api/assistant'");
    expect(html).toContain("page: 'nexus'");
  });

  it('shows founders what information is needed and what is waiting on the CA', () => {
    const html = renderNexus('Acme', [], [], [], [
      { id: 'doc-1', originalName: 'supplier-bill.pdf', mimeType: 'application/pdf',
        size: 100, hash: 'a'.repeat(64), status: 'needs_information',
        receivedAt: '2026-10-01T00:00:00.000Z', linkedVoucherId: null, available: true,
        reviewNote: 'Please send the missing page.', reviewUpdatedAt: '2026-10-01T01:00:00.000Z' },
      { id: 'doc-2', originalName: 'bank-statement.pdf', mimeType: 'application/pdf',
        size: 200, hash: 'b'.repeat(64), status: 'received',
        receivedAt: '2026-10-01T00:00:00.000Z', linkedVoucherId: null, available: true,
        reviewNote: null, reviewUpdatedAt: null },
    ]);
    expect(html).toContain('Needs founder input · 1');
    expect(html).toContain('Please send the missing page.');
    expect(html).toContain('With the CA · 1');
    expect(html).toContain('/documents#doc-doc-1');
    expect(html).toContain('/documents#doc-doc-2');
  });
  it('lets a founder answer a specific document request and upload files in Nexus', () => {
    const html = renderNexus('Acme', [], [], [], [{
      id: 'doc-1', originalName: 'supplier-bill.pdf', mimeType: 'application/pdf',
      size: 100, hash: 'a'.repeat(64), status: 'needs_information',
      receivedAt: '2026-10-01T00:00:00.000Z', linkedVoucherId: null, available: true,
      reviewNote: 'Please send the missing page.', reviewUpdatedAt: '2026-10-01T01:00:00.000Z',
    }], [{ id: 'request-1', documentId: 'doc-1', question: 'Please send the missing page.',
      requestedAt: '2026-10-01T01:00:00.000Z' }], true);
    expect(html).toContain('id="nexus-upload-form"');
    expect(html).toContain('data-request-id="request-1"');
    expect(html).toContain('Send answer');
    expect(html).toContain("fetch('/api/document-requests/'");
    expect(renderNexus('Acme', [], [], [], [], [], false)).not.toContain('data-request-id=');
  });
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
    expect(html).toContain('<summary>WORKFLOW</summary>');
    expect(html).toContain('<summary>BOOKS</summary>');
    expect(html).toContain('<summary>BANKING</summary>');
    expect(html).toContain('<summary>COMPLIANCE</summary>');
    expect(html).toContain('<summary>TOOLS</summary>');
    expect(html).toContain('overscroll-behavior: contain');
    expect(html).toContain('.page-context b { display: none; }');
  });

  it('shows the CA an evidence-bearing AI run log', () => {
    const html = renderAssistantRuns([{
      question: 'Which suppliers are unpaid?', page: 'payables', routingMode: 'deepseek',
      intent: 'payables', provider: 'deepseek', model: 'deepseek-chat',
      answer: 'You owe suppliers ₹117.00.', evidence: ['Payable ledger settlements'],
      supported: true, durationMs: 44, createdAt: '2026-09-16T00:00:00.000Z',
    }]);
    expect(html).toContain('Ask Bharat AI log');
    expect(html).toContain('Nexus · payables');
    expect(html).toContain('Payable ledger settlements');
  });

  it('makes bank-entry review steps and safe save action clear', () => {
    const html = renderQueue({
      items: [{
        bankTransactionId: 'txn-1', txnDate: '2026-10-06', narration: 'UPI receipt',
        direction: 'inbound', debit: '0.00', credit: '1000.00', unmatchedAmount: '1000.00',
        paymentMode: 'UPI', reference: 'ref-1', status: 'unmatched', counterpartyName: null,
        proposal: { best: null, reason: 'No likely match', runnersUp: [], ambiguous: false, autoMatchable: false },
        suggestedClassification: null, suggestedExpenseAccount: null, reviewClassification: null,
        reviewSourceName: null, fundingSuggestion: null, reviewNote: null,
      }] as never,
      totals: { unmatched: 1, matched: 0, autoMatchable: 0, ambiguous: 0, unsure: 0 },
    }, { ties: true, difference: '0.00' } as never,
      'bank-1',
      { expenseAccounts: [], transferAccounts: [], personalAccountName: 'Personal Account' },
      { enabled: true, available: true },
    );
    expect(html).toContain('choose a type');
    expect(html).toContain('1. What best describes this transaction?');
    expect(html).toContain('class="review-kind-picker"');
    expect(html).toContain('data-kind="share_application_pending"');
    expect(html).toContain("document.addEventListener('pointerdown'");
    expect(html).toContain("document.addEventListener('focusin'");
    expect(html).toContain("if (!picker.contains(event.target)) picker.open = false");
    expect(html).toContain('Save answer');
    expect(html).toContain('does not post or reconcile anything');
    expect(html).not.toContain('r.onclick =');
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

  it('shows overdue payment reminders only as WhatsApp review drafts', () => {
    const html = renderReceivables({
      invoices: [{ voucherId: 'invoice-1', invoiceNumber: 'INV-1', partyId: 'customer-1',
        customerName: 'ABC Traders', customerPhone: '9876543210', invoiceDate: '2026-08-01',
        dueDate: '2026-09-01', grandTotal: '118.00', outstanding: '118.00',
        tdsWithheld: '0.00', daysOverdue: 15, bucket: 'd0_30' }],
      accounts: [], reminders: true,
    });
    expect(html).toContain('Payment reminder drafts');
    expect(html).toContain('Review in WhatsApp');
    expect(html).toContain('does not send messages automatically');
  });

  it('guides a client through the essential setup steps', () => {
    const html = renderClientSetup({
      name: 'ABC Traders', pan: null, gstin: null, bankAccounts: 0, teamMembers: 1,
    });
    expect(html).toContain('Set up ABC Traders');
    expect(html).toContain('Company and GST details');
    expect(html).toContain('Import existing books from Tally');
    expect(html).toContain('/api/client-setup');
  });

  it('makes a truncated statement preview explicit and expandable', () => {
    const html = renderImport({
      accounts: [{
        id: 'bank-1', bank_name: 'SBI', last4: '1234', hasSavedPassword: false,
        coverage: {
          coveredFrom: null, coveredTo: null, gaps: [], nextExpectedFrom: null,
        },
      }],
      banks: ['State Bank of India'],
    });
    expect(html).toContain('Statement password');
    expect(html).toContain('Remember securely for this account');
    expect(html).toContain('Transactions — showing');
    expect(html).toContain('show-all-rows');
    expect(html).toContain('r.rows.slice(0, 12)');
    expect(html).toContain('r.rows.map(transactionRow)');
  });
});
