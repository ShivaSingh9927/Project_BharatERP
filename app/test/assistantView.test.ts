import { describe, expect, it } from 'vitest';
import { renderAccounts, renderAssistantRuns, renderBalanceSheet, renderBillReview, renderClientSetup, renderCockpit, renderCustomers, renderDocumentInbox, renderEmailInbox, renderImport, renderNexus, renderNexusBankTransactionSource, renderPayables, renderPeriodClose, renderProfitAndLoss, renderQueue, renderReceivables, renderSales, renderShell, renderTallyImport } from '../src/web/views.ts';

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
    expect(pending).toContain('Confirm type');
    expect(pending).not.toContain('/import?document=doc-1');

    const confirmed = renderDocumentInbox([{ ...document,
      classConfirmation: { documentClass: 'bank_statement', confirmedAt: '2026-10-01T00:01:00.000Z' },
    }], false, [], { enabled: true, available: true });
    expect(confirmed).toContain('/import?document=doc-1');
    expect(confirmed).toContain('Continue to statement preview');
  });

  it('keeps received documents selectable and filterable without changing their review state', () => {
    const completed = { ...document, id: 'doc-2', originalName: 'bill.pdf', status: 'processed',
      classSuggestion: null,
      classConfirmation: { documentClass: 'purchase_bill', confirmedAt: '2026-10-02T00:00:00.000Z' } };
    const html = renderDocumentInbox([document, completed], false, [],
      { enabled: true, available: true }, true, 'doc-2', 'moved', 'purchase_bill');
    expect(html).toContain('<h1>Inbox</h1>');
    expect(html).toContain('Received · 1');
    expect(html).toContain('bill.pdf');
    expect(html).not.toContain('statement.pdf');
    expect(html).toContain('Now in Bills');
    expect(html).toContain('aria-label="Filter received documents"');
  });

  it('renders the handoff review workspace with real source metadata and founder replies gated by role', () => {
    const receivedByEmail = { ...document, channel: 'email', sender: 'accounts@example.test' };
    const request = { id: 'request-1', documentId: document.id,
      question: 'Please provide the missing invoice.', requestedAt: '2026-10-02T00:00:00.000Z' };
    const owner = renderDocumentInbox([receivedByEmail], false, [],
      { enabled: true, available: true }, true, document.id, 'all', 'all', [request], true);
    expect(owner).toContain('inbox-review-grid');
    expect(owner).toContain('Preview is not available in this workspace yet.');
    expect(owner).toContain('Email · accounts@example.test');
    expect(owner).toContain('Confirm or correct type');
    expect(owner).toContain('data-class="bank_statement"');
    expect(owner).toContain('Your CA asked · 1');
    expect(owner).toContain('/api/document-requests/');
    expect(owner).not.toContain('deepseek');

    const ca = renderDocumentInbox([receivedByEmail], true, [],
      { enabled: true, available: true }, true, document.id, 'all', 'all', [request], false);
    expect(ca).toContain('CA review actions');
    expect(ca).not.toContain('Your CA asked · 1');
  });
});

describe('bill review navigation', () => {
  it('shows status filters and plain next-step guidance without changing bill approval rules', () => {
    const bill = {
      index: 0, status: 'ready' as const, documentNumber: 'INV-10', partyName: 'Supplier',
      supplierGstin: null, billDate: '2026-10-01', readBy: 'coordinates',
      taxable: '100.00', tax: '18.00', total: '118.00', totalIsUnverified: false,
      canRecordExpenseOnly: false, registrationStatus: null, partyId: null,
      lines: [{ description: 'Office supplies', amount: '100.00', hsn: null }],
      warnings: [], blockers: [], confirmations: [], tds: null,
    };
    const html = renderBillReview({
      proposals: [bill], token: null, posted: [], hasExpenseAccount: true,
      accounts: [], defaultAccountId: null, canApprove: false,
    });
    expect(html).toContain('Need your input');
    expect(html).toContain('data-status="ready"');
    expect(html).toContain('bill shown');
    expect(html).toContain('CA partner must approve');
    expect(html.split('<script>')[0]).not.toContain('class="primary post"');
  });
});

