/**
 * Server-rendered views for the review server.
 * Spec: bank-and-reconciliation.md §14.1
 *
 * Four design constraints, all from the spec and from `dont-scare-the-ca`:
 *
 *   - sorted by confidence, so easy lines clear in bulk at the top and
 *     attention goes to the bottom where it is needed
 *   - bulk-accept in one action
 *   - keyboard-driven throughout; a CA should never need the mouse
 *   - every proposal shows its reasoning and its runner-up, because trust is
 *     built by being checkable, not by being confident (provenance PR-9, PR-11)
 */

import { STATUTORY_RATES } from '../domain/tax.ts';
import type { QueueItem, MatchProposal } from '../domain/matching.ts';
import type { Brs } from '../domain/brs.ts';
import type { SalesDesk, SalesInvoiceDetail } from '../domain/sales.ts';
import type { InboxDocument, DocumentInformationRequest, DocumentRequestAnswer } from '../domain/documentInbox.ts';
import type { AssistantRunView } from '../domain/assistant.ts';
import type { FollowUpAssignee, FollowUpItem } from '../domain/followUps.ts';
import type { ObligationTimelineItem } from '../domain/obligationTimeline.ts';
import type { NexusAlert } from '../domain/alerts.ts';
import type { ActivityItem } from '../domain/activity.ts';
import type { EmailInbox, IntakeMessage } from '../domain/emailIntake.ts';
import { renderNexusBlocks } from './nexusBlocks.ts';
import type { NexusBankTransactionSource } from '../domain/nexusBankActivity.ts';
import type { NexusBlockEnvelope } from './nexusBlocks.ts';

type NexusTaskUi = {
  id: string; purpose: string; specialist: string; status: string;
  currentAttempt: number; maxAttempts: number;
  attempts: Array<{ ordinal: number; agent_role: string; outcome: string; result: unknown;
    verifier_findings: unknown; addressed_findings: unknown }>;
};
type NexusChatWorkspace = {
  cases: Array<{ id: string; title: string; state: string; created_at: Date | string }>;
  selectedCase: { id: string; title: string; state: string } | null;
  messages: Array<{ id: string; actor_type: 'user' | 'nexus' | 'system'; body: string; response_blocks?: NexusBlockEnvelope | null; recorded_at: Date | string }>;
  bankAccounts?: Array<{ id: string; bank_name: string; account_number_last4: string }>;
  newConversation?: boolean;
  viewerLabel?: string;
};

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

function pageIntro(section: string, title: string, description: string): string {
  return `<section class="page-intro"><div><p class="eyebrow">${esc(section)}</p>
    <h1>${esc(title)}</h1><p class="sub">${esc(description)}</p></div></section>`;
}

/** Indian digit grouping — 12,34,567.89, not 1,234,567.89. */
const inr = (v: string): string => {
  const neg = v.startsWith('-');
  const [whole = '0', frac = '00'] = (neg ? v.slice(1) : v).split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '−' : ''}${grouped}.${frac.padEnd(2, '0').slice(0, 2)}`;
};

export function renderDocumentInbox(
  documents: InboxDocument[], canReview = false, requestHistory: DocumentRequestAnswer[] = [],
  classifier: { enabled: boolean; available: boolean } = { enabled: false, available: false },
  canConfirmClass = true, selectedDocumentId?: string, statusFilter = 'all', classFilter = 'all',
  openRequests: DocumentInformationRequest[] = [], canAnswerRequests = false,
): string {
  const statusLabel = (status: string): string => ({
    received: 'Received · waiting for CA',
    in_review: 'CA is reviewing',
    needs_information: 'Information requested',
    processed: 'Completed',
    dismissed: 'Dismissed as irrelevant · original retained',
    unavailable: 'Original unavailable',
  }[status] ?? status);
  const classLabels: Record<string, string> = {
    bank_statement: 'Bank statement', purchase_bill: 'Purchase bill',
    sales_invoice: 'Sales invoice', expense_receipt: 'Expense receipt',
    tds_document: 'TDS document', gst_document: 'GST document', payroll: 'Payroll',
    contract_legal: 'Contract / legal', other: 'Other', uncertain: 'Uncertain',
  };
  const documentClasses = Object.keys(classLabels);
  const filteredDocuments = documents.filter((document) => {
    const statusMatches = statusFilter === 'all' ||
      (statusFilter === 'needs-review' && ['received', 'needs_information'].includes(document.status)) ||
      (statusFilter === 'with-ca' && document.status === 'in_review') ||
      (statusFilter === 'moved' && document.status === 'processed') ||
      (statusFilter === 'set-aside' && document.status === 'dismissed');
    const classMatches = classFilter === 'all' ||
      (document.classConfirmation?.documentClass ?? document.classSuggestion?.documentClass ?? 'uncertain') === classFilter;
    return statusMatches && classMatches;
  });
  const selectedDocument = filteredDocuments.find((document) => document.id === selectedDocumentId)
    ?? filteredDocuments[0] ?? null;
  const d = selectedDocument;
  const selectedRequests = d ? requestHistory.filter((item) => item.documentId === d.id) : [];
  const history = d ? [
    `<li><b>Received</b><span>${esc(new Date(d.receivedAt).toLocaleString('en-IN'))}</span></li>`,
    ...(d.classSuggestion ? [`<li><b>Nexus suggested ${esc(classLabels[d.classSuggestion.documentClass] ?? d.classSuggestion.documentClass)}</b><span>${d.classSuggestion.confidence}% confidence</span></li>`] : []),
    ...(d.classConfirmation ? [`<li><b>Class confirmed</b><span>${esc(new Date(d.classConfirmation.confirmedAt).toLocaleString('en-IN'))}</span></li>`] : []),
    ...selectedRequests.map((item) => `<li><b>${item.status === 'answered' ? 'Founder answered' : 'Information requested'}</b><span>${esc(new Date(item.status === 'answered' && item.answeredAt ? item.answeredAt : item.requestedAt).toLocaleString('en-IN'))}</span></li>`),
    ...(d.reviewUpdatedAt ? [`<li><b>Status updated</b><span>${esc(new Date(d.reviewUpdatedAt).toLocaleString('en-IN'))}</span></li>`] : []),
  ].join('') : '';
  const requestCards = canAnswerRequests && openRequests.length ? `<section class="panel inbox-requests" aria-label="Questions from your CA">
    <h2>Your CA asked · ${openRequests.length}</h2>${openRequests.map((request) => {
      const requestedDocument = documents.find((item) => item.id === request.documentId);
      return `<form class="inbox-answer-request" data-request-id="${esc(request.id)}">
        <p><b>${esc(requestedDocument?.originalName ?? 'Document')}</b><span>${esc(new Date(request.requestedAt).toLocaleDateString('en-IN'))}</span></p>
        <div>${esc(request.question)}</div><textarea aria-label="Your answer" maxlength="2000" placeholder="Write a reply…"></textarea>
        <label class="inbox-attach">＋ Attach a file<input type="file" name="files" multiple></label>
        <button class="primary" type="submit">Send reply</button><span class="inbox-request-result" role="status"></span>
      </form>`;
    }).join('')}</section>` : '';
  const selectedPanel = d ? `<div class="inbox-review-grid">
    <section class="inbox-preview" aria-label="Document preview">
      <div class="inbox-preview-canvas">${d.available
        ? `<div><b>${esc(d.mimeType)}</b><span>Preview is not available in this workspace yet.</span><a href="/api/documents/${esc(d.id)}/download">Download original ↓</a></div>`
        : '<div><b>Original unavailable</b><span>The source file is not stored here.</span></div>'}</div>
      <p class="why">${d.available ? `Original retained · ${esc((d.size / 1024).toFixed(1))} KB · SHA-256 ${esc(d.hash.slice(0, 12))}…` : 'Source file unavailable'}</p>
    </section>
    <section class="inbox-review" aria-label="Nexus classification and review">
      <div class="inbox-file-head"><h2>${esc(d.originalName)}</h2><span class="inbox-document-status">${esc(statusLabel(d.available ? d.status : 'unavailable'))}</span>
        <small>Received ${esc(new Date(d.receivedAt).toLocaleString('en-IN'))}</small></div>
      <article class="inbox-suggestion"><div class="inbox-suggestion-title"><b>✦ Nexus suggestion</b>${d.classSuggestion ? `<span>${d.classSuggestion.confidence}% confidence</span>` : ''}</div>
        ${d.classSuggestion ? `<strong>${esc(classLabels[d.classSuggestion.documentClass] ?? d.classSuggestion.documentClass)}${d.classSuggestion.subtype ? ` · ${esc(d.classSuggestion.subtype)}` : ''}</strong>
          <p>${esc(d.classSuggestion.rationale)}</p>${d.classSuggestion.evidence.length ? `<details><summary>Evidence and explanation</summary><p>${d.classSuggestion.evidence.map(esc).join(' · ')}</p></details>` : ''}
          <details><summary>What information is shared?</summary><p>For this suggestion, Nexus received text from the document after configured redaction. The file name and remaining text can still identify people or businesses. Nothing is imported or posted automatically.</p></details>`
          : `<p>${classifier.enabled && classifier.available && d.status !== 'dismissed' ? 'No suggestion yet. Ask Nexus to review this file.' : 'No suggestion is available. You can still classify it manually.'}</p>`}
        ${!d.classSuggestion && classifier.enabled && classifier.available && d.status !== 'dismissed' ? `<button type="button" class="classify-document" data-id="${esc(d.id)}">Ask Nexus</button>` : ''}
      </article>
      ${d.status !== 'dismissed' && canConfirmClass && d.available ? `<section class="inbox-class-review"><h3>Confirm or correct type</h3>
        <div class="inbox-class-choices">${documentClasses.map((value) => `<button type="button" class="document-class-choice ${((d.classConfirmation?.documentClass ?? d.classSuggestion?.documentClass ?? 'uncertain') === value) ? 'selected' : ''}" data-id="${esc(d.id)}" data-class="${value}" aria-pressed="${(d.classConfirmation?.documentClass ?? d.classSuggestion?.documentClass ?? 'uncertain') === value}">${esc(classLabels[value]!)}</button>`).join('')}</div>
        <button type="button" class="confirm-document-class primary" data-id="${esc(d.id)}">${d.classConfirmation ? 'Save class correction' : 'Confirm type'}</button>
        <p class="why">Confirming a type does not import, reconcile, or post anything.</p></section>` : ''}
      ${d.classConfirmation ? `<div class="inbox-next-step"><b>Next step</b>${d.classConfirmation.documentClass === 'bank_statement'
        ? `<a href="/import?document=${encodeURIComponent(d.id)}">Continue to statement preview →</a>`
        : d.classConfirmation.documentClass === 'purchase_bill'
          ? `<button type="button" class="review-document" data-id="${esc(d.id)}">Continue to bill review →</button>`
          : d.classConfirmation.documentClass === 'sales_invoice' ? '<a href="/sales">Open sales invoices →</a>'
            : d.classConfirmation.documentClass === 'tds_document' ? '<a href="/tds">Open TDS review →</a>'
              : d.classConfirmation.documentClass === 'gst_document' ? '<a href="/gstr3b">Open GST review →</a>'
                : '<span>Class confirmed. The file remains available for review.</span>'}</div>` : ''}
      <details class="inbox-history"><summary>History</summary><ol>${history}</ol></details>
      ${canReview && d.available && d.status !== 'processed' ? `<details class="inbox-ca-actions"><summary>CA review actions</summary><div class="doc-review-actions">
        <button type="button" class="mark-in-review" data-id="${esc(d.id)}">${d.status === 'dismissed' ? 'Restore for review' : 'Mark in review'}</button>
        ${d.status !== 'dismissed' ? `<label>Ask founder for information<textarea class="review-note" maxlength="1000" placeholder="What should the founder provide?"></textarea></label><button type="button" class="request-info" data-id="${esc(d.id)}">Request information</button>
        <label>Set aside with reason<textarea class="dismiss-reason" maxlength="1000" placeholder="Why is this file irrelevant or incorrect?"></textarea></label><button type="button" class="dismiss-document" data-id="${esc(d.id)}">Set aside</button>` : ''}
      </div></details>` : ''}
      ${d.reviewNote ? `<p class="msg">CA note: ${esc(d.reviewNote)}</p>` : ''}
      ${selectedRequests.filter((item) => item.status === 'answered').map((item) => `<details><summary>Founder answer · ${esc(new Date(item.answeredAt!).toLocaleString('en-IN'))}</summary><p><b>Asked:</b> ${esc(item.question)}</p>${item.answer ? `<p><b>Answered:</b> ${esc(item.answer)}</p>` : ''}${item.attachmentIds.map((id) => `<a href="/documents?document=${encodeURIComponent(id)}">${esc(documents.find((doc) => doc.id === id)?.originalName ?? 'Attached document')}</a>`).join('')}</details>`).join('')}
    </section></div>` : `<div class="inbox-empty-detail"><h2>${documents.length ? 'No document in this view' : 'Your inbox is ready'}</h2><p>${documents.length ? 'Choose another filter or file to continue.' : 'Upload a file to start a review. Received documents stay here until a person confirms the next step.'}</p></div>`;
  const query = (documentId?: string): string => {
    const params = new URLSearchParams();
    if (documentId) params.set('document', documentId);
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (classFilter !== 'all') params.set('type', classFilter);
    return `/documents${params.size ? `?${params.toString()}` : ''}#inbox-detail`;
  };
  const statusCounts = {
    all: documents.length,
    'needs-review': documents.filter((document) => ['received', 'needs_information'].includes(document.status)).length,
    'with-ca': documents.filter((document) => document.status === 'in_review').length,
    moved: documents.filter((document) => document.status === 'processed').length,
    'set-aside': documents.filter((document) => document.status === 'dismissed').length,
  };
  const filters = [
    ['all', 'All'], ['needs-review', 'Needs review'], ['with-ca', 'With the CA'],
    ['moved', 'Completed'], ['set-aside', 'Set aside'],
  ] as const;
  const filterHref = (status: string): string => {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (classFilter !== 'all') params.set('type', classFilter);
    return `/documents${params.size ? `?${params.toString()}` : ''}`;
  };
  const docList = filteredDocuments.length ? filteredDocuments.map((document) => {
    const docClass = document.classConfirmation?.documentClass ?? document.classSuggestion?.documentClass ?? 'uncertain';
    const destination = document.classConfirmation?.documentClass === 'bank_statement' ? 'Bank statements'
      : document.classConfirmation?.documentClass === 'purchase_bill' ? 'Bills'
      : document.classConfirmation?.documentClass === 'sales_invoice' ? 'Sales'
      : document.classConfirmation?.documentClass === 'tds_document' ? 'TDS'
      : document.classConfirmation?.documentClass === 'gst_document' ? 'GST review' : '';
    return `<a class="inbox-document ${document.id === selectedDocument?.id ? 'selected' : ''}" href="${esc(query(document.id))}">
      <span><b>${esc(document.originalName)}</b><small>${esc(new Date(document.receivedAt).toLocaleString('en-IN'))}</small></span>
      <span class="inbox-document-status">${esc(statusLabel(document.available ? document.status : 'unavailable'))}</span>
      <small>${esc(document.channel === 'email' ? `Email${document.sender ? ` · ${document.sender}` : ''}` : document.channel === 'upload' ? 'Upload' : 'Received file')} · ${esc(classLabels[docClass] ?? docClass)}${destination ? ` · Now in ${esc(destination)}` : ''}</small>
    </a>`;
  }).join('') : '<p class="empty">No documents match these filters.</p>';
  return `<div class="inbox-heading"><div><h1>Inbox</h1>
    <p class="sub">Send files here by upload or email. Review the type before moving them into a work area.</p></div>
    <label class="inbox-upload">＋ Upload files<input id="document-files" type="file" multiple aria-label="Choose documents"></label>
    <button class="primary" type="button" id="document-upload">Upload</button>
  </div>
  <p class="why inbox-limit">Up to 5 MB per file. Uploading stores the original; it does not import or post anything.</p>
  <div id="document-upload-result" role="status" aria-live="polite"></div>
  ${requestCards}
  <details class="panel inbox-ai"><summary><b>Nexus document suggestions</b>
    <span class="tag ${classifier.enabled ? 'good' : ''}">${classifier.enabled ? 'On' : 'Off for this firm'}</span></summary>
    <p class="why">Suggestions need your confirmation. If enabled, Nexus sends text from the first two PDF pages or supported text files after redacting some sensitive identifiers and amounts. Filenames and document text may still identify people or businesses.</p>
    ${!classifier.available ? '<p class="why">Nexus AI is not configured on this server.</p>' : ''}
    <button type="button" id="toggle-document-classifier" ${!classifier.available && !classifier.enabled ? 'disabled' : ''}>${classifier.enabled ? 'Turn off for this firm' : 'Turn on for this firm'}</button>
  </details>
  <nav class="inbox-filters" aria-label="Filter received documents">
    ${filters.map(([key, label]) => `<a href="${esc(filterHref(key))}" data-document-filter="${key}" class="${statusFilter === key ? 'on' : ''}">${label}<b>${statusCounts[key]}</b></a>`).join('')}
    <form method="get" action="/documents" class="inbox-type-filter">
      <input type="hidden" name="status" value="${esc(statusFilter)}">
      <label>Type <select name="type" onchange="this.form.submit()"><option value="all">All types</option>${documentClasses.map((value) => `<option value="${value}" ${classFilter === value ? 'selected' : ''}>${esc(classLabels[value]!)}</option>`).join('')}</select></label>
    </form>
  </nav>
  <div class="inbox-layout">
    <nav class="panel inbox-list" aria-label="Received documents">
      <h2>Received · ${filteredDocuments.length}</h2>${docList}
    </nav>
    <section class="panel inbox-detail" id="inbox-detail" aria-label="Selected document review">${selectedPanel}</section>
  </div>
<script>(() => {
  const files = document.getElementById('document-files');
  const button = document.getElementById('document-upload');
  const result = document.getElementById('document-upload-result');
  const classifierToggle = document.getElementById('toggle-document-classifier');
  if (classifierToggle) classifierToggle.onclick = async () => {
    const enabled = ${classifier.enabled ? 'false' : 'true'};
    classifierToggle.disabled = true;
    try {
      const response = await fetch('/api/document-classifier-consent', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
      const data = await response.json(); if (!data.ok) throw new Error(data.error || 'could not update setting');
      location.reload();
    } catch (error) { result.textContent = String(error.message || error); classifierToggle.disabled = false; }
  };
  document.querySelectorAll('.classify-document').forEach((classify) => classify.onclick = async () => {
    classify.disabled = true; result.textContent = 'Asking Nexus for a document-class suggestion…';
    try {
      const response = await fetch('/api/documents/' + encodeURIComponent(classify.dataset.id) + '/classify', { method: 'POST' });
      const data = await response.json(); if (!data.ok) throw new Error(data.error || 'could not classify document');
      location.reload();
    } catch (error) { result.textContent = String(error.message || error); classify.disabled = false; }
  });
  document.querySelectorAll('.confirm-document-class').forEach((confirmClass) => confirmClass.onclick = async () => {
    const choice = document.querySelector('.document-class-choice[data-id="' + confirmClass.dataset.id + '"].selected');
    if (!choice) { result.textContent = 'Choose a document type first.'; return; }
    confirmClass.disabled = true; result.textContent = 'Saving the confirmed document class…';
    try {
      const response = await fetch('/api/documents/' + encodeURIComponent(confirmClass.dataset.id) + '/classification-review', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documentClass: choice.dataset.class }),
      });
      const data = await response.json(); if (!data.ok) throw new Error(data.error || 'could not confirm class');
      location.reload();
    } catch (error) { result.textContent = String(error.message || error); confirmClass.disabled = false; }
  });
  document.querySelectorAll('.mark-in-review').forEach((button) => button.onclick = async () => {
    button.disabled = true;
    try {
      const response = await fetch('/api/documents/' + encodeURIComponent(button.dataset.id) + '/review', { method: 'POST' });
      const data = await response.json(); if (!data.ok) throw new Error(data.error || 'could not update status');
      location.reload();
    } catch (error) { result.textContent = String(error.message || error); button.disabled = false; }
  });
  document.querySelectorAll('.request-info').forEach((button) => button.onclick = async () => {
    const note = button.closest('.doc-review-actions').querySelector('.review-note').value.trim();
    if (!note) { result.textContent = 'Write what information is missing first.'; return; }
    button.disabled = true;
    try {
      const response = await fetch('/api/documents/' + encodeURIComponent(button.dataset.id) + '/request-info', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }),
      });
      const data = await response.json(); if (!data.ok) throw new Error(data.error || 'could not send request');
      location.reload();
    } catch (error) { result.textContent = String(error.message || error); button.disabled = false; }
  });
  document.querySelectorAll('.dismiss-document').forEach((button) => button.onclick = async () => {
    const reason = button.closest('.doc-review-actions').querySelector('.dismiss-reason').value.trim();
    if (!reason) { result.textContent = 'Write why this file is irrelevant first.'; return; }
    button.disabled = true;
    try {
      const response = await fetch('/api/documents/' + encodeURIComponent(button.dataset.id) + '/dismiss', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }),
      });
      const data = await response.json(); if (!data.ok) throw new Error(data.error || 'could not dismiss file');
      location.reload();
    } catch (error) { result.textContent = String(error.message || error); button.disabled = false; }
  });
  document.querySelectorAll('.review-document').forEach((review) => {
    review.onclick = async () => {
      review.disabled = true;
      try {
        const response = await fetch('/api/bills/preview', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ documentIds: [review.dataset.id] }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error || 'could not read this as a bill');
        location.href = '/bills?new=1';
      } catch (error) { result.textContent = String(error.message || error); review.disabled = false; }
    };
  });
  document.querySelectorAll('.document-class-choice').forEach((choice) => choice.onclick = () => {
    document.querySelectorAll('.document-class-choice[data-id="' + choice.dataset.id + '"]').forEach((item) => {
      const selected = item === choice; item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
  });
  const encodeFile = async (file) => {
    if (file.size > 5 * 1024 * 1024) throw new Error(file.name + ': exceeds 5 MB');
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const response = await fetch('/api/documents', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: file.name, mimeType: file.type, data: btoa(binary) }) });
    const data = await response.json(); if (!data.ok) throw new Error(data.error || 'could not upload ' + file.name);
    return data.document.id;
  };
  document.querySelectorAll('.inbox-answer-request').forEach((form) => form.onsubmit = async (event) => {
    event.preventDefault(); const submit = form.querySelector('button[type="submit"]');
    const output = form.querySelector('.inbox-request-result'); submit.disabled = true; output.textContent = 'Sending…';
    try {
      const files = [...form.querySelector('input[name="files"]').files]; if (files.length > 5) throw new Error('Attach up to five files.');
      const attachmentIds = []; for (const file of files) attachmentIds.push(await encodeFile(file));
      const response = await fetch('/api/document-requests/' + encodeURIComponent(form.dataset.requestId) + '/answer', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: form.querySelector('textarea').value, attachmentIds }),
      });
      const data = await response.json(); if (!data.ok) throw new Error(data.error || 'could not send reply');
      output.textContent = 'Reply sent to your CA.'; location.reload();
    } catch (error) { output.textContent = String(error.message || error); submit.disabled = false; }
  });
  button.onclick = async () => {
    if (!files.files.length) { result.textContent = 'Choose at least one file.'; return; }
    button.disabled = true;
    try {
      const messages = [];
      let anyAccepted = false;
      for (const file of files.files) {
        if (file.size > 5 * 1024 * 1024) { messages.push(file.name + ': exceeds 5 MB'); continue; }
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        const response = await fetch('/api/documents', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: file.name, mimeType: file.type, data: btoa(binary) }),
        });
        const data = await response.json();
        if (data.ok) anyAccepted = true;
        messages.push(file.name + ': ' + (data.ok ? data.duplicate ? 'already received' : 'received' : data.error));
      }
      result.textContent = messages.join(' · ');
      if (anyAccepted) location.reload();
    } catch (error) { result.textContent = String(error.message || error); }
    finally { button.disabled = false; }
  };
})();</script>`;
}

export function renderNexus(
  clientName: string, runs: AssistantRunView[], followUps: FollowUpItem[] = [],
  activity: ActivityItem[] = [],
  documents: InboxDocument[] = [],
  documentRequests: DocumentInformationRequest[] = [], canAnswerRequests = false,
  taskWorkspace: { enabled: boolean; available: boolean; canManage: boolean;
    obligations: ObligationTimelineItem[]; tasks: NexusTaskUi[] } = {
      enabled: false, available: false, canManage: false, obligations: [], tasks: [],
    },
  chatWorkspace?: NexusChatWorkspace,
): string {
  const turns = [...runs].reverse().map((run) => {
    const linked = followUps.find((item) => item.sourceQuestion === run.question);
    const followUpControl = linked
      ? `<span class="nexus-run-status">${linked.status === 'open' ? 'In Review desk · Open' : 'In Review desk · Completed'}</span>`
      : `<button type="button" class="nexus-follow" data-question="${esc(run.question)}" data-answer="${esc(run.answer)}">Add to review desk</button>`;
    return `<div class="nexus-turn">
    <div class="nexus-question">${esc(run.question)}</div>
    <div class="nexus-answer">${esc(run.answer)}</div>
    ${run.evidence.length ? `<div class="nexus-evidence">Based on: ${run.evidence.map(esc).join(' · ')}</div>` : ''}
    ${followUpControl}
  </div>`;
  }).join('');
  const caseTurns = chatWorkspace?.messages.map((message) => `<div class="nexus-turn">
    ${message.body ? `<div class="${message.actor_type === 'user' ? 'nexus-question' : message.actor_type === 'nexus' ? 'nexus-answer' : 'nexus-system'}">${esc(message.body)}</div>` : ''}
    ${message.response_blocks ? renderNexusBlocks(message.response_blocks) : ''}
  </div>`).join('');
  const visibleTurns = chatWorkspace?.newConversation ? ''
    : chatWorkspace?.selectedCase ? (caseTurns || '') : turns;
  const caseList = chatWorkspace ? `<section class="nexus-case-list" aria-label="Saved conversations">
    <h2>Saved conversations</h2>
    ${chatWorkspace.cases.length ? `<ul>${chatWorkspace.cases.map((item) => `<li class="${chatWorkspace.selectedCase?.id === item.id ? 'selected' : ''}"><a href="/nexus?case=${encodeURIComponent(item.id)}"${chatWorkspace.selectedCase?.id === item.id ? ' aria-current="page"' : ''}>${esc(item.title)}</a><span class="why">${esc(item.state.replaceAll('_',' '))}</span></li>`).join('')}</ul>` : '<p class="empty">No saved conversations yet.</p>'}
  </section>` : '';
  const canViewFirmTools = ['CA partner', 'CA staff', 'Auditor'].includes(chatWorkspace?.viewerLabel ?? '');
  const canManageFirmEmail = ['CA partner', 'CA staff'].includes(chatWorkspace?.viewerLabel ?? '');
  const latestCaseAnswer = chatWorkspace?.messages.slice().reverse()
    .find((message) => message.actor_type === 'nexus' && message.response_blocks);
  const receiptSources = [...new Map((latestCaseAnswer?.response_blocks?.blocks ?? [])
    .flatMap((block) => block.provenance?.sources ?? [])
    .map((source) => [source.id, source])).values()];
  const receiptRows = receiptSources.map((source, index) => {
    const bankHref = source.kind === 'bank_transaction' && /^[0-9a-f-]{36}$/i.test(source.id)
      ? `/nexus/source/bank-transaction?id=${encodeURIComponent(source.id)}` : null;
    return `<li class="nexus-receipt"><span class="receipt-number">${index + 1}</span><span><b>${esc(source.label)}</b><small>${esc(source.kind.replaceAll('_',' '))}</small></span>${bankHref ? `<a href="${bankHref}">Open →</a>` : ''}</li>`;
  }).join('');
  const openFollowUps = followUps.filter((item) => item.status === 'open');
  const completedFollowUps = followUps.filter((item) => item.status === 'completed').slice(0, 3);
  const needsFounder = documents.filter((doc) => doc.status === 'needs_information'
    || (!doc.available && doc.status !== 'processed'));
  const waitingForCa = documents.filter((doc) => doc.available
    && ['received', 'in_review'].includes(doc.status));
  const nextAction = needsFounder.find((doc) => doc.status === 'needs_information'
    && documentRequests.some((request) => request.documentId === doc.id));
  const missingOriginal = needsFounder.find((doc) => !doc.available);
  const openItems = followUps.filter((item) => item.status === 'open');
  const waitingRows = (items: InboxDocument[], owner: 'founder' | 'ca') => items.map((doc) => {
    const request = documentRequests.find((item) => item.documentId === doc.id);
    const title = owner === 'founder'
      ? (!doc.available ? 'Founder: upload this file again' : 'Founder: information needed')
      : doc.status === 'in_review' ? 'CA is reviewing this file' : 'Waiting for CA review';
    const note = !doc.available ? 'The stored original is unavailable.'
      : doc.reviewNote ?? doc.originalName;
    return `<li><span class="waiting-title">${esc(title)} · ${esc(doc.originalName)}</span>
      <span class="why">${esc(note)}</span>
      ${owner === 'founder' && request && canAnswerRequests ? `<form class="nexus-request" data-request-id="${esc(request.id)}">
        <label>Your answer<textarea name="answer" maxlength="2000" placeholder="Tell the CA what they need to know"></textarea></label>
        <label>Attach supporting files (optional)<input name="files" type="file" multiple></label>
        <button type="submit">Send answer</button><span class="why nexus-request-result" role="status"></span>
      </form>` : ''}<a href="/documents#doc-${esc(doc.id)}">Open document →</a></li>`;
  }).join('');
  const progressRows = (items: FollowUpItem[]): string => items.map((item) =>
    `<li><span class="progress-status">${item.status === 'open' ? 'In progress' : 'Completed'}</span>
      <span>${esc(item.title)}</span></li>`).join('');
  const taskRows = taskWorkspace.tasks.map((task) => `<article class="nexus-task" id="nexus-task-${esc(task.id)}">
    <div class="row-actions"><b>${esc(task.specialist.toUpperCase())} · ${esc(task.status.replaceAll('_',' '))}</b>
      <span class="why">${task.currentAttempt}/${task.maxAttempts} specialist runs</span></div>
    <p>${esc(task.purpose)}</p>
    ${task.attempts.map((attempt) => `<details><summary>${esc(attempt.agent_role)} · ${esc(attempt.outcome)} · attempt ${attempt.ordinal}</summary>
      <pre>${esc(JSON.stringify(attempt.result, null, 2).slice(0,5000))}</pre>
      ${Array.isArray(attempt.verifier_findings) && attempt.verifier_findings.length
        ? `<p><b>Verifier findings</b></p><ul>${attempt.verifier_findings.map((finding) => `<li>${esc(typeof finding === 'object' && finding !== null ? (finding as Record<string,unknown>).summary : finding)}</li>`).join('')}</ul>` : ''}
      ${Array.isArray(attempt.addressed_findings) && attempt.addressed_findings.length
        ? `<p class="why">This retry references ${attempt.addressed_findings.length} prior finding(s).</p>` : ''}
    </details>`).join('')}
    ${['queued','retry_ready'].includes(task.status) ? `<button type="button" class="run-nexus-task" data-id="${esc(task.id)}">Run with Nexus</button>` : ''}
    ${task.status === 'needs_human_review' ? '<a href="/follow-ups">Open the assigned human review →</a>' : ''}
  </article>`).join('');
  const obligationRows = taskWorkspace.obligations.slice(0,100).map((item) => `<label class="nexus-obligation">
    <input type="checkbox" name="obligationIds" value="${esc(item.id)}">
    <span>${esc(item.kind)} · ${esc(item.periodKey)} · ${esc(item.workflowState.replaceAll('_',' '))}</span>
  </label>`).join('');
  const todayParts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).reduce<Record<string, string>>((out, part) => {
      if (part.type !== 'literal') out[part.type] = part.value;
      return out;
    }, {});
  const todayIndia = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
  const thirtyDaysAgo = new Date(`${todayIndia}T00:00:00.000Z`);
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 29);
  const fromIndia = thirtyDaysAgo.toISOString().slice(0, 10);
  return `<div class="nexus-workspace">
  <aside class="nexus-rail" aria-label="Nexus conversations">
    <a class="nexus-new" href="/nexus?new=1">＋ New conversation</a>
    ${caseList}
    <nav class="nexus-rail-links" aria-label="Nexus tools">
      <a href="/assistant-runs">Nexus activity log →</a><a href="/follow-ups">Review desk →</a>
      <a href="/follow-ups">Long-running reviews →</a>
      ${canViewFirmTools ? '<a href="/firm">Firm workspace →</a><a href="/tally">Tally import →</a>' : ''}
      ${canManageFirmEmail ? '<a href="/email-inbox">Firm email →</a>' : ''}
    </nav>
  </aside>
  <section class="nexus-chat" aria-label="Ask Nexus conversation">
    <div class="nexus-head"><div><h1>${chatWorkspace?.newConversation ? 'New conversation' : esc(chatWorkspace?.selectedCase?.title ?? 'Ask Nexus')}</h1>
      <p>${esc(clientName)} · answers use this client’s records</p></div>
      <span class="nexus-viewer">Viewing as <b>${esc(chatWorkspace?.viewerLabel ?? 'User')}</b></span>
      ${chatWorkspace?.selectedCase ? `<span class="nexus-saved">${esc(chatWorkspace.selectedCase.state.replaceAll('_',' '))}</span>` : ''}
    </div>
    <div class="nexus-thread" id="nexus-thread" aria-live="polite">
      ${visibleTurns || (chatWorkspace?.newConversation
        ? '<div class="nexus-welcome"><span class="nexus-spark">✦</span><div><h2>What would you like to work on?</h2><p>Ask about your books or choose a starting point below. Nexus will show the records behind its answers and ask before any review action.</p><div class="nexus-starters"><button type="button" class="nexus-prompt" data-prompt="What needs my attention?">What needs my attention?</button><button type="button" class="nexus-prompt" data-prompt="How much money is in our connected bank accounts?">How much money do we have?</button><button type="button" class="nexus-prompt" data-prompt="What documents have we received?">What documents have we received?</button></div></div></div>'
        : '<div class="nexus-welcome"><span class="nexus-spark">✦</span><div><h2>Ask Nexus about this client</h2><p>Ask about the books, received documents, bank activity, or work that needs attention.</p></div></div>')}
    </div>
    <div class="nexus-compose">
      <form id="nexus-form" class="nexus-message-form">
        <textarea id="nexus-input" maxlength="500" aria-label="Message Nexus"
          placeholder="Ask a follow-up, in Hindi or English…"></textarea>
        <div class="nexus-compose-tools">
          <label class="nexus-attach" for="nexus-upload-files">＋ Attach bill or statement</label>
          <input id="nexus-upload-files" form="nexus-upload-form" type="file" multiple required class="nexus-file-input">
          <button type="button" class="nexus-tool" id="nexus-bank-open">↔ Bank activity</button>
          <span class="why">Read-only · cannot post</span>
          <button class="primary" id="nexus-send" type="submit">Ask</button>
        </div>
        <span id="nexus-compose-result" class="why" role="status"></span>
      </form>
      <form id="nexus-upload-form" class="nexus-upload-form">
        <button id="nexus-upload" type="submit">Upload selected files</button>
        <span class="why" id="nexus-upload-result" role="status"></span>
      </form>
      <details class="nexus-bank-activity" id="nexus-bank-panel">
        <summary class="sr-only">Review bank activity</summary>
        ${chatWorkspace?.bankAccounts?.length ? `<form id="nexus-bank-activity-form">
          <label>Bank account<select name="accountId" required>${chatWorkspace.bankAccounts.map((account) => `<option value="${esc(account.id)}">${esc(account.bank_name)} · ending ${esc(account.account_number_last4)}</option>`).join('')}</select></label>
          <label>From<input type="date" name="fromDate" required value="${fromIndia}"></label>
          <label>To<input type="date" name="toDate" required value="${todayIndia}"></label>
          <button class="primary" type="submit">Show activity in this conversation</button>
          <span id="nexus-bank-activity-result" role="status" class="why"></span>
        </form>` : '<p class="why">No bank account is connected for this client yet.</p>'}
        <p class="why">Defaults to the last 30 India (IST) calendar dates. Read-only summary; it does not classify, reconcile, or post transactions.</p>
      </details>
      ${chatWorkspace?.selectedCase ? `<p class="why nexus-conversation-label">Conversation: ${esc(chatWorkspace.selectedCase.title)}</p>` : ''}
    </div>
  </section>
  <aside class="nexus-context" aria-label="Evidence and work needing attention">
    <section class="nexus-context-section"><h2>Receipts for this answer</h2>
      <ol class="nexus-receipts">${receiptRows || '<li class="nexus-context-empty">Evidence links appear here when Nexus answers with structured records.</li>'}</ol>
    </section>
    <section class="nexus-context-section"><h2>Next step</h2>
      ${nextAction && canAnswerRequests ? `<p>Answer the CA’s question about <b>${esc(nextAction.originalName)}</b>.</p>`
        : missingOriginal ? `<p>Upload <b>${esc(missingOriginal.originalName)}</b> again so it can be reviewed.</p>`
        : waitingForCa.length ? '<p>Your files are with the CA. You can send another file or ask Nexus about your books.</p>'
        : '<p>Ask a question or send a statement, invoice, or receipt for review.</p>'}
    </section>
    <section class="nexus-context-section nexus-waiting"><h2>Waiting on you · ${needsFounder.length}</h2>
      <ul>${waitingRows(needsFounder, 'founder') || '<li class="empty">Nothing needs your input.</li>'}</ul>
    </section>
    <section class="nexus-context-section nexus-waiting"><h2>With your CA · ${waitingForCa.length}</h2>
      <ul>${waitingRows(waitingForCa, 'ca') || '<li class="empty">No documents are waiting for CA review.</li>'}</ul>
    </section>
    <section class="nexus-context-section"><h2>Review desk · ${openItems.length} open</h2>
      <ul id="nexus-open-followups">${openItems.slice(0, 5).map((item) => `<li><a class="waiting-title" href="/follow-ups#followup-${esc(item.id)}">${esc(item.title)} →</a></li>`).join('') || '<li class="empty">No open review items.</li>'}</ul>
      <a href="/follow-ups">Open review desk →</a>
    </section>
    <section class="nexus-context-section"><h2>Recent activity</h2>
      ${activity.slice(0, 5).map(activityRow).join('') || '<p class="empty">No recent activity.</p>'}
      <a href="/activity">All activity →</a>
    </section>
    <details class="nexus-advanced"><summary>Shortcuts and long-running reviews</summary>
      <div class="nexus-starters"><button class="nexus-prompt" type="button" data-prompt="What needs attention?">What needs attention?</button>
      <button class="nexus-prompt" type="button" data-prompt="What documents have we received?">What documents have we received?</button>
      <button class="nexus-prompt" type="button" data-prompt="How many bank transactions need reconciliation?">What needs bank review?</button>
      <button class="nexus-prompt" type="button" data-prompt="How much GST credit is at risk?">How much GST credit is at risk?</button>
      <a href="/documents">Documents</a><a href="/reconcile">Bank reconciliation</a><a href="/bills">Bills</a>
      ${completedFollowUps.length ? `<h3>Recently completed</h3><ul>${progressRows(completedFollowUps)}</ul>` : ''}</div>
    </details>
    <details class="nexus-task-workspace" aria-label="Long-running Nexus reviews">
      <summary>Long-running reviews</summary>
      <p class="why">Nexus can summarize selected compliance timeline records. A review cannot file, pay, reconcile, or change a book entry.</p>
      <details class="nexus-ai-consent">
        <summary>Data sharing and Nexus task consent · ${taskWorkspace.enabled ? 'On' : 'Off'}</summary>
        <p>When enabled, the selected timeline metadata and your review question are sent to the configured AI service (currently ${taskWorkspace.available ? 'available' : 'not configured'}). Original files and statement passwords are not included in this review. Avoid typing sensitive identifiers into the question. Nexus and its verifier produce suggestions; a human remains responsible for decisions.</p>
        ${taskWorkspace.canManage ? `<button type="button" id="toggle-nexus-task-consent" ${!taskWorkspace.available && !taskWorkspace.enabled ? 'disabled' : ''}>${taskWorkspace.enabled ? 'Turn off task runs' : 'Enable task runs'}</button>` : '<p class="why">A firm owner or authorized CA can change this setting.</p>'}
      </details>
      ${taskWorkspace.enabled ? `<form id="nexus-task-form">
        <label>What should Nexus review?<textarea name="purpose" maxlength="1000" required>Summarize these compliance timeline records. State what is recorded, what remains unverified, and what evidence is missing. Do not infer a filing or due date.</textarea></label>
        <label>Specialist<select name="specialist"><option value="gst">GST</option><option value="tds">TDS</option><option value="banking">Banking</option></select></label>
        <fieldset><legend>Choose timeline records</legend>${obligationRows || '<p class="empty">No compliance timeline records are available for this client yet.</p>'}</fieldset>
        <button type="submit" ${!taskWorkspace.obligations.length ? 'disabled' : ''}>Create review task</button>
        <span id="nexus-task-result" role="status" class="why"></span>
      </form>` : '<p class="why">A firm owner or authorized CA must enable task runs before client data is sent to AI.</p>'}
      <h3>Recent task history</h3>
      ${taskRows || '<p class="empty">No Nexus task runs yet.</p>'}
    </details>
  </aside>
</div>
<script>(() => {
  const taskConsent = document.getElementById('toggle-nexus-task-consent');
  if (taskConsent) taskConsent.onclick = async () => {
    taskConsent.disabled = true;
    try {
      const response = await fetch('/api/nexus/task-consent', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: ${taskWorkspace.enabled ? 'false' : 'true'} }) });
      const result = await response.json(); if (!result.ok) throw new Error(result.error || 'could not update Nexus consent');
      location.reload();
    } catch (error) { taskConsent.disabled = false; alert(String(error.message || error)); }
  };
  const taskForm = document.getElementById('nexus-task-form');
  if (taskForm) taskForm.onsubmit = async (event) => {
    event.preventDefault();
    const button = taskForm.querySelector('button[type="submit"]');
    const result = document.getElementById('nexus-task-result');
    const recordRefs = [...taskForm.querySelectorAll('input[name="obligationIds"]:checked')].map((input) => ({ kind: 'obligation', id: input.value }));
    if (!recordRefs.length) { result.textContent = 'Select at least one timeline record.'; return; }
    button.disabled = true; result.textContent = 'Creating a scoped task…';
    try {
      const response = await fetch('/api/nexus/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: taskForm.elements.purpose.value, specialist: taskForm.elements.specialist.value,
          recordRefs, idempotencyKey: crypto.randomUUID() }) });
      const data = await response.json(); if (!data.ok) throw new Error(data.error || 'could not create review task');
      const run = await fetch('/api/nexus/tasks/' + encodeURIComponent(data.taskId) + '/run', { method: 'POST' });
      const outcome = await run.json(); if (!outcome.ok) throw new Error(outcome.error || 'task was created but could not run');
      result.textContent = 'Review finished. Reloading the task history…'; location.reload();
    } catch (error) { result.textContent = String(error.message || error); button.disabled = false; }
  };
  document.querySelectorAll('.run-nexus-task').forEach((button) => button.onclick = async () => {
    button.disabled = true; button.textContent = 'Running…';
    try {
      const response = await fetch('/api/nexus/tasks/' + encodeURIComponent(button.dataset.id) + '/run', { method: 'POST' });
      const data = await response.json(); if (!data.ok) throw new Error(data.error || 'could not run task');
      location.reload();
    } catch (error) { button.disabled = false; button.textContent = String(error.message || error); }
  });
  const form = document.getElementById('nexus-form');
  const input = document.getElementById('nexus-input');
  const send = document.getElementById('nexus-send');
  const thread = document.getElementById('nexus-thread');
  const bankActivityForm = document.getElementById('nexus-bank-activity-form');
  if (bankActivityForm) bankActivityForm.onsubmit = async (event) => {
    event.preventDefault();
    const button = bankActivityForm.querySelector('button[type="submit"]');
    const result = document.getElementById('nexus-bank-activity-result');
    button.disabled = true; result.textContent = 'Loading this account’s activity…';
    try {
      const response = await fetch('/api/nexus/bank-activity', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: bankActivityForm.elements.accountId.value,
          fromDate: bankActivityForm.elements.fromDate.value, toDate: bankActivityForm.elements.toDate.value,
          requestId: crypto.randomUUID(), caseId: ${chatWorkspace?.selectedCase ? JSON.stringify(chatWorkspace.selectedCase.id) : 'null'} }) });
      const data = await response.json(); if (!data.ok) throw new Error(data.error || 'could not load bank activity');
      location.href = '/nexus?case=' + encodeURIComponent(data.caseId);
    } catch (error) { result.textContent = String(error.message || error); button.disabled = false; }
  };
  const uploadFile = async (file) => {
    if (file.size > 5 * 1024 * 1024) throw new Error(file.name + ' exceeds the 5 MB limit');
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('could not read ' + file.name));
      reader.readAsDataURL(file);
    });
    const response = await fetch('/api/documents', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: file.name, mimeType: file.type, data }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'could not upload ' + file.name);
    return result.document.id;
  };
  document.getElementById('nexus-upload-form').onsubmit = async (event) => {
    event.preventDefault();
    const button = document.getElementById('nexus-upload');
    const result = document.getElementById('nexus-upload-result');
    const files = [...document.getElementById('nexus-upload-files').files];
    if (!files.length) return;
    button.disabled = true; result.textContent = 'Receiving files…';
    try {
      for (const file of files) await uploadFile(file);
      result.textContent = files.length + ' file(s) received. Waiting for CA review.';
      location.reload();
    } catch (error) { result.textContent = String(error.message || error); }
    finally { button.disabled = false; }
  };
  const bankPanel = document.getElementById('nexus-bank-panel');
  document.getElementById('nexus-bank-open').onclick = () => {
    bankPanel.open = !bankPanel.open;
    if (bankPanel.open) bankPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const uploadInput = document.getElementById('nexus-upload-files');
  const uploadForm = document.getElementById('nexus-upload-form');
  uploadForm.hidden = !uploadInput.files.length;
  uploadInput.onchange = () => { uploadForm.hidden = !uploadInput.files.length; };
  document.querySelectorAll('.nexus-request').forEach((requestForm) => {
    requestForm.onsubmit = async (event) => {
      event.preventDefault();
      const button = requestForm.querySelector('button');
      const result = requestForm.querySelector('.nexus-request-result');
      button.disabled = true; result.textContent = 'Sending answer…';
      try {
        const attachmentIds = [];
        const files = [...requestForm.querySelector('input[name="files"]').files];
        if (files.length > 5) throw new Error('attach up to five files');
        for (const file of files) attachmentIds.push(await uploadFile(file));
        const response = await fetch('/api/document-requests/' + encodeURIComponent(requestForm.dataset.requestId) + '/answer', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answer: requestForm.querySelector('textarea').value, attachmentIds }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error || 'could not send answer');
        result.textContent = 'Answer recorded. The document is with the CA.';
        location.reload();
      } catch (error) { result.textContent = String(error.message || error); }
      finally { button.disabled = false; }
    };
  });
  const saveFollowUp = async (button, question, response) => {
    button.disabled = true;
    try {
      const saved = await fetch('/api/follow-ups', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: question.slice(0, 160), sourceQuestion: question, sourceAnswer: response }),
      });
      const result = await saved.json();
      if (!result.ok) throw new Error(result.error || 'could not add follow-up');
      button.textContent = 'Added to review desk';
      button.classList.add('nexus-run-status');
      button.classList.remove('nexus-follow');
      const progressList = document.getElementById('nexus-progress-list');
      if (progressList) {
        if (progressList.querySelector('.empty')) progressList.replaceChildren();
        const item = document.createElement('li');
        const status = document.createElement('span'); status.className = 'progress-status';
        status.textContent = 'In progress';
        const title = document.createElement('span'); title.textContent = question.slice(0, 160);
        item.append(status, title); progressList.prepend(item);
        const count = document.querySelector('.nexus-progress-count b');
        if (count) count.textContent = String(Number(count.textContent || '0') + 1);
      }
      const workList = document.getElementById('nexus-open-followups');
      if (workList) {
        if (workList.querySelector('.empty')) workList.replaceChildren();
        const item = document.createElement('li');
        const title = document.createElement('span'); title.className = 'waiting-title';
        title.textContent = question.slice(0, 160);
        const open = document.createElement('a');
        open.href = '/follow-ups#followup-' + encodeURIComponent(result.id);
        open.textContent = 'Open follow-up →';
        item.append(title, open); workList.prepend(item);
        const count = document.getElementById('nexus-open-followup-count');
        if (count) count.textContent = String(Number(count.textContent || '0') + 1);
      }
      const link = document.createElement('a'); link.className = 'nexus-action';
      link.href = '/follow-ups'; link.textContent = 'Open review desk';
      button.insertAdjacentElement('afterend', link);
    } catch (error) { button.textContent = String(error.message || error); button.disabled = false; }
  };
  document.querySelectorAll('.nexus-follow[data-question]').forEach((button) => {
    button.onclick = () => saveFollowUp(button, button.dataset.question, button.dataset.answer);
  });
  const addTurn = (question) => {
    const turn = document.createElement('div'); turn.className = 'nexus-turn';
    const q = document.createElement('div'); q.className = 'nexus-question';
    q.textContent = question; turn.appendChild(q); thread.appendChild(turn);
    thread.scrollTop = thread.scrollHeight;
    return turn;
  };
  const sendQuestion = async (question) => {
    const q = String(question || '').trim(); if (!q || send.disabled) return;
    const turn = addTurn(q); input.value = ''; send.disabled = true;
    const answer = document.createElement('div'); answer.className = 'nexus-answer';
    answer.textContent = 'Checking the records…'; turn.appendChild(answer);
    try {
      const response = await fetch('/api/assistant', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, page: 'nexus', requestId: crypto.randomUUID(),
          caseId: ${chatWorkspace?.selectedCase ? JSON.stringify(chatWorkspace.selectedCase.id) : 'null'} }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'could not answer');
      answer.textContent = data.answer;
      if (data.caseId) {
        const historyLink = document.createElement('a'); historyLink.href = '/nexus?case=' + encodeURIComponent(data.caseId);
        historyLink.textContent = 'Open saved conversation'; historyLink.className = 'nexus-action';
        turn.appendChild(historyLink);
        location.href = historyLink.href;
      }
      if (Array.isArray(data.evidence) && data.evidence.length) {
        const evidence = document.createElement('div'); evidence.className = 'nexus-evidence';
        evidence.textContent = 'Based on: ' + data.evidence.join(' · ');
        turn.appendChild(evidence);
      }
      if (data.action && typeof data.action.href === 'string' && data.action.href.startsWith('/')) {
        const action = document.createElement('a'); action.className = 'nexus-action';
        action.href = data.action.href; action.textContent = data.action.label;
        turn.appendChild(action);
      }
      const follow = document.createElement('button'); follow.type = 'button';
      follow.className = 'nexus-follow'; follow.textContent = 'Add to review desk';
      follow.onclick = () => saveFollowUp(follow, q, data.answer);
      turn.appendChild(follow);
    } catch (error) { answer.textContent = String(error.message || error); }
    finally { send.disabled = false; input.focus(); thread.scrollTop = thread.scrollHeight; }
  };
  form.onsubmit = (event) => { event.preventDefault(); sendQuestion(input.value); };
  input.onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendQuestion(input.value); }
  };
  document.querySelectorAll('[data-prompt]').forEach((button) => {
    button.onclick = () => sendQuestion(button.dataset.prompt);
  });
  thread.scrollTop = thread.scrollHeight;
})();</script>`;
}

export function renderNexusBankTransactionSource(source: NexusBankTransactionSource): string {
  return `<p><a href="/nexus">← Back to Nexus</a></p>
    <h1>Bank line evidence</h1>
    <p class="sub">Read-only source record · ${esc(source.bank_name)} account ending ${esc(source.account_number_last4)}</p>
    <section class="panel">
      <dl class="detail-grid">
        <div><dt>Date</dt><dd>${esc(source.txn_date)}</dd></div>
        <div><dt>Value date</dt><dd>${esc(source.value_date ?? '—')}</dd></div>
        <div><dt>Debit (INR)</dt><dd>${esc(source.debit)}</dd></div>
        <div><dt>Credit (INR)</dt><dd>${esc(source.credit)}</dd></div>
        <div><dt>Running balance (INR)</dt><dd>${esc(source.running_balance ?? '—')}</dd></div>
        <div><dt>Payment mode</dt><dd>${esc(source.payment_mode ?? '—')}</dd></div>
        <div><dt>Counterparty</dt><dd>${esc(source.counterparty_name ?? '—')}</dd></div>
        <div><dt>Reference</dt><dd>${esc(source.reference_number ?? '—')}</dd></div>
        <div><dt>Statement period</dt><dd>${source.statement_from ? `${esc(source.statement_from)} to ${esc(source.statement_to ?? '—')}` : 'No linked statement'}</dd></div>
      </dl>
      <h2>Original narration</h2><p class="mono">${esc(source.narration)}</p>
      <p class="why">This page shows the imported bank evidence. It does not change reconciliation or accounting records.</p>
    </section>`;
}

function activityRow(item: ActivityItem): string {
  const direction = item.kind === 'nexus_reply' ? 'In-app reply'
    : item.kind === 'document_update' && item.status === 'needs_information'
      ? 'Request recorded in app'
      : item.direction === 'incoming' ? 'Received' : 'Workspace update';
  const status = ({ received: 'Received', in_review: 'In review',
    needs_information: 'Needs your answer', processed: 'Completed', open: 'Open',
    completed: 'Completed', answered: 'Answered', unsupported: 'Needs clarification' } as Record<string, string>)[item.status]
    ?? item.status.replaceAll('_', ' ');
  return `<article class="activity-row">
    <div class="activity-row-top"><b>${esc(item.title)}</b><span class="activity-status">${esc(status)}</span></div>
    <div class="activity-detail">${esc(item.detail)}</div>
    <div class="activity-meta">${esc(direction)} · ${esc(new Date(item.occurredAt).toLocaleString('en-IN'))}</div>
    <a href="${esc(item.href)}">Open →</a>
  </article>`;
}

export function renderActivity(items: ActivityItem[]): string {
  return `${pageIntro('TODAY', 'Activity', 'A timeline of what came in, what Nexus answered, and what is still waiting for someone to act.')}
    <section class="activity-feed">
      ${items.map(activityRow).join('') || '<p class="empty">Activity will appear here when a document arrives, Nexus answers, or a follow-up changes.</p>'}
    </section>`;
}

export function renderEmailInbox(inbox: EmailInbox): string {
  const pending = inbox.messages.filter((message) => ['unassigned', 'failed'].includes(message.status));
  const recent = inbox.messages.filter((message) => !['unassigned', 'failed'].includes(message.status));
  const card = (message: IntakeMessage, actionable: boolean): string => `<article class="panel email-item" id="email-${esc(message.id)}">
    <div class="email-item-top"><h3>${esc(message.subject || '(No subject)')}</h3>
      <span class="pill">${esc(message.status)}</span></div>
    <p><b>From:</b> ${esc(message.sender)}<br><b>To:</b> ${esc(message.recipients.join(', '))}</p>
    <p class="why">${esc(new Date(message.receivedAt).toLocaleString('en-IN'))} ·
      ${message.attachmentCount} attachment${message.attachmentCount === 1 ? '' : 's'} ·
      ${esc(message.routingReason)}</p>
    ${message.attachmentReviews?.length
      ? `<p class="why">Files: ${message.attachmentReviews.map((file) =>
        `${esc(file.name)} (${esc(file.status.replaceAll('_', ' '))})`).join(', ')}</p>`
      : message.attachmentNames.length ? `<p class="why">Files: ${esc(message.attachmentNames.join(', '))}</p>` : ''}
    ${message.bodyText ? `<details><summary>Read message</summary><p class="email-body">${esc(message.bodyText)}</p></details>` : ''}
    ${message.processingError ? `<p class="msg">Processing issue: ${esc(message.processingError)}</p>` : ''}
    ${actionable ? `<form class="email-assign" data-id="${esc(message.id)}">
      <label>Assign to client <select name="clientId" required>
        <option value="">Choose client</option>
        ${inbox.clients.filter((client) => !message.clientId || client.id === message.clientId)
          .map((client) => `<option value="${esc(client.id)}" ${client.id === message.suggestedClientId || client.id === message.clientId ? 'selected' : ''}>${esc(client.name)}</option>`).join('')}
      </select></label>
      <label><input type="checkbox" name="rememberSender"> Trust this sender for future emails from this client</label>
      <button type="submit">${message.status === 'failed' ? 'Retry assignment' : 'Assign email'}</button>
      <span class="why" role="status"></span>
    </form>` : `<p><b>Client:</b> ${esc(message.clientName ?? 'Assigning…')}
      ${message.routingMethod ? `· ${esc(message.routingMethod.replaceAll('_', ' '))}` : ''}</p>
      ${message.documentIds.map((id) => `<a href="/documents#doc-${esc(id)}">Open received document →</a>`).join('')}`}
  </article>`;
  return `${pageIntro('INBOX', 'Shared email inbox', 'Local intake test for the CA team. No live mailbox is connected yet. A message without a clear client match stays unassigned.')}
    <section class="panel"><h2>Client references</h2>
      <p class="why">Use these in a sample recipient such as inbox+REFERENCE@example.test. The final domain will be configured when email delivery is connected.</p>
      <div class="email-routes">${inbox.clients.map((client) => `<div><b>${esc(client.name)}</b>
        <code>inbox+${esc(client.token)}</code></div>`).join('') || '<p>No clients are set up yet.</p>'}</div>
    </section>
    <section class="panel"><h2>Try a sample email</h2>
      <form id="sample-email-form" class="email-sample">
        <label>From<input name="sender" type="email" required placeholder="supplier@example.test"></label>
        <label>To<input name="recipient" type="email" required placeholder="inbox+REFERENCE@example.test"></label>
        <label>Subject<input name="subject" maxlength="500" placeholder="Invoice for September"></label>
        <label>Message<textarea name="bodyText" maxlength="20000"></textarea></label>
        <label>Attachments<input name="files" type="file" multiple></label>
        <button type="submit">Receive sample email</button><span id="sample-email-result" role="status"></span>
      </form>
    </section>
    <h2>Unassigned · ${pending.length}</h2>
    ${pending.map((message) => card(message, true)).join('') || '<p class="empty">No email needs assignment.</p>'}
    <h2>Recent intake</h2>
    ${recent.map((message) => card(message, false)).join('') || '<p class="empty">No email has been assigned yet.</p>'}
    <script>(() => {
      const fileData = async (file) => {
        if (file.size > 5 * 1024 * 1024) throw new Error(file.name + ' exceeds 5 MB');
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(new Error('could not read ' + file.name));
          reader.readAsDataURL(file);
        });
        return { name: file.name, mimeType: file.type, data };
      };
      const sample = document.getElementById('sample-email-form');
      sample.onsubmit = async (event) => {
        event.preventDefault();
        const button = sample.querySelector('button');
        const result = document.getElementById('sample-email-result');
        button.disabled = true; result.textContent = 'Receiving sample…';
        try {
          const values = new FormData(sample);
          const files = [...sample.querySelector('input[name="files"]').files];
          if (files.length > 5 || files.reduce((sum, file) => sum + file.size, 0) > 5 * 1024 * 1024)
            throw new Error('attach up to five files, 5 MB total');
          const attachments = [];
          for (const file of files) attachments.push(await fileData(file));
          const response = await fetch('/api/email-inbox/sample', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sender: values.get('sender'), recipients: [values.get('recipient')],
              subject: values.get('subject'), bodyText: values.get('bodyText'), attachments }),
          });
          const data = await response.json();
          if (!data.ok) throw new Error(data.error || 'could not receive sample');
          result.textContent = 'Received · ' + data.status;
          location.reload();
        } catch (error) { result.textContent = String(error.message || error); }
        finally { button.disabled = false; }
      };
      document.querySelectorAll('.email-assign').forEach((form) => {
        form.onsubmit = async (event) => {
          event.preventDefault();
          const button = form.querySelector('button'); const result = form.querySelector('[role="status"]');
          const values = new FormData(form); button.disabled = true; result.textContent = 'Assigning…';
          try {
            const response = await fetch('/api/email-inbox/' + encodeURIComponent(form.dataset.id) + '/assign', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ clientId: values.get('clientId'),
                rememberSender: values.get('rememberSender') === 'on' }),
            });
            const data = await response.json();
            if (!data.ok) throw new Error(data.error || 'could not assign email');
            location.reload();
          } catch (error) { result.textContent = String(error.message || error); button.disabled = false; }
        };
      });
    })();</script>`;
}

export function renderFollowUps(items: FollowUpItem[], assignees: FollowUpAssignee[] = []): string {
  const open = items.filter((item) => item.status === 'open');
  const done = items.filter((item) => item.status === 'completed');
  const row = (item: FollowUpItem, canComplete: boolean): string => `<article id="followup-${esc(item.id)}" class="panel follow-up-item">
    <div class="follow-up-title"><h2>${esc(item.title)}</h2><span class="pill">${esc(item.status)}</span></div>
    ${item.details ? `<p>${esc(item.details)}</p>` : ''}
    ${item.sourceNexusTaskId ? `<p class="sub">Escalated from Nexus task <code>${esc(item.sourceNexusTaskId)}</code></p>` : ''}
    <p class="sub">Priority: <b>${esc(item.priority)}</b> · Assignee: ${esc(item.assigneeName ?? 'Unassigned')} · Due: ${esc(item.dueDate ?? 'No due date')}</p>
    <p><b>Next action:</b> ${item.status === 'completed' ? 'Completed by a user' : item.blockerReason ? `Resolve blocker: ${esc(item.blockerReason)}` : item.snoozedUntil ? `Review after ${esc(item.snoozedUntil)}` : 'Review this item'}</p>
    ${item.sourceQuestion ? `<details><summary>Chat context</summary><p><b>You asked:</b> ${esc(item.sourceQuestion)}</p>
      ${item.sourceAnswer ? `<p><b>Nexus replied:</b> ${esc(item.sourceAnswer)}</p>` : ''}</details>` : ''}
    <small>Added ${esc(new Date(item.createdAt).toLocaleString('en-IN'))}</small>
    ${item.history.length ? `<details><summary>Activity history · ${item.history.length}</summary><ol>${item.history.map((event) => `<li>${esc(event.eventType.replaceAll('_', ' '))}${event.reason ? `: ${esc(event.reason)}` : ''}${event.snoozedUntil ? ` until ${esc(event.snoozedUntil)}` : ''} · ${esc(event.actorName)} · ${esc(new Date(event.recordedAt).toLocaleString('en-IN'))}</li>`).join('')}</ol></details>` : '<p class="sub">No activity recorded yet.</p>'}
    ${canComplete ? `<form class="blocker-follow-up" data-id="${esc(item.id)}"><label>Record blocker or reason<textarea name="reason" maxlength="2000" required placeholder="What is preventing the review?"></textarea></label><button type="submit">Save blocker</button></form>
      <form class="snooze-follow-up" data-id="${esc(item.id)}"><label>Snooze until<input type="date" name="until" required></label><button type="submit">Snooze</button></form>
      <button type="button" class="complete-follow-up" data-id="${esc(item.id)}">Mark complete</button><span class="follow-up-action-result" role="status"></span>` : ''}
  </article>`;
  return `${pageIntro('TODAY', 'Review desk', 'Track questions and follow-ups for this client. Completing an item only updates its status; it does not post to the books.')}
    <section class="panel"><h2>Add a follow-up</h2>
      <form id="follow-up-form"><label>What needs review?<input name="title" maxlength="160" required placeholder="e.g. Confirm the missing bank statement"></label>
      <label>Context<textarea name="details" maxlength="2000" placeholder="What should the CA check?"></textarea></label>
      <label>Assignee<select name="assigneeUserId"><option value="">Unassigned</option>${assignees.map((person) => `<option value="${esc(person.id)}">${esc(person.displayName)} · ${esc(person.role)}</option>`).join('')}</select></label>
      <label>Due date<input type="date" name="dueDate"></label>
      <label>Priority<select name="priority"><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option></select></label>
      <button class="primary" type="submit">Add to queue</button><span id="follow-up-result" role="status"></span></form>
    </section>
    <h2>Open · ${open.length}</h2>
    ${open.length ? open.map((item) => row(item, true)).join('') : '<p class="empty">Nothing is waiting for review.</p>'}
    ${done.length ? `<details class="follow-up-completed"><summary>Completed · ${done.length}</summary>${done.map((item) => row(item, false)).join('')}</details>` : ''}
    <script>(() => {
      const form = document.getElementById('follow-up-form');
      const result = document.getElementById('follow-up-result');
      form.onsubmit = async (event) => {
        event.preventDefault(); const data = new FormData(form);
        const button = form.querySelector('button'); button.disabled = true;
        try {
          const response = await fetch('/api/follow-ups', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: data.get('title'), details: data.get('details'),
              assigneeUserId: data.get('assigneeUserId'), dueDate: data.get('dueDate'), priority: data.get('priority') }) });
          const saved = await response.json(); if (!saved.ok) throw new Error(saved.error || 'could not add follow-up');
          location.reload();
        } catch (error) { result.textContent = String(error.message || error); button.disabled = false; }
      };
      document.querySelectorAll('.complete-follow-up').forEach((button) => button.onclick = async () => {
        button.disabled = true;
        try {
          const response = await fetch('/api/follow-ups/' + encodeURIComponent(button.dataset.id) + '/complete', { method: 'POST' });
          const saved = await response.json(); if (!saved.ok) throw new Error(saved.error || 'could not complete item');
          location.reload();
        } catch (error) { result.textContent = String(error.message || error); button.disabled = false; }
      });
      const submitAction = async (form, action, payload) => {
        form.onsubmit = async (event) => {
          event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
          const result = form.closest('article').querySelector('.follow-up-action-result');
          try {
            const response = await fetch('/api/follow-ups/' + encodeURIComponent(form.dataset.id) + '/' + action,
              { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(new FormData(form))) });
            const saved = await response.json(); if (!saved.ok) throw new Error(saved.error || 'could not update follow-up');
            location.reload();
          } catch (error) { result.textContent = String(error.message || error); button.disabled = false; }
        };
      };
      document.querySelectorAll('.blocker-follow-up').forEach((form) => submitAction(form, 'blocker', (data) => ({ reason: data.get('reason') })));
      document.querySelectorAll('.snooze-follow-up').forEach((form) => submitAction(form, 'snooze', (data) => ({ until: data.get('until') })));
    })();</script>`;
}

export function renderAttention(
  items: FollowUpItem[], obligations: ObligationTimelineItem[], alerts: NexusAlert[] = [], alertTotal = alerts.length,
): string {
  const todayParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const today = `${todayParts.find((part) => part.type === 'year')!.value}-${todayParts.find((part) => part.type === 'month')!.value}-${todayParts.find((part) => part.type === 'day')!.value}`;
  const open = items.filter((item) => item.status === 'open');
  const recent = items.filter((item) => item.status === 'completed')
    .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt)).slice(0, 5);
  const visibleFollowUpIds = new Set([...open, ...recent].map((item) => item.id));
  const visibleStates = new Set(['observed', 'open', 'blocked', 'needs_human_review',
    'prepared', 'submitted_unverified', 'paid_unverified']);
  const visibleObligations = obligations.filter((item) => visibleStates.has(item.workflowState));
  const followUpRow = (item: FollowUpItem): string => `<article id="attention-followup-${esc(item.id)}" class="panel follow-up-item">
    <div class="follow-up-title"><h3>${esc(item.title)}</h3><span class="pill">${item.status === 'open' ? 'Open · needs review' : 'Completed'}</span></div>
    <p class="sub">Priority: <b>${esc(item.priority)}</b> · Assignee: ${esc(item.assigneeName ?? 'Unassigned')} · Due: ${esc(item.dueDate ?? 'No due date')}${item.status === 'open' && item.dueDate && item.dueDate < today ? ' · <b>Overdue</b>' : item.status === 'open' && item.dueDate && (Date.parse(`${item.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000 <= 7 ? ' · <b>Due soon</b>' : ''}</p>
    ${item.details ? `<p>${esc(item.details)}</p>` : ''}
    ${item.sourceQuestion ? `<details><summary>Source context</summary><p><b>You asked:</b> ${esc(item.sourceQuestion)}</p>
      ${item.sourceAnswer ? `<p><b>Nexus replied:</b> ${esc(item.sourceAnswer)}</p>` : ''}</details>` : ''}
    <small>${item.status === 'open' ? 'Added' : 'Completed'} ${esc(new Date(item.status === 'open' ? item.createdAt : item.completedAt ?? item.createdAt).toLocaleString('en-IN'))}</small>
    <p><a href="/follow-ups#followup-${esc(item.id)}">Open review desk item →</a></p></article>`;
  const labels: Record<string, string> = {
    observed: 'Observed · applicability or status not established',
    open: 'Open · work remains',
    blocked: 'Blocked · review the recorded blocker',
    needs_human_review: 'Needs human review',
    prepared: 'Prepared · not filed or paid',
    submitted_unverified: 'Submitted · unverified',
    paid_unverified: 'Payment reported · unverified',
  };
  return `<p class="sub">Client work recorded for review. Nexus shows stored statuses and does not infer deadlines, filing, or payment.</p>
    <h2>Open follow-ups · ${open.length}</h2>
    ${open.length ? open.map(followUpRow).join('') : '<p class="empty">No open follow-ups.</p>'}
    <h2>Obligations to review · ${visibleObligations.length}</h2>
    ${visibleObligations.length ? visibleObligations.map((item) => `<article id="attention-obligation-${esc(item.id)}" class="panel">
      <h3>${esc(item.kind)} · ${esc(item.periodKey)}</h3><span class="pill">${esc(labels[item.workflowState] ?? item.workflowState)}</span>
      ${item.history.length ? `<details><summary>Recorded workflow history · ${item.history.length}</summary><ol>${item.history.slice(-5).reverse().map((event) => `<li id="attention-event-${esc(event.id)}"><b>${esc(labels[event.workflowState] ?? event.workflowState)}</b> · ${esc(new Date(event.recordedAt).toLocaleString('en-IN'))}</li>`).join('')}</ol></details>` : ''}
    </article>`).join('') : '<p class="empty">No unresolved or unverified obligations recorded.</p>'}
    <h2>Recent in-app alerts · ${alertTotal} total${alertTotal > alerts.length ? ` (showing ${alerts.length})` : ''}</h2>
    ${alerts.length ? alerts.map((alert) => {
      const sourceObligation = alert.sourceKind === 'obligation_event'
        ? visibleObligations.find((item) => item.history.some((event) => event.id === alert.sourceId)) : undefined;
      const sourceVisible = alert.sourceKind === 'follow_up'
        ? visibleFollowUpIds.has(alert.sourceId) : Boolean(sourceObligation);
      const href = alert.sourceKind === 'follow_up'
        ? `/follow-ups#followup-${encodeURIComponent(alert.sourceId)}`
        : sourceObligation ? `/attention#attention-obligation-${encodeURIComponent(sourceObligation.id)}` : null;
      return `<article id="alert-${esc(alert.id)}" class="panel"><div class="follow-up-title"><h3>${esc(alert.title)}</h3><span class="pill">${esc(alert.priority)}</span></div>
        <p>${esc(alert.message)}</p><small>${esc(new Date(alert.createdAt).toLocaleString('en-IN'))}</small>
        ${sourceVisible && href ? `<p><a href="${esc(href)}">Review source →</a></p>` : '<p class="sub">Source item is not shown in the current review list.</p>'}</article>`;
    }).join('') : '<p class="empty">No in-app alerts recorded.</p>'}
    <h2>Recently completed follow-ups</h2>
    ${recent.length ? recent.map(followUpRow).join('') : '<p class="empty">No recently completed follow-ups.</p>'}`;
}

const CSS = `
@font-face { font-family: "IBM Plex Sans"; src: url("/assets/fonts/IBMPlexSans-400.woff2") format("woff2"); font-style: normal; font-weight: 400; font-display: swap; }
@font-face { font-family: "IBM Plex Sans"; src: url("/assets/fonts/IBMPlexSans-500.woff2") format("woff2"); font-style: normal; font-weight: 500; font-display: swap; }
@font-face { font-family: "IBM Plex Sans"; src: url("/assets/fonts/IBMPlexSans-600.woff2") format("woff2"); font-style: normal; font-weight: 600; font-display: swap; }
@font-face { font-family: "IBM Plex Sans"; src: url("/assets/fonts/IBMPlexSans-700.woff2") format("woff2"); font-style: normal; font-weight: 700; font-display: swap; }
@font-face { font-family: "IBM Plex Mono"; src: url("/assets/fonts/IBMPlexMono-400.woff2") format("woff2"); font-style: normal; font-weight: 400; font-display: swap; }
@font-face { font-family: "IBM Plex Mono"; src: url("/assets/fonts/IBMPlexMono-500.woff2") format("woff2"); font-style: normal; font-weight: 500; font-display: swap; }
@font-face { font-family: "IBM Plex Mono"; src: url("/assets/fonts/IBMPlexMono-600.woff2") format("woff2"); font-style: normal; font-weight: 600; font-display: swap; }
:root {
  color-scheme: light;
  --bg: #fff; --canvas: #fff; --panel: #fff; --ink: #142354; --muted: #66708f;
  --line: #dfe4f1; --accent: #0046ff; --good: #087a42; --warn: #a34a13;
  --bad: #b02020; --sel: #e8eeff; --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  --navy: #001bb7; --orange: #ff8040; --surface: #f6f7fb;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--canvas); color: var(--ink);
  font: 14px/1.5 "IBM Plex Sans", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.app-shell { min-height: 100vh; display: flex; flex-direction: column; }
a.skip-link { position: fixed; z-index: 30; top: 8px; left: 8px; transform: translateY(-160%);
  padding: 8px 12px; border-radius: 6px; background: #fff; color: var(--navy); }
a.skip-link:focus { transform: translateY(0); }
:focus-visible { outline: 3px solid var(--orange); outline-offset: 2px; }
.primary-header { position: sticky; z-index: 10; top: 0; min-height: 60px; display: flex; align-items: center;
  gap: 18px; padding: 0 24px; background: var(--navy); color: #fff; }
.brand { display: inline-flex; flex: 0 0 auto; align-items: center; color: #fff; text-decoration: none;
  font-size: 17px; font-weight: 700; letter-spacing: -.02em; }
.brand-mark { display: inline-grid; place-items: center; width: 24px; height: 24px; margin-right: 7px;
  border-radius: 6px; background: var(--orange); color: var(--navy); font: 700 13px/1 system-ui; }
.primary-nav { display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1;
  overflow-x: auto; scrollbar-width: thin; }
.primary-nav a { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
  padding: 7px 10px; border-radius: 6px; color: rgba(255,255,255,.82); text-decoration: none;
  font-size: 13px; font-weight: 500; }
.primary-nav a:hover, .primary-nav a:focus-visible { background: rgba(255,255,255,.14); color: #fff; }
.primary-nav a.on { background: var(--accent); color: #fff; }
.primary-nav .count { min-width: 20px; padding: 1px 6px; border-radius: 12px; background: var(--orange);
  color: var(--navy); text-align: center; font: 600 10px/1.5 var(--mono); }
.top-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.top-actions .upload-link { padding: 6px 10px; border-radius: 6px; background: #fff; color: var(--navy);
  text-decoration: none; font-weight: 600; }
.top-actions .client-chip { max-width: 210px; padding: 6px 10px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; border: 1px solid rgba(255,255,255,.35); border-radius: 6px; color: #fff; }
.top-actions .who { margin: 0; padding: 0; border: 0; color: #fff; }
.top-actions .who span { display: none; }
.top-actions .who a { margin-right: 4px; color: #fff; font-size: 12px; }
.top-actions .who button { margin: 0; border: 0; background: transparent; color: #fff; }
.top-actions .who button:hover { background: rgba(255,255,255,.12); }
.workspace { min-width: 0; flex: 1; }
.workspace > header.pagebar { position: sticky; top: 60px; z-index: 5; min-height: 56px; display: flex; align-items: center;
  gap: 14px; padding: 0 28px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,.97); }
.page-context { display: none; }
.secondary-nav { display: flex; align-items: stretch; gap: 20px; flex: 1; min-width: 0;
  overflow-x: auto; scrollbar-width: thin; }
.secondary-nav a { display: inline-flex; align-items: center; flex: 0 0 auto; padding: 16px 1px 13px;
  border-bottom: 3px solid transparent; color: #555b80; text-decoration: none; font-size: 13px; font-weight: 500; }
.secondary-nav a:hover, .secondary-nav a:focus-visible { color: var(--navy); }
.secondary-nav a.on { color: var(--navy); border-bottom-color: var(--accent); font-weight: 650; }
.firm-nav { display: flex; gap: 14px; align-items: center; margin-left: auto; flex: 0 0 auto; }
.firm-nav a { color: #555b80; text-decoration: none; font-size: 12px; }
.firm-nav a.on { color: var(--navy); font-weight: 650; }
.pagebar .ask-toggle { margin-left: 0; }
.suggestion-details { margin: 0 0 10px; padding: 8px 10px; background: #fff;
  border: 1px solid #e2e7f3; border-radius: 7px; }
.suggestion-details summary { cursor: pointer; color: #34446f; font-size: 12px; font-weight: 600; }
.suggestion-details p { margin: 8px 0 0; white-space: pre-wrap; }
.nav-group { margin: 13px 0 4px; padding: 0 13px; color: #79819a; font-size: 11px; font-weight: 700;
  letter-spacing: .05em; }
.ask-toggle { white-space: nowrap; border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
.primary-link { display: inline-flex; align-items: center; padding: 8px 12px; border-radius: 6px;
  background: var(--navy); color: #fff; text-decoration: none; font-weight: 600; }
.primary-link:hover, .primary-link:focus-visible { background: var(--accent); color: #fff; }
.ask-shade { position: fixed; inset: 0; z-index: 19; background: rgba(0,0,0,.38); }
.ask-drawer { position: fixed; z-index: 20; top: 0; right: 0; bottom: 0;
  width: min(390px, 94vw); box-sizing: border-box; display: flex; flex-direction: column;
  background: var(--bg); border-left: 3px solid var(--accent);
  box-shadow: -18px 0 45px rgba(0,0,0,.28); }
.ask-drawer[hidden], .ask-shade[hidden] { display: none; }
.ask-head { padding: 16px 16px 13px; border-bottom: 1px solid var(--line);
  display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.ask-head h2 { margin: 0 0 3px; font-size: 17px; }
.ask-close { padding: 3px 9px; font-size: 18px; line-height: 1; }
.ask-context { color: var(--muted); font-size: 12px; }
.ask-quick { padding: 12px 16px; display: flex; gap: 6px; flex-wrap: wrap;
  border-bottom: 1px solid var(--line); }
.ask-quick button { font-size: 12px; text-align: left; background: var(--panel); }
.ask-messages { flex: 1; overflow-y: auto; padding: 15px 16px; }
.ask-msg { margin: 0 0 14px; max-width: 92%; line-height: 1.45; }
.ask-msg.user { margin-left: auto; padding: 9px 11px; border-radius: 9px 9px 2px 9px;
  background: var(--accent); color: #fff; }
.ask-msg.bharat { padding-left: 11px; border-left: 2px solid var(--line); }
.ask-proof { margin-top: 7px; color: var(--muted); font-size: 11px; }
.ask-proof span + span::before { content: ' · '; }
.ask-action { display: inline-block; margin-top: 8px; color: var(--accent); font-size: 12px; }
.ask-compose { border-top: 1px solid var(--line); padding: 12px 16px 16px; }
.ask-compose form { display: flex; gap: 7px; }
.ask-compose input { flex: 1; min-width: 0; background: var(--panel); }
.ask-compose .why { margin-top: 7px; }
.nexus-page { padding: 0; max-width: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.pagebar-nexus:not(:has(.firm-nav)) { display: none !important; }
.pagebar-nexus { display: none !important; }
.nexus-workspace { display: grid; grid-template-columns: 220px minmax(390px, 1fr) minmax(280px, 330px);
  align-items: stretch; min-height: calc(100vh - 96px); color: #18265c; }
.nexus-rail { position: sticky; top: 96px; height: calc(100vh - 96px); box-sizing: border-box;
  display: flex; flex-direction: column; min-width: 0; padding: 18px 14px 16px;
  border-right: 1px solid #dce2f0; background: #f6f7fb; overflow-y: auto; }
.nexus-new { display: block; padding: 10px 12px; border-radius: 7px; background: var(--accent);
  color: #fff !important; text-align: center; text-decoration: none; font-size: 13px; font-weight: 650; }
.nexus-case-list { margin-top: 22px; }
.nexus-case-list h2, .nexus-context h2 { margin: 0 0 10px; color: #626b88; font-size: 11px;
  font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.nexus-case-list ul { list-style: none; margin: 0; padding: 0; }
.nexus-case-list li { display: grid; gap: 3px; margin-bottom: 5px; padding: 9px 9px; border-radius: 7px; }
.nexus-case-list li.selected { background: #e7edff; }
.nexus-case-list a { overflow: hidden; color: #1536bd; text-overflow: ellipsis; white-space: nowrap; text-decoration: none; font-size: 12px; }
.nexus-case-list .why { font-size: 10px; }
.nexus-rail-links { display: grid; gap: 8px; margin-top: auto; padding: 16px 8px 0; }
.nexus-rail-links a { color: #2443b9; font-size: 11px; }
.nexus-chat { display: flex; flex-direction: column; min-height: calc(100vh - 96px); min-width: 0;
  border-right: 1px solid #dce2f0; background: #fff; }
.nexus-head { position: sticky; top: 96px; z-index: 2; display: flex; align-items: center; gap: 12px;
  min-height: 65px; box-sizing: border-box; padding: 12px 24px; border-bottom: 1px solid var(--line); background: #fff; }
.nexus-head h1 { margin: 0; overflow: hidden; font-size: 18px; text-overflow: ellipsis; white-space: nowrap; }
.nexus-head p { margin: 4px 0 0; color: var(--muted); font-size: 11px; }
.nexus-viewer { margin-left: auto; color: var(--muted); font-size: 11px; white-space: nowrap; }
.nexus-viewer b, .nexus-saved { padding: 5px 10px; border: 1px solid #dce2f0; border-radius: 7px; color: var(--navy); }
.nexus-saved { font-size: 10px; text-transform: uppercase; }
.nexus-thread { flex: 1; overflow-y: auto; padding: 24px clamp(18px, 4vw, 54px); max-height: calc(100vh - 305px); }
.nexus-welcome { display: flex; gap: 12px; max-width: 680px; margin: 26px auto; color: #23367f; }
.nexus-welcome h2 { margin: 0 0 6px; font-size: 19px; }
.nexus-welcome p { margin: 0 0 14px; color: #69718e; line-height: 1.55; }
.nexus-spark { flex: 0 0 28px; height: 28px; border-radius: 8px; background: var(--accent); color: white; text-align: center; line-height: 28px; }
.nexus-starters { display: flex; gap: 7px; flex-wrap: wrap; }
.nexus-starters .nexus-prompt { width: auto; margin: 0; padding: 7px 10px; border-color: #dce2f0; border-radius: 18px; color: #2443b9; font-size: 11px; }
.nexus-turn { margin: 0 0 24px; }
.nexus-question { width: fit-content; max-width: 85%; margin-left: auto; padding: 10px 14px;
  border-radius: 10px 10px 2px 10px; background: #17275b; color: #fff; }
.nexus-answer { max-width: 92%; margin-top: 10px; padding: 2px 0 2px 13px;
  border-left: 2px solid #b5c4e4; line-height: 1.6; white-space: pre-wrap; }
.nexus-system { max-width: 92%; margin-top: 10px; color: var(--muted); font-size: 12px; }
.nexus-evidence { margin: 6px 0 0 13px; color: var(--muted); font-size: 11px; }
.nexus-action { display: inline-block; margin: 8px 0 0 13px; color: var(--accent); }
.nexus-compose { position: sticky; bottom: 0; z-index: 2; padding: 10px 24px 14px; border-top: 1px solid var(--line); background: #fff; }
.nexus-compose form.nexus-message-form { display: grid; gap: 7px; padding: 10px 12px; border: 1px solid #bcc8ff; border-radius: 12px; }
.nexus-compose textarea { width: 100%; min-height: 43px; max-height: 130px; border: 0; padding: 3px; resize: vertical;
  font: inherit; }
.nexus-compose-tools { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.nexus-attach, .nexus-tool, .nexus-upload-form button { display: inline-flex; padding: 6px 9px; border: 1px solid #dce2f0; border-radius: 18px; background: #fff; color: #2443b9; cursor: pointer; font-size: 11px; }
.nexus-file-input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.nexus-file-input:focus-visible + .nexus-tool { outline: 3px solid var(--focus); }
.nexus-upload-form { display: flex; min-height: 0; gap: 8px; align-items: center; }
.nexus-upload-form button { border-color: transparent; }
.nexus-upload-form[hidden] { display: none; }
.nexus-compose #nexus-upload-form { margin-top: 6px; align-items: center; flex-wrap: wrap; }
.nexus-compose #nexus-upload-form label { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 12px; }
.nexus-request { display: grid; gap: 7px; margin: 7px 0; }
.nexus-request label { display: grid; gap: 4px; font-size: 12px; }
.nexus-request textarea { min-height: 58px; resize: vertical; font: inherit; }
.nexus-request button { width: fit-content; }
.email-routes { display: grid; gap: 8px; }
.email-routes > div { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
.email-routes code { overflow-wrap: anywhere; }
.email-sample, .email-assign { display: grid; gap: 10px; max-width: 640px; }
.email-sample label, .email-assign label { display: grid; gap: 4px; }
.email-sample input, .email-sample textarea, .email-assign select { font: inherit; }
.email-sample textarea { min-height: 76px; }
.email-sample button, .email-assign button { width: fit-content; }
.email-item { margin-bottom: 12px; }
.email-item-top { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; }
.email-item-top h3 { margin: 0; }
.email-body { white-space: pre-wrap; overflow-wrap: anywhere; }
.nexus-context { position: sticky; top: 96px; height: calc(100vh - 96px); box-sizing: border-box;
  overflow-y: auto; padding: 18px 15px; background: #f8f9fc; }
.nexus-context-section { padding: 4px 4px 14px; margin-bottom: 12px; border-bottom: 1px solid #dce2f0; }
.nexus-context-section p { margin: 0; color: #606985; font-size: 12px; line-height: 1.5; }
.nexus-context-section a { color: #1741cd; font-size: 11px; }
.nexus-receipts { display: grid; gap: 7px; list-style: none; margin: 0; padding: 0; }
.nexus-receipt { display: grid; grid-template-columns: 22px minmax(0,1fr) auto; align-items: start; gap: 7px; padding: 9px;
  border: 1px solid #dce2f0; border-radius: 8px; background: #fff; font-size: 11px; }
.nexus-receipt > span:nth-child(2) { min-width: 0; overflow-wrap: anywhere; }
.nexus-receipt small { display: block; margin-top: 3px; color: var(--muted); }
.receipt-number { width: 18px; height: 18px; border-radius: 5px; background: var(--accent); color: white; text-align: center; line-height: 18px; }
.nexus-context-empty { color: var(--muted); font-size: 11px; line-height: 1.5; }
.nexus-context .nexus-waiting ul, .nexus-context-section > ul { list-style: none; margin: 0; padding: 0; }
.nexus-context-section > ul > li { padding: 7px 0; border-top: 1px solid #e4e8f2; }
.nexus-context .activity-row { padding: 7px 0; margin: 0; font-size: 11px; }
.nexus-context .activity-row::before { display: none; }
.nexus-context .activity-detail, .nexus-context .activity-meta { font-size: 10px; }
.nexus-advanced { padding: 8px 4px; border-bottom: 1px solid #dce2f0; font-size: 11px; }
.nexus-advanced summary { color: #2443b9; cursor: pointer; font-weight: 650; }
.nexus-advanced > div { display: grid; gap: 7px; padding-top: 10px; }
.nexus-prompt { width: 100%; text-align: left; margin: 0 0 8px; padding: 9px 11px; }
.nexus-context .nexus-task-workspace { padding: 9px 4px; border-bottom: 1px solid #dce2f0; font-size: 11px; }
.nexus-context .nexus-task-workspace > summary { color: #2443b9; cursor: pointer; font-weight: 650; }
.nexus-task-workspace > form { display: grid; gap: 9px; }
.nexus-task-workspace label { display: grid; gap: 5px; }
.nexus-task-workspace textarea { min-height: 84px; resize: vertical; font: inherit; }
.nexus-task-workspace fieldset { display: grid; gap: 6px; max-height: 220px; overflow: auto;
  border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
.nexus-task-workspace .nexus-obligation { display: flex; grid-template-columns: auto 1fr; gap: 7px; align-items: start; font-size: 12px; }
.nexus-task { border-top: 1px solid var(--line); padding: 10px 0; overflow-wrap: anywhere; }
.nexus-task pre { max-height: 220px; overflow: auto; white-space: pre-wrap; font-size: 11px; }
.nexus-task details { margin: 8px 0; }
.nexus-ai-consent { margin: 10px 0; }
.nexus-side a { display: block; margin: 7px 0; }
.nexus-progress-count { color: var(--muted); }
.nexus-progress-count b { color: var(--ink); font-size: 20px; }
.nexus-progress ul { list-style: none; padding: 0; margin: 10px 0; }
.nexus-progress li { display: grid; gap: 2px; padding: 9px 0; border-top: 1px solid var(--line); }
.nexus-waiting section { margin: 8px 0 14px; }
.nexus-waiting section:last-child { margin-bottom: 0; }
.nexus-waiting ul { list-style: none; padding: 0; margin: 4px 0 0; }
.nexus-waiting li { display: grid; gap: 3px; padding: 8px 0; border-top: 1px solid var(--line); }
.nexus-waiting a { font-size: 12px; }
.waiting-title { font-size: 12px; font-weight: 600; }
.nexus-activity { max-height: 460px; overflow-y: auto; }
.activity-feed { max-width: 850px; border-left: 1px solid var(--line); margin: 16px 0 0 8px; padding-left: 22px; }
.activity-row { position: relative; padding: 0 0 18px; margin-bottom: 4px; border-bottom: 1px solid var(--line); }
.activity-row::before { content: ''; position: absolute; left: -28px; top: 6px; width: 9px; height: 9px;
  border-radius: 50%; background: var(--accent); border: 2px solid #fff; outline: 1px solid var(--line); }
.activity-row-top { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.activity-status { color: var(--muted); font-size: 11px; white-space: nowrap; }
.activity-detail { margin-top: 3px; white-space: pre-wrap; overflow-wrap: anywhere; }
.activity-meta { color: var(--muted); font-size: 11px; margin: 3px 0; }
.activity-row a { font-size: 12px; }
.progress-status { color: var(--good); font-size: 11px; font-weight: 700; }
.nexus-run-status { display: inline-block; margin: 9px 0 0 12px; color: var(--good); font-size: 12px; font-weight: 650; }
.nexus-follow { display: block; margin: 9px 0 0 12px; border: 1px solid var(--line); border-radius: 6px;
  background: #fff; padding: 6px 9px; color: #29335a; cursor: pointer; font-size: 12px; }
@media (prefers-reduced-motion: no-preference) {
  .ask-drawer { animation: ask-in .16s ease-out; }
  @keyframes ask-in { from { transform: translateX(18px); opacity: .7; } }
}
main { padding: 30px; max-width: 1520px; margin: 0 auto; }
.today-page { max-width: none; padding: 0; }
.today-home { display: grid; grid-template-columns: minmax(0, 1fr) 300px; min-height: calc(100vh - 60px); }
.today-main-column { min-width: 0; padding: 28px clamp(20px, 3.6vw, 48px) 36px; display: flex; flex-direction: column; gap: 18px; }
.today-hero { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; }
.today-hero h1 { max-width: 850px; font-size: clamp(24px, 2.4vw, 30px); line-height: 1.2; margin: 5px 0 0; }
.today-hero h1 span { color: var(--accent); }
.today-eyebrow { display: flex; gap: 12px; align-items: center; color: #555b80; font: 500 10px var(--mono); letter-spacing: .045em; }
.today-period-picker { display: inline-flex; margin: 0; font: inherit; }
.today-period-picker label { display: inline-flex; align-items: center; gap: 4px; }
.today-period-picker select { width: auto; min-width: 90px; padding: 2px 5px; border: 0; border-radius: 4px; background: transparent; color: inherit; font: inherit; }
.today-viewer { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 8px; margin-top: 2px; color: var(--muted); font-size: 11px; }
.today-viewer b { border: 1px solid var(--line); border-radius: 7px; padding: 5px 10px; color: var(--navy); background: var(--surface); }
.today-ask { display: flex; align-items: center; gap: 10px; min-height: 52px; margin: 0; padding: 9px 13px; border: 1.5px solid var(--navy); border-radius: 12px; box-shadow: 0 6px 24px rgba(0,70,255,.08); }
.today-ask > span:first-child { color: var(--accent); }
.today-ask input { flex: 1; min-width: 0; padding: 5px 2px; border: 0; box-shadow: none; background: transparent; }
.today-ask input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.today-ask button { padding: 6px 12px; border-radius: 7px; border: 0; background: var(--accent); color: #fff; font-size: 12px; }
.today-ask button:hover { background: var(--navy); }
.today-queue { overflow: hidden; border: 1px solid var(--line); border-radius: 12px; }
.today-queue > header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 11px 14px; background: var(--surface); }
.today-queue > header div { display: flex; gap: 9px; align-items: baseline; flex-wrap: wrap; }
.today-queue h2, .today-info-card h2, .today-section-heading h2 { margin: 0; font-size: 14px; }
.today-queue > header span { color: var(--muted); font-size: 10px; }
.today-queue > header > a, .today-info-card > a, .today-rail-section > a:last-child { font-size: 11px; white-space: nowrap; }
.today-queue-row { display: grid; grid-template-columns: 82px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 14px; border-top: 1px solid #eef0f6; }
.today-queue-row > div { min-width: 0; display: grid; gap: 2px; }
.today-queue-row b { overflow: hidden; text-overflow: ellipsis; color: var(--navy); font-size: 12px; font-weight: 600; }
.today-queue-row small { color: var(--muted); font-size: 10.5px; }
.today-source { justify-self: start; padding: 2px 5px; border: 1px solid #c2d3ff; border-radius: 4px; background: #e8eeff; color: var(--accent); font: 600 9px var(--mono); }
.today-queue-action { padding: 5px 9px; border: 1px solid var(--line); border-radius: 6px; color: var(--navy); font-size: 10px; text-align: center; text-decoration: none; white-space: nowrap; }
.today-queue-action.primary { background: var(--navy); color: #fff; }
.today-clear { padding: 10px 14px; margin: 0; color: var(--muted); font-size: 12px; }
.today-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.today-metric { min-width: 0; display: flex; flex-direction: column; gap: 3px; padding: 12px 13px; border: 1px solid var(--line); border-radius: 11px; text-decoration: none; }
.today-metric:hover { border-color: var(--accent); }
.today-metric-label { color: var(--muted); font-size: 10.5px; }
.today-metric b { overflow: hidden; text-overflow: ellipsis; color: var(--navy); font: 500 18px var(--mono); white-space: nowrap; }
.today-metric b.warn, .today-gst-values .warn b { color: var(--bad); }
.today-metric small { color: var(--muted); font-size: 9.5px; line-height: 1.4; }
.today-lower-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.today-info-card { min-width: 0; padding: 14px 15px; border: 1px solid var(--line); border-radius: 11px; }
.today-info-card p, .today-rail-section p { margin: 7px 0; color: var(--muted); font-size: 11px; }
.today-info-card ul { margin: 8px 0; padding-left: 18px; font-size: 11px; }
.today-alert-card { border-color: #ffc6a6; background: #fff5ef; }
.today-gst-values { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin: 13px 0 8px; }
.today-gst-values div { display: grid; gap: 2px; }
.today-gst-values small { color: var(--muted); font-size: 9px; }
.today-gst-values b { color: var(--navy); font: 500 14px var(--mono); }
.today-recent { margin: 0; }
.today-section-heading { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; margin-bottom: 7px; }
.today-section-heading > a { font-size: 10.5px; }
.today-posted-list { border-top: 1px solid var(--line); }
.today-posted-row { display: grid; grid-template-columns: minmax(90px, 1.1fr) minmax(100px, 2fr) minmax(70px, .7fr) minmax(85px, .8fr); gap: 10px; align-items: center; padding: 7px 0; border-bottom: 1px solid #eef0f6; color: var(--navy); font-size: 10.5px; text-decoration: none; }
.today-posted-row time { color: var(--muted); }
.today-posted-row > b { text-align: right; font: 500 10.5px var(--mono); }
.today-rail { min-width: 0; padding: 22px 18px; border-left: 1px solid var(--line); background: var(--surface); display: flex; flex-direction: column; gap: 16px; }
.today-rail-card { padding: 13px 14px; background: #fff; border: 1px solid var(--line); border-radius: 11px; }
.today-health { display: flex; gap: 11px; align-items: center; padding-bottom: 10px; }
.today-health-mark { width: 46px; height: 46px; display: grid; place-items: center; flex: 0 0 auto; border: 4px solid var(--accent); border-radius: 50%; color: var(--navy); font: 600 17px var(--mono); }
.today-health div { display: grid; gap: 2px; }
.today-health small, .today-rail-section h2 { color: #555b80; font-size: 10px; letter-spacing: .04em; }
.today-health b { font-size: 11.5px; }
.today-health-items { display: grid; gap: 5px; padding: 8px 0; border-top: 1px solid #eef0f6; }
.today-health-items small, .today-health-items a { font-size: 10px; }
.today-health-items small { color: var(--muted); }
.today-health-items a { color: var(--navy); text-decoration: none; }
.today-rail-card > a, .today-rail-section > a:last-child { font-size: 10.5px; }
.today-rail-section { display: flex; flex-direction: column; gap: 6px; }
.today-rail-section h2 { margin: 0; }
.today-rail-row, .today-activity-row { display: grid; gap: 2px; padding: 7px 0; border-bottom: 1px solid var(--line); color: var(--navy); text-decoration: none; }
.today-rail-row b, .today-activity-row b { font-size: 10.5px; font-weight: 500; }
.today-rail-row small, .today-activity-row small, .today-activity-row time { color: var(--muted); font-size: 9.5px; }
.today-heading { display: flex; justify-content: space-between; gap: 18px; align-items: start; }
.today-heading h1 { margin-bottom: 2px; }
.today-heading .row { margin: 0; }
.today-grid { display: grid; grid-template-columns: minmax(280px, .85fr) minmax(0, 1.4fr); gap: 14px; align-items: start; }
.today-grid > .panel { margin: 0; }
.today-grid h2, .today-recent h2 { margin: 0 0 8px; }
.today-section-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
.today-section-head .sub { margin-bottom: 8px; }
.today-actions { display: grid; }
.today-action { display: grid; gap: 3px; padding: 11px 0; border-top: 1px solid var(--line); text-decoration: none; }
.today-action b { color: var(--ink); }
.today-action span, .today-clear { color: var(--muted); font-size: 12px; }
.today-action:hover b { color: var(--accent); }
.today-needs .msg { margin-top: 12px; }
.today-position .tiles { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 0; }
.today-position .tile { padding: 13px; }
.today-position .tile b { font-size: 19px; }
.today-recent { margin-top: 22px; }
h1 { color: #142354; font-size: 25px; letter-spacing: -.035em; margin: 0 0 6px; }
h2 { color: #142354; font-size: 15px; margin: 24px 0 9px; }
.sub { color: var(--muted); margin: 0 0 16px; }
.panel {
  background: var(--panel); border: 1px solid #e0e4ee;
  border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(20,35,84,.025);
}
.report-range { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; margin: 14px 0 18px; }
.report-range label { display: grid; gap: 4px; color: var(--muted); font-size: 12px; }
.report-range input, .report-range select { min-width: 170px; }
.report-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.report-summary > div { display: grid; gap: 4px; padding: 4px 8px; border-right: 1px solid var(--line); }
.report-summary > div:last-child { border: 0; }
.report-summary span { color: var(--muted); font-size: 12px; }
.report-summary b { font: 600 20px/1.35 var(--mono); overflow-wrap: anywhere; }
.report-total td, .report-total th { border-top: 1px solid #c4cbe0; font-weight: 700; color: var(--navy); }
.balance-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.balance-columns h2 { margin-top: 0; }
.period-close-head { display: flex; justify-content: space-between; gap: 14px; align-items: start; }
.period-close-head h2 { margin: 0; }
.period-close-form { display: grid; gap: 10px; max-width: 600px; margin-top: 14px; }
.period-close-form label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
.period-close-form textarea { min-height: 76px; font: inherit; }
.doc-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 6px; }
.doc-actions a { font-size: 12px; }
.inbox-heading { display: flex; align-items: end; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
.inbox-heading > div { margin-right: auto; }
.inbox-heading .sub { margin-bottom: 2px; }
.inbox-upload { display: inline-flex; align-items: center; gap: 7px; padding: 7px 9px; border: 1px solid var(--line);
  border-radius: 6px; background: #fff; color: var(--navy); font-size: 12px; font-weight: 600; }
.inbox-upload input { max-width: 205px; font-size: 12px; }
.inbox-limit { margin: 0 0 8px; }
.inbox-ai { padding: 9px 12px; }
.inbox-ai summary { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.inbox-ai p { max-width: 880px; }
.inbox-filters { display: flex; align-items: center; gap: 7px; margin: 12px 0; overflow-x: auto; }
.inbox-filters > a { display: inline-flex; gap: 6px; align-items: center; flex: 0 0 auto; padding: 6px 10px;
  border: 1px solid var(--line); border-radius: 18px; color: var(--muted); text-decoration: none; font-size: 12px; }
.inbox-filters > a.on { border-color: var(--navy); background: var(--navy); color: #fff; }
.inbox-filters > a b { font: 600 10px var(--mono); }
.inbox-type-filter { flex: 0 0 auto; margin-left: auto; }
.inbox-type-filter label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.inbox-type-filter select { padding: 5px 8px; }
.inbox-layout { display: grid; grid-template-columns: minmax(260px, 33%) minmax(0, 1fr); gap: 0; align-items: stretch; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; background: #f6f7fb; }
.inbox-layout > .panel { margin: 0; border: 0; border-radius: 0; box-shadow: none; }
.inbox-list { max-height: 76vh; overflow-y: auto; padding: 0; border-right: 1px solid var(--line) !important; background: #fff; }
.inbox-list h2 { position: sticky; top: 0; z-index: 1; margin: 0; padding: 12px 13px; background: #fff; border-bottom: 1px solid var(--line); }
.inbox-document { display: grid; gap: 5px; padding: 11px 13px; border-bottom: 1px solid var(--line); color: var(--ink); text-decoration: none; }
.inbox-document:hover, .inbox-document.selected { background: var(--sel); }
.inbox-document.selected { box-shadow: inset 3px 0 0 var(--accent); }
.inbox-document > span:first-child { display: flex; justify-content: space-between; gap: 7px; }
.inbox-document b { overflow-wrap: anywhere; }
.inbox-document small { color: var(--muted); font-size: 11px; }
.inbox-document-status { color: var(--accent); font-size: 11px; }
.inbox-detail { min-width: 0; padding: 16px !important; }
.inbox-review-grid { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(270px, .88fr); gap: 18px; align-items: start; }
.inbox-preview { min-width: 0; position: sticky; top: 16px; }
.inbox-preview-canvas { display: grid; place-items: center; min-height: 440px; border: 1px solid #dce1eb; border-radius: 8px; background: repeating-linear-gradient(135deg,#fff,#fff 12px,#f3f5fa 12px,#f3f5fa 24px); text-align: center; padding: 20px; }
.inbox-preview-canvas > div { display: grid; gap: 12px; max-width: 270px; }
.inbox-preview-canvas b { color: var(--navy); overflow-wrap: anywhere; }
.inbox-preview-canvas span, .inbox-preview > .why { color: var(--muted); font-size: 12px; }
.inbox-preview-canvas a { display: inline-flex; justify-content: center; padding: 8px 11px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--navy); text-decoration: none; }
.inbox-file-head { display: grid; gap: 5px; margin-bottom: 12px; }
.inbox-file-head h2 { margin: 0; overflow-wrap: anywhere; }
.inbox-file-head small { color: var(--muted); }
.inbox-suggestion, .inbox-class-review, .inbox-next-step, .inbox-history, .inbox-ca-actions { padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: #fff; margin-bottom: 10px; }
.inbox-suggestion-title { display: flex; justify-content: space-between; gap: 8px; color: var(--navy); font-size: 12px; }
.inbox-suggestion-title span { color: var(--muted); }
.inbox-suggestion > strong { display: block; color: var(--navy); margin-top: 4px; }
.inbox-suggestion p, .inbox-suggestion details p { color: var(--muted); font-size: 12px; line-height: 1.5; }
.inbox-suggestion details summary, .inbox-history summary, .inbox-ca-actions summary { color: var(--navy); cursor: pointer; font-size: 12px; font-weight: 600; }
.inbox-class-review h3 { margin: 0 0 9px; color: var(--navy); font-size: 13px; }
.inbox-class-choices { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 6px; margin-bottom: 9px; }
.inbox-class-choices button { padding: 7px 8px; text-align: left; font-size: 11px; }
.inbox-class-choices button.selected { border-color: var(--accent); background: var(--sel); color: var(--navy); box-shadow: inset 0 0 0 1px var(--accent); }
.inbox-next-step { display: grid; gap: 7px; font-size: 12px; }
.inbox-history ol { list-style: none; padding: 0; margin: 10px 0 0; }
.inbox-history li { display: grid; gap: 2px; border-left: 2px solid var(--accent); padding: 0 0 11px 12px; font-size: 12px; }
.inbox-history li span { color: var(--muted); }
.doc-review-actions { display: grid; gap: 7px; margin-top: 10px; }
.doc-review-actions label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
.doc-review-actions textarea { min-height: 54px; width: 100%; resize: vertical; }
.inbox-requests { border-color: #ffd2bb; background: #fff8f3; }
.inbox-requests h2 { margin: 0 0 10px; color: #a84115; }
.inbox-answer-request { display: grid; grid-template-columns: minmax(0,1fr) auto auto; align-items: center; gap: 8px; padding: 10px 0; border-top: 1px solid #f0d9cc; }
.inbox-answer-request > p { grid-column: 1 / -1; display: flex; justify-content: space-between; margin: 0; color: var(--navy); font-size: 12px; }
.inbox-answer-request > div { color: var(--ink); font-size: 13px; }
.inbox-answer-request textarea { grid-column: 1 / -1; min-height: 54px; }
.inbox-attach { color: var(--navy); font-size: 12px; cursor: pointer; }
.inbox-attach input { display: block; max-width: 210px; font-size: 11px; }
.inbox-request-result { grid-column: 1 / -1; color: var(--muted); font-size: 12px; }
.inbox-empty-detail { padding: 24px; color: var(--muted); }
.inbox-empty-detail h2 { margin-top: 0; color: var(--navy); }
.inbox-detail-table { overflow-x: auto; margin-top: 12px; }
.inbox-detail-table table { min-width: 780px; }
.inbox-detail-table td:first-child { min-width: 250px; }
.inbox-detail-table td:nth-child(3) { min-width: 185px; }
.inbox-detail-table td:last-child { min-width: 180px; }
.doc-review-actions { display: grid; gap: 6px; min-width: 190px; }
.doc-review-actions textarea { min-height: 54px; width: 100%; resize: vertical; }
.page-intro { display:flex; align-items:end; justify-content:space-between; gap:12px; margin-bottom:8px; }
.page-intro .sub { margin-bottom:4px; }
.eyebrow { margin:0 0 4px; color:var(--muted); font-size:10px; font-weight:700; letter-spacing:.09em; }
.bill-next-step { margin-bottom:14px; }
.bill-summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); padding:0; overflow:hidden; }
.bill-filter { display:grid; justify-items:start; gap:4px; min-height:76px; padding:13px 16px; border:0; border-right:1px solid var(--line); border-radius:0; background:#fff; text-align:left; }
.bill-filter:last-child { border-right:0; }
.bill-filter:hover,.bill-filter.on { background:var(--sel); }
.bill-filter b { font:600 21px/1.2 var(--mono); }
.bill-filter span { color:var(--muted); font-size:12px; }
.bill-review-guidance { margin:0 0 10px; }
.bill-card-list { display:grid; gap:10px; }
.billcard[hidden] { display:none; }
.strip { display: flex; gap: 22px; flex-wrap: wrap; align-items: center; }
.stat b { display: block; font-size: 19px; font-variant-numeric: tabular-nums; }
.stat span { color: var(--muted); font-size: 12px; }
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left; font-size: 11px; letter-spacing: .02em; color: var(--muted); font-weight: 650;
  padding: 6px 8px; border-bottom: 1px solid var(--line);
}
td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); }
tr.row { cursor: default; }
tr.row:hover { background: var(--sel); }
tr.row.sel { background: var(--sel); box-shadow: inset 3px 0 0 var(--accent); }
.narr { font-family: var(--mono); font-size: 12px; word-break: break-all; }
.tag {
  display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 20px;
  border: 1px solid var(--line); color: var(--muted); text-transform: uppercase;
  letter-spacing: .03em;
}
.score { font-family: var(--mono); font-weight: 600; }
.s-hi { color: var(--good); } .s-mid { color: var(--warn); } .s-lo { color: var(--muted); }
.amb { color: var(--bad); font-weight: 600; }
.why { color: var(--muted); font-size: 12px; }
.empty { color: var(--muted); padding: 30px 0; }
button, select, input, textarea {
  font: inherit; color: var(--ink); background: var(--panel);
  border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px;
}
button { cursor: pointer; }
button.primary { background: #17275b; color: #fff; border-color: transparent; box-shadow: 0 2px 5px rgba(23,39,91,.14); }
button:disabled { opacity: .5; cursor: default; }
textarea { width: 100%; min-height: 150px; font-family: var(--mono); font-size: 12px; }
.row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.bank-review { margin-top: 8px; border-top: 1px solid var(--line); padding-top: 6px; }
.bank-review summary { cursor: pointer; color: var(--accent); font-size: 12px; }
.bank-review-body { display: grid; grid-template-columns: repeat(2, minmax(130px, 1fr)); gap: 7px 10px;
  margin-top: 8px; padding: 10px; border-left: 3px solid #c8d3f7; background: #f8faff; }
.bank-review-body label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--muted); }
.bank-review-body [hidden] { display: none !important; }
.bank-review-body input, .bank-review-body select { width: 100%; padding: 5px 7px; font-size: 12px; }
.review-kind-field { display: flex; flex-direction: column; gap: 3px; min-width: 0;
  color: var(--muted); font-size: 11px; }
.review-kind-picker { position: relative; width: 100%; min-width: 0; }
.review-kind-picker summary { display: flex; align-items: center; justify-content: space-between; gap: 10px;
  list-style: none; color: var(--ink); background: #fff; border: 1px solid #cfd5e2;
  border-radius: 7px; padding: 7px 10px; font-size: 13px; }
.review-kind-picker summary::-webkit-details-marker { display: none; }
.review-kind-picker summary::after { content: '⌄'; flex: 0 0 auto; color: #59657e; }
.review-kind-picker[open] summary::after { transform: rotate(180deg); }
.review-kind-options { position: absolute; z-index: 8; top: calc(100% + 4px); left: 0;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; width: min(360px, 84vw);
  max-height: 260px; overflow-y: auto; padding: 5px; background: #fff; border: 1px solid #d8deea;
  border-radius: 8px; box-shadow: 0 10px 26px rgba(23,39,91,.18); }
.review-kind-options button { border-color: transparent; background: #fff; text-align: left;
  font-size: 12px; line-height: 1.35; }
.review-kind-options button:hover { background: #f2f5fc; }
.review-kind-options button[aria-pressed="true"] { background: var(--sel); border-color: #b8c7f0; color: #17275b; }
.bank-review-body .review-explain { grid-column: 1 / -1; margin: 0; }
.bank-review-body .review-submit { justify-self: start; font-size: 12px; }
@media (max-width: 900px) { .bank-review-body { grid-template-columns: 1fr; } }
.warn { color: var(--warn); } .bad { color: var(--bad); } .good { color: var(--good); }
/* A link that sits beside a button and should read as one. */
/* Who is signed in, and the way out. Deliberately a form and not a link:
   signing out changes state, and a GET that changes state can be triggered by
   anything that renders a URL. */
.who { margin-top: auto; padding: 14px 8px 0; border-top: 1px solid #e1e5f0; display: flex;
  align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.who button { margin-left: auto; padding: 4px 8px; font: inherit; font-size: 12px; }
.btnlink { display: inline-block; margin-left: 6px; padding: 3px 9px; font-size: 13px;
  border: 1px solid var(--line); border-radius: 6px; text-decoration: none;
  color: var(--ink); }
/* A disposed asset stays on the register — it is history, not a mistake —
   but it should not read as something the client still owns. */
tr.gone td { opacity: .55; }
.cnbox { display: flex; gap: 4px; margin-top: 4px; }
.cnbox input { width: 130px; padding: 3px 6px; font: inherit;
  border: 1px solid var(--line); border-radius: 4px; }
/* A month whose deposit deadline has passed. Tinted rather than just
   red-texted: it is the row a CA has to act on today. */
.lategrp td { background: color-mix(in srgb, var(--bad) 7%, transparent); }
.msg { padding: 10px 12px; border-radius: 6px; border: 1px solid var(--line); margin: 10px 0; }
.msg.bad { border-color: var(--bad); }
.msg.good { border-color: var(--good); }
kbd {
  font-family: var(--mono); font-size: 11px; border: 1px solid var(--line);
  border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; color: var(--muted);
}
.keys { color: var(--muted); font-size: 12px; margin-top: 10px; }
.keys kbd { margin: 0 2px; }
dialog { border: 1px solid var(--line); border-radius: 10px; background: var(--panel);
  color: var(--ink); max-width: 420px; padding: 18px; }
dialog::backdrop { background: rgba(0,0,0,.4); }
.mono { font-family: var(--mono); font-size: 12px; }
.muted { color: var(--muted); }
.note { color: var(--muted); font-size: 13px; max-width: 40ch; }
.tag.good { background: color-mix(in srgb, var(--good) 15%, transparent); color: var(--good); }
.tag.bad  { background: color-mix(in srgb, var(--bad) 15%, transparent); color: var(--bad); }
.tag.warn { background: color-mix(in srgb, var(--warn, #b8860b) 18%, transparent); }
.tag.amb  { background: color-mix(in srgb, var(--bad) 10%, transparent); }
tr.done { opacity: .5; }
.warn { color: var(--warn, #b8860b); font-weight: 600; }
.mt { margin-top: 26px; }
.setup-step { border-left: 3px solid var(--line); padding: 10px 12px; margin: 8px 0;
  background: var(--panel); }
.setup-step b { display: block; margin-bottom: 3px; }
.setup-step.good { border-left-color: var(--good); }
.setup-step.warn { border-left-color: var(--warn); }
.billcard { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px;
  margin: 12px 0; background: var(--panel); }
.billcard.blocked { border-color: color-mix(in srgb, var(--bad) 40%, var(--line)); }
.billcard.needs_answer { border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
.billcard.done { opacity: .55; }
.billhead { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  align-items: baseline; }
.billhead b { margin-right: 8px; }
.figs { display: flex; gap: 24px; margin: 12px 0; flex-wrap: wrap; }
.fig { display: flex; flex-direction: column; }
.fig b { font-variant-numeric: tabular-nums; font-family: var(--mono); font-size: 17px; }
.fig span span, .fig > span:last-child { font-size: 11px; color: var(--muted); }
.confirm { background: color-mix(in srgb, var(--warn) 12%, transparent);
  border-radius: 8px; padding: 10px 12px; margin: 8px 0; }
.confirm p { margin: 0 0 6px; }
.pick { display: block; margin: 3px 0; cursor: pointer; }
.warns, .blocks { margin: 8px 0 0; padding-left: 18px; font-size: 13px; }
.warns li { color: var(--muted); }
.blocks li { color: var(--bad); }
.billactions { margin-top: 12px; }
.banksetup { max-width: 760px; margin-top: 14px; border-left: 3px solid var(--accent); }
.banksetup .formgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 18px; }
.banksetup label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; }
.banksetup input, .banksetup select { width: 100%; box-sizing: border-box; }
.banksetup .billactions { display: flex; align-items: center; gap: 10px; }
@media (max-width: 620px) { .banksetup .formgrid { grid-template-columns: 1fr; } }
.fill { margin-top: 12px; padding: 12px; border: 1px solid var(--line);
        border-radius: 6px;
        background: color-mix(in srgb, var(--accent) 5%, var(--panel));
        color: var(--ink); }
.fillhead { font-weight: 600; margin-bottom: 10px; }
/* Master data, kept visually apart from the per-bill form: saving here prices
   every future bill from this supplier, not just the one on screen. */
.partyrcm { margin-top: 12px; padding: 12px; border: 1px solid var(--line);
        border-left: 3px solid var(--warn); border-radius: 6px;
        background: color-mix(in srgb, var(--warn) 7%, var(--panel)); }
.partyrcm select { padding: 6px 8px; border: 1px solid var(--line);
        border-radius: 4px; font: inherit; }
.fillrow { margin-bottom: 12px; }
.fillrow label { display: block; font-size: 13px; margin-bottom: 4px; }
.fillrow label .muted { font-weight: 400; }
.fillrow input { padding: 6px 8px; border: 1px solid var(--line); border-radius: 4px;
                 font: inherit; min-width: 220px; }
.fillfigs { display: flex; gap: 6px; flex-wrap: wrap; }
.fillfigs input { min-width: 0; width: 108px; text-align: right;
                  font-variant-numeric: tabular-nums; }
.expenseonly { margin-top: 12px; padding: 14px; border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--warn) 55%, var(--line));
  background: color-mix(in srgb, var(--warn) 8%, var(--panel)); }
.expenseonly h3 { margin: 0 0 4px; font-size: 16px; }
.expenseonly .expensegrid { display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(220px, 1fr) auto;
  gap: 10px; align-items: end; margin-top: 12px; }
.expenseonly label { display: flex; flex-direction: column; gap: 4px;
  color: var(--muted); font-size: 12px; }
.expenseonly input, .expenseonly select { width: 100%; background: var(--panel); }
.manualalternative { margin-top: 10px; color: var(--muted); }
.manualalternative summary { cursor: pointer; font-size: 13px; }
@media (max-width: 720px) { .expenseonly .expensegrid { grid-template-columns: 1fr; } }
.small { font-size: 12px; }
.billctl { display: flex; gap: 20px; align-items: center; flex-wrap: wrap;
  margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); }
.billctl label { font-size: 13px; color: var(--muted); }
.billctl select { margin-left: 6px; font-family: inherit; padding: 3px 6px;
  background: var(--panel); color: var(--ink); border: 1px solid var(--line);
  border-radius: 6px; }
.billctl .chk { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.lines { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); }
.lines table { width: 100%; }
.lines th { font-size: 11px; color: var(--muted); text-transform: uppercase;
  letter-spacing: .04em; text-align: left; padding-bottom: 4px; }
.lines td { padding: 4px 8px 4px 0; vertical-align: middle; }
.lines select { font-family: inherit; padding: 3px 6px; background: var(--panel);
  color: var(--ink); border: 1px solid var(--line); border-radius: 6px; max-width: 260px; }
.learned { font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--accent); border: 1px solid var(--accent); border-radius: 4px;
  padding: 0 4px; margin-left: 6px; vertical-align: middle; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px; margin: 16px 0; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 16px; display: flex; flex-direction: column; gap: 4px; text-decoration: none;
  color: inherit; }
a.tile:hover { border-color: var(--accent); }
.tile b { font-size: 24px; font-variant-numeric: tabular-nums; font-family: var(--mono); }
.tile span { font-size: 12px; color: var(--muted); }
.payrow { display: flex; gap: 14px; align-items: flex-end; flex-wrap: wrap;
  padding: 8px 0; }
.payrow label { display: flex; flex-direction: column; font-size: 12px;
  color: var(--muted); gap: 3px; }
.payrow input, .payrow select { font-family: inherit; padding: 4px 6px;
  background: var(--bg); color: var(--ink); border: 1px solid var(--line);
  border-radius: 6px; }
tr.payform td { background: color-mix(in srgb, var(--accent) 6%, transparent); }
tr.hot td { background: color-mix(in srgb, var(--bad) 7%, transparent); }
.sales-head { display: flex; align-items: flex-start; justify-content: space-between;
  gap: 18px; margin-bottom: 14px; }
.sales-grid { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 14px; }
.invoice-meta { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr));
  gap: 10px; margin-bottom: 14px; }
.invoice-meta label, .customer-form label { display: flex; flex-direction: column;
  gap: 4px; color: var(--muted); font-size: 12px; }
.invoice-meta input, .invoice-meta select, .customer-form input, .customer-form select {
  width: 100%; color: var(--ink); background: var(--bg); }
.entry-table th { white-space: nowrap; }
.entry-table input, .entry-table select { width: 100%; min-width: 68px;
  background: var(--bg); }
.entry-table .desc { min-width: 210px; }
.entry-table .hsn { min-width: 90px; }
.entry-table .account { min-width: 150px; }
.entry-table .remove { padding: 5px 8px; color: var(--bad); }
.ledger-proof { position: sticky; top: 58px; border-top: 3px solid var(--accent); }
.ledger-proof h2 { margin-top: 0; }
.proof-line { display: flex; justify-content: space-between; gap: 12px;
  padding: 5px 0; border-bottom: 1px solid var(--line); }
.proof-line b { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.proof-total { font-size: 16px; padding-top: 10px; border-bottom: 0; }
.customer-form { display: grid; grid-template-columns: 1.2fr 1.2fr 1fr .8fr 1.5fr auto;
  gap: 10px; align-items: end; }
.quick-due { display: flex; align-items: center; gap: 6px; margin-top: -6px;
  margin-bottom: 12px; color: var(--muted); font-size: 12px; }
.quick-due button { padding: 3px 8px; }
.invoice-shortcuts { color: var(--muted); font-size: 12px; }
.invoice-share { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.invoice-share a { margin-left: 0; }
.sales-actions { display: flex; justify-content: space-between; align-items: center;
  gap: 10px; margin-top: 12px; }
.invoice-paper { max-width: 850px; margin: 0 auto; }
.invoice-title { display: flex; justify-content: space-between; gap: 20px;
  padding-bottom: 14px; border-bottom: 2px solid var(--ink); }
.invoice-total { font-size: 22px; font-family: var(--mono); }
@media (max-width: 900px) {
  .primary-header { min-height: 56px; gap: 12px; padding: 8px 14px 0; flex-wrap: wrap; }
  .primary-nav { order: 3; flex-basis: calc(100% + 28px); margin: 0 -14px; padding: 0 14px; }
  .top-actions { margin-left: auto; }
  .top-actions .upload-link { display: inline-flex; padding: 4px 7px; font-size: 11px; }
  .workspace > header.pagebar { top: 56px; min-height: 49px; gap: 9px; padding: 0 12px; }
  .firm-nav { display: flex; max-width: 36vw; overflow-x: auto; gap: 10px; }
  .secondary-nav { gap: 16px; }
  .secondary-nav a { padding-top: 13px; padding-bottom: 10px; }
  main { padding: 20px 16px; }
  .sales-grid { grid-template-columns: 1fr; }
  .report-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .balance-columns { grid-template-columns: 1fr; }
  .today-grid { grid-template-columns: 1fr; }
  .today-home { grid-template-columns: minmax(0,1fr) 260px; }
  .today-main-column { padding: 22px 18px; }
  .today-rail { padding: 18px 13px; }
  .today-metrics { grid-template-columns: repeat(2, minmax(0,1fr)); }
  .today-viewer { display: none; }
  .inbox-layout { grid-template-columns: 1fr; }
  .inbox-list { max-height: 300px; }
  .inbox-review-grid { grid-template-columns: 1fr; }
  .inbox-preview { position: static; }
  .inbox-preview-canvas { min-height: 260px; }
  .invoice-meta { grid-template-columns: repeat(2, minmax(130px, 1fr)); }
  .customer-form { grid-template-columns: 1fr 1fr; }
  .ledger-proof { position: static; }
  .bill-summary { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .bill-filter:nth-child(2) { border-right:0; }
  .bill-filter:nth-child(-n+2) { border-bottom:1px solid var(--line); }
  .entry-scroll { overflow-x: auto; }
  .nexus-workspace { grid-template-columns: 190px minmax(0,1fr); }
  .nexus-context { position: static; grid-column: 1 / -1; display: grid; grid-template-columns: repeat(2,minmax(0,1fr));
    gap: 10px; height: auto; max-height: 460px; border-top: 1px solid var(--line); }
  .nexus-chat { min-height: 660px; }
  .nexus-thread { max-height: 55vh; }
  .nexus-rail { top: 96px; height: calc(100vh - 96px); }
  .nexus-head { top: 96px; }
  .nexus-context { top: 96px; }
}
@media (max-width: 700px) {
  .today-home { grid-template-columns: 1fr; }
  .today-main-column { padding: 20px 14px; }
  .today-rail { border-left: 0; border-top: 1px solid var(--line); padding: 16px 14px; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); align-items: start; }
  .today-hero { display: block; }
  .today-eyebrow { flex-wrap: wrap; }
  .today-lower-grid { grid-template-columns: 1fr; }
  .today-queue-row { grid-template-columns: 68px minmax(0,1fr); }
  .today-queue-action { grid-column: 2; justify-self: start; }
}
@media (max-width: 560px) {
  .primary-header { gap: 8px; }
  .brand { font-size: 16px; }
  .top-actions .client-chip { max-width: 125px; padding: 5px 7px; font-size: 11px; }
  .top-actions .who button { padding: 5px 4px; font-size: 11px; }
  .workspace > header.pagebar:not(.pagebar-nexus) { align-items: stretch; flex-direction: column; gap: 0; padding: 0 12px; }
  .secondary-nav { min-height: 45px; order: 1; padding-right: 94px; }
  .firm-nav { order: 2; max-width: 100%; min-height: 36px; margin: 0; padding: 0 0 7px; }
  .pagebar .ask-toggle { align-self: flex-end; position: absolute; top: 7px; right: 12px; }
  .nexus-workspace { display: flex; flex-direction: column; min-height: 0; }
  .nexus-rail { position: static; height: auto; max-height: 210px; overflow-y: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .nexus-case-list { margin-top: 13px; }
  .nexus-case-list ul { display: flex; gap: 6px; overflow-x: auto; }
  .nexus-case-list li { min-width: 145px; }
  .nexus-rail-links { display: flex; gap: 12px; padding-top: 9px; }
  .nexus-chat { min-height: 68vh; border-right: 0; }
  .nexus-head { position: static; flex-wrap: wrap; padding: 10px 14px; }
  .nexus-thread { max-height: none; min-height: 260px; padding: 16px 14px; }
  .nexus-compose { padding: 9px 12px; }
  .nexus-context { display: block; max-height: none; padding: 14px; }
  .nexus-context-section { margin-bottom: 7px; }
  .today-heading { flex-direction: column; }
  .inbox-heading { align-items: start; }
  .inbox-heading > div { flex-basis: 100%; }
  .inbox-upload { width: 100%; justify-content: space-between; }
  .inbox-type-filter { margin-left: 0; }
  .inbox-answer-request { grid-template-columns: 1fr; }
  .inbox-answer-request > p, .inbox-answer-request textarea, .inbox-request-result { grid-column: 1; }
  .inbox-attach input { max-width: 100%; }
  .inbox-detail { padding: 12px !important; }
  .inbox-class-choices { grid-template-columns: 1fr 1fr; }
  .page-intro { align-items:start; flex-direction:column; }
}
@media print {
  header, .no-print { display: none !important; }
  body, main { background: #fff; color: #000; }
  main { padding: 0; max-width: none; }
  .invoice-paper { border: 0; }
}
`;

// ---------------------------------------------------------------------------

export function renderShell(a: {
  session: { clientName: string; displayName?: string; email?: string;
    role?: string; boundClientId?: string | null };
  accounts: Array<{ id: string; bank_name: string; last4: string }>;
  active: string;
  accountId?: string;
  body: string;
}): string {
  const canSeeFirm = a.session.boundClientId == null &&
    ['ca_partner', 'ca_staff', 'auditor'].includes(a.session.role ?? '');
  const canManageEmail = a.session.boundClientId == null &&
    ['ca_partner', 'ca_staff'].includes(a.session.role ?? '');
  const q = a.accountId ? `?account=${encodeURIComponent(a.accountId)}` : '';
  const groups: Array<{ label: string; keys: string[]; href: string; links: Array<[string, string, string]> }> = [
    { label: 'Today', keys: ['home','setup','activity','attention','follow-ups'], href: '/', links: [
      ['/', 'home', 'Overview'], ['/setup', 'setup', 'Setup'], ['/activity', 'activity', 'Activity'],
      ['/attention', 'attention', 'Attention'], ['/follow-ups', 'follow-ups', 'Review desk']] },
    { label: 'Ask Nexus', keys: ['nexus','assistant-runs'], href: '/nexus', links: [
      ['/nexus', 'nexus', 'Conversations'], ['/assistant-runs', 'assistant-runs', 'AI activity']] },
    { label: 'Inbox', keys: ['documents','email-inbox'], href: '/documents', links: [
      ['/documents', 'documents', 'Documents'], ['/email-inbox', 'email-inbox', 'Firm email']] },
    { label: 'Bills', keys: ['bills','payables','suppliers','returns'], href: '/bills', links: [
      ['/bills', 'bills', 'To review'], ['/payables', 'payables', 'Payables'],
      ['/suppliers', 'suppliers', 'Suppliers'], ['/returns', 'returns', 'Returns']] },
    { label: 'Sales', keys: ['sales','receivables','customers'], href: '/sales', links: [
      ['/sales', 'sales', 'Invoices'], ['/receivables', 'receivables', 'Receivables'],
      ['/customers', 'customers', 'Customers']] },
    { label: 'Bank', keys: ['reconcile','import','brs','cash','accounts'], href: `/reconcile${q}`, links: [
      [`/reconcile${q}`, 'reconcile', 'Reconcile'], ['/import', 'import', 'Statements'],
      [`/brs${q}`, 'brs', 'BRS'], ['/cash', 'cash', 'Cash'], ['/accounts', 'accounts', 'Accounts']] },
    { label: 'GST & TDS', keys: ['gstr2b','gstr1','gstr3b','tds'], href: '/gstr2b', links: [
      ['/gstr2b', 'gstr2b', 'GSTR-2B'], ['/gstr1', 'gstr1', 'GSTR-1'],
      ['/gstr3b', 'gstr3b', 'GSTR-3B'], ['/tds', 'tds', 'TDS']] },
    { label: 'Reports', keys: ['reports','profit-loss','balance-sheet','close-month','assets'], href: '/reports/profit-loss', links: [
      ['/reports/profit-loss', 'profit-loss', 'Profit & loss'], ['/reports/balance-sheet', 'balance-sheet', 'Balance sheet'],
      ['/reports/close-month', 'close-month', 'Close month'], ['/assets', 'assets', 'Fixed assets']] },
  ];
  const activeGroup = groups.find((group) => group.keys.includes(a.active));
  const currentGroup = activeGroup ?? groups[0]!;
  const primaryLink = (group: typeof groups[number]): string =>
    `<a href="${esc(group.href)}" class="${group === activeGroup ? 'on' : ''}"${group === activeGroup ? ' aria-current="page"' : ''}>${esc(group.label)}</a>`;
  const subLink = ([href, key, label]: [string, string, string]): string =>
    `<a href="${esc(href)}" class="${a.active === key ? 'on' : ''}"${a.active === key ? ' aria-current="page"' : ''}>${esc(label)}</a>`;
  const prompts: Record<string, string[]> = {
    bills: ['How does this page work?', 'What needs attention?'],
    payables: ['How much do we owe suppliers?', 'What needs attention?'],
    receivables: ['Draft payment reminders', 'How much do customers owe?'],
    reconcile: ['Prepare reconciliation review', 'How many bank transactions need reconciliation?'],
    gstr2b: ['How much GST credit is at risk?', 'How does this page work?'],
    gstr1: ['What is our GST position?', 'What needs attention?'],
    gstr3b: ['What is our GST position?', 'What needs attention?'],
    firm: ['What needs attention?', 'How much do we owe suppliers?'],
    home: ['What needs attention?', 'How much GST credit is at risk?'],
    documents: ['What documents have we received?', 'What needs attention?'],
  };
  const quick = prompts[a.active] ?? ['What needs attention?', 'How does this page work?'];
  const pageNames: Record<string, string> = {
    home: 'Today', nexus: 'Ask Nexus', documents: 'Inbox', 'email-inbox': 'Firm email inbox',
    'follow-ups': 'Review desk', 'assistant-runs': 'Nexus activity', gstr2b: 'GSTR-2B',
    gstr1: 'GSTR-1', gstr3b: 'GSTR-3B', reconcile: 'Reconcile', import: 'Statements',
    brs: 'BRS', cash: 'Cash', accounts: 'Accounts', 'profit-loss': 'Profit & loss',
    'balance-sheet': 'Balance sheet', 'close-month': 'Close month', assets: 'Fixed assets',
  };
  const pageName = pageNames[a.active] ?? a.active.replaceAll('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BharatERP — ${esc(a.session.clientName)}</title>
<style>${CSS}</style></head>
<body>
<a class="skip-link" href="#main-content">Skip to main content</a>
<div class="app-shell">
<div class="primary-header">
  <a class="brand" href="/"><span class="brand-mark">B</span>BharatERP</a>
  <nav class="primary-nav" aria-label="Main navigation">${groups.map(primaryLink).join('')}</nav>
  <div class="top-actions">
    <a class="upload-link" href="/documents#document-files">＋ Upload</a>
    <span class="client-chip" title="${esc(a.session.clientName)}">${esc(a.session.clientName)}</span>
    <form method="post" action="/logout" class="who" aria-label="Sign out">
      <span title="${esc(a.session.email ?? '')}">${esc(a.session.displayName ?? '')}</span>
      <a href="/password">Password</a>
      <button type="submit">Sign out</button>
    </form>
  </div>
</div>
<div class="workspace">
${a.active === 'home' ? '' : `<header class="pagebar${a.active === 'nexus' ? ' pagebar-nexus' : ''}">
  <div class="page-context"><span class="client">${esc(a.session.clientName)}</span></div>
  ${activeGroup ? `<nav class="secondary-nav" aria-label="${esc(currentGroup.label)} navigation">
    ${currentGroup.links.filter(([href]) => href !== '/email-inbox' || canManageEmail).map(subLink).join('')}
  </nav>` : ''}
  ${canSeeFirm ? `<nav class="firm-nav" aria-label="Firm workspace">
    <a href="/firm" class="${a.active === 'firm' ? 'on' : ''}"${a.active === 'firm' ? ' aria-current="page"' : ''}>Firm</a>
    ${canManageEmail && !activeGroup?.keys.includes('email-inbox') ? `<a href="/email-inbox" class="${a.active === 'email-inbox' ? 'on' : ''}"${a.active === 'email-inbox' ? ' aria-current="page"' : ''}>Email</a>` : ''}
    ${!activeGroup?.keys.includes('follow-ups') ? `<a href="/follow-ups" class="${a.active === 'follow-ups' ? 'on' : ''}"${a.active === 'follow-ups' ? ' aria-current="page"' : ''}>Review desk</a>` : ''}
    ${!activeGroup?.keys.includes('tally') ? `<a href="/tally" class="${a.active === 'tally' ? 'on' : ''}"${a.active === 'tally' ? ' aria-current="page"' : ''}>Tally</a>` : ''}
  </nav>` : ''}
  <button type="button" class="ask-toggle" id="ask-toggle" aria-controls="ask-drawer"
    aria-expanded="false">Ask Nexus</button>
</header>`}
<main id="main-content"${a.active === 'nexus' ? ' class="nexus-page"' : a.active === 'home' ? ' class="today-page"' : ''}>${a.body}</main>
</div>
</div>
<div class="ask-shade" id="ask-shade" hidden></div>
<aside class="ask-drawer" id="ask-drawer" aria-label="Ask Nexus" hidden>
  <div class="ask-head">
    <div><h2>Ask Nexus</h2>
      <div class="ask-context">${esc(a.session.clientName)} · ${esc(pageName)}</div></div>
    <button type="button" class="ask-close" id="ask-close" aria-label="Close Ask Nexus">×</button>
  </div>
  <div class="ask-quick">
    ${quick.map((prompt) => `<button type="button" data-ask="${esc(prompt)}">${esc(prompt)}</button>`).join('')}
  </div>
  <div class="ask-messages" id="ask-messages" aria-live="polite">
    <div class="ask-msg bharat">Ask about these books. I will show the records behind every figure.</div>
  </div>
  <div class="ask-compose">
    <form id="ask-form">
      <input id="ask-input" maxlength="500" autocomplete="off" placeholder="Ask about this client…"
        aria-label="Question for Ask Nexus">
      <button class="primary" id="ask-send" type="submit">Ask</button>
    </form>
    <div class="why">Read-only preview. It cannot post or change the books.</div>
  </div>
</aside>
<script>
(() => {
  const toggle = document.getElementById('ask-toggle');
  const drawer = document.getElementById('ask-drawer');
  const shade = document.getElementById('ask-shade');
  const close = document.getElementById('ask-close');
  const form = document.getElementById('ask-form');
  const todayAskForm = document.getElementById('today-ask-form');
  const todayAskInput = document.getElementById('today-ask-input');
  const input = document.getElementById('ask-input');
  const send = document.getElementById('ask-send');
  const messages = document.getElementById('ask-messages');
  const setOpen = (open) => {
    drawer.hidden = !open; shade.hidden = !open;
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    if (open) input.focus();
    else (toggle || todayAskForm?.querySelector('button'))?.focus();
  };
  const add = (role, text, evidence, action) => {
    const box = document.createElement('div'); box.className = 'ask-msg ' + role;
    const copy = document.createElement('div'); copy.textContent = text; box.appendChild(copy);
    if (evidence && evidence.length) {
      const proof = document.createElement('div'); proof.className = 'ask-proof';
      evidence.forEach((item) => { const span = document.createElement('span'); span.textContent = item; proof.appendChild(span); });
      box.appendChild(proof);
    }
    if (action && typeof action.href === 'string' && action.href.startsWith('/')) {
      const link = document.createElement('a'); link.className = 'ask-action';
      link.href = action.href; link.textContent = action.label; box.appendChild(link);
    }
    messages.appendChild(box); messages.scrollTop = messages.scrollHeight;
  };
  const ask = async (question) => {
    const q = String(question || '').trim(); if (!q) return;
    add('user', q); input.value = ''; send.disabled = true;
    try {
      const response = await fetch('/api/assistant', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, page: '${esc(a.active)}' }),
      });
      const r = await response.json();
      if (!r.ok) throw new Error(r.error || 'could not answer');
      add('bharat', r.answer, r.evidence, r.action);
    } catch (error) {
      add('bharat', String(error.message || error));
    } finally { send.disabled = false; input.focus(); }
  };
  if (toggle) toggle.onclick = () => setOpen(true);
  close.onclick = () => setOpen(false);
  shade.onclick = () => setOpen(false);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer.hidden) setOpen(false);
  });
  form.onsubmit = (event) => { event.preventDefault(); ask(input.value); };
  if (todayAskForm) todayAskForm.onsubmit = (event) => {
    event.preventDefault();
    setOpen(true);
    if (todayAskInput.value.trim()) ask(todayAskInput.value);
  };
  document.querySelectorAll('[data-ask]').forEach((button) => {
    button.onclick = () => { setOpen(true); ask(button.dataset.ask); };
  });
})();
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------

export function renderAssistantRuns(runs: Array<{
  question: string; page: string; routingMode: string; intent: string | null;
  provider: string | null; model: string | null; answer: string; evidence: string[];
  supported: boolean; durationMs: number; createdAt: string;
}>): string {
  const route = (r: typeof runs[number]) => r.routingMode === 'deepseek'
    ? `Nexus · ${esc(r.intent ?? 'unsupported')}`
    : r.routingMode === 'deepseek_fallback' ? 'Nexus unavailable · local fallback'
    : 'Local deterministic tool';
  return `<section class="card wide"><h1>Nexus activity</h1>
    <p class="muted">A read-only record of what was asked, what route was used, and the evidence shown to this client.</p>
    ${runs.length === 0 ? '<p>No Nexus questions have been recorded for this client yet.</p>' :
      `<table><thead><tr><th>When</th><th>Question and answer</th><th>Route</th><th>Evidence</th></tr></thead>
      <tbody>${runs.map((r) => `<tr>
        <td>${esc(new Date(r.createdAt).toLocaleString('en-IN'))}<br><small>${r.durationMs} ms</small></td>
        <td><strong>${esc(r.question)}</strong><br>${esc(r.answer)}${r.supported ? '' : '<br><small>Unsupported question</small>'}</td>
        <td>${route(r)}${r.model ? `<br><small>${esc(r.model)}</small>` : ''}</td>
        <td>${r.evidence.map(esc).join('<br>')}</td>
      </tr>`).join('')}</tbody></table>`}
  </section>`;
}

export function renderAccounts(
  accounts: Array<{ id: string; bank_name: string; last4: string; kind: string }>,
  today = new Date().toISOString().slice(0, 10),
  canManage = true,
): string {
  if (accounts.length === 0) {
    if (!canManage) return `${pageIntro('BANKING', 'Bank accounts', 'Bank accounts connected to this client ledger.')}<p class="empty">No bank accounts are configured for this client.</p>`;
    return renderBankAccountSetup(today, '/accounts');
  }
  return `${pageIntro('BANKING', 'Bank accounts', 'Account numbers are stored as last-four plus a hash only (BR-2).')}
  <div class="panel"><table>
    <tr><th>Bank</th><th>Account</th><th>Type</th><th></th></tr>
    ${accounts.map((a) => `<tr>
      <td>${esc(a.bank_name)}</td>
      <td class="num">••${esc(a.last4)}</td>
      <td><span class="tag">${esc(a.kind)}</span></td>
      <td class="row-actions">
        <a href="/reconcile?account=${esc(a.id)}"><button>Reconcile</button></a>
        <a href="/brs?account=${esc(a.id)}"><button>BRS</button></a>
      </td></tr>`).join('')}
  </table></div>
  ${canManage ? `<details style="margin-top:16px"><summary>Add another bank account</summary>
    ${bankAccountForm(today, '/accounts')}
  </details>` : ''}`;
}

function bankAccountForm(today: string, returnTo: string): string {
  return `<div class="panel banksetup">
    <div class="formgrid">
      <label>Bank name
        <input id="bank-name" placeholder="e.g. HDFC Bank" autocomplete="organization">
      </label>
      <label>Account number
        <input id="account-number" placeholder="Full account number" inputmode="numeric"
          autocomplete="off">
        <span class="muted small">We keep only the last four digits and a one-way fingerprint.</span>
      </label>
      <label>IFSC <span class="muted">optional</span>
        <input id="ifsc" placeholder="HDFC0001234" autocapitalize="characters">
      </label>
      <label>Account type
        <select id="bank-kind">
          <option value="current">Current</option><option value="savings">Savings</option>
          <option value="od">Overdraft</option><option value="cc">Credit card</option>
          <option value="fd">Fixed deposit</option>
        </select>
      </label>
    </div>
    <p class="why" style="margin:12px 0 0">You do not need to know the balance now. Your first statement will be checked against this account before it is imported.</p>
    <div class="billactions">
      <button class="primary" id="save-bank">Save bank account</button>
      <span id="bank-result" class="muted" aria-live="polite"></span>
    </div>
  </div>
  <script>
  document.getElementById('save-bank').onclick = async () => {
    const btn = document.getElementById('save-bank');
    const out = document.getElementById('bank-result');
    btn.disabled = true; out.textContent = 'Saving…';
    try {
      const response = await fetch('/api/bank-accounts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bankName: document.getElementById('bank-name').value,
          accountNumber: document.getElementById('account-number').value,
          ifsc: document.getElementById('ifsc').value,
          kind: document.getElementById('bank-kind').value,
        }),
      });
      const r = await response.json();
      if (!r.ok) throw new Error(r.error || 'could not save bank account');
      location.href = '${esc(returnTo)}' + ('${esc(returnTo)}' === '/reconcile'
        ? '?account=' + encodeURIComponent(r.id) : '');
    } catch (e) {
      out.innerHTML = '<span class="bad">' + String(e.message || e).replace(/</g, '&lt;') + '</span>';
      btn.disabled = false;
    }
  };
  </script>`;
}

export function renderBankAccountSetup(today: string, returnTo = '/reconcile'): string {
  return `${pageIntro('BANKING', 'Add your bank account', 'This connects the ledger to statement imports. It cannot move money.')}
    ${bankAccountForm(today, returnTo)}`;
}

// ---------------------------------------------------------------------------

export function renderCustomers(customers: SalesDesk['customers']): string {
  return `<section class="page-intro"><div><p class="eyebrow">SALES</p><h1>Customers</h1>
    <p class="sub">Customer records and statements for this client.</p></div>
    <a class="primary-link" href="/sales#customer-form">＋ Add customer</a></section>
    <div class="panel strip"><div class="stat"><b>${customers.length}</b><span>customers</span></div>
      <div class="stat"><b>${customers.filter((customer) => customer.gstCategory !== 'unregistered').length}</b><span>GST registered</span></div>
      <div class="stat"><a href="/sales">Prepare an invoice →</a><span>Sales workflow</span></div></div>
    ${customers.length ? `<section class="panel" style="padding:0"><table><thead><tr>
      <th>Customer</th><th>GST status</th><th>GSTIN</th><th>State</th><th>Phone</th><th></th>
      </tr></thead><tbody>${customers.map((customer) => `<tr>
        <td><b>${esc(customer.name)}</b>${customer.legalName && customer.legalName !== customer.name
          ? `<br><small>${esc(customer.legalName)}</small>` : ''}</td>
        <td>${customer.gstCategory === 'unregistered' ? 'Unregistered' : 'Registered'}</td>
        <td class="mono">${esc(customer.gstin ?? '—')}</td>
        <td>${esc(customer.stateCode ?? '—')}</td><td>${esc(customer.phone ?? '—')}</td>
        <td><a href="/receivables?party=${encodeURIComponent(customer.id)}">View statement</a></td>
      </tr>`).join('')}</tbody></table></section>`
      : `<section class="panel"><p class="empty">No customers have been added yet.</p>
        <p><a href="/sales#customer-form">Add the first customer</a> to prepare a sales invoice.</p></section>`}`;
}

// ---------------------------------------------------------------------------

export function renderSales(a: {
  desk: SalesDesk;
  today: string;
  created?: string;
  draft?: { customerId: string; amount?: string; gstRate?: string };
}): string {
  const { desk } = a;
  const customerOptions = desk.customers.map((c) =>
    `<option value="${esc(c.id)}" data-state="${esc(c.stateCode ?? '')}" data-phone="${esc(c.phone ?? '')}">` +
    `${esc(c.name)}${c.gstin ? ` · ${esc(c.gstin)}` : ' · unregistered'}</option>`).join('');
  const registrationOptions = desk.registrations.map((r) =>
    `<option value="${esc(r.id)}" data-state="${esc(r.stateCode)}">` +
    `${esc(r.gstin)}${r.primary ? ' (primary)' : ''}</option>`).join('');
  const accountOptions = desk.incomeAccounts.map((x) =>
    `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');

  const invoiceRows = desk.invoices.map((x) => {
    const open = Number(x.outstanding) > 0;
    return `<tr>
      <td><a href="/sales/${esc(x.voucherId)}" class="mono">${esc(x.invoiceNumber)}</a></td>
      <td>${esc(x.postingDate)}</td><td>${esc(x.customerName)}</td>
      <td class="num">${inr(x.grandTotal)}</td>
      <td class="num ${open ? 'warn' : 'good'}">${open ? inr(x.outstanding) : 'Paid'}</td>
    </tr>`;
  }).join('');

  const ready = desk.customers.length > 0 && desk.registrations.length > 0 &&
    desk.incomeAccounts.length > 0;

  return `<section class="page-intro"><div><p class="eyebrow">SALES</p><h1>Sales invoices</h1>
    <p class="sub">Prepare a GST invoice, check the preview, then post it to the ledger.</p></div>
    <a class="primary-link" href="/customers">View customers →</a></section>
<div class="panel strip sales-overview"><div class="stat"><b>${desk.invoices.length}</b><span>invoices in this view</span></div>
  <div class="stat"><b>${desk.customers.length}</b><span>customers</span></div>
  <div class="stat"><b>${desk.registrations.length}</b><span>GST registrations</span></div>
  <div class="stat"><span>Next: enter customer and invoice lines. Review totals and tax before posting.</span></div></div>
${a.created ? `<div class="msg good"><b>Invoice ${esc(a.created)} posted.</b> It is now in receivables and GSTR-1.</div>` : ''}
${a.draft ? '<div class="msg warn"><b>AI-prepared draft.</b> It has not posted anything. Confirm the description, HSN/SAC, amount, GST and dates before posting.</div>' : ''}

<details class="panel" id="customer-form" ${desk.customers.length === 0 ? 'open' : ''}>
  <summary><b>Add customer</b></summary>
  <form id="customer-form" class="customer-form" style="margin-top:12px">
    <label>Customer name<input name="name" required autocomplete="organization"></label>
    <label>Legal name<input name="legalName" autocomplete="organization"></label>
    <label>GST status<select name="gstCategory" id="customer-category">
      <option value="registered_regular">Registered</option>
      <option value="unregistered">Unregistered</option>
    </select></label>
    <label>State code<input name="stateCode" required inputmode="numeric" maxlength="2" placeholder="27"></label>
    <label id="gstin-label">GSTIN<input name="gstin" maxlength="15" class="mono" required></label>
    <label>WhatsApp number<input name="phone" inputmode="tel" autocomplete="tel" placeholder="9876543210"></label>
    <label>Billing address<input name="billingAddress" required autocomplete="street-address"></label>
    <div><button class="primary" type="submit">Save customer</button></div>
  </form>
  <div id="customer-msg"></div>
</details>

<div class="sales-grid">
  <section class="panel">
    <h2 style="margin-top:0">New invoice</h2>
    ${desk.registrations.length === 0 ? '<div class="msg bad">Add an active GST registration before raising an invoice.</div>' : ''}
    ${desk.incomeAccounts.length === 0 ? '<div class="msg bad">Add a sales or income ledger before raising an invoice.</div>' : ''}
    ${desk.customers.length === 0 ? '<div class="msg">Add the first customer above.</div>' : ''}
    <div class="invoice-meta">
      <label>Customer<select id="invoice-customer"><option value="">Choose customer</option>${customerOptions}</select></label>
      <label>Invoice date<input id="invoice-date" type="date" value="${esc(a.today)}"></label>
      <label>Due date<input id="due-date" type="date"></label>
      <label>Issued from<select id="invoice-registration">${registrationOptions}</select></label>
      <label>Place of supply<input id="invoice-pos" maxlength="2" inputmode="numeric" placeholder="State code"></label>
      <label style="grid-column:span 3">Narration<input id="invoice-narration" placeholder="Optional note for the ledger"></label>
    </div>
    <div class="quick-due"><span>Set due date:</span>
      <button type="button" data-due="7">7 days</button>
      <button type="button" data-due="15">15 days</button>
      <button type="button" data-due="30">30 days</button>
    </div>

    <div class="entry-scroll"><table class="entry-table">
      <thead><tr><th>Description</th><th>HSN/SAC</th><th class="num">Qty</th>
        <th class="num">Rate ₹</th><th class="num">GST %</th><th>Income ledger</th><th></th></tr></thead>
      <tbody id="invoice-lines"></tbody>
    </table></div>
    <template id="invoice-line-template"><tr>
      <td><input class="desc" aria-label="Description" required></td>
      <td><input class="hsn mono" aria-label="HSN or SAC" required></td>
      <td><input class="qty num" aria-label="Quantity" inputmode="decimal" value="1" required></td>
      <td><input class="price num" aria-label="Unit price" inputmode="decimal" placeholder="0.00" required></td>
      <td><input class="gst num" aria-label="GST rate" inputmode="decimal" value="18" required></td>
      <td><select class="account" aria-label="Income ledger">${accountOptions}</select></td>
      <td><button class="remove" type="button" aria-label="Remove line">×</button></td>
    </tr></template>
    <div class="sales-actions">
      <div><button type="button" id="add-line">Add line</button>
        <span class="invoice-shortcuts">Press Enter after GST to add another line</span></div>
      <button class="primary" type="button" id="post-invoice" ${ready ? '' : 'disabled'}>Post invoice</button>
    </div>
    <div id="invoice-msg"></div>
  </section>

  <aside class="panel ledger-proof">
    <h2>Posting preview</h2>
    <p class="note">The final figures are calculated again by the accounting engine.</p>
    <div class="proof-line"><span>Taxable value</span><b id="sum-taxable">₹0.00</b></div>
    <div class="proof-line"><span id="label-cgst">CGST</span><b id="sum-cgst">₹0.00</b></div>
    <div class="proof-line"><span id="label-sgst">SGST</span><b id="sum-sgst">₹0.00</b></div>
    <div class="proof-line"><span>IGST</span><b id="sum-igst">₹0.00</b></div>
    <div class="proof-line"><span>Round off</span><b id="sum-round">₹0.00</b></div>
    <div class="proof-line proof-total"><span>Customer owes</span><b id="sum-total">₹0.00</b></div>
  </aside>
</div>

<h2>Recent invoices</h2>
${desk.invoices.length === 0 ? '<p class="empty">No sales invoices yet.</p>' : `<div class="panel" style="padding:0"><table>
  <tr><th>Invoice</th><th>Date</th><th>Customer</th><th class="num">Total</th><th class="num">Outstanding</th></tr>
  ${invoiceRows}</table></div>`}

<script>
const $ = (id) => document.getElementById(id);
const lines = $('invoice-lines');
const template = $('invoice-line-template');
if (location.hash === '#customer-form') $('customer-form').open = true;
const fmt = (n) => '₹' + (Number.isFinite(n) ? n : 0).toFixed(2);

function addLine() {
  lines.append(template.content.cloneNode(true));
  const row = lines.lastElementChild;
  row.querySelector('.remove').onclick = (e) => {
    const row = e.currentTarget.closest('tr');
    if (lines.children.length > 1) row.remove();
    calculate();
  };
  row.querySelectorAll('input,select').forEach((x) =>
    x.addEventListener('input', calculate));
  row.querySelector('.gst').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); addLine();
      lines.lastElementChild.querySelector('.desc').focus();
    }
  });
}

function calculate() {
  let taxable = 0, tax = 0;
  lines.querySelectorAll('tr').forEach((r) => {
    const value = (Number(r.querySelector('.qty').value) || 0) *
      (Number(r.querySelector('.price').value) || 0);
    taxable += value;
    tax += value * (Number(r.querySelector('.gst').value) || 0) / 100;
  });
  const reg = $('invoice-registration').selectedOptions[0];
  const intra = reg && reg.dataset.state === $('invoice-pos').value;
  const cgst = intra ? tax / 2 : 0, sgst = intra ? tax / 2 : 0, igst = intra ? 0 : tax;
  const before = taxable + tax;
  const rounded = Math.round(before);
  $('sum-taxable').textContent = fmt(taxable);
  $('sum-cgst').textContent = fmt(cgst); $('sum-sgst').textContent = fmt(sgst);
  $('sum-igst').textContent = fmt(igst); $('sum-round').textContent = fmt(rounded - before);
  $('sum-total').textContent = fmt(rounded);
}

$('add-line').onclick = addLine;
$('invoice-customer').onchange = (e) => {
  const o = e.target.selectedOptions[0];
  if (o && o.dataset.state) $('invoice-pos').value = o.dataset.state;
  calculate();
};
$('invoice-registration').onchange = calculate;
$('invoice-pos').oninput = calculate;
$('invoice-date').onchange = () => {
  if (!$('due-date').value) setDue(30);
};
function setDue(days) {
  const start = new Date($('invoice-date').value + 'T00:00:00');
  if (Number.isNaN(start.getTime())) return;
  start.setDate(start.getDate() + days);
  $('due-date').value = start.toISOString().slice(0, 10);
}
document.querySelectorAll('[data-due]').forEach((b) =>
  b.onclick = () => setDue(Number(b.dataset.due)));
addLine(); calculate();
const aiDraft = ${JSON.stringify(a.draft ?? null)};
if (aiDraft) {
  $('invoice-customer').value = aiDraft.customerId;
  $('invoice-customer').dispatchEvent(new Event('change'));
  const first = lines.querySelector('tr');
  if (aiDraft.amount) first.querySelector('.price').value = aiDraft.amount;
  if (aiDraft.gstRate) first.querySelector('.gst').value = aiDraft.gstRate;
  calculate();
  first.querySelector('.desc').focus();
}

$('customer-category').onchange = (e) => {
  const input = document.querySelector('[name=gstin]');
  const registered = e.target.value === 'registered_regular';
  input.required = registered; input.disabled = !registered;
  if (!registered) input.value = '';
};

$('customer-form').onsubmit = async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(new FormData(e.target));
  const out = $('customer-msg');
  try {
    const r = await fetch('/api/customers', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(values) });
    const result = await r.json();
    if (!result.ok) throw new Error(result.error);
    const option = document.createElement('option');
    option.value = result.id; option.textContent = values.name;
    option.dataset.state = values.stateCode; option.dataset.phone = values.phone || '';
    $('invoice-customer').append(option); $('invoice-customer').value = result.id;
    $('invoice-pos').value = values.stateCode; calculate();
    $('post-invoice').disabled = !$('invoice-registration').value ||
      !lines.querySelector('.account').value;
    e.target.reset(); $('customer-category').dispatchEvent(new Event('change'));
    e.target.closest('details').open = false;
    out.innerHTML = '<div class="msg good">Customer saved and selected.</div>';
    lines.querySelector('.desc').focus();
  } catch (error) { out.innerHTML = '<div class="msg bad">' + escJs(error.message) + '</div>'; }
};

$('post-invoice').onclick = async () => {
  const button = $('post-invoice'), out = $('invoice-msg');
  const invoiceLines = [...lines.querySelectorAll('tr')].map((r) => ({
    description: r.querySelector('.desc').value.trim(),
    hsnSac: r.querySelector('.hsn').value.trim(), quantity: r.querySelector('.qty').value,
    unitPrice: r.querySelector('.price').value, gstRate: r.querySelector('.gst').value,
    incomeAccountId: r.querySelector('.account').value,
  }));
  const body = {
    partyId: $('invoice-customer').value, registrationId: $('invoice-registration').value,
    postingDate: $('invoice-date').value, dueDate: $('due-date').value || undefined,
    placeOfSupply: $('invoice-pos').value, narration: $('invoice-narration').value.trim() || undefined,
    lines: invoiceLines,
  };
  if (!body.partyId || !body.postingDate || !body.placeOfSupply ||
      invoiceLines.some((l) => !l.description || !l.hsnSac || !l.quantity || !l.unitPrice || !l.incomeAccountId)) {
    out.innerHTML = '<div class="msg bad">Choose a customer and complete every invoice line.</div>';
    return;
  }
  button.disabled = true; out.innerHTML = '<div class="msg">Posting invoice…</div>';
  try {
    const r = await fetch('/api/invoices', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
    const result = await r.json();
    if (!result.ok) throw new Error(result.error);
    location.href = '/sales?created=' + encodeURIComponent(result.invoiceNumber);
  } catch (error) {
    out.innerHTML = '<div class="msg bad"><b>Invoice not posted.</b><br>' + escJs(error.message) + '</div>';
    button.disabled = false;
  }
};
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !$('post-invoice').disabled) {
    e.preventDefault(); $('post-invoice').click();
  }
});
function escJs(s) { const d = document.createElement('div'); d.textContent = String(s || 'Unknown error'); return d.innerHTML; }
</script>`;
}

export function renderSalesInvoice(a: SalesInvoiceDetail): string {
  const taxRows = [
    ['CGST', a.totalCgst], ['SGST', a.totalSgst], ['IGST', a.totalIgst],
    ['Cess', a.totalCess], ['Round off', a.roundOff],
  ].filter(([, value]) => Number(value) !== 0).map(([label, value]) =>
    `<div class="proof-line"><span>${label}</span><b>₹${inr(value!)}</b></div>`).join('');

  const phone = (a.customerPhone ?? '').replace(/\D/g, '').replace(/^0+/, '');
  const invoiceMessage = `Invoice ${a.invoiceNumber} from ${a.supplierName} for ₹${inr(a.grandTotal)}.`;
  const reminderMessage = `Payment reminder: invoice ${a.invoiceNumber} for ₹${inr(a.grandTotal)}` +
    `${a.dueDate ? ` was due on ${a.dueDate}` : ' is outstanding'}.`;
  const whatsapp = (message: string) => `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;

  return `<div class="no-print sales-head">
    <div><a href="/sales">← Sales invoices</a></div>
    <div class="invoice-share">
      <a class="btnlink" href="${esc(whatsapp(invoiceMessage))}" target="_blank" rel="noopener">Share on WhatsApp</a>
      <a class="btnlink" href="${esc(whatsapp(reminderMessage))}" target="_blank" rel="noopener">Send payment reminder</a>
      <button onclick="window.print()">Print / save PDF</button>
    </div>
  </div>
  <article class="panel invoice-paper">
    <div class="invoice-title">
      <div><h1>${esc(a.supplierName)}</h1><div class="muted">Tax invoice</div>
        <div class="mono">${esc(a.invoiceNumber)}</div></div>
      <div style="text-align:right"><b>${esc(a.customerName)}</b>
        <div class="muted">${a.customerGstin ? `GSTIN ${esc(a.customerGstin)}` : 'Unregistered customer'}</div>
        ${a.billingAddress ? `<div class="muted">${esc(a.billingAddress)}</div>` : ''}</div>
    </div>
    <div class="invoice-meta" style="margin-top:16px">
      <div><span class="muted">Invoice date</span><br><b>${esc(a.postingDate)}</b></div>
      <div><span class="muted">Due date</span><br><b>${esc(a.dueDate ?? '—')}</b></div>
      <div><span class="muted">Supplier GSTIN</span><br><b class="mono">${esc(a.supplierGstin)}</b></div>
      <div><span class="muted">Place of supply</span><br><b>${esc(a.placeOfSupply)}</b></div>
    </div>
    <table><tr><th>Description</th><th>HSN/SAC</th><th class="num">Qty</th>
      <th class="num">Rate</th><th class="num">GST</th><th class="num">Taxable</th></tr>
      ${a.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="mono">${esc(l.hsnSac)}</td>
        <td class="num">${esc(l.quantity)} ${esc(l.uom)}</td><td class="num">₹${inr(l.unitPrice)}</td>
        <td class="num">${esc(l.gstRate)}%</td><td class="num">₹${inr(l.taxableValue)}</td></tr>`).join('')}
    </table>
    <div style="max-width:310px;margin:20px 0 0 auto">
      <div class="proof-line"><span>Taxable value</span><b>₹${inr(a.taxableValue)}</b></div>
      ${taxRows}
      <div class="proof-line proof-total"><span>Total</span><b class="invoice-total">₹${inr(a.grandTotal)}</b></div>
    </div>
  </article>`;
}

// ---------------------------------------------------------------------------

export function renderTallyImport(): string {
  return `${pageIntro('FIRM TOOLS', 'Import from Tally', 'Start with a safe preview. Nothing is added to the books until the ledgers are mapped and you confirm the import.')}

  <div class="msg"><b>Current scope:</b> ledger history only. Customer and supplier
  bill-wise balances, invoice detail, and inventory are not migrated yet.</div>

  <div class="panel">
    <h2 style="margin-top:0">Export from TallyPrime</h2>
    <ol>
      <li>Open <b>Alt+E → Masters</b>, choose XML, and export all accounting masters.</li>
      <li>Open <b>Alt+E → Transactions</b>, choose all vouchers and XML.</li>
      <li>Preview each XML file here. Raw Tally backup files are not supported.</li>
    </ol>
    <label><b>Choose Tally XML</b><br>
      <input id="tally-file" type="file" accept=".xml,text/xml,application/xml" style="margin-top:8px">
    </label>
    <button class="primary" id="tally-preview" type="button" style="margin-left:8px">Preview file</button>
  </div>
  <div id="tally-result"></div>

  <script>
  const file = document.getElementById('tally-file');
  const result = document.getElementById('tally-result');
  const button = document.getElementById('tally-preview');
  const escT = (s) => { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; };
  const statT = (value, label) => '<div class="stat"><b>' + escT(value) + '</b><span>' + escT(label) + '</span></div>';

  button.onclick = async () => {
    if (!file.files[0]) { result.innerHTML = '<div class="msg bad">Choose an XML file first.</div>'; return; }
    button.disabled = true;
    result.innerHTML = '<div class="msg">Reading Tally export…</div>';
    try {
      const xml = await file.files[0].text();
      const response = await fetch('/api/tally/preview', {
        method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ xml })
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error);
      const warnings = data.warnings.length
        ? '<div class="msg bad"><b>Needs attention</b><ul>' + data.warnings.map((x) => '<li>' + escT(x) + '</li>').join('') + '</ul></div>' : '';
      const vouchers = data.vouchers.length ? '<h2>Voucher sample</h2><div class="panel" style="padding:0"><table>' +
        '<tr><th>Date</th><th>Number</th><th>Type</th><th class="num">Lines</th><th class="num">Difference</th></tr>' +
        data.vouchers.map((v) => '<tr><td>' + escT(v.date || 'Invalid') + '</td><td class="mono">' + escT(v.number || '—') +
          '</td><td>' + escT(v.sourceType) + '</td><td class="num">' + escT(v.entries) + '</td><td class="num ' +
          (v.balanced ? 'good' : 'bad') + '">' + escT(v.difference) + '</td></tr>').join('') + '</table></div>' : '';
      const ledgers = data.ledgers.length ? '<h2>Ledger sample</h2><div class="panel" style="padding:0"><table>' +
        '<tr><th>Ledger</th><th>Kind</th><th>Parent group</th><th>GSTIN</th><th class="num">Opening balance</th></tr>' +
        data.ledgers.map((l) => '<tr><td>' + escT(l.name) + '</td><td>' + (l.partyType ? '<span class="tag">' + escT(l.partyType) + '</span>' : 'account') +
          '</td><td>' + escT(l.parent || '—') + '</td><td class="mono">' +
          escT(l.gstin || '—') + '</td><td class="num">' + escT(l.openingBalance || '—') + '</td></tr>').join('') + '</table></div>' : '';
      const mappings = data.mappings.length ? '<h2>Map Tally ledgers</h2><div class="panel" style="padding:0"><table>' +
        '<tr><th>Tally ledger</th><th class="num">Used in</th><th>BharatERP account</th></tr>' +
        data.mappings.map((m) => '<tr><td>' + escT(m.sourceName) + (m.partyType ? ' <span class="tag">creates ' + escT(m.partyType) + '</span>' : '') +
          '</td><td class="num">' + escT(m.usedIn) +
          '</td><td><select class="tally-map" data-source="' + escT(m.sourceName) + '"><option value="">Choose account</option>' +
          data.accounts.map((a) => '<option value="' + escT(a.id) + '" ' + (a.id === m.suggestedAccountId ? 'selected' : '') +
            '>' + escT(a.name) + ' (' + escT(a.rootType) + ')</option>').join('') + '</select></td></tr>').join('') +
        '</table></div>' : '';
      const confirm = data.stats.voucherCount ? '<div class="panel"><button id="confirm-tally" class="primary" ' +
        (data.canImport ? '' : 'disabled') + '>Confirm and import ' + escT(data.stats.voucherCount) + ' vouchers</button>' +
        '<p class="note">Imports ledger history only. Vouchers are marked as Tally history and safe to resume without duplicates.</p></div>' : '';
      result.innerHTML = '<div class="panel strip">' + statT(data.company || 'Unknown', 'company') +
        statT(data.stats.ledgerCount, 'ledgers') + statT(data.stats.voucherCount, 'vouchers') +
        statT(data.stats.balancedCount, 'balanced') + statT(data.stats.unbalancedCount, 'need review') + '</div>' +
        warnings + ledgers + vouchers + mappings + confirm;

      const confirmButton = document.getElementById('confirm-tally');
      if (confirmButton) confirmButton.onclick = async () => {
        const selected = [...document.querySelectorAll('.tally-map')];
        if (selected.some((x) => !x.value)) {
          result.insertAdjacentHTML('afterbegin', '<div class="msg bad">Map every Tally ledger before importing.</div>');
          return;
        }
        confirmButton.disabled = true;
        confirmButton.textContent = 'Importing…';
        try {
          const response = await fetch('/api/tally/import', {
            method: 'POST', headers: {'content-type':'application/json'},
            body: JSON.stringify({ token: data.token, mappings: selected.map((x) => ({ sourceName: x.dataset.source, accountId: x.value })) })
          });
          const imported = await response.json();
          if (!imported.ok) throw new Error(imported.error);
          result.innerHTML = '<div class="msg good"><b>Import complete.</b><br>' + escT(imported.imported) +
            ' voucher(s) posted' + (imported.skippedDuplicates ? '; ' + escT(imported.skippedDuplicates) + ' already imported and skipped' : '') +
            '.</div><p><a href="/"><button class="primary">Open dashboard</button></a></p>';
        } catch (error) {
          confirmButton.disabled = false; confirmButton.textContent = 'Confirm import';
          result.insertAdjacentHTML('afterbegin', '<div class="msg bad"><b>Import stopped.</b><br>' + escT(error.message) + '</div>');
        }
      };
    } catch (error) {
      result.innerHTML = '<div class="msg bad"><b>Cannot preview this file.</b><br>' + escT(error.message) + '</div>';
    } finally { button.disabled = false; }
  };
  </script>`;
}

// ---------------------------------------------------------------------------

export function renderImport(a: {
  sourceDocument?: { id: string; name: string };
  accounts: Array<{
    id: string; bank_name: string; last4: string;
    coverage: {
      coveredFrom: string | null; coveredTo: string | null;
      gaps: Array<{ from: string; to: string }>;
      nextExpectedFrom: string | null;
    };
    saved?: boolean;
    autoOpenEmail?: boolean;
    hasSavedPassword?: boolean;
  }>;
  banks: string[];
}): string {
  if (a.accounts.length === 0) {
    return `${pageIntro('BANKING', 'Bank sync', 'A statement must be linked to a bank account before it can be imported or reconciled.')}
<div class="msg"><b>Add the bank account first.</b><br>
This only records the account in BharatERP. It cannot access or move money in your bank.</div>
<p><a href="/accounts"><button class="primary">Add bank account →</button></a></p>`;
  }
  const coverageByAccount = JSON.stringify(Object.fromEntries(
    a.accounts.map((x) => [x.id, x.coverage]))).replace(/</g, '\\u003c');
  const savedPasswordByAccount = JSON.stringify(Object.fromEntries(
    a.accounts.map((x) => [x.id, x.saved ?? x.hasSavedPassword ?? false]))).replace(/</g, '\\u003c');
  const autoOpenByAccount = JSON.stringify(Object.fromEntries(
    a.accounts.map((x) => [x.id, x.autoOpenEmail ?? false]))).replace(/</g, '\\u003c');
  return `<section class="page-intro"><div><p class="eyebrow">BANKING</p><h1>Bank sync</h1>
<p class="sub">Upload CSV, Excel or PDF bank statements. Overlapping dates are safe:
transactions already present are skipped. Every file must pass its own balance
and running-balance checks before anything is saved. Upload supplier and grocery
invoices from <a href="/bills">Bills</a>.</p></div></section>
${a.sourceDocument ? `<div class="msg">Using received document <b>${esc(a.sourceDocument.name)}</b>. Choose the bank account, then preview it below. <a href="/documents">Choose another file</a>.</div>` : ''}

<div class="panel">
  <div class="strip" style="margin-bottom:12px">
    <label>Account
      <select id="account">
        ${a.accounts.map((x) => `<option value="${esc(x.id)}">${esc(x.bank_name)} ••${esc(x.last4)}</option>`).join('')}
      </select>
    </label>
    <label>Bank layout
      <select id="bank">
        <option value="">Detect automatically</option>
        ${a.banks.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}
      </select>
    </label>
    <label>File <input type="file" id="file" accept=".csv,.tsv,.txt,.xls,.xlsx,.pdf"${a.sourceDocument ? ' disabled' : ''}></label>
  </div>
  <div class="strip" style="margin-bottom:12px">
    <label>Statement password
      <input type="password" id="statement-password" autocomplete="off"
             placeholder="Only for protected PDF/Excel">
    </label>
    <label style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="remember-password">
      Remember securely for this account
    </label>
    <label style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" id="auto-open-email">
      Automatically open future emailed statements for this account
    </label>
    <button type="button" id="forget-password">Forget saved password</button>
    <span class="why" id="password-status"></span>
  </div>
  <textarea id="text" placeholder="…or paste the statement here"${a.sourceDocument ? ' disabled' : ''}></textarea>
  <div class="strip" style="margin-top:10px">
    <button class="primary" id="preview">Preview <kbd>⏎</kbd></button>
    <button id="commit" disabled>Import</button>
    <span class="why" id="hint"></span>
  </div>
</div>
<div id="coverage"></div>
<div id="out"></div>

<script>
const $ = (id) => document.getElementById(id);
let uploadedFile = null;
const coverageByAccount = ${coverageByAccount};
const savedPasswordByAccount = ${savedPasswordByAccount};
const autoOpenByAccount = ${autoOpenByAccount};
const sourceDocumentId = ${JSON.stringify(a.sourceDocument?.id ?? null)};

function showPasswordStatus() {
  const saved = savedPasswordByAccount[$('account').value];
  $('statement-password').placeholder = saved
    ? 'Leave blank to use saved password'
    : 'Only for protected PDF/Excel';
  $('password-status').textContent = saved
    ? (autoOpenByAccount[$('account').value]
      ? 'Password saved for this account. Leave the field blank and click Preview to use it. Future emailed PDFs can open for review; nothing imports automatically.'
      : 'Password saved for this account. Leave the field blank and click Preview to use it.')
    : 'Nothing saved for this account.';
  $('forget-password').hidden = !saved;
  $('auto-open-email').disabled = !saved && !$('remember-password').checked;
}

function showCoverage(value) {
  const c = value || coverageByAccount[$('account').value];
  if (!c || !c.coveredFrom) {
    $('coverage').innerHTML = '<div class="msg">No statement imported yet. The first upload starts this account’s sync history.</div>';
    return;
  }
  const gaps = c.gaps || [];
  $('coverage').innerHTML = '<div class="panel"><div class="strip">'
    + stat(c.coveredFrom + ' → ' + c.coveredTo, 'statement dates covered')
    + stat(c.nextExpectedFrom, 'next upload can start')
    + stat(gaps.length ? gaps.length : 'none', 'missing periods')
    + '</div>'
    + (gaps.length ? '<div class="msg bad"><b>Missing statement dates</b><ul>'
      + gaps.map((g) => '<li>' + esc(g.from) + ' → ' + esc(g.to) + '</li>').join('')
      + '</ul></div>' : '<div class="msg good">Coverage is continuous. No date gap found.</div>')
    + '</div>';
}
$('account').addEventListener('change', () => {
  $('statement-password').value = '';
  $('remember-password').checked = false;
  $('auto-open-email').checked = Boolean(autoOpenByAccount[$('account').value]);
  showCoverage();
  showPasswordStatus();
});
showCoverage();
$('auto-open-email').checked = Boolean(autoOpenByAccount[$('account').value]);
showPasswordStatus();
$('remember-password').addEventListener('change', () => {
  if (!$('remember-password').checked && !savedPasswordByAccount[$('account').value]) {
    $('auto-open-email').checked = false;
  }
  showPasswordStatus();
});
$('forget-password').onclick = async () => {
  const accountId = $('account').value;
  const result = await post('/api/statement-password/forget', { bankAccountId: accountId });
  if (!result.ok) { $('password-status').textContent = result.error; return; }
  savedPasswordByAccount[accountId] = false;
  autoOpenByAccount[accountId] = false;
  $('auto-open-email').checked = false;
  $('remember-password').checked = false;
  $('statement-password').value = '';
  showPasswordStatus();
};

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) {
    uploadedFile = f;
    $('text').value = f.type.startsWith('text/') || /\.(csv|tsv|txt)$/i.test(f.name)
      ? await f.text() : '';
    $('hint').textContent = f.name;
  }
});

const fileBase64 = (f) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(f);
});

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const money = (v) => v === null || v === undefined ? '—' : v;

function transactionRow(x) {
  return '<tr><td class="num">' + esc(x.txnDate) + '</td>'
    + '<td class="narr">' + esc(x.narration) + '</td>'
    + '<td class="num">' + (x.debit === '0.00' ? '' : esc(x.debit)) + '</td>'
    + '<td class="num">' + (x.credit === '0.00' ? '' : esc(x.credit)) + '</td>'
    + '<td class="num">' + esc(x.runningBalance ?? '') + '</td></tr>';
}

$('preview').onclick = async () => {
  const r = await post('/api/preview', {
    bankAccountId: $('account').value,
    documentId: sourceDocumentId || undefined,
    fileText: $('text').value,
    fileBase64: uploadedFile ? await fileBase64(uploadedFile) : undefined,
    bank: $('bank').value,
    password: $('statement-password').value || undefined,
    rememberPassword: $('remember-password').checked,
    autoOpenEmail: $('auto-open-email').checked,
  });
  if (!r.ok) {
    $('out').innerHTML = '<div class="msg bad"><b>Cannot read this file.</b><br>' + esc(r.error) + '</div>';
    $('commit').disabled = true;
    return;
  }
  $('commit').disabled = false;
  if (r.passwordRemembered) {
    savedPasswordByAccount[$('account').value] = true;
    $('statement-password').value = '';
    showPasswordStatus();
  }
  autoOpenByAccount[$('account').value] = r.autoOpenEmail === true;
  $('auto-open-email').checked = r.autoOpenEmail === true;
  showPasswordStatus();
  $('out').innerHTML =
    '<div class="panel"><div class="strip">'
    + stat(r.bank, 'layout used') + stat(r.rowCount, 'rows read')
    + stat(money(r.openingBalance), 'opening') + stat(money(r.closingBalance), 'closing')
    + stat(r.periodFrom + ' → ' + r.periodTo, 'period')
    + stat('••' + r.accountCheck.last4, 'account checked by ' + r.accountCheck.matchedBy)
    + '</div></div>'
    + (r.warnings.length ? '<div class="msg"><b>Notes</b><ul>'
        + r.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></div>' : '')
    + (r.skippedRows.length ? '<div class="msg"><b>' + r.skippedRows.length
        + ' row(s) not read as transactions</b><ul>'
        + r.skippedRows.slice(0, 8).map((s) => '<li>line ' + s.index + ' — ' + esc(s.reason)
            + '<br><span class="narr">' + esc(s.text) + '</span></li>').join('')
        + '</ul></div>' : '')
    + '<div class="strip"><h2 id="preview-row-heading">Transactions — showing '
    + Math.min(12, r.rows.length) + ' of ' + r.rowCount + '</h2>'
    + (r.rows.length > 12 ? '<button id="show-all-rows">Show all ' + r.rows.length + '</button>' : '')
    + '</div><div class="panel"><table>'
    + '<tr><th>Date</th><th>Narration</th><th class="num">Debit</th>'
    + '<th class="num">Credit</th><th class="num">Balance</th></tr>'
    + '<tbody id="preview-rows">' + r.rows.slice(0, 12).map(transactionRow).join('') + '</tbody>'
    + '</table></div>';
  const showAll = $('show-all-rows');
  if (showAll) showAll.onclick = () => {
    $('preview-rows').innerHTML = r.rows.map(transactionRow).join('');
    $('preview-row-heading').textContent = 'Transactions — showing all ' + r.rows.length;
    showAll.remove();
  };
};

$('commit').onclick = async () => {
  $('commit').disabled = true;
  const r = await post('/api/import', {
    bankAccountId: $('account').value, fileText: $('text').value, bank: $('bank').value,
    documentId: sourceDocumentId || undefined,
    fileBase64: uploadedFile ? await fileBase64(uploadedFile) : undefined,
    password: $('statement-password').value || undefined,
    rememberPassword: $('remember-password').checked,
    autoOpenEmail: $('auto-open-email').checked,
  });
  const head = r.ok
    ? '<div class="msg good"><b>Imported ' + r.imported + ' row(s)</b>'
      + (r.duplicates ? ' — ' + r.duplicates + ' already present' : '')
      + '<br>' + esc(r.arithmetic ? r.arithmetic.detail : '') + '</div>'
    : '<div class="msg bad"><b>Import refused</b><br>' + esc(r.error) + '</div>';
  $('out').innerHTML = head
    + (r.warnings.length ? '<div class="msg"><ul>'
        + r.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></div>' : '')
    + (r.ok ? '<p><a href="/reconcile?account=' + encodeURIComponent($('account').value)
        + '"><button class="primary">Go to reconciliation →</button></a></p>' : '');
  if (r.ok && r.coverage) {
    coverageByAccount[$('account').value] = r.coverage;
    showCoverage(r.coverage);
  }
  $('commit').disabled = !r.ok;
};

function stat(v, label) {
  return '<div class="stat"><b>' + esc(v) + '</b><span>' + esc(label) + '</span></div>';
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
document.addEventListener('keydown', (e) => {
  // Enter in an import input previews only. Import requires activating its
  // button explicitly, so a second Enter cannot commit financial rows.
  if (e.key === 'Enter' && e.target.matches('input, select')) {
    e.preventDefault();
    $('preview').click();
  }
});
</script>`;
}

// ---------------------------------------------------------------------------

function scoreClass(score: number | undefined): string {
  if (score === undefined) return 's-lo';
  if (score >= 60) return 's-hi';
  if (score >= 45) return 's-mid';
  return 's-lo';
}

const CLASSIFY_HINT: Record<string, string> = {
  bank_charge: 'Looks like a bank charge — <kbd>c</kbd> to post it, and claim the GST on it',
  interest: 'Looks like interest — <kbd>n</kbd> to post it GROSS, before the bank\'s TDS',
  cheque: 'A cheque presentation — clear it against the payment already in the books',
};

function proposalCell(p: MatchProposal, hint: string | null): string {
  if (!p.best) {
    return `<div>
      <span class="why">${esc(p.reason)}</span>
      ${hint ? `<div class="why" style="margin-top:4px">${CLASSIFY_HINT[hint]}</div>` : ''}
    </div>`;
  }
  const cls = p.ambiguous ? 'amb' : scoreClass(p.best.score);
  return `<div>
    <span class="score ${cls}">${p.best.score}</span>
    &nbsp;<b>${esc(p.best.documentNumber)}</b>
    ${p.best.partyName ? `<span class="why"> · ${esc(p.best.partyName)}</span>` : ''}
    ${p.ambiguous ? '<span class="tag" style="border-color:var(--bad);color:var(--bad)">ambiguous</span>' : ''}
    <div class="why">${esc(p.reason)}</div>
    ${p.runnersUp.length ? `<div class="why">runner-up: ${p.runnersUp
      .map((r) => `${esc(r.documentNumber)} (${r.score})`).join(', ')}</div>` : ''}
  </div>`;
}

export function renderQueue(
  queue: { items: QueueItem[]; totals: { unmatched: number; matched: number;
           autoMatchable: number; ambiguous: number; unsure: number } },
  brs: Brs,
  accountId: string,
  review: {
    expenseAccounts: Array<{ id: string; name: string }>;
    transferAccounts: Array<{ id: string; name: string }>;
    personalAccountName: string;
  },
  classifier: { enabled: boolean; available: boolean; called?: boolean;
    canReview?: boolean; canPost?: boolean; canManageSettings?: boolean } = {
    enabled: false, available: false,
  },
): string {
  const { items, totals } = queue;
  const canReview = classifier.canReview ?? true;
  const canPost = classifier.canPost ?? true;
  const canManageSettings = classifier.canManageSettings ?? true;

  const optionList = (accounts: Array<{ id: string; name: string }>, selected: string | null) =>
    `<option value="">Choose account</option>${accounts.map((a) =>
      `<option value="${esc(a.id)}" ${a.name === selected ? 'selected' : ''}>${esc(a.name)}</option>`
    ).join('')}`;
  const reviewControl = (it: QueueItem, i: number): string => {
    if (!canReview) return '';
    const defaultKind = it.reviewClassification ?? it.fundingSuggestion?.classification
      ?? (it.suggestedExpenseAccount ? 'business_expense' : 'unsure');
    const outbound = it.direction === 'outbound';
    const kindOptions = [
      { value: 'unsure', label: 'Unsure — do not post' },
      ...(outbound && canPost ? [
        { value: 'business_expense', label: 'Business expense — receipt missing' },
        { value: 'personal', label: 'Personal payment' },
      ] : [
        { value: 'share_application_pending', label: 'Share application — allotment pending' },
        { value: 'related_party_loan_pending', label: 'Director / related-party loan — verify terms' },
        { value: 'customer_advance_pending', label: 'Customer advance — verify order' },
        { value: 'intercompany_transfer_pending', label: 'Company account transfer — verify both accounts' },
        { value: 'refund_or_reversal_pending', label: 'Refund or reversal — find original payment' },
        { value: 'bank_interest_pending', label: 'Bank interest — verify statement' },
        { value: 'customer_receipt_pending', label: 'Customer payment — match invoice' },
      ]),
      ...(canPost ? [{ value: 'transfer', label: 'Transfer between company accounts' }] : []),
    ];
    const selectedKind = kindOptions.find((option) => option.value === defaultKind) ?? kindOptions[0]!;
    const suggestion = !outbound && !it.proposal.best
      ? `<details class="suggestion-details">
          <summary>ⓘ Nexus suggestion${it.fundingSuggestion ? ` · ${it.fundingSuggestion.confidence}% confidence` : ''} · View details</summary>
          <p class="why">${esc(it.fundingSuggestion?.reason
            ?? 'No invoice match. Confirm who sent this and why before treating it as income, a loan, or share money.')}
            ${it.fundingSuggestion ? `Suggestion only; confirm the sender and supporting records.${it.fundingSuggestion.evidence?.length
              ? ` Evidence: ${it.fundingSuggestion.evidence.map((e) => `“${e}”`).join(', ')}.` : ''}${it.fundingSuggestion.question
                ? ` Reviewer question: ${it.fundingSuggestion.question}` : ''}` : ''}</p>
        </details>`
      : '';
    return `<details class="bank-review" ${!it.proposal.best ? 'open' : ''}>
        <summary>${it.reviewClassification === 'unsure' ? 'Review this transaction again' : 'Review this transaction'}</summary>
      <div class="bank-review-body" data-review="${i}">
        ${suggestion}
        <div class="review-kind-field">
          <span>1. What best describes this transaction?</span>
          <select class="review-kind" hidden aria-hidden="true" tabindex="-1">
            ${kindOptions.map((option) => `<option value="${esc(option.value)}" ${selectedKind.value === option.value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}
          </select>
          <details class="review-kind-picker">
            <summary class="review-kind-current">${esc(selectedKind.label)}</summary>
            <div class="review-kind-options">
              ${kindOptions.map((option) => `<button type="button" data-kind="${esc(option.value)}" aria-pressed="${option.value === selectedKind.value}">${esc(option.label)}</button>`).join('')}
            </div>
          </details>
        </div>
        <label class="review-source">Who sent the money?
          <input class="review-source-name" maxlength="160" placeholder="Confirm sender name"
            value="${esc(it.reviewSourceName ?? it.fundingSuggestion?.sourceName ?? it.counterpartyName ?? '')}">
        </label>
        ${canPost ? `<label class="review-expense">Expense account
          <select class="review-expense-account">${optionList(review.expenseAccounts, it.suggestedExpenseAccount)}</select>
        </label>
        <label class="review-transfer">Other account
          <select class="review-transfer-account">${optionList(review.transferAccounts, null)}</select>
        </label>` : ''}
        <label>Note <input class="review-note" maxlength="500" placeholder="What evidence supports this choice?" value="${esc(it.reviewNote ?? '')}"></label>
        <p class="why review-explain"></p>
        ${!canPost ? '<p class="why">Ledger posting and reconciliation require an owner or CA partner. You can save an unsure or pending review for them.</p>' : ''}
        <button class="primary review-submit">Save answer</button>
      </div>
    </details>`;
  };

  const rows = items.map((it, i) => `
    <tr class="row" data-i="${i}" id="r${i}"
        data-txn="${esc(it.bankTransactionId)}"
        data-voucher="${esc(it.proposal.best?.voucherId ?? '')}"
        data-auto="${it.proposal.autoMatchable ? '1' : '0'}"
        data-amount="${esc(it.unmatchedAmount)}"
        data-score="${it.proposal.best?.score ?? ''}">
      <td class="num">${esc(it.txnDate)}</td>
      <td>
        <div class="narr">${esc(it.narration)}</div>
        <div class="why">
          ${it.paymentMode ? `<span class="tag">${esc(it.paymentMode)}</span> ` : ''}
          ${it.reference ? `ref ${esc(it.reference)}` : ''}
          ${it.status !== 'unmatched' ? ` · <span class="tag">${esc(it.status)}</span>` : ''}
        </div>
      </td>
      <td class="num">${it.direction === 'outbound' ? inr(it.debit) : ''}</td>
      <td class="num">${it.direction === 'inbound' ? inr(it.credit) : ''}</td>
      <td>${proposalCell(it.proposal, it.suggestedClassification)}${reviewControl(it, i)}</td>
    </tr>`).join('');

  return `${pageIntro('BANKING', 'Reconcile',
    'Sorted by confidence — clear the top in bulk, spend your attention at the bottom. Nothing posts without you.')}

<div class="msg"><b>Review a transaction:</b> choose a type, fill in the sender or evidence if you know it, then select <b>Save answer</b>. If you are unsure, leave “Unsure” selected. Saving a review does not post or reconcile anything.</div>

  <div class="panel row-actions" style="justify-content:space-between;align-items:center">
  <div><b>Nexus transaction suggestions</b>
    <div class="why">Optional AI suggestions for unmatched incoming transactions. They are saved for review and never post automatically.</div>
    <details class="suggestion-details"><summary>ⓘ What information is shared?</summary>
      <p class="why">When enabled, redacted narration is sent to the configured AI provider for classification. Narration can still contain a payer or merchant name. Amounts, account numbers, and balances are not sent.</p>
    </details>
    ${classifier.enabled ? '<span class="tag good">Enabled</span>' : '<span class="tag">Off</span>'}
    ${!classifier.available ? '<span class="why"> · Nexus AI is not configured on this server.</span>' : ''}
  </div>
  ${canManageSettings ? `<button type="button" id="toggle-bank-classifier" ${!classifier.available && !classifier.enabled ? 'disabled' : ''}>${classifier.enabled ? 'Turn off' : 'Enable for this firm'}</button>` : '<span class="why">Only an owner or CA partner can change this firm setting.</span>'}
</div>

<div class="panel strip">
  <div class="stat"><b>${totals.unmatched}</b><span>unmatched</span></div>
  <div class="stat"><b class="good">${totals.autoMatchable}</b><span>high confidence</span></div>
  <div class="stat"><b class="${totals.ambiguous ? 'bad' : ''}">${totals.ambiguous}</b><span>ambiguous</span></div>
  <div class="stat"><b class="${totals.unsure ? 'bad' : ''}">${totals.unsure}</b><span>marked unsure</span></div>
  <div class="stat"><b class="${brs.ties ? 'good' : 'bad'}">${inr(brs.difference)}</b><span>BRS difference</span></div>
  <div style="margin-left:auto" class="row-actions">
    <button class="primary" id="bulk" ${totals.autoMatchable === 0 || !canPost ? 'disabled' : ''}>
      Accept ${totals.autoMatchable} high-confidence <kbd>A</kbd>
    </button>
  </div>
</div>

${brs.ties ? '' : `<div class="msg bad"><b>The BRS does not tie.</b><br>${esc(brs.exception)}</div>`}
${brs.openingSuggestion && canPost ? `<div class="msg">
  <b>First statement starting balance: ${inr(brs.openingSuggestion.amount)}</b><br>
  This amount is printed on the statement for ${esc(brs.openingSuggestion.date)}. Confirm it once to start this bank account in the books.
  <p><button class="primary" id="use-statement-opening">Use this starting balance</button></p>
</div>` : ''}

<div id="msg"></div>

${items.length === 0
  ? '<p class="empty">Nothing to reconcile. Import a statement to begin.</p>'
  : `<div class="panel" style="padding:0"><table>
      <tr><th>Date</th><th>Narration</th><th class="num">Out</th>
          <th class="num">In</th><th>Match or classify</th></tr>
      ${rows}
    </table></div>`}

${!canReview ? '<p class="why">Read-only bank review. An owner, CA partner, or CA staff member can record a review.</p>' : ''}

<p class="keys">
  <kbd>j</kbd><kbd>k</kbd> move ·
  <kbd>⏎</kbd> accept the proposal ·
  <kbd>t</kbd> accept as TDS-deducted ·
  <kbd>c</kbd> bank charge ·
  <kbd>n</kbd> interest ·
  <kbd>x</kbd> ignore ·
  <kbd>A</kbd> accept all high-confidence
</p>

<script>
const rowsEl = [...document.querySelectorAll('tr.row')];
let sel = 0;

function paint() {
  rowsEl.forEach((r, i) => r.classList.toggle('sel', i === sel));
  rowsEl[sel] && rowsEl[sel].scrollIntoView({ block: 'nearest' });
}
if (rowsEl.length) paint();

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const classifierToggle = document.getElementById('toggle-bank-classifier');
if (classifierToggle) classifierToggle.onclick = async () => {
  const enabled = ${classifier.enabled ? 'false' : 'true'};
  if (enabled && !confirm('Enable Nexus bank suggestions for this firm? Redacted transaction narration will be sent to the configured AI service for suggestions.')) return;
  classifierToggle.disabled = true;
  const r = await post('/api/bank-classifier-consent', { enabled });
  if (r.ok) location.reload();
  else { classifierToggle.disabled = false; say(false, r.error); }
};

const useStatementOpening = document.getElementById('use-statement-opening');
if (useStatementOpening) useStatementOpening.onclick = async () => {
  useStatementOpening.disabled = true;
  const r = await post('/api/bank-opening-from-statement', { bankAccountId: ${JSON.stringify(accountId)} });
  if (r.ok) location.reload();
  else { useStatementOpening.disabled = false; say(false, r.error); }
};

function say(ok, text) {
  document.getElementById('msg').innerHTML =
    '<div class="msg ' + (ok ? 'good' : 'bad') + '">' + text + '</div>';
}

function reviewHelp(kind, personalAccount) {
  if (kind === 'business_expense') return 'Posts the full payment to the selected expense account. Receipt missing; GST credit ₹0.';
  if (kind === 'personal') return 'Posts to ' + personalAccount + ', not to the business P&L.';
  if (kind === 'transfer') return 'Posts between the bank and the selected balance-sheet account.';
  if (kind === 'share_application_pending') return 'Records your answer, but does not post or mark this reconciled. Check the application and allotment documents before choosing the ledger account.';
  if (kind === 'related_party_loan_pending') return 'Records your answer without posting. Confirm the lender and terms before accounting for the loan.';
  if (kind === 'customer_advance_pending') return 'Records your answer without posting. Match the customer and order before accounting for the advance.';
  if (kind === 'intercompany_transfer_pending') return 'Records your answer without posting. Verify both accounts are owned by the company.';
  if (kind === 'refund_or_reversal_pending') return 'Records your answer without posting. Find and verify the original transaction.';
  if (kind === 'bank_interest_pending') return 'Records your answer without posting. Verify interest in the bank advice before accounting for it.';
  if (kind === 'customer_receipt_pending') return 'Records your answer without posting. Match it to a customer and invoice.';
  return 'Saves this as unsure. Nothing posts and it remains in the review queue.';
}

document.querySelectorAll('.bank-review-body').forEach((box) => {
  const kind = box.querySelector('.review-kind');
  const kindPicker = box.querySelector('.review-kind-picker');
  const kindCurrent = box.querySelector('.review-kind-current');
  const expense = box.querySelector('.review-expense');
  const transfer = box.querySelector('.review-transfer');
  const source = box.querySelector('.review-source');
  const explain = box.querySelector('.review-explain');
  const refresh = () => {
    const selected = kind.options[kind.selectedIndex];
    kindCurrent.textContent = selected.textContent;
    kindPicker.querySelectorAll('[data-kind]').forEach((choice) => {
      choice.setAttribute('aria-pressed', String(choice.dataset.kind === kind.value));
    });
    expense.hidden = kind.value !== 'business_expense';
    transfer.hidden = kind.value !== 'transfer';
    source.hidden = !kind.value.endsWith('_pending');
    explain.textContent = reviewHelp(kind.value, ${JSON.stringify(review.personalAccountName)});
  };
  kind.addEventListener('change', refresh);
  kindPicker.querySelectorAll('[data-kind]').forEach((choice) => choice.onclick = (event) => {
    event.preventDefault(); event.stopPropagation();
    kind.value = choice.dataset.kind;
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    kindPicker.open = false;
  });
  refresh();
  box.querySelector('.review-submit').onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const row = box.closest('tr.row');
    const accountId = kind.value === 'business_expense'
      ? box.querySelector('.review-expense-account').value
      : kind.value === 'transfer' ? box.querySelector('.review-transfer-account').value : undefined;
    const r = await post('/api/review-bank-transaction', {
      bankTransactionId: row.dataset.txn, classification: kind.value, accountId,
      sourceName: box.querySelector('.review-source-name').value,
      note: box.querySelector('.review-note').value,
    });
    if (!r.ok) { say(false, r.error); return; }
    location.reload();
  };
});

// Capture the pointer event before table/row handlers can stop propagation.
// This keeps the picker open for clicks inside it and dismisses it on any
// outside interaction, including clicks on another row's controls.
document.addEventListener('pointerdown', (event) => {
  if (!(event.target instanceof Node)) return;
  document.querySelectorAll('.review-kind-picker[open]').forEach((picker) => {
    if (!picker.contains(event.target)) picker.open = false;
  });
}, true);

// Also dismiss when keyboard navigation moves focus outside the popover.
document.addEventListener('focusin', (event) => {
  if (!(event.target instanceof Node)) return;
  document.querySelectorAll('.review-kind-picker[open]').forEach((picker) => {
    if (!picker.contains(event.target)) picker.open = false;
  });
});

async function accept(row, asTds) {
  if (!row.dataset.voucher) { say(false, 'No candidate to accept on this line.'); return false; }
  const r = await post('/api/accept', {
    bankTransactionId: row.dataset.txn,
    voucherId: row.dataset.voucher,
    treatShortfallAsTds: !!asTds,
    matchType: row.dataset.auto === '1' ? 'scored' : 'manual',
    confidence: row.dataset.score ? Number(row.dataset.score) / 100 : null,
    evidence: { accepted_from: 'reconciliation screen', score: row.dataset.score },
  });
  if (!r.ok) { say(false, r.error); return false; }
  return true;
}

document.addEventListener('keydown', async (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const row = rowsEl[sel];

  if (e.key === 'j' || e.key === 'ArrowDown') { sel = Math.min(sel + 1, rowsEl.length - 1); paint(); e.preventDefault(); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); paint(); e.preventDefault(); }
  else if (e.key === 'Enter' && row) { if (await accept(row, false)) location.reload(); }
  else if (e.key === 't' && row) { if (await accept(row, true)) location.reload(); }
  else if (e.key === 'c' && row) {
    const gst = prompt('GST included in this charge (0 if none):', '0');
    if (gst === null) return;
    const r = await post('/api/classify', { kind: 'bank_charge',
      bankTransactionId: row.dataset.txn, amount: row.dataset.amount, gstAmount: gst });
    r.ok ? location.reload() : say(false, r.error);
  }
  else if (e.key === 'n' && row) {
    const gross = prompt('GROSS interest earned (before the bank\\'s TDS):', row.dataset.amount);
    if (gross === null) return;
    const r = await post('/api/classify', { kind: 'interest',
      bankTransactionId: row.dataset.txn, grossInterest: gross });
    r.ok ? location.reload() : say(false, r.error);
  }
  else if (e.key === 'x' && row) {
    const r = await post('/api/ignore', { bankTransactionId: row.dataset.txn });
    r.ok ? location.reload() : say(false, r.error);
  }
  else if (e.key === 'A') { document.getElementById('bulk').click(); }
});

document.getElementById('bulk').onclick = async () => {
  const btn = document.getElementById('bulk');
  btn.disabled = true;
  const auto = rowsEl.filter((r) => r.dataset.auto === '1');
  let done = 0;
  const failures = [];
  for (const row of auto) {
    // Sequential on purpose: each settlement changes what the next one may
    // allocate, so running them in parallel would race on outstanding balances.
    const r = await post('/api/accept', {
      bankTransactionId: row.dataset.txn, voucherId: row.dataset.voucher,
      matchType: 'scored',
      confidence: row.dataset.score ? Number(row.dataset.score) / 100 : null,
      evidence: { accepted_from: 'bulk accept', score: row.dataset.score },
    });
    r.ok ? done++ : failures.push(r.error);
  }
  if (failures.length) {
    say(false, 'Accepted ' + done + ' of ' + auto.length + '. ' + failures.length
      + ' failed:<ul><li>' + failures.slice(0, 5).map((f) =>
        String(f).replace(/[<>&]/g, '')).join('</li><li>') + '</li></ul>');
    setTimeout(() => location.reload(), 4000);
  } else location.reload();
};
</script>`;
}

// ---------------------------------------------------------------------------

export function renderBrs(brs: Brs, accountId: string): string {
  const rows = brs.lines.map((l) => `<tr>
    <td>${l.effect === 'add' ? 'Add' : 'Less'}: ${esc(l.label)}
        <div class="why">${esc(l.detail)} · ${l.count} item(s)</div></td>
    <td class="num">${l.effect === 'less' ? '(' : ''}${inr(l.amount)}${l.effect === 'less' ? ')' : ''}</td>
  </tr>`).join('');

  return `${pageIntro('BANKING', 'Bank Reconciliation Statement',
    `As at ${brs.asOf}. Book and bank balances differ legitimately — this explains the difference item by item. A residual left over is an error, and is never rounded away (BR-22).`)}

<div class="panel"><table>
  <tr><td><b>Balance as per books</b></td><td class="num"><b>${inr(brs.bookBalance)}</b></td></tr>
  ${rows || '<tr><td class="why">No reconciling items.</td><td></td></tr>'}
  <tr><td><b>Balance as per bank (computed)</b></td>
      <td class="num"><b>${inr(brs.computedBankBalance)}</b></td></tr>
  <tr><td>Balance as per bank statement</td>
      <td class="num">${inr(brs.actualBankBalance)}</td></tr>
  <tr><td><b>Difference</b></td>
      <td class="num ${brs.ties ? 'good' : 'bad'}"><b>${inr(brs.difference)}</b>
      ${brs.ties ? ' ✓' : ''}</td></tr>
</table></div>

${brs.ties
  ? '<div class="msg good">The statement ties exactly.</div>'
  : `<div class="msg bad"><b>Exception</b><br>${esc(brs.exception)}</div>`}

<p class="keys">An unreconciled account blocks period close (BR-23).</p>
<p><a href="/reconcile?account=${esc(accountId)}"><button>Back to reconciliation</button></a></p>`;
}

// ---------------------------------------------------------------------------

/**
 * The cash register (G-21, review answer B4).
 *
 * Deliberately blunt. A negative cash balance is not a nuance to be weighed —
 * it is money paid out that was never held, so one of three specific things is
 * wrong, and the screen says which three so the reviewer starts in the right
 * place rather than staring at a number.
 */
export function renderCashRegister(r: {
  ok: boolean;
  accountsChecked: number;
  negativeDays: Array<{
    accountName: string; date: string; balance: string; shortfall: string;
    vouchers: Array<{ voucherNumber: string; voucherType: string; amount: string }>;
  }>;
}, from: string, to: string): string {
  const form = `
    <form method="get" action="/cash" class="row">
      <label>From <input type="date" name="from" value="${esc(from)}"></label>
      <label>To <input type="date" name="to" value="${esc(to)}"></label>
      <button type="submit">Check</button>
    </form>`;

  if (r.ok) {
    return `${pageIntro('BANKING', 'Cash register', 'Check the cash balance for every day in a selected period.')}${form}
      <p class="ok">✔ ${r.accountsChecked} cash account(s) stayed at or above
      zero on every day in this period.</p>
      <p class="muted">Overdraft and cash-credit accounts are excluded: going
      negative is what those are for.</p>`;
  }

  const rows = r.negativeDays.map((d) => `
    <tr>
      <td>${esc(d.accountName)}</td>
      <td>${esc(d.date)}</td>
      <td class="num bad">${esc(d.balance)}</td>
      <td class="num">${esc(d.shortfall)}</td>
      <td>${d.vouchers.map((v) =>
        `${esc(v.voucherNumber)} <span class="muted">(${esc(v.voucherType)} ${esc(v.amount)})</span>`,
      ).join('<br>')}</td>
    </tr>`).join('');

  return `${pageIntro('BANKING', 'Cash register', 'Check the cash balance for every day in a selected period.')}${form}
    <p class="bad"><b>${r.negativeDays.length} impossible balance(s).</b>
    Cash cannot go below zero — you cannot pay out money you do not hold. For
    each one, either a receipt was never recorded, a payment was recorded twice,
    or a payment is dated wrong.</p>
    <table>
      <thead><tr>
        <th>Account</th><th>First day negative</th><th>Balance</th>
        <th>At least this much is missing</th><th>That day&rsquo;s vouchers</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="muted">A run of consecutive negative days is shown once — it is
    one missing entry, not one per day.</p>`;
}

// ---------------------------------------------------------------------------
// GSTR-2B reconciliation
//
// The four situations, most-actionable first — mismatch and unfiled credit are
// where money is at stake, matched is the reassuring tail. The number the CA
// came for sits at the top: credit 2B supports, and credit booked that no
// supplier has yet filed (s.16(2)(aa)).

interface ReconLineView {
  id: string; status: string; supplierGstin: string | null; note: string;
  resolved: boolean; billNumber: string | null; billTax: string | null;
  filedNumber: string | null; filedTax: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  matched: 'Matched',
  mismatch: 'Mismatch',
  in_books_only: 'In books, not filed',
  in_2b_only: 'Filed, not in books',
};
const STATUS_CLASS: Record<string, string> = {
  matched: 'good', mismatch: 'bad', in_books_only: 'warn', in_2b_only: 'amb',
};

export function renderGstr2b(a: {
  period: string;
  periods: string[];
  lines: ReconLineView[];
  creditSupported: string;
  creditAtRisk: string;
}): string {
  const counts: Record<string, number> = {};
  for (const l of a.lines) counts[l.status] = (counts[l.status] ?? 0) + 1;

  const periodPicker = `
    <form method="get" action="/gstr2b" class="row">
      <label>Return period
        <select name="period" onchange="this.form.submit()">
          ${a.periods.map((p) =>
            `<option value="${esc(p)}" ${p === a.period ? 'selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
      </label>
      <noscript><button type="submit">Show</button></noscript>
    </form>`;

  const upload = `
    <div class="row">
      <label>Reconcile a 2B JSON downloaded from the portal
        <input type="file" id="f2b" accept="application/json,.json">
      </label>
      <button class="primary" id="run2b" disabled>Run reconciliation</button>
    </div>`;

  if (a.periods.length === 0) {
    return `${pageIntro('GST & TDS', 'GSTR-2B', 'Reconcile the purchase ledger against what suppliers filed. Credit needs supplier filing support in this return.')}
      <form method="get" action="/gstr2b" class="row">
        <label>Return period <input name="period" value="${esc(a.period)}" placeholder="YYYY-MM"></label>
        <button type="submit">Set period</button>
      </form>
      ${upload}
      <p class="empty">No reconciliation yet. Set the period and upload its 2B JSON to begin.</p>
      <script>
      const f = document.getElementById('f2b'), run = document.getElementById('run2b');
      const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      if (f) f.onchange = () => { run.disabled = !f.files.length; };
      if (run) run.onclick = async () => {
        try {
          const json = JSON.parse(await f.files[0].text());
          const r = await post('/api/2b/run', { period: ${JSON.stringify(a.period)}, json });
          if (r.ok) location.href = '/gstr2b?period=' + encodeURIComponent(${JSON.stringify(a.period)});
          else alert(r.error || 'could not reconcile');
        } catch (e) { alert('that file is not valid JSON'); }
      };
      </script>`;
  }

  const row = (l: ReconLineView): string => `
    <tr class="${l.resolved ? 'done' : ''}">
      <td><span class="tag ${STATUS_CLASS[l.status] ?? ''}">${STATUS_LABEL[l.status] ?? l.status}</span></td>
      <td class="mono">${esc(l.supplierGstin ?? '—')}</td>
      <td class="mono">${esc(l.billNumber ?? l.filedNumber ?? '—')}</td>
      <td class="num">${l.billTax !== null ? inr(l.billTax) : ''}</td>
      <td class="num">${l.filedTax !== null ? inr(l.filedTax) : ''}</td>
      <td class="note">${esc(l.note)}</td>
      <td>${l.resolved
        ? '<span class="muted">resolved</span>'
        : `<button class="resolve" data-id="${esc(l.id)}">Resolve</button>`}</td>
    </tr>`;

  return `${pageIntro('GST & TDS', 'GSTR-2B', 'What the books claim, against what suppliers filed. Credit needs supplier filing support in this return.')}

${periodPicker}

<div class="panel strip">
  <div class="stat"><b class="good">${inr(a.creditSupported)}</b><span>credit 2B supports</span></div>
  <div class="stat"><b class="${a.creditAtRisk === '0.00' ? '' : 'warn'}">${inr(a.creditAtRisk)}</b><span>booked, not yet filed</span></div>
  <div class="stat"><b class="${counts['mismatch'] ? 'bad' : ''}">${counts['mismatch'] ?? 0}</b><span>mismatch</span></div>
  <div class="stat"><b>${counts['in_books_only'] ?? 0}</b><span>in books only</span></div>
  <div class="stat"><b>${counts['in_2b_only'] ?? 0}</b><span>in 2B only</span></div>
  <div class="stat"><b class="good">${counts['matched'] ?? 0}</b><span>matched</span></div>
</div>

<div id="msg"></div>
${upload}

<div class="panel" style="padding:0"><table>
  <tr><th>Status</th><th>Supplier GSTIN</th><th>Invoice</th>
      <th class="num">Books tax</th><th class="num">2B tax</th>
      <th>What it means</th><th></th></tr>
  ${a.lines.map(row).join('')}
</table></div>

<script>
const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const f = document.getElementById('f2b'), run = document.getElementById('run2b');
if (f) f.onchange = () => { run.disabled = !f.files.length; };
if (run) run.onclick = async () => {
  const file = f.files[0]; if (!file) return;
  run.disabled = true; run.textContent = 'Reading…';
  try {
    const json = JSON.parse(await file.text());
    const r = await post('/api/2b/run', { period: ${JSON.stringify(a.period)}, json });
    if (r.ok) { location.href = '/gstr2b?period=' + encodeURIComponent(${JSON.stringify(a.period)}); }
    else { document.getElementById('msg').innerHTML = '<div class="msg bad">' + (r.error || 'could not reconcile') + '</div>'; run.disabled = false; run.textContent = 'Run reconciliation'; }
  } catch (e) {
    document.getElementById('msg').innerHTML = '<div class="msg bad">that file is not valid JSON</div>';
    run.disabled = false; run.textContent = 'Run reconciliation';
  }
};

document.querySelectorAll('button.resolve').forEach((b) => {
  b.onclick = async () => {
    const r = await post('/api/2b/resolve', { id: b.dataset.id });
    if (r.ok) {
      const tr = b.closest('tr');
      tr.classList.add('done');
      b.replaceWith(Object.assign(document.createElement('span'),
        { className: 'muted', textContent: 'resolved' }));
    } else {
      document.getElementById('msg').innerHTML =
        '<div class="msg bad">' + (r.error || 'could not resolve') + '</div>';
    }
  };
});
</script>`;
}

// ---------------------------------------------------------------------------
// Bill ingestion review
//
// A PDF becomes one card per document it holds. The card's whole job is to
// make the three states legible at a glance — ready to post, needing an answer
// first, or blocked — and to put the reason in plain language beside each. A
// reviewer approves on their own authority (AT-13); nothing posts on its own.

interface ProposalViewV {
  index: number;
  status: 'ready' | 'needs_answer' | 'blocked';
  documentNumber: string | null;
  partyName: string | null;
  supplierGstin: string | null;
  billDate: string | null;
  readBy: string;
  taxable: string | null;
  tax: string | null;
  total: string | null;
  totalIsUnverified: boolean;
  canRecordExpenseOnly: boolean;
  registrationStatus: string | null;
  /** Null when no supplier could be matched — nothing to hang master data on. */
  partyId: string | null;
  lines: Array<{ description: string; amount: string; hsn: string | null;
    suggestedAccountId?: string;
    aiSuggestion?: { accountId: string | null; confidence: number; reason: string } }>;
  warnings: string[];
  blockers: string[];
  confirmations: Array<{ field: string; chose: string; instead: string; question: string }>;
  /** The TDS position, when this bill has one. */
  tds: { category: string; amount: string; code: string; rate: string;
         question: string } | null;
  /** What to ask for, when the bill was refused — see `billForm.ts`. */
  form?: {
    fields: Array<{ field: string; ask: string; because: string }>;
    unfixable: string[];
  };
  token?: string;
}

const READ_BY_LABEL: Record<string, string> = {
  coordinates: 'read on-page', candidates: 'read from the page structure',
  docling: 'read by Docling', llm: 'read by a model',
  summary: 'read from stated totals', charges: 'read from charges in words',
  entered: 'entered by a reviewer',
};

/**
 * The form a refused bill offers instead of a wall.
 *
 * Only the fields that would actually clear the refusal, each carrying the
 * reason it is being asked. Nothing is pre-filled that could not be read: a
 * guessed invoice number a reviewer clicks past is worse than an empty box,
 * because it reconciles against nothing and nobody knows it was invented.
 */
function fillForm(p: ProposalViewV, token: string): string {
  const form = p.form;
  if (!form || form.fields.length === 0) return '';

  const box = (f: { field: string; ask: string; because: string }): string => {
    if (f.field === 'figures') {
      return `<div class="fillrow">
        <label>Figures as printed <span class="muted">${esc(f.ask)}</span></label>
        <div class="fillfigs">
          <input data-fill="taxable" placeholder="taxable" inputmode="decimal"
            value="${esc(p.taxable ?? '')}">
          <input data-fill="cgst" placeholder="CGST" inputmode="decimal">
          <input data-fill="sgst" placeholder="SGST" inputmode="decimal">
          <input data-fill="igst" placeholder="IGST" inputmode="decimal">
          <input data-fill="total" placeholder="total" inputmode="decimal"
            value="${esc(p.total ?? '')}">
        </div>
        <div class="muted small">They must add up — taxable + tax = total — and
          the tax must match a scheduled rate. Checked before anything posts.</div>
      </div>`;
    }
    const label = f.field === 'documentNumber' ? 'Invoice number'
      : f.field === 'billDate' ? 'Invoice date'
      : f.field === 'fxRate' ? 'Exchange rate' : 'Supplier';
    const type = f.field === 'billDate' ? 'date' : 'text';
    return `<div class="fillrow">
      <label>${label} <span class="muted">${esc(f.ask)}</span></label>
      <input data-fill="${esc(f.field)}" type="${type}">
    </div>`;
  };

  return `<div class="fill" data-index="${p.index}" data-token="${esc(token)}">
    <div class="fillhead">This bill could not be read on its own. Fill in what
      the document says and it will be checked the same way.</div>
    ${form.fields.map(box).join('')}
    ${form.unfixable.length > 0
      ? `<div class="notes blocks"><b>A form cannot settle these:</b>
           ${form.unfixable.map((u) => `<div>${esc(u)}</div>`).join('')}</div>`
      : ''}
    <div class="billactions">
      <button class="check" data-index="${p.index}" data-token="${esc(token)}"
        ${form.unfixable.length > 0 ? 'disabled' : ''}>Check these figures</button>
      <span class="fillresult muted"></span>
    </div>
  </div>`;
}

function expenseOnlyForm(
  p: ProposalViewV, token: string,
  accounts: Array<{ id: string; name: string; itc: string | null }>,
  defaultAccountId: string | null,
): string {
  if (!p.canRecordExpenseOnly || p.total === null) return '';
  const accountOptions = accounts.map((a) =>
    `<option value="${esc(a.id)}" ${a.id === defaultAccountId ? 'selected' : ''}>${esc(a.name)}</option>`
  ).join('');
  const supplier = p.partyId === null
    ? `<label>New supplier name
         <input class="expense-supplier" placeholder="e.g. Campus E-Shop" autocomplete="organization">
       </label>`
    : `<div><span class="muted small">Supplier</span><br><b>${esc(p.partyName ?? 'Supplier on file')}</b></div>`;
  return `<div class="expenseonly" data-index="${p.index}" data-token="${esc(token)}"
      data-party="${esc(p.partyId ?? '')}" data-gstin="${esc(p.supplierGstin ?? '')}"
      data-total="${esc(p.total)}" data-prepared="0">
    <h3>Record ${inr(p.total)} as expense</h3>
    <div class="muted small">The receipt total is kept. No GST amount or input credit is recorded.</div>
    <div class="expensegrid">
      ${supplier}
      <label>Expense account
        <select class="grossaccount">${accountOptions}</select>
      </label>
      <button class="prepare-expense" ${accounts.length === 0 ? 'disabled' : ''}>
        Prepare without GST credit
      </button>
    </div>
    <div class="expense-result small" aria-live="polite"></div>
  </div>`;
}

/**
 * The blocker that says a supplier's standing reverse-charge rate is missing.
 * Pinned to the wording in `billProposal`; a test holds the two together.
 */
const NEEDS_PARTY_RCM = /Set the rate on .+ party record/i;

/**
 * Setting the supplier's standing reverse-charge rate, from the blocked bill.
 *
 * Deliberately NOT part of the fill-in form above, and the separation is the
 * point. That form answers questions about THIS document and its answers are
 * recorded as entered on this bill. This writes MASTER DATA: it will price
 * every future bill from this supplier, including ones nobody reviews as
 * carefully as the one on screen. So it is its own block, with its own button,
 * and it asks what the supply is rather than taking a bare number — the rate
 * is the one figure on a reverse-charge bill that no arithmetic can check, so
 * the reason for it is the only evidence there will ever be.
 */
function partyRcmForm(p: ProposalViewV, token: string): string {
  if (p.partyId === null) return '';
  const blocker = p.blockers.find((b) => NEEDS_PARTY_RCM.test(b));
  if (blocker === undefined) return '';

  // Which provision, from the branch that raised it. An overseas supplier is
  // s.5(3) of the IGST Act; a domestic one can only be s.9(3).
  const provision = /outside India/i.test(blocker) ? 'igst_5_3' : 'cgst_9_3';
  const rates = STATUTORY_RATES
    .map((r) => `<option value="${r}"${r === '18' ? ' selected' : ''}>${r}%</option>`)
    .join('');

  return `<div class="partyrcm" data-index="${p.index}" data-token="${esc(token)}"
       data-party="${esc(p.partyId)}" data-provision="${provision}">
    <div class="fillhead">This supplier's supplies are taxed in your client's
      hands, and the rate is not on the document — it never is, because the
      supplier charges none. Set it once here and it applies to every bill from
      ${esc(p.partyName ?? 'this supplier')}, this one included.</div>
    <div class="fillrow">
      <label>Rate <span class="muted">The rate this supply would attract in
        India in the ordinary way.</span></label>
      <select data-rcm="rate">${rates}</select>
    </div>
    <div class="fillrow">
      <label>What they supply <span class="muted">In the notification's own
        words — "legal services by an advocate", "goods transport agency",
        "cloud hosting". This is the justification for the rate.</span></label>
      <input data-rcm="supply" type="text">
    </div>
    <div class="fillrow">
      <label>In force from <span class="muted">Bills dated before this are
        unaffected — an older bill keeps the rate that priced it.</span></label>
      <input data-rcm="effectiveFrom" type="date"
        value="${esc(p.billDate ?? '')}">
    </div>
    <div class="billactions">
      <button class="setrcm">Save on ${esc(p.partyName ?? 'supplier')}</button>
      <span class="rcmresult muted"></span>
    </div>
  </div>`;
}

function proposalCard(
  p: ProposalViewV, token: string,
  accounts: Array<{ id: string; name: string; itc: string | null }>,
  defaultAccountId: string | null,
  canApprove = false,
): string {
  const badge = p.status === 'ready'
    ? `<span class="tag good">${canApprove ? 'Ready to post' : 'Ready for CA review'}</span>`
    : p.status === 'needs_answer'
      ? '<span class="tag warn">Needs your answer</span>'
      : '<span class="tag bad">Blocked</span>';

  const money = (label: string, v: string | null): string =>
    v !== null ? `<span class="fig"><b>${inr(v)}</b><span>${label}</span></span>` : '';

  const confirms = p.confirmations.map((c) => `
    <div class="confirm" data-field="${esc(c.field)}">
      <p>${esc(c.question)}</p>
      <label class="pick"><input type="radio" name="c_${p.index}_${esc(c.field)}"
        value="${esc(c.chose)}" checked> ${esc(c.chose)} <span class="muted">(read)</span></label>
      <label class="pick"><input type="radio" name="c_${p.index}_${esc(c.field)}"
        value="${esc(c.instead)}"> ${esc(c.instead)}</label>
    </div>`).join('');

  const notes = (cls: string, items: string[]): string =>
    items.length === 0 ? ''
      : `<ul class="${cls}">${items.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;

  const canPost = p.status !== 'blocked';
  const fill = fillForm(p, token);
  const expenseOnly = expenseOnlyForm(p, token, accounts, defaultAccountId);
  const fillChoice = p.canRecordExpenseOnly && fill !== ''
    ? `<details class="manualalternative"><summary>Enter the GST breakup instead</summary>${fill}</details>`
    : fill;

  // The classification controls — an expense head per line, and whether to
  // claim credit at all. Offered only on a postable card; a blocked one has
  // nothing to post. Each line carries its own account: a hotel bill splits
  // room (Professional Fees) from food (blocked), a hardware run splits capital
  // from consumable — the CA's judgement, one row at a time.
  const opt = (sel: string) => accounts.map((ac) =>
    `<option value="${esc(ac.id)}" ${ac.id === sel ? 'selected' : ''}>${esc(ac.name)}${
      ac.itc && ac.itc !== 'eligible' ? ` — ITC ${esc(ac.itc)}` : ''}</option>`).join('');

  const lineRows = p.lines.map((l, i) => {
    const chosen = l.suggestedAccountId ?? l.aiSuggestion?.accountId ?? defaultAccountId ?? '';
    return `
    <tr>
      <td>${esc(l.description || 'Line ' + (i + 1))}${
        l.hsn ? ` <span class="muted">HSN ${esc(l.hsn)}</span>` : ''}</td>
      <td class="num">${inr(l.amount)}</td>
      <td>
        <select class="lineacct" data-line="${i}">${opt(chosen)}</select>
        ${l.suggestedAccountId ? '<span class="learned" title="learned from a previous bill">learned</span>' : ''}
        ${!l.suggestedAccountId && l.aiSuggestion?.accountId
          ? `<span class="learned" title="Nexus suggestion only; review before posting">AI suggestion · ${l.aiSuggestion.confidence}%</span>
             <span class="why" title="${esc(l.aiSuggestion.reason)}">${esc(l.aiSuggestion.reason)}</span>` : ''}
        ${!l.suggestedAccountId && l.aiSuggestion && !l.aiSuggestion.accountId
          ? `<span class="why" title="Nexus could not confidently choose an account">AI unsure · ${l.aiSuggestion.confidence}%</span>` : ''}
      </td>
    </tr>`;
  }).join('');

  const controls = !canPost ? '' : `
    <div class="lines">
      <table>
        <tr><th>Line</th><th class="num">Taxable</th><th>Post to account</th></tr>
        ${lineRows}
      </table>
    </div>
    <div class="billctl">
      <label class="chk"><input type="checkbox" class="noitc"> Do not claim input credit</label>
    </div>`;

  return `<div class="billcard ${p.status}" data-index="${p.index}">
    <div class="billhead">
      <div>
        <b class="mono">${esc(p.documentNumber ?? '(no number)')}</b>
        ${badge}
        <span class="tag">${READ_BY_LABEL[p.readBy] ?? p.readBy}</span>
      </div>
      <div class="muted">${esc(p.partyName ?? p.supplierGstin ?? 'supplier not identified')}
        ${p.billDate ? ` · ${esc(p.billDate)}` : ''}
        ${p.registrationStatus ? ` · GSTIN ${esc(p.registrationStatus)}` : ''}</div>
    </div>

    <div class="figs">
      ${money('taxable', p.taxable)} ${money('tax', p.tax)}
      ${money(p.totalIsUnverified ? 'total seen — check it' : 'total', p.total)}
    </div>

    ${confirms}
    ${notes('warns', p.warnings)}
    ${notes('blocks', p.blockers)}
    ${partyRcmForm(p, token)}
    ${expenseOnly}
    ${fillChoice}
    ${controls}

    <div class="billactions">
      ${canPost && canApprove
        ? `<button class="primary post" data-index="${p.index}" data-token="${esc(token)}">
             ${p.status === 'needs_answer' ? 'Confirm & post' : 'Approve & post'}</button>`
        : canPost
          ? '<span class="muted">Your review is ready. A CA partner must approve it before it is posted to the books.</span>'
        : (p.form && p.form.fields.length > 0 && p.form.unfixable.length === 0
            ? '<span class="muted">Fill the fields above, check them, then post.</span>'
            : p.blockers.some((b) => NEEDS_PARTY_RCM.test(b)) && p.partyId !== null
              // The block above IS the way through, and saving it re-reads the
              // bill in place. Telling them to re-upload would be wrong.
              ? '<span class="muted">Set the rate above and this bill is re-read on the spot.</span>'
              : '<span class="muted">Resolve the blocker on the document, then re-upload.</span>')}
    </div>
  </div>`;
}

export function renderBillReview(a: {
  proposals: ProposalViewV[];
  token: string | null;
  posted: Array<{ number: string; party: string; date: string; total: string }>;
  hasExpenseAccount: boolean;
  accounts: Array<{ id: string; name: string; itc: string | null }>;
  defaultAccountId: string | null;
  canApprove?: boolean;
  classifier?: { enabled: boolean; available: boolean };
}): string {
  const canApprove = a.canApprove === true;
  const upload = `
    <div class="row">
      <label>Upload invoice PDFs or photos
        <input type="file" id="pdfs" accept="application/pdf,image/jpeg,image/png,image/webp" multiple>
      </label>
      <button class="primary" id="run" disabled>Read them</button>
    </div>`;

  const summary = a.proposals.length === 0 ? '' : (() => {
    const c = { ready: 0, needs_answer: 0, blocked: 0 };
    for (const p of a.proposals) c[p.status]++;
    return `<div class="panel bill-summary" aria-label="Bill review counts">
      <button type="button" class="bill-filter on" data-status="all" aria-pressed="true"><b>${a.proposals.length}</b><span>All to review</span></button>
      <button type="button" class="bill-filter" data-status="ready" aria-pressed="false"><b class="good">${c.ready}</b><span>Ready</span></button>
      <button type="button" class="bill-filter" data-status="needs_answer" aria-pressed="false"><b class="${c.needs_answer ? 'warn' : ''}">${c.needs_answer}</b><span>Need your input</span></button>
      <button type="button" class="bill-filter" data-status="blocked" aria-pressed="false"><b class="${c.blocked ? 'bad' : ''}">${c.blocked}</b><span>Blocked</span></button>
    </div>`;
  })();

  const postedRows = a.posted.map((b) => `
    <tr><td class="mono">${esc(b.number)}</td><td>${esc(b.party)}</td>
        <td>${esc(b.date)}</td><td class="num">${inr(b.total)}</td></tr>`).join('');

  return `<section class="page-intro bill-intro"><div><p class="eyebrow">PURCHASES</p><h1>Bills</h1>
<p class="sub">Review supplier invoices, correct anything Nexus could not read, then send them for approval.</p></div>
<a class="primary-link" href="/documents">Open document inbox →</a></section>
<div class="msg bill-next-step"><b>Next:</b> upload a supplier invoice or open a bill below. Read and correct its details before posting.
${canApprove ? ' Posting always needs your explicit approval.' : ' A CA partner must approve before anything posts to the books.'}</div>

${a.hasExpenseAccount ? '' :
  '<div class="msg bad">This client has no Purchases account, so a bill has nowhere to post. Seed the chart of accounts first.</div>'}

<section class="panel bill-upload"><h2>Start with a supplier invoice</h2><p class="why">Upload a PDF or photo. Nexus prepares a review; it does not post the bill.</p>${upload}</section>
${a.classifier ? `<section class="panel bill-ai-consent">
  <div><b>Nexus expense-account suggestions</b>
    <div class="why">Optional AI suggestions for expense accounts. Suggestions are editable and never post by themselves.</div>
    <details class="suggestion-details"><summary>ⓘ What information is shared?</summary>
      <p class="why">When enabled, the supplier name, line descriptions, HSN/SAC codes, and your expense-account names are sent to the configured AI service. Prices, totals, GSTINs, and the original invoice file are not sent.</p>
    </details>
    ${!a.classifier.available ? '<div class="why">Nexus AI is not configured on this server.</div>' : ''}
  </div>
  <label><input type="checkbox" id="bill-ai-toggle" ${a.classifier.enabled ? 'checked' : ''} ${a.classifier.available ? '' : 'disabled'}> Enable for this firm</label>
  <span id="bill-ai-status" class="why" role="status"></span>
</section>` : ''}
<div id="msg"></div>

${summary}
<p class="why bill-review-guidance" id="bill-filter-guidance">Select a bill to review its source, confirm the details and expense accounts, then use the approval action at the bottom of that bill.</p>
<div id="cards" class="bill-card-list">
  ${a.proposals.map((p) => proposalCard(p, p.token ?? a.token ?? '', a.accounts, a.defaultAccountId, canApprove)).join('')}
</div>

${a.posted.length === 0 ? '' : `
  <h2 class="mt">Recently posted</h2>
  <div class="panel" style="padding:0"><table>
    <tr><th>Invoice</th><th>Supplier</th><th>Date</th><th class="num">Total</th></tr>
    ${postedRows}
  </table></div>`}

<script>
const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());
const canApprove = ${canApprove ? 'true' : 'false'};
const say = (ok, t) => { document.getElementById('msg').innerHTML =
  '<div class="msg ' + (ok ? 'good' : 'bad') + '">' + t + '</div>'; };

document.querySelectorAll('.bill-filter').forEach((filter) => filter.onclick = () => {
  const status = filter.dataset.status;
  document.querySelectorAll('.bill-filter').forEach((item) => {
    const selected = item === filter;
    item.classList.toggle('on', selected);
    item.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll('.billcard').forEach((card) => {
    card.hidden = status !== 'all' && !card.classList.contains(status);
  });
  const shown = [...document.querySelectorAll('.billcard')].filter((card) => !card.hidden).length;
  document.getElementById('bill-filter-guidance').textContent = shown
    ? shown + (shown === 1 ? ' bill shown. Open it, confirm the details and expense accounts, then use its approval action.'
      : ' bills shown. Review each source and use the approval action on the bill when ready.')
    : 'No bills in this group.';
});

const billAiToggle = document.getElementById('bill-ai-toggle');
if (billAiToggle) billAiToggle.onchange = async () => {
  const enabled = billAiToggle.checked;
  if (enabled && !confirm('Enable Nexus expense-account suggestions for this firm? Supplier names, invoice line descriptions, HSN/SAC codes, and expense-account names will be sent to the configured AI service.')) {
    billAiToggle.checked = false; return;
  }
  billAiToggle.disabled = true;
  const status = document.getElementById('bill-ai-status'); status.textContent = 'Saving…';
  try {
    const r = await post('/api/bill-classifier-consent', { enabled });
    if (!r.ok) throw new Error(r.error || 'could not save the setting');
    status.textContent = enabled ? 'Enabled. New bill previews can receive suggestions.' : 'Disabled.';
  } catch (error) {
    billAiToggle.checked = !enabled; status.textContent = String(error.message || error);
  } finally { billAiToggle.disabled = false; }
};

const pdfs = document.getElementById('pdfs'), run = document.getElementById('run');
if (pdfs) pdfs.onchange = () => { run.disabled = !pdfs.files.length; };
if (run) run.onclick = async () => {
  run.disabled = true; run.textContent = 'Reading…';
  try {
    // One file at a time, so a slow model read on one does not hold the rest.
    const b64 = async (f) => {
      const buf = new Uint8Array(await f.arrayBuffer());
      let s = ''; for (const x of buf) s += String.fromCharCode(x);
      return btoa(s);
    };
    const files = [...pdfs.files];
    const payloads = [];
    for (const f of files) payloads.push({ name: f.name, data: await b64(f) });
    const r = await post('/api/bills/preview', { files: payloads });
    if (r.ok) location.href = '/bills?new=1';
    else { say(false, r.error || 'could not read the file'); run.disabled = false; run.textContent = 'Read them'; }
  } catch (e) { say(false, String(e)); run.disabled = false; run.textContent = 'Read them'; }
};

/*
 * Reading the form back off the card.
 *
 * Blank fields are omitted rather than sent as empty strings: an absent answer
 * means "still unread", and an empty string would look like a value someone
 * chose to leave blank.
 */
/**
 * Which account the reviewer picked for each line.
 *
 * Sent with a re-read as well as with the post, because the account decides
 * the TDS section and whether input credit is claimable — so a re-read that
 * ignored it would answer about the default head, not the chosen one.
 */
function readLineAccounts(card) {
  const out = [];
  card.querySelectorAll('.lineacct, .grossaccount').forEach((sel) => out.push(sel.value || null));
  return out.length > 0 ? out : undefined;
}

function readFill(card) {
  const fill = card.querySelector('.fill');
  const manual = {};
  const figures = {};
  if (fill) {
    fill.querySelectorAll('[data-fill]').forEach((el) => {
      const v = el.value.trim();
      if (v === '') return;
      const k = el.dataset.fill;
      if (['taxable','cgst','sgst','igst','cess','total'].includes(k)) figures[k] = v;
      else manual[k] = v;
    });
  }
  if (figures.taxable !== undefined && figures.total !== undefined) {
    manual.figures = figures;
  }
  const expense = card.querySelector('.expenseonly[data-prepared="1"]');
  if (expense) {
    manual.expenseOnly = true;
    if (expense.dataset.party) manual.partyId = expense.dataset.party;
    delete manual.figures;
  }
  return Object.keys(manual).length > 0 ? manual : undefined;
}

document.querySelectorAll('button.prepare-expense').forEach((btn) => {
  btn.onclick = async () => {
    const box = btn.closest('.expenseonly');
    const card = btn.closest('.billcard');
    const out = box.querySelector('.expense-result');
    let partyId = box.dataset.party;
    btn.disabled = true; out.textContent = 'Preparing…';
    try {
      if (!partyId) {
        const name = box.querySelector('.expense-supplier').value.trim();
        if (!name) throw new Error('Enter the supplier name.');
        const made = await post('/api/suppliers', { name, gstin: box.dataset.gstin || undefined });
        if (!made.ok) throw new Error(made.error || 'could not create supplier');
        partyId = made.id; box.dataset.party = partyId;
      }
      box.dataset.prepared = '1';
      const r = await post('/api/bills/fill', {
        token: box.dataset.token, index: Number(box.dataset.index),
        manual: readFill(card), lineAccounts: readLineAccounts(card),
      });
      if (!r.ok) throw new Error(r.error || 'could not prepare expense');
      if (!r.ready) {
        box.dataset.prepared = '0';
        throw new Error((r.blockers || []).join(' '));
      }
      out.innerHTML = '<span class="good">Ready for review.</span>';
      const actions = card.querySelector(':scope > .billactions');
      if (canApprove) {
        actions.innerHTML = '<button class="primary post" data-index="' + box.dataset.index +
          '" data-token="' + box.dataset.token + '">Approve ₹' + box.dataset.total +
          ' expense</button>';
        wirePost(actions.querySelector('button.post'));
      } else {
        actions.textContent = 'Prepared. A CA partner must approve before it is posted.';
      }
    } catch (error) {
      out.innerHTML = '<span class="bad">' + String(error.message || error).replace(/</g, '&lt;') + '</span>';
      btn.disabled = false;
    }
  };
});

/*
 * Reclassifying a line can create a TDS liability, so the card has to ask
 * before the post is refused.
 *
 * Moving a line from Purchases to Professional Fees is the moment 10% becomes
 * due — the account is what picks the section. The proposal is re-read with the
 * chosen accounts and, if a deduction is now due, the question is inserted as
 * an ordinary confirmation block, which wirePost already collects generically —
 * so once it is on the page it posts like any other answered question.
 */
function tdsBlock(c) {
  const div = document.createElement('div');
  div.className = 'confirm tdsask';
  div.dataset.field = c.field;
  div.innerHTML =
    '<p>' + c.question.replace(/</g, '&lt;') + '</p>' +
    '<label class="pick"><input type="radio" name="' + c.field +
      '" value="' + c.chose.replace(/"/g, '&quot;') + '"> ' +
      c.chose.replace(/</g, '&lt;') + '</label>' +
    '<label class="pick"><input type="radio" name="' + c.field +
      '" value="' + c.instead.replace(/"/g, '&quot;') + '"> ' +
      c.instead.replace(/</g, '&lt;') + '</label>';
  return div;
}

document.querySelectorAll('select.lineacct').forEach((sel) => {
  sel.onchange = async () => {
    const card = sel.closest('.billcard');
    const token = card.querySelector('[data-token]');
    if (!token) return;
    const r = await post('/api/bills/fill', {
      token: token.dataset.token, index: Number(token.dataset.index),
      manual: readFill(card), lineAccounts: readLineAccounts(card) });
    if (!r.ok) return;

    const asked = (r.confirmations || []).find((c) => c.field === 'tds_deduction');
    const shown = card.querySelector('.confirm[data-field="tds_deduction"]');
    // Gone: the head no longer attracts TDS, so the question is stale and
    // leaving it would collect an answer to something nobody asked.
    if (!asked && shown && shown.classList.contains('tdsask')) shown.remove();
    if (asked && !shown) {
      const anchor = card.querySelector('.lines') || card.querySelector('.billactions');
      anchor.parentNode.insertBefore(tdsBlock(asked), anchor);
    }
  };
});

document.querySelectorAll('button.setrcm').forEach((btn) => {
  btn.onclick = async () => {
    const box = btn.closest('.partyrcm');
    const out = box.querySelector('.rcmresult');
    const body = { partyId: box.dataset.party, provision: box.dataset.provision };
    box.querySelectorAll('[data-rcm]').forEach((el) => {
      body[el.dataset.rcm] = el.value.trim();
    });
    if (!body.supply) { out.textContent = 'Say what they supply first.'; return; }
    if (!body.effectiveFrom) { out.textContent = 'Say from when it applies.'; return; }
    btn.disabled = true; out.textContent = 'Saving…';
    const r = await post('/api/parties/rcm-rate', body);
    if (!r.ok) { btn.disabled = false; out.textContent = r.error || 'could not save'; return; }

    // Re-read the document with the rate now on file, so the reviewer sees
    // what it produces rather than being told to upload it again.
    const card = btn.closest('.billcard');
    out.textContent = 'Saved. Re-reading the bill…';
    const f = await post('/api/bills/fill', {
      token: box.dataset.token, index: Number(box.dataset.index),
      manual: readFill(card) });
    btn.disabled = false;
    if (!f.ok) { out.textContent = f.error || 'saved, but could not re-read'; return; }
    if (f.ready) {
      out.innerHTML = '<span class="good">Saved — this bill is ready for CA review.</span>';
      const actions = card.querySelector(':scope > .billactions');
      if (canApprove && actions && !actions.querySelector('button.post')) {
        actions.innerHTML =
          '<button class="primary post" data-index="' + box.dataset.index +
          '" data-token="' + box.dataset.token + '">Approve & post</button>';
        wirePost(actions.querySelector('button.post'));
      }
    } else {
      out.innerHTML = '<span class="bad">Saved. Still outstanding: ' +
        (f.blockers || []).map((b) => b.replace(/</g, '&lt;')).join(' ') + '</span>';
    }
  };
});

document.querySelectorAll('button.check').forEach((btn) => {
  btn.onclick = async () => {
    const card = btn.closest('.billcard');
    const out = card.querySelector('.fillresult');
    const manual = readFill(card);
    if (!manual) { out.textContent = 'Nothing filled in yet.'; return; }
    btn.disabled = true; out.textContent = 'Checking…';
    const r = await post('/api/bills/fill', {
      token: btn.dataset.token, index: Number(btn.dataset.index), manual,
      lineAccounts: readLineAccounts(card) });
    btn.disabled = false;
    if (!r.ok) { out.textContent = r.error || 'could not check'; return; }
    if (r.ready) {
      out.innerHTML = '<span class="good">These figures hold together — the bill is ready for review.</span>';
      const actions = card.querySelector(':scope > .billactions');
      if (canApprove && actions && !actions.querySelector('button.post')) {
        actions.innerHTML =
          '<button class="primary post" data-index="' + btn.dataset.index +
          '" data-token="' + btn.dataset.token + '">Approve & post</button>';
        wirePost(actions.querySelector('button.post'));
      }
    } else {
      out.innerHTML = '<span class="bad">' +
        (r.blockers || []).map((b) => b.replace(/</g, '&lt;')).join(' ') + '</span>';
    }
  };
});

function wirePost(btn) {
  btn.onclick = async () => {
    const card = btn.closest('.billcard');
    const confirm = {};
    card.querySelectorAll('.confirm').forEach((c) => {
      const field = c.dataset.field;
      const sel = c.querySelector('input[type=radio]:checked');
      if (sel) confirm[field] = sel.value;
    });
    const lineAccounts = [];
    card.querySelectorAll('.lineacct').forEach((s) => {
      lineAccounts[Number(s.dataset.line)] = s.value;
    });
    const noitc = card.querySelector('.noitc');
    btn.disabled = true; btn.textContent = 'Posting…';
    const r = await post('/api/bills/post', {
      token: btn.dataset.token, index: Number(btn.dataset.index), confirm,
      lineAccounts,
      blockItc: (noitc ? noitc.checked : false) ||
        !!card.querySelector('.expenseonly[data-prepared="1"]'),
      // The same answers the check ran against, so the bill posted is the bill
      // the reviewer was shown.
      manual: readFill(card),
    });
    if (r.ok) {
      card.classList.add('done');
      card.querySelector(':scope > .billactions').innerHTML =
        '<span class="good">Posted — ' + r.voucherId + '</span>';
    } else {
      say(false, r.error || 'could not post'); btn.disabled = false;
      btn.textContent = 'Approve & post';
    }
  };
}

document.querySelectorAll('button.post').forEach(wirePost);
</script>`;
}

// ---------------------------------------------------------------------------
// The dashboard — the client on one screen.
//
// Leads with the number that costs money: credit booked that no supplier has
// filed, unclaimable until they do. Everything else is context around it.

interface DashboardV {
  period: string;
  periods: string[];
  billsPosted: number;
  purchaseValue: string;
  creditClaimed: string;
  creditAtRisk: string | null;
  creditSupported: string | null;
  openReconItems: number;
  totalPayable: string;
  overduePayable: string;
  overdueCount: number;
  recentBills: Array<{ number: string; party: string; date: string; total: string }>;
  registrationIssues: Array<{ party: string; gstin: string; status: string }>;
  hasRecon: boolean;
  displayName?: string;
  clientName?: string;
  role?: string;
  obligations?: ObligationTimelineItem[];
  followUps?: FollowUpItem[];
  founderRequests?: Array<{ id: string; documentId: string; question: string }>;
  activity?: ActivityItem[];
  setup?: { pan: string | null; gstin: string | null; bankAccounts: number; teamMembers: number };
}

export function renderDashboard(a: DashboardV): string {
  const periodLabel = (period: string): string => new Intl.DateTimeFormat('en-IN', {
    month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata',
  }).format(new Date(`${period}-01T00:00:00+05:30`));
  const picker = a.periods.length ? `
    <form method="get" action="/" class="today-period-picker">
      <label><span class="sr-only">Books for</span>
        <select name="period" onchange="this.form.submit()">
          ${a.periods.map((p) =>
            `<option value="${esc(p)}" ${p === a.period ? 'selected' : ''}>${esc(periodLabel(p))}</option>`).join('')}
        </select>
      </label>
    </form>` : '';

  const followUps = a.followUps ?? [];
  const founderRequests = a.founderRequests ?? [];
  const obligations = (a.obligations ?? []).filter((item) =>
    ['observed', 'open', 'blocked', 'needs_human_review', 'prepared',
      'submitted_unverified', 'paid_unverified'].includes(item.workflowState));
  const activity = (a.activity ?? []).slice(0, 4);
  const month = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })
    .format(new Date(`${a.period}-01T00:00:00+05:30`));
  const dateLabel = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
    .format(new Date());
  const localHour = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  const greeting = localHour < 12 ? 'morning' : localHour < 17 ? 'afternoon' : 'evening';
  const displayFirstName = a.displayName?.trim().split(/\s+/)[0] ?? '';
  const greetingName = /^(ca|owner|user|auditor|admin)$/i.test(displayFirstName) ? 'there' : displayFirstName || 'there';
  const amount = (value: string): string => `₹${inr(value)}`;
  const needs: Array<{ source: string; title: string; detail: string; href: string; action: string; primary?: boolean }> = [
    ...(a.creditAtRisk === null
      ? [{ source: 'GST', title: 'Compare supplier filings', detail: 'Run the 2B reconciliation to check which recorded credit is supported.', href: '/gstr2b', action: 'Review' }]
      : a.creditAtRisk !== '0.00'
        ? [{ source: 'GST', title: `${amount(a.creditAtRisk)} credit is not yet supported`, detail: 'Review the unmatched GSTR-2B items before relying on this credit.', href: '/gstr2b', action: 'Review' }] : []),
    ...(a.openReconItems > 0
      ? [{ source: 'GST', title: `${a.openReconItems} GSTR-2B match${a.openReconItems === 1 ? '' : 'es'} need review`, detail: 'Resolve the remaining supplier statement differences.', href: '/gstr2b', action: 'Open GSTR-2B' }] : []),
    ...(a.overdueCount > 0
      ? [{ source: 'BILLS', title: `${a.overdueCount} overdue supplier bill${a.overdueCount === 1 ? '' : 's'}`, detail: `${amount(a.overduePayable)} outstanding is past its recorded due date.`, href: '/payables', action: 'Review payables' }] : []),
    ...(a.registrationIssues.length > 0
      ? [{ source: 'SUPPLIERS', title: `${a.registrationIssues.length} supplier GST registration issue${a.registrationIssues.length === 1 ? '' : 's'}`, detail: 'Check the recorded GST status before relying on input credit.', href: '/suppliers', action: 'View suppliers' }] : []),
    ...followUps.filter((item) => item.status === 'open').slice(0, 3).map((item) => ({
      source: 'REVIEW DESK', title: item.title,
      detail: `${item.priority} priority · ${item.assigneeName ? `with ${item.assigneeName}` : 'unassigned'}${item.dueDate ? ` · due ${item.dueDate}` : ''}`,
      href: `/follow-ups#followup-${encodeURIComponent(item.id)}`, action: 'Open item',
    })),
    ...founderRequests.slice(0, 3).map((item) => ({
      source: 'INBOX', title: 'Your CA asked for information', detail: item.question,
      href: `/documents?document=${encodeURIComponent(item.documentId)}`, action: 'Reply', primary: true,
    })),
  ];
  const reviewCount = needs.length;

  const compactMetric = (label: string, value: string, note: string, href = '', tone = ''): string => {
    const content = `<span class="today-metric-label">${esc(label)}</span><b class="${tone}">${esc(value)}</b><small>${esc(note)}</small>`;
    return href ? `<a class="today-metric" href="${href}">${content}</a>` : `<div class="today-metric">${content}</div>`;
  };
  const statusLabels: Record<string, string> = {
    observed: 'Observed · status not established', open: 'Open · work remains', blocked: 'Blocked',
    needs_human_review: 'Needs human review', prepared: 'Prepared · not filed',
    submitted_unverified: 'Submitted · unverified', paid_unverified: 'Payment reported · unverified',
  };
  const setup = a.setup;
  const setupIncomplete = setup ? [!setup.pan, !setup.gstin, setup.bankAccounts === 0, setup.teamMembers < 2].filter(Boolean).length : null;

  return `<div class="today-home">
    <div class="today-main-column">
      <div class="today-hero">
        <div><div class="today-eyebrow">${esc(dateLabel)} · BOOKS FOR ${picker}</div>
          <h1>Good ${greeting}, ${esc(greetingName)}. <span>${reviewCount} ${reviewCount === 1 ? 'thing needs' : 'things need'} your attention.</span></h1>
        </div><span class="today-viewer">Viewing as <b>${esc(a.role ?? 'User')}</b></span>
      </div>
      <form class="today-ask" id="today-ask-form"><span aria-hidden="true">✦</span><input id="today-ask-input" maxlength="500" autocomplete="off" placeholder="Ask anything about ${esc((a.clientName ?? 'this client') + (a.clientName ? "'s" : '’s'))} money…" aria-label="Ask Nexus about this client"><button type="submit">Ask Nexus</button></form>
      <section class="today-queue" aria-labelledby="today-needs-heading">
        <header><div><h2 id="today-needs-heading">Needs you · ${needs.length}</h2><span>Collected from this client’s records · accounting changes still need your approval</span></div><a href="/attention">All attention →</a></header>
        ${needs.length ? needs.map((item) => `<article class="today-queue-row">
          <span class="today-source">${esc(item.source)}</span><div><b>${esc(item.title)}</b><small>${esc(item.detail)}</small></div>
          <a class="today-queue-action ${item.primary ? 'primary' : ''}" href="${esc(item.href)}">${esc(item.action)}</a>
        </article>`).join('') : '<p class="today-clear">No open items in the checks shown here. New documents and statements still need review in their own queues.</p>'}
      </section>
      <section class="today-metrics" aria-label="Current financial position">
        ${compactMetric('Supplier payables', amount(a.totalPayable), a.overdueCount ? `${a.overdueCount} overdue · ${amount(a.overduePayable)}` : 'Nothing overdue', '/payables')}
        ${compactMetric('Purchases · ' + month, amount(a.purchaseValue), `${a.billsPosted} bill${a.billsPosted === 1 ? '' : 's'} recorded`, '/bills')}
        ${compactMetric(a.creditAtRisk === null ? 'Input credit claimed' : 'Credit not yet supported', amount(a.creditAtRisk ?? a.creditClaimed), a.creditAtRisk === null ? 'No 2B check recorded for this period' : a.hasRecon ? `${amount(a.creditSupported ?? '0.00')} supported by this 2B check` : 'No supplier filing match recorded', '/gstr2b', a.creditAtRisk && a.creditAtRisk !== '0.00' ? 'warn' : '')}
        ${compactMetric('GSTR-2B items', String(a.openReconItems), 'Unresolved matches for this period', '/gstr2b', a.openReconItems ? 'warn' : '')}
      </section>
      <div class="today-lower-grid">
        <section class="today-info-card"><h2>GST credit · ${esc(month)}</h2>
          <div class="today-gst-values"><div><small>Claimed on bills</small><b>${amount(a.creditClaimed)}</b></div>
            <div><small>Supported by 2B</small><b>${a.creditSupported === null ? 'Not checked' : amount(a.creditSupported)}</b></div>
            <div class="${a.creditAtRisk && a.creditAtRisk !== '0.00' ? 'warn' : ''}"><small>Not yet supported</small><b>${a.creditAtRisk === null ? 'Not checked' : amount(a.creditAtRisk)}</b></div></div>
          <a href="/gstr2b">${a.hasRecon ? 'Review supplier matches →' : 'Run GSTR-2B comparison →'}</a>
        </section>
        <section class="today-info-card ${a.registrationIssues.length ? 'today-alert-card' : ''}"><h2>Supplier registration</h2>
          ${a.registrationIssues.length ? `<b>${a.registrationIssues.length} supplier registration issue${a.registrationIssues.length === 1 ? '' : 's'}</b><ul>${a.registrationIssues.slice(0, 3).map((r) => `<li>${esc(r.party)} · ${esc(r.status)}</li>`).join('')}</ul><a href="/suppliers">Review supplier records →</a>` : '<p>No inactive supplier registrations are recorded in the registry check.</p><a href="/suppliers">View suppliers →</a>'}
        </section>
      </div>
      <section class="today-recent"><div class="today-section-heading"><h2>Recently posted</h2><a href="/bills">All bills →</a></div>
        ${a.recentBills.length ? `<div class="today-posted-list">${a.recentBills.slice(0, 5).map((b) => `<a href="/bills" class="today-posted-row"><span class="mono">${esc(b.number)}</span><span>${esc(b.party)}</span><time>${esc(b.date)}</time><b>${amount(b.total)}</b></a>`).join('')}</div>` : '<p class="today-clear">No bills have been posted yet. <a href="/bills">Review a bill</a> when one is ready.</p>'}
      </section>
    </div>
    <aside class="today-rail" aria-label="Client work summary">
      <section class="today-rail-card"><div class="today-health"><span class="today-health-mark">${reviewCount ? '!' : '✓'}</span><div><small>RECORDED CHECKS</small><b>${reviewCount ? 'Review items are open' : 'No review items found'}</b></div></div>
        <div class="today-health-items"><small>Based on the checks shown</small>
          <a href="/gstr2b">${a.openReconItems} GSTR-2B item${a.openReconItems === 1 ? '' : 's'} open</a>
          <a href="/payables">${a.overdueCount} overdue supplier bill${a.overdueCount === 1 ? '' : 's'}</a>
          <a href="/suppliers">${a.registrationIssues.length} supplier status issue${a.registrationIssues.length === 1 ? '' : 's'}</a>
        </div><a href="/nexus">Ask Nexus about the open items →</a></section>
      <section class="today-rail-section"><h2>Recorded compliance work</h2>
        ${obligations.length ? obligations.slice(0, 4).map((item) => `<a class="today-rail-row" href="/attention#attention-obligation-${encodeURIComponent(item.id)}"><b>${esc(item.kind)} · ${esc(item.periodKey)}</b><small>${esc(statusLabels[item.workflowState] ?? item.workflowState)} · deadline not recorded here</small></a>`).join('') : '<p>No compliance timeline items have been recorded for this client.</p>'}
        <a href="/attention">Open attention →</a></section>
      <section class="today-rail-section"><h2>With your CA · ${followUps.filter((item) => item.status === 'open' && item.assigneeName).length}</h2>
        ${followUps.filter((item) => item.status === 'open' && item.assigneeName).slice(0, 3).map((item) => `<a class="today-rail-row" href="/follow-ups#followup-${encodeURIComponent(item.id)}"><b>${esc(item.title)}</b><small>${esc(item.assigneeName!)}${item.dueDate ? ` · due ${esc(item.dueDate)}` : ''}</small></a>`).join('') || '<p>No open follow-ups assigned to a CA.</p>'}
        <a href="/follow-ups">Open review desk →</a></section>
      <section class="today-rail-section"><h2>Setup</h2>
        ${setup ? `<p>${setupIncomplete === 0 ? 'Core client details are recorded.' : `${setupIncomplete} setup detail${setupIncomplete === 1 ? '' : 's'} may still need attention.`}</p><small>${setup.pan ? 'PAN recorded' : 'PAN not recorded'} · ${setup.gstin ? 'GST registration recorded' : 'GST registration not recorded'} · ${setup.bankAccounts} bank account${setup.bankAccounts === 1 ? '' : 's'}</small>` : '<p>Setup status is unavailable.</p>'}
        <a href="/setup">Review setup →</a></section>
      ${['CA partner', 'CA staff', 'Auditor'].includes(a.role ?? '') ? `<section class="today-rail-section"><h2>Firm workspace</h2>
        <a href="/firm">Firm cockpit →</a>${a.role !== 'Auditor' ? '<a href="/email-inbox">Firm email →</a>' : ''}<a href="/tally">Tally import →</a></section>` : ''}
      <section class="today-rail-section"><div class="today-section-heading"><h2>Recent activity</h2><a href="/activity">All →</a></div>
        ${activity.length ? activity.map((item) => `<a class="today-activity-row" href="${esc(item.href)}"><b>${esc(item.title)}</b><small>${esc(item.detail.slice(0, 100))}${item.detail.length > 100 ? '…' : ''}</small><time>${esc(new Date(item.occurredAt).toLocaleDateString('en-IN'))}</time></a>`).join('') : '<p>No client activity recorded yet.</p>'}
      </section>
    </aside>
  </div>`;
}

export function renderProfitAndLoss(a: {
  from: string; to: string;
  report: { revenue: string; cogs: string; grossProfit: string; operatingExpenses: string;
    operatingProfit: string; nonOperating: string; netProfit: string };
}): string {
  const rows: Array<[string, string, boolean]> = [
    ['Sales and other income', a.report.revenue, false],
    ['Cost of goods sold', a.report.cogs, false],
    ['Gross profit', a.report.grossProfit, true],
    ['Operating expenses', a.report.operatingExpenses, false],
    ['Operating profit', a.report.operatingProfit, true],
    ['Non-operating expenses', a.report.nonOperating, false],
    ['Net profit', a.report.netProfit, true],
  ];
  return `${pageIntro('REPORTS', 'Profit & loss', 'Income and expenses recorded in the ledger for this date range. Opening balances are excluded.')}
    <form class="report-range" method="get" action="/reports/profit-loss">
      <label>From <input type="date" name="from" value="${esc(a.from)}" required></label>
      <label>To <input type="date" name="to" value="${esc(a.to)}" required></label>
      <button class="primary" type="submit">Show report</button>
    </form>
    <section class="panel report-summary"><div><span>Revenue</span><b>${inr(a.report.revenue)}</b></div>
      <div><span>Gross profit</span><b>${inr(a.report.grossProfit)}</b></div>
      <div><span>Operating profit</span><b>${inr(a.report.operatingProfit)}</b></div>
      <div><span>Net profit</span><b>${inr(a.report.netProfit)}</b></div></section>
    <section class="panel report-ledger"><h2>How the result is worked out</h2>
      <p class="sub">${esc(a.from)} to ${esc(a.to)} · statutory books</p>
      <table><thead><tr><th>Accounting heading</th><th class="num">Amount</th></tr></thead><tbody>
        ${rows.map(([label, amount, total]) => `<tr class="${total ? 'report-total' : ''}"><td>${label}</td><td class="num">${inr(amount)}</td></tr>`).join('')}
      </tbody></table>
      <p class="why">Figures are computed from posted ledger entries. Selecting a total does not change the books.</p>
    </section>`;
}

export function renderBalanceSheet(a: {
  asOf: string;
  report: { currentAssets: string; nonCurrentAssets: string; totalAssets: string;
    currentLiabilities: string; nonCurrentLiabilities: string; totalLiabilities: string;
    equity: string; retainedProfit: string; totalEquity: string;
    totalLiabilitiesAndEquity: string; workingCapital: string; balanced: boolean };
  trialBalance: { rows: Array<{ code: string | null; name: string; debit: string; credit: string }>;
    totalDebit: string; totalCredit: string; balanced: boolean };
}): string {
  const left: Array<[string, string]> = [
    ['Current assets', a.report.currentAssets], ['Non-current assets', a.report.nonCurrentAssets],
    ['Total assets', a.report.totalAssets],
  ];
  const right: Array<[string, string]> = [
    ['Current liabilities', a.report.currentLiabilities], ['Non-current liabilities', a.report.nonCurrentLiabilities],
    ['Total liabilities', a.report.totalLiabilities], ['Paid-in equity', a.report.equity],
    ['Retained profit', a.report.retainedProfit], ['Total equity', a.report.totalEquity],
    ['Liabilities and equity', a.report.totalLiabilitiesAndEquity],
  ];
  const list = (rows: Array<[string, string]>): string => `<table><tbody>${rows.map(([label, amount]) =>
    `<tr class="${label.startsWith('Total') || label === 'Liabilities and equity' ? 'report-total' : ''}"><td>${label}</td><td class="num">${inr(amount)}</td></tr>`).join('')}</tbody></table>`;
  return `${pageIntro('REPORTS', 'Balance sheet', 'What the company owns and owes as at a recorded date.')}
    <form class="report-range" method="get" action="/reports/balance-sheet">
      <label>As of <input type="date" name="asOf" value="${esc(a.asOf)}" required></label>
      <button class="primary" type="submit">Show report</button>
    </form>
    <div class="tiles"><div class="tile"><b>${inr(a.report.workingCapital)}</b><span>Working capital</span></div>
      <div class="tile"><b>${inr(a.report.totalAssets)}</b><span>What the company owns</span></div>
      <div class="tile"><b>${inr(a.report.totalLiabilitiesAndEquity)}</b><span>What it owes plus owners' share</span></div>
      <div class="tile"><b class="${a.report.balanced && a.trialBalance.balanced ? 'good' : 'bad'}">${a.report.balanced && a.trialBalance.balanced ? 'Agrees' : 'Check needed'}</b><span>Balance and trial balance checks</span></div></div>
    <div class="balance-columns"><section class="panel"><h2>What the company owns</h2>${list(left)}</section>
      <section class="panel"><h2>What it owes and owners' share</h2>${list(right)}</section></div>
    <details class="panel"><summary>Trial balance · ${a.trialBalance.rows.length} accounts</summary>
      <table><thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>
      ${a.trialBalance.rows.map((row) => `<tr><td>${row.code ? `<span class="mono">${esc(row.code)}</span> · ` : ''}${esc(row.name)}</td><td class="num">${inr(row.debit)}</td><td class="num">${inr(row.credit)}</td></tr>`).join('')}
      <tr class="report-total"><th>Total</th><th class="num">${inr(a.trialBalance.totalDebit)}</th><th class="num">${inr(a.trialBalance.totalCredit)}</th></tr></tbody></table>
    </details>`;
}

export interface PeriodCloseView {
  periods: Array<{ label: string; startDate: string; endDate: string; isClosed: boolean; closedAt: string | null }>;
  selected: string | null;
  check: { ok: boolean; blockers: string[] } | null;
  canClose: boolean;
  error?: string;
}

export function renderPeriodClose(a: PeriodCloseView): string {
  const selected = a.periods.find((period) => period.label === a.selected) ?? null;
  return `${pageIntro('REPORTS', 'Close month', 'Check what is ready before closing a period. Closing is recorded and blocks later postings into that period.')}
    ${a.error ? `<div class="msg bad" role="alert">${esc(a.error)}</div>` : ''}
    ${a.periods.length ? `<form class="report-range" method="get" action="/reports/close-month"><label>Accounting period
      <select name="period">${a.periods.map((period) => `<option value="${esc(period.label)}" ${period.label === a.selected ? 'selected' : ''}>${esc(period.label)}${period.isClosed ? ' · closed' : ''}</option>`).join('')}</select></label><button type="submit">Review period</button></form>`
      : '<section class="panel"><p class="empty">No accounting periods are configured for this client yet.</p></section>'}
    ${selected ? `<section class="panel period-close-card"><div class="period-close-head"><div><h2>${esc(selected.label)}</h2><p class="sub">${esc(selected.startDate)} to ${esc(selected.endDate)}</p></div>
      <span class="tag ${selected.isClosed ? 'good' : ''}">${selected.isClosed ? 'Closed' : 'Open'}</span></div>
      ${selected.isClosed ? `<p class="good">Closed at ${esc(selected.closedAt ?? 'recorded date unavailable')}.</p>` : a.check?.ok
        ? '<p class="good">All required checks pass. This period is ready to close.</p>'
        : `<div class="msg bad"><b>${a.check?.blockers.length ?? 0} blocker(s) need review.</b><ul>${(a.check?.blockers ?? []).map((blocker) => `<li>${esc(blocker)}</li>`).join('')}</ul></div>`}
      ${!selected.isClosed && a.canClose ? `<form id="period-close-form" class="period-close-form" method="post" action="/reports/close-month">
        <input type="hidden" name="label" value="${esc(selected.label)}">
        ${!a.check?.ok ? '<label>Reason to close with blockers<textarea name="reason" maxlength="1000" required placeholder="Explain why this period must close despite the listed blockers."></textarea></label>' : ''}
        <button class="primary" type="submit">${a.check?.ok ? 'Close period' : 'Close with recorded reason'}</button></form>`
        : !selected.isClosed ? '<p class="why">A CA partner must complete the close. Ask your CA to review this period.</p>' : ''}
      </section>` : ''}
    <section class="panel"><h2>Period history</h2>${a.periods.length ? `<table><thead><tr><th>Period</th><th>Dates</th><th>Status</th></tr></thead><tbody>${a.periods.map((period) => `<tr><td><a href="/reports/close-month?period=${encodeURIComponent(period.label)}">${esc(period.label)}</a></td><td>${esc(period.startDate)} – ${esc(period.endDate)}</td><td>${period.isClosed ? 'Closed' : 'Open'}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No period history.</p>'}</section>
    `;
}

// ---------------------------------------------------------------------------
// Payables — who is owed, how overdue, and paying them down.
//
// Ageing across the top, oldest-due bills first below. A payment reveals a
// small inline form on the row: how much, from which account, when. Nothing
// leaves the ledger's own arithmetic — the payment is a posted voucher.

interface OutstandingBillV {
  voucherId: string; billNumber: string; supplierName: string;
  billDate: string; dueDate: string; grandTotal: string; outstanding: string;
  daysOverdue: number; bucket: string;
}

const BUCKET_LABEL: Record<string, string> = {
  not_due: 'Not due', d0_30: '1–30 days', d31_60: '31–60 days',
  d61_90: '61–90 days', d90_plus: '90+ days',
};

export function renderPayables(a: {
  bills: OutstandingBillV[];
  accounts: Array<{ id: string; name: string }>;
  today: string;
  draftVoucherId?: string;
}): string {
  // Ageing totals per bucket.
  const buckets: Record<string, bigint> = {
    not_due: 0n, d0_30: 0n, d31_60: 0n, d61_90: 0n, d90_plus: 0n };
  let total = 0n;
  for (const b of a.bills) {
    const p = BigInt(Math.round(Number(b.outstanding) * 100));
    buckets[b.bucket] = (buckets[b.bucket] ?? 0n) + p;
    total += p;
  }
  const rupees = (p: bigint) => inr((p / 100n).toString() + '.' + String(p % 100n).padStart(2, '0'));

  const strip = `<div class="panel strip">
    ${(['not_due', 'd0_30', 'd31_60', 'd61_90', 'd90_plus'] as const).map((k) =>
      `<div class="stat"><b class="${k === 'd90_plus' && buckets[k] ? 'bad' : k === 'd61_90' && buckets[k] ? 'warn' : ''}">${
        rupees(buckets[k] ?? 0n)}</b><span>${BUCKET_LABEL[k]}</span></div>`).join('')}
    <div class="stat"><b>${rupees(total)}</b><span>total payable</span></div>
  </div>`;

  const acctOptions = a.accounts.map((ac) =>
    `<option value="${esc(ac.id)}">${esc(ac.name)}</option>`).join('');

  const rows = a.bills.map((b) => {
    const isDraft = b.voucherId === a.draftVoucherId;
    return `
    <tr class="prow" data-v="${esc(b.voucherId)}">
      <td>${esc(b.supplierName)}</td>
      <td class="mono">${esc(b.billNumber)}</td>
      <td>${esc(b.dueDate)}</td>
      <td class="num ${b.daysOverdue > 60 ? 'bad' : b.daysOverdue > 0 ? 'warn' : 'muted'}">${
        b.daysOverdue > 0 ? b.daysOverdue + 'd overdue' : 'not due'}</td>
      <td class="num"><b>${inr(b.outstanding)}</b></td>
      <td><button class="pay" data-v="${esc(b.voucherId)}" data-out="${esc(b.outstanding)}">Pay</button>
        <a class="btnlink" href="/returns?bill=${esc(b.voucherId)}">Return</a></td>
    </tr>
    <tr class="payform" id="pf_${esc(b.voucherId)}" ${isDraft ? '' : 'hidden'}>
      <td colspan="6">
        <div class="payrow">
          ${isDraft ? '<strong>AI-prepared draft — check every field before approval.</strong>' : ''}
          <label>Amount <input type="text" class="p-amt" value="${esc(b.outstanding)}"></label>
          <label>From <select class="p-acct">${acctOptions}</select></label>
          <label>Date <input type="date" class="p-date" value="${esc(a.today)}"></label>
          <label>Ref <input type="text" class="p-ref" placeholder="UTR / cheque no"></label>
          <button class="primary p-go" data-v="${esc(b.voucherId)}">${isDraft ? 'Approve and record payment' : 'Record payment'}</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `${pageIntro('PURCHASES', 'Payables', 'What the client owes, oldest first. A payment posts to the ledger and clears the bill only after a human records it.')}

${strip}
${a.draftVoucherId ? '<div class="msg warn">This is an AI-prepared draft. It has not posted anything. Check the amount, payment account and date before approving.</div>' : ''}
<div id="msg"></div>

${a.bills.length === 0
  ? '<p class="empty">Nothing outstanding. Every bill is paid.</p>'
  : `<div class="panel" style="padding:0"><table>
      <tr><th>Supplier</th><th>Invoice</th><th>Due</th><th class="num">Age</th>
          <th class="num">Outstanding</th><th></th></tr>
      ${rows}
    </table></div>`}

<script>
const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());
const say = (ok, t) => { document.getElementById('msg').innerHTML =
  '<div class="msg ' + (ok ? 'good' : 'bad') + '">' + t + '</div>'; };

document.querySelectorAll('button.pay').forEach((b) => {
  b.onclick = () => {
    const f = document.getElementById('pf_' + b.dataset.v);
    f.hidden = !f.hidden;
  };
});

document.querySelectorAll('button.p-go').forEach((btn) => {
  btn.onclick = async () => {
    const form = btn.closest('.payrow');
    btn.disabled = true; btn.textContent = 'Posting…';
    const r = await post('/api/payables/pay', {
      billVoucherId: btn.dataset.v,
      amount: form.querySelector('.p-amt').value.trim(),
      paidFromAccountId: form.querySelector('.p-acct').value,
      paymentDate: form.querySelector('.p-date').value,
      reference: form.querySelector('.p-ref').value.trim() || undefined,
    });
    if (r.ok) {
      say(true, 'Paid ' + r.paid + (r.fullySettled ? ' — bill settled.'
        : ' — ' + r.outstandingAfter + ' still outstanding.'));
      setTimeout(() => location.reload(), 900);
    } else {
      say(false, r.error || 'could not record the payment');
      btn.disabled = false; btn.textContent = 'Record payment';
    }
  };
});
</script>`;
}

// ---------------------------------------------------------------------------
// Suppliers — the list, and the 360 view of one.

interface SupplierListRowV {
  id: string; name: string; gstin: string | null;
  status: string | null; outstanding: string;
}

export function renderSupplierList(a: { suppliers: SupplierListRowV[] }): string {
  const rows = a.suppliers.map((s) => `
    <tr>
      <td><a href="/suppliers/${esc(s.id)}">${esc(s.name)}</a></td>
      <td class="mono">${esc(s.gstin ?? '—')}</td>
      <td>${s.status
        ? `<span class="tag ${/active/i.test(s.status) ? 'good' : 'bad'}">${esc(s.status)}</span>`
        : '<span class="muted">unchecked</span>'}</td>
      <td class="num">${s.outstanding === '0.00' ? '<span class="muted">—</span>' : inr(s.outstanding)}</td>
    </tr>`).join('');
  return `${pageIntro('PURCHASES', 'Suppliers', 'Everyone the client buys from. Open one for its full history.')}
${a.suppliers.length === 0
  ? '<p class="empty">No suppliers yet.</p>'
  : `<div class="panel" style="padding:0"><table>
      <tr><th>Supplier</th><th>GSTIN</th><th>Registration</th><th class="num">Outstanding</th></tr>
      ${rows}</table></div>`}`;
}

interface SupplierDetailV {
  id: string; name: string; legalName: string | null; gstin: string | null;
  stateCode: string | null; gstCategory: string;
  registration: {
    status: string; taxpayerType: string | null;
    registeredOn: string | null; cancelledOn: string | null;
    einvoiceRequired: boolean | null;
  } | null;
  totalBilled: string; totalPaid: string; totalOutstanding: string;
  bills: Array<{ voucherId: string; billNumber: string; billDate: string;
    grandTotal: string; outstanding: string; settled: boolean }>;
  payments: Array<{ voucherNumber: string; date: string; amount: string;
    billNumber: string | null }>;
  learned: Array<{ lineKey: string; accountName: string; timesSeen: number }>;
}

export function renderSupplier(s: SupplierDetailV): string {
  const reg = s.registration;
  const regLine = reg === null
    ? '<span class="muted">registration not checked</span>'
    : `<span class="tag ${/active/i.test(reg.status) ? 'good' : 'bad'}">${esc(reg.status)}</span>
       ${reg.taxpayerType ? esc(reg.taxpayerType) : ''}
       ${reg.registeredOn ? ` · registered ${esc(reg.registeredOn)}` : ''}
       ${reg.cancelledOn ? ` · <span class="bad">cancelled ${esc(reg.cancelledOn)}</span>` : ''}
       ${reg.einvoiceRequired ? ' · e-invoicing required' : ''}`;

  const billRows = s.bills.map((b) => `
    <tr>
      <td class="mono">${esc(b.billNumber)}</td>
      <td>${esc(b.billDate)}</td>
      <td class="num">${inr(b.grandTotal)}</td>
      <td class="num">${b.settled
        ? '<span class="tag good">settled</span>'
        : '<b>' + inr(b.outstanding) + '</b>'}</td>
    </tr>`).join('');

  const payRows = s.payments.length === 0 ? '' : `
    <h2 class="mt">Payments</h2>
    <div class="panel" style="padding:0"><table>
      <tr><th>Voucher</th><th>Date</th><th>Against</th><th class="num">Amount</th></tr>
      ${s.payments.map((p) => `<tr>
        <td class="mono">${esc(p.voucherNumber)}</td><td>${esc(p.date)}</td>
        <td class="mono">${esc(p.billNumber ?? '—')}</td>
        <td class="num">${inr(p.amount)}</td></tr>`).join('')}
    </table></div>`;

  const learnedBlock = s.learned.length === 0 ? '' : `
    <h2 class="mt">What the books have learned</h2>
    <p class="sub">Where this supplier's lines are posted by default — taught by
    past bills, offered on the next.</p>
    <div class="panel" style="padding:0"><table>
      <tr><th>Line</th><th>Posts to</th><th class="num">Times</th></tr>
      ${s.learned.map((l) => `<tr>
        <td class="mono">${esc(l.lineKey)}</td><td>${esc(l.accountName)}</td>
        <td class="num muted">${l.timesSeen}</td></tr>`).join('')}
    </table></div>`;

  return `<p class="sub"><a href="/suppliers">← Suppliers</a></p>
${pageIntro('PURCHASES', s.name, `${s.legalName && s.legalName !== s.name ? s.legalName + ' · ' : ''}${s.gstin ?? 'no GSTIN'}${s.stateCode ? ' · state ' + s.stateCode : ''} · ${s.gstCategory}`)}
<p>${regLine}</p>

<div class="tiles">
  <div class="tile"><b>${inr(s.totalBilled)}</b><span>billed</span></div>
  <div class="tile"><b class="good">${inr(s.totalPaid)}</b><span>paid</span></div>
  <a class="tile" href="/payables"><b class="${s.totalOutstanding === '0.00' ? '' : 'bad'}">${inr(s.totalOutstanding)}</b><span>outstanding</span></a>
</div>

<h2 class="mt">Bills</h2>
${s.bills.length === 0
  ? '<p class="empty">No bills from this supplier yet.</p>'
  : `<div class="panel" style="padding:0"><table>
      <tr><th>Invoice</th><th>Date</th><th class="num">Total</th><th class="num">Outstanding</th></tr>
      ${billRows}</table></div>`}

${payRows}
${learnedBlock}`;
}

// ---------------------------------------------------------------------------
// GSTR-1 — the outward-supplies return, as a summary the CA reviews before it
// is filed. Leads with the liability, then each section that carries anything.

interface Gstr1V {
  period: string;
  b2b: Array<{ ctin: string; name: string; invoices: Array<{ invoiceNumber: string;
    invoiceDate: string; grandTotal: string; taxable: string }> }>;
  b2cl: Array<{ invoiceNumber: string; placeOfSupply: string; grandTotal: string }>;
  b2cs: Array<{ pos: string; rate: string; taxable: string; igst: string;
    cgst: string; sgst: string; cess: string }>;
  exp: Array<{ invoiceNumber: string; grandTotal: string }>;
  cdnr: Array<{ invoiceNumber: string; customerName: string; grandTotal: string }>;
  hsn: Array<{ hsn: string; description: string; quantity: string; rate: string;
    taxable: string; igst: string; cgst: string; sgst: string; cess: string }>;
  summary: { documents: number; taxable: string; igst: string; cgst: string;
    sgst: string; cess: string; totalTax: string };
  periods: string[];
}

export function renderGstr1(a: Gstr1V): string {
  const picker = `
    <form method="get" action="/gstr1" class="row">
      <label>Return period
        <select name="period" onchange="this.form.submit()">
          ${(a.periods.length ? a.periods : [a.period]).map((p) =>
            `<option value="${esc(p)}" ${p === a.period ? 'selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
      </label>
    </form>`;

  const empty = a.summary.documents === 0;

  const b2bBlock = a.b2b.length === 0 ? '' : `
    <h2 class="mt">B2B — registered customers (${a.b2b.length})</h2>
    <div class="panel" style="padding:0"><table>
      <tr><th>Customer</th><th>GSTIN</th><th class="num">Invoices</th><th class="num">Taxable</th></tr>
      ${a.b2b.map((cst) => {
        const tx = cst.invoices.reduce((s, i) => s + Number(i.taxable), 0).toFixed(2);
        return `<tr><td>${esc(cst.name)}</td><td class="mono">${esc(cst.ctin)}</td>
          <td class="num">${cst.invoices.length}</td><td class="num">${inr(tx)}</td></tr>`;
      }).join('')}
    </table></div>`;

  const b2csBlock = a.b2cs.length === 0 ? '' : `
    <h2 class="mt">B2CS — consumer sales, summarised</h2>
    <div class="panel" style="padding:0"><table>
      <tr><th>Place of supply</th><th class="num">Rate</th><th class="num">Taxable</th>
          <th class="num">IGST</th><th class="num">CGST</th><th class="num">SGST</th></tr>
      ${a.b2cs.map((r) => `<tr><td>${esc(r.pos)}</td><td class="num">${esc(r.rate)}%</td>
        <td class="num">${inr(r.taxable)}</td><td class="num">${inr(r.igst)}</td>
        <td class="num">${inr(r.cgst)}</td><td class="num">${inr(r.sgst)}</td></tr>`).join('')}
    </table></div>`;

  const section = (title: string, rows: string, cols: string) => rows === '' ? '' : `
    <h2 class="mt">${title}</h2>
    <div class="panel" style="padding:0"><table>${cols}${rows}</table></div>`;

  const b2cl = section('B2CL — large inter-state consumer sales',
    a.b2cl.map((r) => `<tr><td class="mono">${esc(r.invoiceNumber)}</td>
      <td>${esc(r.placeOfSupply)}</td><td class="num">${inr(r.grandTotal)}</td></tr>`).join(''),
    '<tr><th>Invoice</th><th>POS</th><th class="num">Value</th></tr>');

  const exp = section('Exports',
    a.exp.map((r) => `<tr><td class="mono">${esc(r.invoiceNumber)}</td>
      <td class="num">${inr(r.grandTotal)}</td></tr>`).join(''),
    '<tr><th>Invoice</th><th class="num">Value</th></tr>');

  const cdnr = section('Credit / debit notes',
    a.cdnr.map((r) => `<tr><td class="mono">${esc(r.invoiceNumber)}</td>
      <td>${esc(r.customerName)}</td><td class="num">${inr(r.grandTotal)}</td></tr>`).join(''),
    '<tr><th>Note</th><th>Customer</th><th class="num">Value</th></tr>');

  const hsn = section('HSN summary',
    a.hsn.map((r) => `<tr><td class="mono">${esc(r.hsn)}</td><td>${esc(r.description)}</td>
      <td class="num">${esc(r.quantity)}</td><td class="num">${esc(r.rate)}%</td>
      <td class="num">${inr(r.taxable)}</td></tr>`).join(''),
    '<tr><th>HSN</th><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Taxable</th></tr>');

  return `${pageIntro('GST & TDS', 'GSTR-1', 'Outward supplies for the selected period, grouped into the return sections for review. The tax total below is the declared liability.')}

${picker}

${empty ? '<p class="empty">No sales invoices in this period.</p>' : `
<div class="panel strip">
  <div class="stat"><b>${a.summary.documents}</b><span>documents</span></div>
  <div class="stat"><b>${inr(a.summary.taxable)}</b><span>taxable value</span></div>
  <div class="stat"><b>${inr(a.summary.igst)}</b><span>IGST</span></div>
  <div class="stat"><b>${inr(a.summary.cgst)}</b><span>CGST</span></div>
  <div class="stat"><b>${inr(a.summary.sgst)}</b><span>SGST</span></div>
  <div class="stat"><b class="bad">${inr(a.summary.totalTax)}</b><span>tax declared</span></div>
</div>

${b2bBlock}${b2csBlock}${b2cl}${exp}${cdnr}${hsn}
`}`;
}

// ---------------------------------------------------------------------------
// GSTR-3B — the net return. Leads with the cash to pay, then shows the working:
// output owed, credit available, and the set-off between them.

interface Gstr3bV {
  period: string;
  outwardTaxable: string; rcmTaxable: string;
  output: { igst: string; cgst: string; sgst: string; cess: string };
  itc: { igst: string; cgst: string; sgst: string; cess: string };
  setOff: {
    cash: { igst: string; cgst: string; sgst: string; cess: string };
    carryForward: { igst: string; cgst: string; sgst: string; cess: string };
  };
  netCash: string; carryForward: string;
  periods: string[];
}

export function renderGstr3b(a: Gstr3bV): string {
  const picker = `
    <form method="get" action="/gstr3b" class="row">
      <label>Return period
        <select name="period" onchange="this.form.submit()">
          ${(a.periods.length ? a.periods : [a.period]).map((p) =>
            `<option value="${esc(p)}" ${p === a.period ? 'selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
      </label>
    </form>`;

  const heads = (h: { igst: string; cgst: string; sgst: string; cess: string }) =>
    `<td class="num">${inr(h.igst)}</td><td class="num">${inr(h.cgst)}</td>
     <td class="num">${inr(h.sgst)}</td><td class="num">${inr(h.cess)}</td>`;

  return `${pageIntro('GST & TDS', 'GSTR-3B', 'Review output tax, eligible input credit, set-off, and the resulting cash position for the selected period.')}

${picker}

<div class="tiles">
  <a class="tile" href="/gstr1"><b>${inr(a.outwardTaxable)}</b><span>outward supplies (3.1a)</span></a>
  <a class="tile" href="/gstr2b"><b>${inr(a.rcmTaxable)}</b><span>reverse-charge inward (3.1d)</span></a>
  <div class="tile"><b class="bad">${inr(a.netCash)}</b><span>net cash payable</span></div>
  <div class="tile"><b class="${a.carryForward === '0.00' ? '' : 'good'}">${inr(a.carryForward)}</b><span>credit carried forward</span></div>
</div>

<h2 class="mt">The working</h2>
<div class="panel" style="padding:0"><table>
  <tr><th></th><th class="num">IGST</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">Cess</th></tr>
  <tr><td>Output tax owed</td>${heads(a.output)}</tr>
  <tr><td>Input credit available</td>${heads(a.itc)}</tr>
  <tr><td><b>Cash payable</b></td>${heads(a.setOff.cash)}</tr>
  <tr><td class="muted">Credit carried forward</td>${heads(a.setOff.carryForward)}</tr>
</table></div>

<p class="sub">This is the return, not the filing — the figure owed is settled in
cash; lodging it with the portal is a separate step.</p>`;
}

// ---------------------------------------------------------------------------
// Fixed assets — the register, and both depreciation figures side by side.
//
// The page exists to make one thing unmissable: the book charge and the tax
// charge are different numbers, and the gap between them is the add-back in
// the income computation. A screen showing one of them labelled
// "depreciation" would be telling a CA something false.

interface AssetsV {
  asOf: string;
  fiscalYear: number;
  register: {
    rows: Array<{ id: string; description: string; identifier: string | null;
                  className: string; cost: string; putToUseOn: string;
                  accumulated: string; carrying: string; residualValue: string;
                  disposedOn: string | null; disposalProceeds: string | null }>;
    totalCost: string; totalCarrying: string;
  };
  book: { fromDate: string; toDate: string; total: string;
          lines: Array<{ description: string; className: string; method: string;
                         openingWdv: string; charge: string; closingWdv: string;
                         days: number; note: string | null }>;
          warnings: string[] };
  /** Null when this year has already been charged. */
  alreadyRun: boolean;
  tax: { fiscalYear: string; total: string;
         blocks: Array<{ block: string; rate: string; openingWdv: string;
                         additionsFullRate: string; additionsHalfRate: string;
                         deductions: string; depreciation: string;
                         closingWdv: string; note: string | null }>;
         warnings: string[] };
}

export function renderAssets(a: AssetsV): string {
  const gap = (Number(a.tax.total) - Number(a.book.total)).toFixed(2);

  const register = a.register.rows.length === 0
    ? `<p class="sub">Nothing on the register yet. A bill line above the
       capitalisation threshold on a goods or asset head asks whether it is a
       cost or an asset (BE-11), and answering "asset" puts it here.</p>`
    : `<div class="panel" style="padding:0"><table>
        <tr><th>Asset</th><th>Class</th><th>In use from</th>
            <th class="num">Cost</th><th class="num">Depreciated</th>
            <th class="num">Carrying</th></tr>
        ${a.register.rows.map((r) => `<tr class="${r.disposedOn ? 'gone' : ''}">
          <td>${esc(r.description)}${r.identifier
            ? `<div class="muted small">${esc(r.identifier)}</div>` : ''}</td>
          <td class="muted small">${esc(r.className)}</td>
          <td>${esc(r.putToUseOn)}${r.disposedOn
            ? `<div class="muted small">gone ${esc(r.disposedOn)}${
                r.disposalProceeds ? ` for ${inr(r.disposalProceeds)}` : ''}</div>`
            : ''}</td>
          <td class="num">${inr(r.cost)}</td>
          <td class="num">${r.accumulated === '0.00'
            ? '<span class="muted">—</span>' : inr(r.accumulated)}</td>
          <td class="num">${r.disposedOn
            ? '<span class="muted">—</span>' : `<b>${inr(r.carrying)}</b>`}</td>
        </tr>`).join('')}
        <tr><td colspan="3"><b>Total</b></td>
            <td class="num"><b>${inr(a.register.totalCost)}</b></td><td></td>
            <td class="num"><b>${inr(a.register.totalCarrying)}</b></td></tr>
      </table></div>`;

  return `${pageIntro('REPORTS', 'Fixed assets', 'What the client owns, what it has depreciated, and what it is carried at. Accumulated depreciation stays separate from original cost.')}

<div class="tiles">
  <div class="tile"><b>${inr(a.register.totalCarrying)}</b><span>carrying amount</span></div>
  <div class="tile"><b>${inr(a.book.total)}</b><span>book charge, ${esc(a.book.fromDate.slice(0,4))}-${esc(String((Number(a.book.fromDate.slice(0,4))+1)%100).padStart(2,'0'))}</span></div>
  <div class="tile"><b>${inr(a.tax.total)}</b><span>tax charge, same year</span></div>
  <div class="tile"><b class="${gap === '0.00' ? '' : 'warn'}">${inr(gap)}</b>
    <span>difference to add back</span></div>
</div>

<h2 class="mt">The register</h2>
${register}

<h2 class="mt">Book depreciation — Companies Act, Schedule II</h2>
<p class="sub">What POSTS. Pro-rated by days from the date each asset became
available for use, and capped so nothing falls below its residual value.</p>
${a.book.lines.length === 0
  ? `<p class="sub">${a.alreadyRun
      ? 'Already charged for this year.'
      : 'Nothing to charge — no asset in use, or everything is written down.'}</p>`
  : `<div class="panel" style="padding:0"><table>
      <tr><th>Asset</th><th>Method</th><th class="num">Opening</th>
          <th class="num">Charge</th><th class="num">Closing</th><th>Days</th></tr>
      ${a.book.lines.map((l) => `<tr>
        <td>${esc(l.description)}<div class="muted small">${esc(l.className)}${
          l.note ? ` · ${esc(l.note)}` : ''}</div></td>
        <td class="muted small">${l.method === 'slm' ? 'straight line' : 'written down'}</td>
        <td class="num">${inr(l.openingWdv)}</td>
        <td class="num"><b>${inr(l.charge)}</b></td>
        <td class="num">${inr(l.closingWdv)}</td>
        <td class="num muted">${l.days}</td></tr>`).join('')}
      <tr><td colspan="3"><b>Total</b></td>
          <td class="num"><b>${inr(a.book.total)}</b></td><td colspan="2"></td></tr>
    </table></div>
    <div class="billactions">
      <button class="primary" id="runDep"
        data-from="${esc(a.book.fromDate)}" data-to="${esc(a.book.toDate)}"
        ${a.alreadyRun ? 'disabled' : ''}>
        ${a.alreadyRun ? 'Already charged for this year' : 'Post this charge'}</button>
      <span id="depResult" class="muted"></span>
    </div>`}
${a.book.warnings.length === 0 ? '' :
  `<ul class="warns">${a.book.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`}

<h2 class="mt">Tax depreciation — Income Tax Act, block of assets</h2>
<p class="sub">A computation and not an entry. Nothing here posts: the unit is
the BLOCK rather than the asset, the method is always written-down value at the
Appendix I rate, and an asset put to use for under 180 days in its first year
gets half of it.</p>
${a.tax.blocks.length === 0
  ? '<p class="sub">No block has anything in it for this year.</p>'
  : `<div class="panel" style="padding:0"><table>
      <tr><th>Block</th><th class="num">Rate</th><th class="num">Opening</th>
          <th class="num">Additions</th><th class="num">Under 180d</th>
          <th class="num">Sold</th><th class="num">Depreciation</th>
          <th class="num">Closing</th></tr>
      ${a.tax.blocks.map((b) => `<tr>
        <td>${esc(b.block)}${b.note
          ? `<div class="bad small">${esc(b.note)}</div>` : ''}</td>
        <td class="num">${esc(b.rate)}%</td>
        <td class="num">${inr(b.openingWdv)}</td>
        <td class="num">${inr(b.additionsFullRate)}</td>
        <td class="num">${b.additionsHalfRate === '0.00'
          ? '<span class="muted">—</span>' : inr(b.additionsHalfRate)}</td>
        <td class="num">${b.deductions === '0.00'
          ? '<span class="muted">—</span>' : inr(b.deductions)}</td>
        <td class="num"><b>${inr(b.depreciation)}</b></td>
        <td class="num">${inr(b.closingWdv)}</td></tr>`).join('')}
    </table></div>`}
${a.tax.warnings.length === 0 ? '' :
  `<ul class="warns">${a.tax.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`}

<script>
const rd = document.getElementById('runDep');
if (rd) rd.onclick = async () => {
  const out = document.getElementById('depResult');
  rd.disabled = true; out.textContent = 'Posting…';
  const r = await post('/api/assets/depreciate', {
    fromDate: rd.dataset.from, toDate: rd.dataset.to });
  if (!r.ok) { rd.disabled = false; out.innerHTML = '<span class="bad">' + r.error + '</span>'; return; }
  out.innerHTML = '<span class="good">Charged ' + r.total + ' across ' +
    r.lines + ' asset(s).</span>';
  setTimeout(() => location.reload(), 1200);
};
</script>`;
}

// ---------------------------------------------------------------------------
// Receivables — who owes the client, and collecting it.
//
// The screen leads with the oldest money, because that is the one that gets
// forgotten and the one least likely to arrive. The TDS field on the receipt
// form is the reason this page differs from Payables: ₹1,08,000 against a
// ₹1,18,000 invoice is usually not a short payment, and treating it as one
// leaves the invoice open forever and loses a credit the client is owed.

const RBUCKET_LABEL: Record<string, string> = {
  not_due: 'not yet due', d0_30: '1–30 days', d31_60: '31–60 days',
  d61_90: '61–90 days', d90_plus: 'over 90 days',
};

interface OutstandingInvoiceV {
  voucherId: string; invoiceNumber: string; partyId: string;
  customerName: string; customerPhone: string | null; invoiceDate: string; dueDate: string;
  grandTotal: string; outstanding: string; tdsWithheld: string;
  daysOverdue: number; bucket: string;
}

export function renderReceivables(a: {
  invoices: OutstandingInvoiceV[];
  accounts: Array<{ id: string; name: string }>;
  reminders?: boolean;
}): string {
  const buckets: Record<string, bigint> = {
    not_due: 0n, d0_30: 0n, d31_60: 0n, d61_90: 0n, d90_plus: 0n };
  let total = 0n;
  for (const i of a.invoices) {
    const p = BigInt(Math.round(Number(i.outstanding) * 100));
    buckets[i.bucket] = (buckets[i.bucket] ?? 0n) + p;
    total += p;
  }
  const rupees = (p: bigint) =>
    inr((p / 100n).toString() + '.' + String(p % 100n).padStart(2, '0'));

  const acctOptions = a.accounts.map((ac) =>
    `<option value="${esc(ac.id)}">${esc(ac.name)}</option>`).join('');
  const overdue = a.invoices.filter((invoice) => invoice.daysOverdue > 0);
  const reminderDrafts = !a.reminders ? '' : overdue.length === 0
    ? '<div class="msg good">No overdue invoices need a reminder.</div>'
    : `<section class="panel mt"><h2 style="margin-top:0">Payment reminder drafts</h2>
      <p class="sub">Review each draft before opening WhatsApp. BharatERP does not send messages automatically.</p>
      ${overdue.map((invoice) => {
        const phone = (invoice.customerPhone ?? '').replace(/\D/g, '').replace(/^0+/, '');
        const message = `Payment reminder from BharatERP: invoice ${invoice.invoiceNumber} for ₹${inr(invoice.outstanding)} was due on ${invoice.dueDate}. Please confirm the payment date.`;
        return `<div class="reminder-card"><b>${esc(invoice.customerName)}</b>
          <span class="muted"> · ${esc(invoice.invoiceNumber)} · ${inr(invoice.outstanding)} · ${invoice.daysOverdue}d overdue</span>
          <p>${esc(message)}</p>
          ${phone ? `<a class="btnlink" href="https://wa.me/${esc(phone)}?text=${encodeURIComponent(message)}" target="_blank" rel="noopener">Review in WhatsApp</a>`
            : '<span class="bad">No WhatsApp number saved for this customer.</span>'}
        </div>`;
      }).join('')}</section>`;

  const rows = a.invoices.map((i) => `
    <tr class="rrow">
      <td><a href="/receivables?party=${esc(i.partyId)}">${esc(i.customerName)}</a></td>
      <td class="mono">${esc(i.invoiceNumber)}</td>
      <td>${esc(i.dueDate)}</td>
      <td class="num ${i.daysOverdue > 60 ? 'bad' : i.daysOverdue > 0 ? 'warn' : 'muted'}">${
        i.daysOverdue > 0 ? i.daysOverdue + 'd overdue' : 'not due'}</td>
      <td class="num"><b>${inr(i.outstanding)}</b>${
        i.tdsWithheld === '0.00' ? ''
          : `<div class="muted small">${inr(i.tdsWithheld)} TDS withheld</div>`}</td>
      <td><button class="rcv" data-v="${esc(i.voucherId)}" data-out="${esc(i.outstanding)}">Receipt</button>
        <button class="woff" data-v="${esc(i.voucherId)}" data-out="${esc(i.outstanding)}">Write off</button></td>
    </tr>
    <tr class="rcvform" id="rf_${esc(i.voucherId)}" hidden>
      <td colspan="6">
        <div class="payrow">
          <label>Received <input type="text" class="r-amt" value="${esc(i.outstanding)}"></label>
          <label>TDS withheld <input type="text" class="r-tds" value="0.00"></label>
          <label>Into <select class="r-acct">${acctOptions}</select></label>
          <label>On <input type="date" class="r-date"></label>
          <label>Ref <input type="text" class="r-ref" size="12"></label>
          <button class="primary r-go" data-v="${esc(i.voucherId)}">Record</button>
          <span class="r-out muted"></span>
        </div>
        <div class="muted small">Enter the tax the customer withheld separately.
          A short payment and a withholding look identical in a bank statement
          and mean opposite things — one is still owed, the other is an asset
          the client claims — so it is asked rather than guessed.</div>
      </td>
    </tr>
    <tr class="wofform" id="wf_${esc(i.voucherId)}" hidden>
      <td colspan="6">
        <div class="payrow">
          <label>Write off <input type="text" class="w-amt" value="${esc(i.outstanding)}"></label>
          <label>On <input type="date" class="w-date"></label>
          <label>Why <input type="text" class="w-why" size="30"
            placeholder="struck off, untraceable, disputed and abandoned"></label>
          <button class="w-go" data-v="${esc(i.voucherId)}">Write it off</button>
          <span class="w-out muted"></span>
        </div>
        <div class="muted small">A debt given up is an expense of the business.
          The GST on it is <b>not</b> recoverable — it became payable at the time
          of supply and India has no bad-debt relief — so this writes off the
          tax as well.</div>
      </td>
    </tr>`).join('');

  return `${pageIntro('SALES', 'Receivables', 'What customers owe, oldest first. Read from the ledger so receipts, credit notes, and write-offs reduce balances from recorded transactions.')}

<div class="panel strip">
  ${['not_due', 'd0_30', 'd31_60', 'd61_90', 'd90_plus'].map((k) =>
    `<div class="stat"><b class="${
      k === 'd90_plus' && buckets[k] ? 'bad' : k === 'd61_90' && buckets[k] ? 'warn' : ''
    }">${rupees(buckets[k] ?? 0n)}</b><span>${RBUCKET_LABEL[k]}</span></div>`).join('')}
  <div class="stat"><b>${rupees(total)}</b><span>total receivable</span></div>
</div>

${reminderDrafts}

${a.invoices.length === 0
  ? '<p class="sub mt">Nothing outstanding.</p>'
  : `<div class="panel mt" style="padding:0"><table>
      <tr><th>Customer</th><th>Invoice</th><th>Due</th><th class="num">Age</th>
          <th class="num">Outstanding</th><th></th></tr>
      ${rows}
    </table></div>`}

<script>
const toggle = (btn, prefix) => {
  const row = document.getElementById(prefix + btn.dataset.v);
  row.hidden = !row.hidden;
};
document.querySelectorAll('button.rcv').forEach((b) => {
  b.onclick = () => {
    toggle(b, 'rf_');
    const d = document.querySelector('#rf_' + b.dataset.v + ' .r-date');
    if (!d.value) d.value = new Date().toISOString().slice(0, 10);
  };
});
document.querySelectorAll('button.woff').forEach((b) => {
  b.onclick = () => {
    toggle(b, 'wf_');
    const d = document.querySelector('#wf_' + b.dataset.v + ' .w-date');
    if (!d.value) d.value = new Date().toISOString().slice(0, 10);
  };
});

document.querySelectorAll('button.r-go').forEach((b) => {
  b.onclick = async () => {
    const box = document.getElementById('rf_' + b.dataset.v);
    const out = box.querySelector('.r-out');
    const v = (cls) => box.querySelector(cls).value.trim();
    b.disabled = true; out.textContent = 'Recording…';
    const r = await post('/api/receivables/receipt', {
      invoiceVoucherId: b.dataset.v, amount: v('.r-amt'),
      tdsWithheld: v('.r-tds') || '0',
      receivedIntoAccountId: v('.r-acct'), receiptDate: v('.r-date'),
      reference: v('.r-ref') || undefined,
    });
    b.disabled = false;
    if (!r.ok) { out.innerHTML = '<span class="bad">' + r.error + '</span>'; return; }
    out.innerHTML = '<span class="good">' +
      (r.fullySettled ? 'Settled in full.' : r.outstandingAfter + ' still owed.') +
      '</span>';
    if ((r.warnings || []).length) {
      out.innerHTML += '<div class="muted small">' +
        r.warnings.map((w) => w.replace(/</g, '&lt;')).join(' ') + '</div>';
    }
    setTimeout(() => location.reload(), (r.warnings || []).length ? 6000 : 900);
  };
});

document.querySelectorAll('button.w-go').forEach((b) => {
  b.onclick = async () => {
    const box = document.getElementById('wf_' + b.dataset.v);
    const out = box.querySelector('.w-out');
    const v = (cls) => box.querySelector(cls).value.trim();
    if (!v('.w-why')) { out.textContent = 'Say why first.'; return; }
    b.disabled = true; out.textContent = 'Writing off…';
    const r = await post('/api/receivables/write-off', {
      invoiceVoucherId: b.dataset.v, amount: v('.w-amt'),
      writeOffDate: v('.w-date'), reason: v('.w-why'),
    });
    b.disabled = false;
    if (!r.ok) { out.innerHTML = '<span class="bad">' + r.error + '</span>'; return; }
    out.innerHTML = '<div class="muted small">' +
      (r.warnings || []).map((w) => w.replace(/</g, '&lt;')).join(' ') + '</div>';
    setTimeout(() => location.reload(), 7000);
  };
});
</script>`;
}

export function renderStatement(a: {
  customer: string;
  closing: string;
  lines: Array<{ date: string; voucherType: string; reference: string;
                 narration: string; debit: string; credit: string;
                 balance: string }>;
}): string {
  return `<h1>${esc(a.customer)}</h1>
<p class="sub">Their account with this client, oldest first. Built from the
ledger rather than from the invoices — a statement that left out a receipt or a
credit note would be worse than none.</p>

<div class="panel strip">
  <div class="stat"><b class="${a.closing === '0.00' ? 'good' : ''}">${inr(a.closing)}</b>
    <span>balance owed</span></div>
</div>

<div class="panel mt" style="padding:0"><table>
  <tr><th>Date</th><th>Document</th><th>Detail</th>
      <th class="num">Debit</th><th class="num">Credit</th>
      <th class="num">Balance</th></tr>
  ${a.lines.map((l) => `<tr>
    <td>${esc(l.date)}</td>
    <td class="mono">${esc(l.reference)}<div class="muted small">${esc(l.voucherType)}</div></td>
    <td class="muted small">${esc(l.narration)}</td>
    <td class="num">${l.debit === '0.00' ? '' : inr(l.debit)}</td>
    <td class="num">${l.credit === '0.00' ? '' : inr(l.credit)}</td>
    <td class="num">${inr(l.balance)}</td></tr>`).join('')}
</table></div>
<p class="sub"><a href="/receivables">← back to receivables</a></p>`;
}

// ---------------------------------------------------------------------------
// The door.
//
// Its own page, outside `renderShell`: the shell carries a client switcher and
// a nav to screens the caller has no right to yet, and drawing them around a
// login form would be telling an unauthenticated visitor who the firm's
// clients are.

export function renderLogin(a: {
  email?: string;
  error?: string;
  /** Set when this is the change-password form rather than the login form. */
  changeFor?: string;
  /** True when the current password was issued by an administrator. */
  issued?: boolean;
}): string {
  const body = a.changeFor === undefined ? `
    <h1>Sign in</h1>
    <form method="post" action="/login">
      <label>Email
        <input name="email" type="email" autocomplete="username" required
          value="${esc(a.email ?? '')}" autofocus></label>
      <label>Password
        <input name="password" type="password" autocomplete="current-password" required></label>
      <button class="primary" type="submit">Sign in</button>
    </form>
    <p class="sub">No sign-up here. A firm's partner issues accounts, because
      an accounting system's users are its audit trail — every posting names
      one of them.</p>` : `
    <h1>${a.issued ? 'Choose your own password' : 'Change password'}</h1>
    ${a.issued ? `<p class="sub">The password you signed in with was issued to
      you, so somebody else knows it. It works once. Choose your own and
      nothing else on this account will accept the old one.</p>` : ''}
    <form method="post" action="/password">
      <input type="hidden" name="email" value="${esc(a.changeFor)}"
        autocomplete="username">
      <label>Current password
        <input name="current" type="password" autocomplete="current-password" required autofocus></label>
      <label>New password
        <input name="next" type="password" autocomplete="new-password"
          minlength="12" required></label>
      <button class="primary" type="submit">Save it</button>
    </form>
    <p class="sub">At least 12 characters, and no rules about symbols — length
      is what defeats guessing. Every other session on this account is signed
      out when you save, because the usual reason to change a password is that
      somebody else might know the old one.</p>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BharatERP</title>
<style>${CSS}
.gate { max-width: 380px; margin: 12vh auto; padding: 0 20px; }
.gate form { display: flex; flex-direction: column; gap: 14px; margin-top: 18px; }
.gate label { display: flex; flex-direction: column; gap: 5px; font-size: 13px;
  color: var(--muted); }
.gate input { padding: 9px 10px; font: inherit; color: var(--ink);
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.gate button { padding: 9px; font: inherit; }
.gate .err { margin-top: 14px; padding: 9px 11px; border-radius: 6px;
  background: color-mix(in srgb, var(--bad) 14%, transparent);
  color: var(--bad); font-size: 14px; }
</style></head><body>
<main class="gate">
  <div class="brand" style="font-size:15px">BharatERP</div>
  ${a.error ? `<div class="err">${esc(a.error)}</div>` : ''}
  ${body}
</main></body></html>`;
}

// ---------------------------------------------------------------------------
// Purchase returns — the debit note.
//
// The screen has to carry one idea that is easy to get wrong and expensive:
// our debit note reduces what we owe and reverses our own credit, and it does
// NOT reduce the supplier's liability. Only their credit note does that. So
// the list leads with which returns are still waiting for one.

interface ReturnsV {
  returns: Array<{
    voucherId: string; noteNumber: string; noteDate: string; billNumber: string;
    supplier: string; reason: string; taxableValue: string; grandTotal: string;
    supplierCreditNote: string | null;
  }>;
  /** Set when a bill was chosen to return against. */
  bill: null | {
    voucherId: string; billNumber: string; billDate: string; supplier: string;
    grandTotal: string;
    lines: Array<{ lineNo: number; description: string; hsnSac: string | null;
                   taxableValue: string; returned: string; remaining: string;
                   gstRate: string; itc: string }>;
  };
}

export function renderReturns(a: ReturnsV): string {
  const waiting = a.returns.filter((r) => r.supplierCreditNote === null);

  const form = a.bill === null ? `
    <p class="sub">Pick a bill from <a href="/payables">Payables</a> and press
      Return. A return always points at the bill it reduces — a floating credit
      is one nobody can reconcile.</p>` : `
    <div class="panel">
      <h2>Return against ${esc(a.bill.billNumber)}</h2>
      <p class="sub">${esc(a.bill.supplier)}, dated ${esc(a.bill.billDate)},
        ${inr(a.bill.grandTotal)}. Enter the taxable value going back on each
        line — the tax comes off in the same proportion it went on, and a line
        whose credit was blocked has its GST taken back out of the expense
        rather than off input credit.</p>
      <table>
        <tr><th>#</th><th>Line</th><th class="num">Billed</th>
            <th class="num">Already back</th><th class="num">Returning</th></tr>
        ${a.bill.lines.map((l) => `
          <tr>
            <td class="muted">${l.lineNo}</td>
            <td>${esc(l.description)}
              <div class="muted small">${esc(l.gstRate)}%${
                l.itc === 'eligible' ? '' : ` · credit ${esc(l.itc)}`}${
                l.hsnSac ? ` · HSN ${esc(l.hsnSac)}` : ''}</div></td>
            <td class="num">${inr(l.taxableValue)}</td>
            <td class="num ${l.returned === '0.00' ? 'muted' : ''}">${
              l.returned === '0.00' ? '—' : inr(l.returned)}</td>
            <td class="num">${Number(l.remaining) <= 0
              ? '<span class="muted">fully returned</span>'
              : `<input class="rline" data-line="${l.lineNo}"
                   data-max="${esc(l.remaining)}" inputmode="decimal"
                   placeholder="up to ${esc(l.remaining)}">`}</td>
          </tr>`).join('')}
      </table>
      <div class="row mt">
        <label>Debit note no. <input id="rnum"></label>
        <label>Dated <input id="rdate" type="date" value="${esc(a.bill.billDate)}"></label>
        <label>Why <input id="rreason" size="34"
          placeholder="short delivery, damaged, rate corrected"></label>
      </div>
      <div class="row">
        <label>Supplier's credit note <input id="rscn" placeholder="if it has arrived"></label>
        <label>Dated <input id="rscnd" type="date"></label>
      </div>
      <div class="billactions">
        <button class="primary" id="rsave" data-bill="${esc(a.bill.voucherId)}">Post the return</button>
        <span id="rresult" class="muted"></span>
      </div>
      <div id="rwarn"></div>
    </div>`;

  const rows = a.returns.map((r) => `
    <tr>
      <td class="mono">${esc(r.noteNumber)}<div class="muted small">${esc(r.noteDate)}</div></td>
      <td>${esc(r.supplier)}<div class="muted small">against ${esc(r.billNumber)}</div></td>
      <td>${esc(r.reason)}</td>
      <td class="num">${inr(r.grandTotal)}</td>
      <td>${r.supplierCreditNote === null
        ? `<span class="warn">not received</span>
           <div class="cnbox"><input class="cnnum" placeholder="their CN no.">
             <input class="cndate" type="date">
             <button class="cnsave" data-v="${esc(r.voucherId)}">Record</button></div>`
        : `<span class="good mono">${esc(r.supplierCreditNote)}</span>`}</td>
    </tr>`).join('');

  return `${pageIntro('PURCHASES', 'Purchase returns', 'Track goods returned and the bills they reduce. A debit note records the buyer-side reduction; the supplier liability changes when the supplier issues its credit note.')}

${waiting.length === 0 ? '' : `<div class="panel strip">
  <div class="stat"><b class="warn">${waiting.length}</b>
    <span>awaiting the supplier's credit note</span></div>
  <div class="stat"><b>${inr(waiting.reduce((t, r) =>
    (Number(t) + Number(r.grandTotal)).toFixed(2), '0'))}</b>
    <span>unsupported in GSTR-2B</span></div>
</div>`}

${form}

<h2 class="mt">Returns</h2>
${a.returns.length === 0
  ? '<p class="sub">None yet.</p>'
  : `<div class="panel" style="padding:0"><table>
      <tr><th>Debit note</th><th>Supplier</th><th>Reason</th>
          <th class="num">Value</th><th>Their credit note</th></tr>
      ${rows}
    </table></div>`}

<script>
const rs = document.getElementById('rsave');
if (rs) rs.onclick = async () => {
  const out = document.getElementById('rresult');
  const warn = document.getElementById('rwarn');
  const lines = [];
  document.querySelectorAll('input.rline').forEach((el) => {
    const v = el.value.trim();
    if (v !== '') lines.push({ billLineNo: Number(el.dataset.line), taxableValue: v });
  });
  if (lines.length === 0) { out.textContent = 'Nothing entered to return.'; return; }
  const g = (id) => document.getElementById(id).value.trim();
  out.textContent = 'Posting…'; warn.innerHTML = '';
  const r = await fetch('/api/returns/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      billVoucherId: rs.dataset.bill, noteNumber: g('rnum'), noteDate: g('rdate'),
      reason: g('rreason'), lines,
      supplierCreditNote: g('rscn') ? { number: g('rscn'), date: g('rscnd') } : undefined,
    }),
  }).then((x) => x.json());
  if (!r.ok) { out.innerHTML = '<span class="bad">' + r.error + '</span>'; return; }
  out.innerHTML = '<span class="good">Posted ' + r.grandTotal + '.</span>';
  // The warnings are the reason this screen exists, so they are shown before
  // the reload rather than lost in it.
  warn.innerHTML = '<ul class="warns">' +
    (r.warnings || []).map((w) => '<li>' + w.replace(/</g, '&lt;') + '</li>').join('') +
    '</ul><p class="sub">Reloading…</p>';
  setTimeout(() => { location.href = '/returns'; }, (r.warnings || []).length ? 6000 : 1200);
};

document.querySelectorAll('button.cnsave').forEach((b) => {
  b.onclick = async () => {
    const box = b.closest('.cnbox');
    const num = box.querySelector('.cnnum').value.trim();
    const date = box.querySelector('.cndate').value.trim();
    if (!num || !date) { b.textContent = 'number and date'; return; }
    b.disabled = true;
    const r = await fetch('/api/returns/credit-note', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnVoucherId: b.dataset.v, number: num, date }),
    }).then((x) => x.json());
    if (!r.ok) { b.disabled = false; b.textContent = 'failed'; return; }
    location.reload();
  };
});
</script>`;
}

// ---------------------------------------------------------------------------
// TDS — what has been withheld, what is owed to the government, and by when.
//
// The screen exists because BE-36 made a liability and gave nobody a deadline.
// It leads with the two figures that cost money on a timetable — overdue tax
// and the interest already accrued — rather than with the total deducted,
// which is interesting and not urgent.

interface TdsPositionV {
  asOf: string;
  months: Array<{
    period: string; deducted: string; deposited: string; outstanding: string;
    shortfall: string;
    deposit: { due: string; citation: string | null } | null;
    overdue: null | { days: number; months: number; interest: string; rate: string };
    statement: { due: string; quarter: string } | null;
    deductions: number; parties: number;
  }>;
  totalOutstanding: string;
  totalInterest: string;
  totalShortfall: string;
  paymentAccounts: Array<{ id: string; name: string }>;
}

export function renderTds(a: TdsPositionV): string {
  if (a.months.length === 0) {
    return `${pageIntro('GST & TDS', 'TDS', 'Nothing has been withheld yet. A bill posted to a head that attracts TDS asks before posting; the amount withheld appears here with its deposit date.')}`;
  }

  const row = (m: TdsPositionV['months'][number]): string => {
    const late = m.overdue !== null;
    return `<tr class="${late ? 'lategrp' : ''}">
      <td><b>${esc(m.period)}</b>
        <div class="muted small">${m.deductions} deduction(s), ${m.parties} supplier(s)</div></td>
      <td class="num">${inr(m.deducted)}</td>
      <td class="num">${m.deposited === '0.00' ? '<span class="muted">—</span>' : inr(m.deposited)}</td>
      <td class="num">${m.outstanding === '0.00'
        ? '<span class="good">settled</span>' : `<b>${inr(m.outstanding)}</b>`}</td>
      <td>${m.deposit === null
        ? '<span class="muted">no rule on file</span>'
        : `${esc(m.deposit.due)}${late
            ? `<div class="bad small">${m.overdue!.days} days late — ` +
              `${inr(m.overdue!.interest)} interest at ${esc(m.overdue!.rate)}% ` +
              `for ${m.overdue!.months} month(s)</div>`
            : ''}`}</td>
      <td>${m.statement === null ? '<span class="muted">—</span>'
        : `${esc(m.statement.due)}<div class="muted small">${esc(m.statement.quarter)}</div>`}</td>
      <td>${m.outstanding === '0.00' ? ''
        : `<button class="depositbtn" data-period="${esc(m.period)}"
             data-tax="${esc(m.outstanding)}"
             data-interest="${esc(m.overdue?.interest ?? '0.00')}">Record challan</button>`}</td>
    </tr>`;
  };

  const accounts = a.paymentAccounts
    .map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');

  return `${pageIntro('GST & TDS', 'TDS', 'Tax withheld on bills, and what is owed to the government. Deposit deadlines follow the month the tax was deducted in, not the month somebody gets round to paying it.')}

<div class="tiles">
  <div class="tile"><b class="${a.totalOutstanding === '0.00' ? 'good' : 'bad'}">${inr(a.totalOutstanding)}</b>
    <span>owed to the government</span></div>
  <div class="tile"><b class="${a.totalInterest === '0.00' ? '' : 'bad'}">${inr(a.totalInterest)}</b>
    <span>interest accrued, s.201(1A)</span></div>
  <div class="tile"><b class="${a.totalShortfall === '0.00' ? '' : 'warn'}">${inr(a.totalShortfall)}</b>
    <span>due but not withheld</span></div>
</div>

<div class="panel mt" style="padding:0"><table>
  <tr><th>Deducted in</th><th class="num">Withheld</th><th class="num">Deposited</th>
      <th class="num">Owed</th><th>Deposit by</th><th>Statement by</th><th></th></tr>
  ${a.months.map(row).join('')}
</table></div>

${a.totalShortfall === '0.00' ? '' : `
<p class="sub"><b>Due but not withheld</b> is tax a reviewer decided against
deducting. It is not lost: the next deduction for that supplier charges the
running total and nets off only what was actually withheld, so the shortfall is
caught up then. Until it is, the client owes it.</p>`}

<div class="panel mt" id="challan" hidden>
  <h2>Record a challan</h2>
  <p class="sub">What was actually paid to the government. The tax clears the
    liability; interest and any late fee go to their own expense head, because
    they are the client's own cost of being late and are added back at year
    end rather than allowed.</p>
  <div class="row">
    <label>Month <input id="cperiod" readonly></label>
    <label>Paid on <input id="cdate" type="date"></label>
    <label>Tax <input id="ctax" inputmode="decimal"></label>
    <label>Interest <input id="cint" inputmode="decimal"></label>
    <label>Late fee <input id="cfee" inputmode="decimal" value="0"></label>
  </div>
  <div class="row">
    <label>Paid from <select id="cacct">${accounts}</select></label>
    <label>BSR code <input id="cbsr" maxlength="7" placeholder="7 digits"></label>
    <label>Challan serial <input id="cserial"></label>
  </div>
  <div class="billactions">
    <button class="primary" id="csave">Record it</button>
    <button id="ccancel">Cancel</button>
    <span id="cresult" class="muted"></span>
  </div>
  <p class="sub">The CIN — BSR code, date and serial — is what the quarterly
    statement quotes against each deduction. A return filed without it is
    rejected, so it is worth entering now rather than hunting for it in July.</p>
</div>

<script>
document.querySelectorAll('button.depositbtn').forEach((b) => {
  b.onclick = () => {
    const box = document.getElementById('challan');
    box.hidden = false;
    document.getElementById('cperiod').value = b.dataset.period;
    document.getElementById('ctax').value = b.dataset.tax;
    // Pre-filled with the interest accrued TO TODAY, which is what it would
    // cost to pay now. It is editable because the challan records what was
    // actually paid, not what we calculated.
    document.getElementById('cint').value = b.dataset.interest;
    document.getElementById('cdate').value = new Date().toISOString().slice(0, 10);
    box.scrollIntoView({ behavior: 'smooth' });
  };
});
const cc = document.getElementById('ccancel');
if (cc) cc.onclick = () => { document.getElementById('challan').hidden = true; };
const cs = document.getElementById('csave');
if (cs) cs.onclick = async () => {
  const out = document.getElementById('cresult');
  const v = (id) => document.getElementById(id).value.trim();
  out.textContent = 'Recording…';
  const r = await fetch('/api/tds/deposit', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      period: v('cperiod'), depositedOn: v('cdate'), tax: v('ctax'),
      interest: v('cint') || '0', lateFee: v('cfee') || '0',
      paidFromAccountId: v('cacct'), bsrCode: v('cbsr') || undefined,
      challanSerial: v('cserial') || undefined,
    }),
  }).then((x) => x.json());
  if (!r.ok) { out.innerHTML = '<span class="bad">' + (r.error || 'could not record') + '</span>'; return; }
  out.innerHTML = '<span class="good">Recorded ' + r.remitted + '.</span>';
  setTimeout(() => location.reload(), 800);
};
</script>`;
}

// ---------------------------------------------------------------------------
// The firm cockpit — every client on one page, neediest first.
//
// The one screen that is not about a single client. It answers the question a
// practice actually runs on: which of these needs me today?

export function renderClientSetup(a: {
  name: string; pan: string | null; gstin: string | null;
  bankAccounts: number; teamMembers: number;
}): string {
  const done = [Boolean(a.pan), Boolean(a.gstin), a.bankAccounts > 0].filter(Boolean).length;
  const step = (complete: boolean, title: string, note: string, href?: string) =>
    `<div class="setup-step ${complete ? 'good' : 'warn'}"><b>${complete ? 'Done' : 'Next'} · ${esc(title)}</b>
      <span>${esc(note)}</span>${href ? ` <a href="${esc(href)}">Open →</a>` : ''}</div>`;
  return `${pageIntro('TODAY', `Set up ${a.name}`, 'Complete the basics before posting live books. You can return here any time.')}
<div class="panel strip">
  <div class="stat"><b>${done}/3</b><span>core setup complete</span></div>
  <div class="stat"><b>${a.teamMembers}</b><span>firm team members</span></div>
</div>

<section class="panel mt"><h2 style="margin-top:0">1. Company and GST details</h2>
  <p class="sub">The PAN identifies the books. Add a GSTIN only when this client is registered.</p>
  <label>Company name<input id="setup-name" value="${esc(a.name)}" maxlength="160"></label>
  <div class="row"><label>PAN<input id="setup-pan" class="mono" value="${esc(a.pan ?? '')}" maxlength="10" placeholder="ABCDE1234F"></label>
    <label>Primary GSTIN <span class="muted">optional</span><input id="setup-gstin" class="mono" value="${esc(a.gstin ?? '')}" maxlength="15" placeholder="27ABCDE1234F1Z5"></label>
  </div>
  <button class="primary" id="save-setup">Save company details</button><span id="setup-result" class="why"></span>
</section>

<section class="mt">
  ${step(Boolean(a.pan), 'Company PAN', a.pan ? `PAN ${a.pan}` : 'Add the company PAN above.')}
  ${step(Boolean(a.gstin), 'GST registration', a.gstin ? `GSTIN ${a.gstin}` : 'Optional for an unregistered client.')}
  ${step(a.bankAccounts > 0, 'Bank account', a.bankAccounts ? `${a.bankAccounts} account(s) added.` : 'Add the account used for reconciliation.', '/accounts')}
  ${step(false, 'Opening data', 'Import existing books from Tally or a bank statement.', '/tally')}
  ${step(a.teamMembers > 1, 'CA team', a.teamMembers > 1 ? `${a.teamMembers} firm users can access this firm.` : 'Add staff and approval roles next.')}
</section>

<script>
const postSetup = (body) => fetch('/api/client-setup', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
document.getElementById('save-setup').onclick = async () => {
  const result = document.getElementById('setup-result');
  const r = await postSetup({ name: document.getElementById('setup-name').value,
    pan: document.getElementById('setup-pan').value, gstin: document.getElementById('setup-gstin').value });
  if (!r.ok) { result.className = 'bad'; result.textContent = r.error; return; }
  location.reload();
};
</script>`;
}

interface CockpitRowV {
  clientId: string; name: string; gstin: string | null;
  outputTax: string; creditAtRisk: string; reconciled: boolean;
  overduePayable: string; overdueCount: number; billsPosted: number;
  registrationIssues: number;
  documentsWaiting: number; informationRequested: number;
  gstr1Due: string; gstr3bDue: string;
  daysToGstr1: number; daysToGstr3b: number; attention: number;
}

export function renderCockpit(a: {
  period: string; periods: string[]; today: string;
  rows: CockpitRowV[];
  totals: { clients: number; outputTax: string; creditAtRisk: string;
    overduePayable: string; needingAttention: number;
    documentsWaiting: number; informationRequested: number };
}): string {
  const picker = `
    <form method="get" action="/firm" class="row">
      <label>Period
        <select name="period" onchange="this.form.submit()">
          ${(a.periods.length ? a.periods : [a.period]).map((p) =>
            `<option value="${esc(p)}" ${p === a.period ? 'selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
      </label>
    </form>`;

  const dueCell = (days: number, date: string) => {
    if (days < 0) return `<span class="bad">${-days}d overdue</span>`;
    if (days <= 7) return `<span class="warn">in ${days}d</span>`;
    return `<span class="muted">${esc(date.slice(5))}</span>`;
  };

  const flags = (r: CockpitRowV) => {
    const out: string[] = [];
    if (!r.reconciled && r.outputTax !== '0.00') out.push('<span class="tag warn">2B not run</span>');
    if (r.registrationIssues > 0) {
      out.push(`<span class="tag bad">${r.registrationIssues} supplier registration</span>`);
    }
    if (r.overdueCount > 0) out.push(`<span class="tag">${r.overdueCount} overdue</span>`);
    if (r.documentsWaiting > 0) out.push(`<a class="tag warn" href="/documents?client=${esc(r.clientId)}">${r.documentsWaiting} docs to review</a>`);
    if (r.informationRequested > 0) out.push(`<a class="tag bad" href="/documents?client=${esc(r.clientId)}">${r.informationRequested} info requested</a>`);
    return out.join(' ') || '<span class="muted">—</span>';
  };

  // Every link carries ?client=, which switches the session for that client.
  const rows = a.rows.map((r) => `
    <tr class="${r.attention >= 60 ? 'hot' : ''}">
      <td><a href="/?client=${esc(r.clientId)}"><b>${esc(r.name)}</b></a>
        <div class="why mono">${esc(r.gstin ?? 'no GSTIN')}</div></td>
      <td>${dueCell(r.daysToGstr1, r.gstr1Due)}</td>
      <td>${dueCell(r.daysToGstr3b, r.gstr3bDue)}</td>
      <td class="num">${inr(r.outputTax)}</td>
      <td class="num">${r.creditAtRisk === '0.00'
        ? '<span class="muted">—</span>'
        : `<a class="bad" href="/gstr2b?client=${esc(r.clientId)}">${inr(r.creditAtRisk)}</a>`}</td>
      <td class="num">${r.overduePayable === '0.00'
        ? '<span class="muted">—</span>'
        : `<a href="/payables?client=${esc(r.clientId)}">${inr(r.overduePayable)}</a>`}</td>
      <td class="num muted">${r.billsPosted}</td>
      <td>${flags(r)}</td>
    </tr>`).join('');

  return `${pageIntro('FIRM WORKSPACE', 'The firm', 'Every client, sorted by what needs you. Deadlines shown are standard monthly dates; QRMP clients may follow a different calendar.')}

${picker}

<div class="panel strip">
  <div class="stat"><b>${a.totals.clients}</b><span>clients</span></div>
  <div class="stat"><b class="${a.totals.needingAttention ? 'bad' : 'good'}">${a.totals.needingAttention}</b><span>need attention</span></div>
  <div class="stat"><b>${inr(a.totals.outputTax)}</b><span>tax declared</span></div>
  <div class="stat"><b class="${a.totals.creditAtRisk === '0.00' ? '' : 'bad'}">${inr(a.totals.creditAtRisk)}</b><span>credit at risk</span></div>
  <div class="stat"><b>${inr(a.totals.overduePayable)}</b><span>overdue payables</span></div>
  <div class="stat"><b>${a.totals.documentsWaiting}</b><span>documents to review</span></div>
  <div class="stat"><b>${a.totals.informationRequested}</b><span>information requested</span></div>
</div>

${a.rows.length === 0
  ? '<p class="empty">No clients yet.</p>'
  : `<div class="panel" style="padding:0"><table>
      <tr><th>Client</th><th>GSTR-1</th><th>GSTR-3B</th><th class="num">Tax declared</th>
          <th class="num">Credit at risk</th><th class="num">Overdue</th>
          <th class="num">Bills</th><th>Flags</th></tr>
      ${rows}
    </table></div>`}`;
}