describe('firm workspace orientation', () => {
  it('labels firm cockpit and Tally tools while preserving review-first guidance', () => {
    const cockpit = renderCockpit({
      period: '2026-10', periods: ['2026-10'], today: '2026-10-12', rows: [],
      totals: { clients: 0, outputTax: '0.00', creditAtRisk: '0.00',
        overduePayable: '0.00', needingAttention: 0, documentsWaiting: 0,
        informationRequested: 0 },
    });
    expect(cockpit).toContain('<p class="eyebrow">FIRM WORKSPACE</p>');
    expect(cockpit).toContain('Every client, sorted by what needs you');

    const tally = renderTallyImport();
    expect(tally).toContain('<p class="eyebrow">FIRM TOOLS</p>');
    expect(tally).toContain('Preview each XML file here');
    expect(tally).toContain('Nothing is added to the books until');
  });
});

describe('BharatERP redesign shell', () => {
  it('hides bank setup controls from read-only roles', () => {
    const empty = renderAccounts([], '2026-10-11', false);
    expect(empty).toContain('No bank accounts are configured');
    expect(empty).not.toContain('Add your bank account');
    const existing = renderAccounts([{ id: 'a1', bank_name: 'HDFC', last4: '4961', kind: 'current' }], '2026-10-11', false);
    expect(existing).toContain('HDFC');
    expect(existing).toContain('<p class="eyebrow">BANKING</p>');
    expect(existing).not.toContain('Add another bank account');
  });

  it('renders bank evidence as an escaped read-only source page', () => {
    const html = renderNexusBankTransactionSource({
      id: 'source-1', txn_date: '2026-10-01', value_date: null,
      narration: '<script>untrusted narration</script>', debit: '99.00', credit: '0.00',
      running_balance: '1000.00', reference_number: null, payment_mode: 'upi',
      counterparty_name: 'Vendor', bank_name: 'HDFC', account_number_last4: '4961',
      statement_from: '2026-10-01', statement_to: '2026-10-31',
    });
    expect(html).toContain('Bank line evidence');
    expect(html).toContain('&lt;script&gt;untrusted narration&lt;/script&gt;');
    expect(html).not.toContain('<script>untrusted narration</script>');
    expect(html).toContain('does not change reconciliation or accounting records');
  });
  it('shows the CA a local Unassigned email queue and client references', () => {
    const html = renderEmailInbox({
      clients: [{ id: 'client-1', name: 'ABC Traders', token: 'a'.repeat(20) }],
      messages: [{ id: 'email-1', sender: 'vendor@example.test', recipients: ['inbox@example.test'],
        subject: 'Invoice', bodyText: 'Please see attached.', receivedAt: '2026-10-01T00:00:00.000Z',
        status: 'unassigned', suggestedClientId: null, routingReason: 'No verified client match',
        clientId: null, clientName: null, routingMethod: null, processingError: null,
        attachmentCount: 1, attachmentNames: ['invoice.pdf'], documentIds: [] }],
    });
    expect(html).toContain('<p class="eyebrow">INBOX</p>');
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
    expect(caShell).toContain('href="/firm"');
    expect(caShell).toContain('href="/tally"');
    expect(caShell).toContain('.firm-nav { display: flex; max-width: 36vw; overflow-x: auto;');
    expect(founderShell).not.toContain('href="/email-inbox"');
    expect(founderShell).not.toContain('href="/tally"');
  });
  it('gives the agent a dedicated client-scoped chat with saved exchanges', () => {
    const html = renderNexus('Acme & Co', [{
      question: '<Where are my files?>', page: 'nexus', routingMode: 'deterministic',
      intent: 'documents', provider: null, model: null,
      answer: 'Three files were received.', evidence: ['Client document inbox'],
      supported: true, durationMs: 15, createdAt: '2026-10-01T00:00:00.000Z',
    }]);
    expect(html).toContain('Ask Nexus');
    expect(html).toContain('Acme &amp; Co');
    expect(html).toContain('&lt;Where are my files?&gt;');
    expect(html).toContain('Three files were received.');
    expect(html).toContain("fetch('/api/assistant'");
    expect(html).toContain("page: 'nexus'");
  });

  it('renders recent Nexus cases and safely escaped saved messages', () => {
    const html = renderNexus('Acme', [], [], [], [], [], false, undefined, {
      cases: [{ id: 'case-1', title: '<Review & follow up>', state: 'completed', created_at: '2026-10-10' }],
      selectedCase: { id: 'case-1', title: '<Review & follow up>', state: 'completed' },
      messages: [
        { id: 'msg-1', actor_type: 'user', body: '<script>alert(1)</script>', recorded_at: '2026-10-10' },
        { id: 'msg-2', actor_type: 'nexus', body: 'Saved answer & evidence.', recorded_at: '2026-10-10' },
      ],
    });
    expect(html).toContain('Saved conversations');
    expect(html).toContain('&lt;Review &amp; follow up&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Saved answer &amp; evidence.');
    expect(html).not.toContain('<div class="nexus-question">You</div>');
    expect(html).not.toContain('<div class="nexus-question">Nexus</div>');
    expect(html).toContain('/nexus?case=case-1');
  });

  it('renders a fresh Nexus workspace with a conversation rail, evidence panel, and role label', () => {
    const html = renderNexus('Acme', [], [], [], [], [], false, undefined, {
      cases: [{ id: 'case-1', title: 'Open bills', state: 'open', created_at: '2026-10-10' }],
      selectedCase: null, messages: [], newConversation: true, viewerLabel: 'Owner',
    });
    expect(html).toContain('class="nexus-workspace"');
    expect(html).toContain('aria-label="Nexus conversations"');
    expect(html).toContain('＋ New conversation');
    expect(html).toContain('Saved conversations');
    expect(html).toContain('What would you like to work on?');
    expect(html).toContain('Viewing as <b>Owner</b>');
    expect(html).toContain('Receipts for this answer');
    expect(html).toContain('Evidence links appear here when Nexus answers with structured records.');
    expect(html).toContain('id="nexus-upload-files"');
    expect(html).toContain('id="nexus-upload-form"');
    expect(html).toContain('id="nexus-bank-open"');
    expect(html).toContain('Waiting on you · 0');
    const shell = renderShell({ session: { clientName: 'Acme', role: 'owner', boundClientId: 'client-1' },
      accounts: [], active: 'nexus', body: html });
    expect(shell).toContain('grid-template-columns: 220px minmax(390px, 1fr) minmax(280px, 330px)');
    expect(html).not.toContain('href="/email-inbox"');
    expect(html).not.toContain('href="/firm"');
    const caHtml = renderNexus('Acme', [], [], [], [], [], false, undefined, {
      cases: [], selectedCase: null, messages: [], viewerLabel: 'CA staff',
    });
    expect(caHtml).toContain('href="/email-inbox"');
    expect(caHtml).toContain('href="/firm"');
    expect(caHtml).toContain('href="/tally"');
  });

  it('links evidence receipts only to valid scoped bank source identifiers', () => {
    const blocks = { schema_version: 1, generated_at: '2026-10-10T00:00:00.000Z', blocks: [
      { id: 'summary', type: 'paragraph', text: 'Checked a bank line.', provenance: {
        as_of: '2026-10-10T00:00:00.000Z', sources: [{ kind: 'bank_transaction',
          id: '123e4567-e89b-12d3-a456-426614174000', label: '<Imported line>' }],
        coverage: { scope: 'Account · period', completeness: 'complete', limitations: [] },
      } },
    ] };
    const html = renderNexus('Acme', [], [], [], [], [], false, undefined, {
      cases: [], selectedCase: { id: 'case-1', title: 'Bank check', state: 'open' },
      messages: [{ id: 'msg-1', actor_type: 'nexus', body: 'Checked a bank line.',
        response_blocks: blocks as never, recorded_at: '2026-10-10' }],
    });
    expect(html).toContain('&lt;Imported line&gt;');
    expect(html).toContain('/nexus/source/bank-transaction?id=123e4567-e89b-12d3-a456-426614174000');
    expect(html).toContain('Receipts for this answer');
  });

  it('shows a read-only bank activity control and saved response blocks inside the chat', () => {
    const blocks = { schema_version: 1, generated_at: '2026-10-10T00:00:00.000Z', blocks: [
      { id: 'summary', type: 'paragraph', text: 'Checked two lines.', provenance: {
        as_of: '2026-10-10T00:00:00.000Z', sources: [{ kind: 'bank_statement', id: 'source-1', label: 'Statement' }],
        coverage: { scope: 'Account · period', completeness: 'complete', limitations: [] },
      } },
    ] };
    const html = renderNexus('Acme', [], [], [], [], [], false, undefined, {
      cases: [], selectedCase: { id: 'case-1', title: 'Bank activity', state: 'open' },
      bankAccounts: [{ id: 'account-1', bank_name: 'HDFC', account_number_last4: '4961' }],
      messages: [{ id: 'msg-1', actor_type: 'nexus', body: 'Checked two lines.', response_blocks: blocks as never, recorded_at: '2026-10-10' }],
    });
    expect(html).toContain('Review bank activity');
    expect(html).toContain('Show activity in this conversation');
    expect(html).toContain('Read-only summary');
    expect(html).toContain('last 30 India (IST) calendar dates');
    expect(html).toMatch(/name="fromDate" required value="\d{4}-\d{2}-\d{2}"/);
    expect(html).toContain('Checked two lines.');
    expect(html).toContain('Account · period');
    expect(html).toContain("fetch('/api/nexus/bank-activity'");
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
    expect(html).toContain('Waiting on you · 1');
    expect(html).toContain('Please send the missing page.');
    expect(html).toContain('With your CA · 1');
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
  it('shows scoped long-running review consent, timeline selection, and escaped attempt history', () => {
    const html = renderNexus('Acme', [], [], [], [], [], false, {
      enabled: true, available: true, canManage: true,
      obligations: [{ id: 'obl-1', clientId: 'client-1', registrationId: null, kind: 'GSTR-3B',
        periodKey: '2026-09', identityKey: 'gstr3b-2026-09', ownerUserId: null,
        createdAt: '2026-10-01T00:00:00.000Z', workflowState: 'needs_human_review', history: [] }],
      tasks: [{ id: 'task-1', purpose: '<Review this>', specialist: 'gst', status: 'completed',
        currentAttempt: 1, maxAttempts: 4, attempts: [
          { ordinal: 1, agent_role: 'gst', outcome: 'completed', result: { summary: '<untrusted model text>' }, verifier_findings: [], addressed_findings: [] },
        ] }],
    });
    expect(html).toContain('Data sharing and Nexus task consent · On');
    expect(html).toContain('value="obl-1"');
    expect(html).toContain('Create review task');
    expect(html).toContain('&lt;Review this&gt;');
    expect(html).toContain('&lt;untrusted model text&gt;');
    expect(html).toContain('cannot file, pay, reconcile, or change a book entry');
    expect(html).toContain("fetch('/api/nexus/tasks'");
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
    expect(html).toContain('class="primary-header"');
    expect(html).toContain('aria-label="Main navigation"');
    expect(html).toContain('href="/reconcile" class="on" aria-current="page">Bank</a>');
    expect(html).toContain('href="/brs" class=""');
    expect(html).toContain('class="secondary-nav" aria-label="Bank navigation"');
    expect(html).toContain('id="ask-toggle"');
    expect(html).toContain('aria-label="Ask Nexus"');
    expect(html).toContain('href="/documents#document-files"');
    expect(html).toContain('href="/password"');
    expect(html).toContain('@font-face');
    expect(html).toContain('href="#main-content"');
    expect(html).toContain('<main id="main-content">');
    expect(html).not.toContain('<div class="page-context"><b>Reconcile</b>');
    expect(html).not.toContain('WORKFLOW');
  });

  it('keeps every existing workspace destination reachable through contextual navigation', () => {
    const session = { clientName: 'ABC Traders', role: 'owner', boundClientId: 'client-1' };
    const destinations: Array<[string, string[]]> = [
      ['home', ['/']],
      ['nexus', ['/nexus', '/assistant-runs']],
      ['documents', ['/documents']],
      ['bills', ['/bills', '/payables', '/suppliers', '/returns']],
      ['sales', ['/sales', '/receivables', '/customers']],
      ['reconcile', ['/reconcile', '/import', '/brs', '/cash', '/accounts']],
      ['gstr2b', ['/gstr2b', '/gstr1', '/gstr3b', '/tds']],
      ['profit-loss', ['/reports/profit-loss', '/reports/balance-sheet', '/reports/close-month', '/assets']],
    ];
    for (const [active, links] of destinations) {
      const html = renderShell({ session, accounts: [], active, body: '' });
      for (const href of links) expect(html, `${active} navigation should expose ${href}`).toContain(`href="${href}`);
    }
    const todayShell = renderShell({ session, accounts: [], active: 'home', body: '' });
    expect(todayShell).not.toContain('aria-label="Today navigation"');

    const firmShell = renderShell({ session: { clientName: 'Firm', role: 'ca_partner', boundClientId: null },
      accounts: [], active: 'firm', body: '' });
    expect(firmShell).toContain('href="/firm"');
    expect(firmShell).toContain('href="/email-inbox"');
    expect(firmShell).toContain('href="/tally"');
    expect(firmShell).toContain('aria-label="Sign out"');
    expect(firmShell).not.toContain('aria-label="Today navigation"');
    const tallyShell = renderShell({ session: { clientName: 'Firm', role: 'ca_partner', boundClientId: null },
      accounts: [], active: 'tally', body: '' });
    expect(tallyShell).not.toContain('aria-label="Today navigation"');
    expect(tallyShell).toContain('href="/tally" class="on" aria-current="page">Tally</a>');
    const followUpsShell = renderShell({ session: { clientName: 'Firm', role: 'ca_partner', boundClientId: null },
      accounts: [], active: 'follow-ups', body: '' });
    expect(followUpsShell.match(/>Review desk<\/a>/g)).toHaveLength(1);
    const firmInbox = renderShell({ session: { clientName: 'Firm', role: 'ca_staff', boundClientId: null },
      accounts: [], active: 'documents', body: '' });
    expect(firmInbox).toContain('href="/email-inbox"');
    expect(firmInbox.match(/href="\/email-inbox"/g)).toHaveLength(1);
    const ownerInbox = renderShell({ session, accounts: [], active: 'documents', body: '' });
    expect(ownerInbox).not.toContain('href="/email-inbox"');
  });

  it('renders exact client report values with date filters and an expandable trial balance', () => {
    const profit = renderProfitAndLoss({ from: '2026-10-01', to: '2026-10-31', report: {
      revenue: '12345678901234567890.12', cogs: '1.00', grossProfit: '12345678901234567889.12',
      operatingExpenses: '2.00', operatingProfit: '12345678901234567887.12',
      nonOperating: '3.00', netProfit: '12345678901234567884.12',
    } });
    expect(profit).toContain('name="from" value="2026-10-01"');
    expect(profit).toContain('name="to" value="2026-10-31"');
    expect(profit).toContain('<p class="eyebrow">REPORTS</p>');
    expect(profit).toContain('1,23,45,67,89,01,23,45,67,890.12');
    expect(profit).toContain('Figures are computed from posted ledger entries');

    const balance = renderBalanceSheet({ asOf: '2026-10-31', report: {
      currentAssets: '100.00', nonCurrentAssets: '20.00', totalAssets: '120.00',
      currentLiabilities: '30.00', nonCurrentLiabilities: '10.00', totalLiabilities: '40.00',
      equity: '60.00', retainedProfit: '20.00', totalEquity: '80.00',
      totalLiabilitiesAndEquity: '120.00', workingCapital: '70.00', balanced: true,
    }, trialBalance: { rows: [{ code: '1000', name: 'Cash', debit: '100.00', credit: '0.00' }],
      totalDebit: '100.00', totalCredit: '100.00', balanced: true } });
    expect(balance).toContain('<details class="panel"><summary>Trial balance');
    expect(balance).toContain('<p class="eyebrow">REPORTS</p>');
    expect(balance).toContain('Balance and trial balance checks');
    expect(balance).toContain('Cash');
  });

  it('makes close-month human approval and blockers clear without exposing an action to owners', () => {
    const period = { label: '2026-10', startDate: '2026-10-01', endDate: '2026-10-31',
      isClosed: false, closedAt: null };
    const partner = renderPeriodClose({ periods: [period], selected: '2026-10',
      check: { ok: false, blockers: ['<unmatched bank items>'] }, canClose: true });
    expect(partner).toContain('Close with recorded reason');
    expect(partner).toContain('<p class="eyebrow">REPORTS</p>');
    expect(partner).toContain('&lt;unmatched bank items&gt;');
    expect(partner).toContain('method="post" action="/reports/close-month"');
    const owner = renderPeriodClose({ periods: [period], selected: '2026-10',
      check: { ok: true, blockers: [] }, canClose: false });
    expect(owner).not.toContain('id="period-close-form"');
    expect(owner).toContain('A CA partner must complete the close');
  });

  it('provides a client-scoped customer list with statement links and safe empty state', () => {
    const html = renderCustomers([{ id: 'customer-1', name: '<Acme>', legalName: 'Acme Trading',
      gstin: null, gstCategory: 'unregistered', stateCode: '27', phone: null }]);
    expect(html).toContain('&lt;Acme&gt;');
    expect(html).toContain('Unregistered');
    expect(html).toContain('/receivables?party=customer-1');
    expect(renderCustomers([])).toContain('No customers have been added yet');
  });

  it('shows the CA an evidence-bearing AI run log', () => {
    const html = renderAssistantRuns([{
      question: 'Which suppliers are unpaid?', page: 'payables', routingMode: 'deepseek',
      intent: 'payables', provider: 'deepseek', model: 'deepseek-chat',
      answer: 'You owe suppliers ₹117.00.', evidence: ['Payable ledger settlements'],
      supported: true, durationMs: 44, createdAt: '2026-09-16T00:00:00.000Z',
    }]);
    expect(html).toContain('Nexus activity');
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
    expect(html).toContain('<p class="eyebrow">BANKING</p>');
    expect(html).toContain('1. What best describes this transaction?');
    expect(html).toContain('class="review-kind-picker"');
    expect(html).toContain('data-kind="share_application_pending"');
    expect(html).toContain("document.addEventListener('pointerdown'");
    expect(html).toContain("document.addEventListener('focusin'");
    expect(html).toContain("if (!picker.contains(event.target)) picker.open = false");
    expect(html).toContain('Save answer');
    expect(html).toContain('does not post or reconcile anything');
    expect(html).not.toContain('r.onclick =');

    const staffHtml = renderQueue({
      items: [{
        bankTransactionId: 'txn-1', txnDate: '2026-10-06', narration: 'UPI receipt',
        direction: 'inbound', debit: '0.00', credit: '1000.00', unmatchedAmount: '1000.00',
        paymentMode: 'UPI', reference: 'ref-1', status: 'unmatched', counterpartyName: null,
        proposal: { best: null, reason: 'No likely match', runnersUp: [], ambiguous: false, autoMatchable: false },
        suggestedClassification: null, suggestedExpenseAccount: null, reviewClassification: null,
        reviewSourceName: null, fundingSuggestion: null, reviewNote: null,
      }] as never,
      totals: { unmatched: 1, matched: 0, autoMatchable: 0, ambiguous: 0, unsure: 0 },
    }, { ties: true, difference: '0.00' } as never, 'bank-1',
    { expenseAccounts: [], transferAccounts: [], personalAccountName: 'Personal Account' },
    { enabled: true, available: true, canReview: true, canPost: false, canManageSettings: false });
    expect(staffHtml).toContain('can save an unsure or pending review');
    expect(staffHtml).not.toContain('data-kind="business_expense"');
    expect(staffHtml).not.toContain('data-kind="transfer"');
    expect(staffHtml).not.toContain('class="review-expense"');
    expect(staffHtml).not.toContain('id="toggle-bank-classifier"');

    const auditorHtml = renderQueue({
      items: [{
        bankTransactionId: 'txn-1', txnDate: '2026-10-06', narration: 'UPI receipt',
        direction: 'inbound', debit: '0.00', credit: '1000.00', unmatchedAmount: '1000.00',
        paymentMode: 'UPI', reference: 'ref-1', status: 'unmatched', counterpartyName: null,
        proposal: { best: null, reason: 'No likely match', runnersUp: [], ambiguous: false, autoMatchable: false },
        suggestedClassification: null, suggestedExpenseAccount: null, reviewClassification: null,
        reviewSourceName: null, fundingSuggestion: null, reviewNote: null,
      }] as never,
      totals: { unmatched: 1, matched: 0, autoMatchable: 0, ambiguous: 0, unsure: 0 },
    }, { ties: true, difference: '0.00' } as never, 'bank-1',
    { expenseAccounts: [], transferAccounts: [], personalAccountName: 'Personal Account' },
    { enabled: false, available: true, canReview: false, canPost: false, canManageSettings: false });
    expect(auditorHtml).not.toContain('class="bank-review"');
    expect(auditorHtml).toContain('Read-only bank review');
  });

  it('opens an AI-prepared payment as a review-only draft', () => {
    const html = renderPayables({
      bills: [{ voucherId: 'bill-1', billNumber: 'ES-1', supplierName: 'Campus E-Shop',
        billDate: '2026-09-01', dueDate: '2026-09-01', grandTotal: '117.00',
        outstanding: '117.00', daysOverdue: 1, bucket: 'd0_30' }],
      accounts: [{ id: 'bank-1', name: 'Bank Accounts' }], today: '2026-09-16',
      draftVoucherId: 'bill-1',
    });
    expect(html).toContain('<p class="eyebrow">PURCHASES</p>');
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
    expect(html).toContain('<p class="eyebrow">SALES</p>');
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
