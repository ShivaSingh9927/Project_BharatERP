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

import type { QueueItem, MatchProposal } from '../domain/matching.ts';
import type { Brs } from '../domain/brs.ts';

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

/** Indian digit grouping — 12,34,567.89, not 1,234,567.89. */
const inr = (v: string): string => {
  const neg = v.startsWith('-');
  const [whole = '0', frac = '00'] = (neg ? v.slice(1) : v).split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '−' : ''}${grouped}.${frac.padEnd(2, '0').slice(0, 2)}`;
};

const CSS = `
:root {
  --bg: #fbfbfa; --panel: #fff; --ink: #1a1a18; --muted: #6b6b66;
  --line: #e3e3df; --accent: #1d4ed8; --good: #0f7b3f; --warn: #9a5b00;
  --bad: #b02020; --sel: #eef2ff; --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17171a; --panel: #1e1e22; --ink: #e8e8e4; --muted: #9a9a94;
    --line: #32323a; --accent: #7ea2ff; --good: #55c98a; --warn: #e0a54a;
    --bad: #ef7676; --sel: #22283c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
header {
  display: flex; align-items: baseline; gap: 18px; padding: 10px 18px;
  border-bottom: 1px solid var(--line); background: var(--panel);
  position: sticky; top: 0; z-index: 5;
}
header b { font-size: 15px; }
header .client { color: var(--muted); }
nav { display: flex; gap: 4px; margin-left: auto; }
nav a {
  color: var(--ink); text-decoration: none; padding: 4px 10px; border-radius: 6px;
}
nav a:hover { background: var(--sel); }
nav a.on { background: var(--accent); color: #fff; }
main { padding: 18px; max-width: 1180px; }
h1 { font-size: 17px; margin: 0 0 4px; }
h2 { font-size: 14px; margin: 22px 0 8px; }
.sub { color: var(--muted); margin: 0 0 16px; }
.panel {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 8px; padding: 14px; margin-bottom: 16px;
}
.strip { display: flex; gap: 22px; flex-wrap: wrap; align-items: center; }
.stat b { display: block; font-size: 19px; font-variant-numeric: tabular-nums; }
.stat span { color: var(--muted); font-size: 12px; }
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left; font-size: 11px; text-transform: uppercase;
  letter-spacing: .04em; color: var(--muted); font-weight: 600;
  padding: 6px 8px; border-bottom: 1px solid var(--line);
}
td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); }
tr.row { cursor: pointer; }
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
button.primary { background: var(--accent); color: #fff; border-color: transparent; }
button:disabled { opacity: .5; cursor: default; }
textarea { width: 100%; min-height: 150px; font-family: var(--mono); font-size: 12px; }
.row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.warn { color: var(--warn); } .bad { color: var(--bad); } .good { color: var(--good); }
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
`;

// ---------------------------------------------------------------------------

export function renderShell(a: {
  session: { clientName: string };
  accounts: Array<{ id: string; bank_name: string; last4: string }>;
  active: string;
  accountId?: string;
  body: string;
}): string {
  const q = a.accountId ? `?account=${encodeURIComponent(a.accountId)}` : '';
  const link = (href: string, key: string, label: string): string =>
    `<a href="${href}" class="${a.active === key ? 'on' : ''}">${label}</a>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BharatERP — ${esc(a.session.clientName)}</title>
<style>${CSS}</style></head>
<body>
<header>
  <b>BharatERP</b>
  <span class="client">${esc(a.session.clientName)}</span>
  <nav>
    ${link('/accounts', 'accounts', 'Accounts')}
    ${link('/import', 'import', 'Import')}
    ${link(`/reconcile${q}`, 'reconcile', 'Reconcile')}
    ${link(`/brs${q}`, 'brs', 'BRS')}
    ${link('/cash', 'cash', 'Cash')}
    ${link('/gstr2b', 'gstr2b', 'GSTR-2B')}
  </nav>
</header>
<main>${a.body}</main>
</body></html>`;
}

// ---------------------------------------------------------------------------

export function renderAccounts(
  accounts: Array<{ id: string; bank_name: string; last4: string; kind: string }>,
): string {
  if (accounts.length === 0) {
    return `<h1>Bank accounts</h1>
      <p class="empty">None yet. Seed a client and add a bank account to begin.</p>`;
  }
  return `<h1>Bank accounts</h1>
  <p class="sub">Account numbers are stored as last-four plus a hash only (BR-2).</p>
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
  </table></div>`;
}

// ---------------------------------------------------------------------------

export function renderImport(a: {
  accounts: Array<{ id: string; bank_name: string; last4: string }>;
  banks: string[];
}): string {
  return `<h1>Import a statement</h1>
<p class="sub">CSV, TSV or any delimited export. The file is checked against its
own arithmetic before anything is saved — if it does not add up, the parse is
wrong and the import is refused (BR-6).</p>

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
    <label>File <input type="file" id="file" accept=".csv,.tsv,.txt"></label>
  </div>
  <textarea id="text" placeholder="…or paste the statement here"></textarea>
  <div class="strip" style="margin-top:10px">
    <button class="primary" id="preview">Preview <kbd>⏎</kbd></button>
    <button id="commit" disabled>Import</button>
    <span class="why" id="hint"></span>
  </div>
</div>
<div id="out"></div>

<script>
const $ = (id) => document.getElementById(id);
let previewed = false;

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) { $('text').value = await f.text(); $('hint').textContent = f.name; }
});

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const money = (v) => v === null || v === undefined ? '—' : v;

$('preview').onclick = async () => {
  const r = await post('/api/preview', { fileText: $('text').value, bank: $('bank').value });
  if (!r.ok) {
    $('out').innerHTML = '<div class="msg bad"><b>Cannot read this file.</b><br>' + esc(r.error) + '</div>';
    $('commit').disabled = true;
    return;
  }
  previewed = true;
  $('commit').disabled = false;
  $('out').innerHTML =
    '<div class="panel"><div class="strip">'
    + stat(r.bank, 'layout used') + stat(r.rowCount, 'rows read')
    + stat(money(r.openingBalance), 'opening') + stat(money(r.closingBalance), 'closing')
    + stat(r.periodFrom + ' → ' + r.periodTo, 'period')
    + '</div></div>'
    + (r.warnings.length ? '<div class="msg"><b>Notes</b><ul>'
        + r.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></div>' : '')
    + (r.skippedRows.length ? '<div class="msg"><b>' + r.skippedRows.length
        + ' row(s) not read as transactions</b><ul>'
        + r.skippedRows.slice(0, 8).map((s) => '<li>line ' + s.index + ' — ' + esc(s.reason)
            + '<br><span class="narr">' + esc(s.text) + '</span></li>').join('')
        + '</ul></div>' : '')
    + '<h2>First rows</h2><div class="panel"><table>'
    + '<tr><th>Date</th><th>Narration</th><th class="num">Debit</th>'
    + '<th class="num">Credit</th><th class="num">Balance</th></tr>'
    + r.rows.map((x) => '<tr><td class="num">' + x.txnDate + '</td>'
        + '<td class="narr">' + esc(x.narration) + '</td>'
        + '<td class="num">' + (x.debit === '0.00' ? '' : x.debit) + '</td>'
        + '<td class="num">' + (x.credit === '0.00' ? '' : x.credit) + '</td>'
        + '<td class="num">' + (x.runningBalance ?? '') + '</td></tr>').join('')
    + '</table></div>';
};

$('commit').onclick = async () => {
  $('commit').disabled = true;
  const r = await post('/api/import', {
    bankAccountId: $('account').value, fileText: $('text').value, bank: $('bank').value,
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
  if (e.target.tagName === 'TEXTAREA' && !(e.metaKey || e.ctrlKey)) return;
  if (e.key === 'Enter') { e.preventDefault(); previewed ? $('commit').click() : $('preview').click(); }
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
           autoMatchable: number; ambiguous: number } },
  brs: Brs,
  accountId: string,
): string {
  const { items, totals } = queue;

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
      <td>${proposalCell(it.proposal, it.suggestedClassification)}</td>
    </tr>`).join('');

  return `<h1>Reconcile</h1>
<p class="sub">Sorted by confidence — clear the top in bulk, spend your attention
at the bottom. Nothing posts without you.</p>

<div class="panel strip">
  <div class="stat"><b>${totals.unmatched}</b><span>unmatched</span></div>
  <div class="stat"><b class="good">${totals.autoMatchable}</b><span>high confidence</span></div>
  <div class="stat"><b class="${totals.ambiguous ? 'bad' : ''}">${totals.ambiguous}</b><span>ambiguous</span></div>
  <div class="stat"><b class="${brs.ties ? 'good' : 'bad'}">${inr(brs.difference)}</b><span>BRS difference</span></div>
  <div style="margin-left:auto" class="row-actions">
    <button class="primary" id="bulk" ${totals.autoMatchable === 0 ? 'disabled' : ''}>
      Accept ${totals.autoMatchable} high-confidence <kbd>A</kbd>
    </button>
  </div>
</div>

${brs.ties ? '' : `<div class="msg bad"><b>The BRS does not tie.</b><br>${esc(brs.exception)}</div>`}

<div id="msg"></div>

${items.length === 0
  ? '<p class="empty">Nothing to reconcile. Import a statement to begin.</p>'
  : `<div class="panel" style="padding:0"><table>
      <tr><th>Date</th><th>Narration</th><th class="num">Out</th>
          <th class="num">In</th><th>Proposed match</th></tr>
      ${rows}
    </table></div>`}

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
rowsEl.forEach((r, i) => r.onclick = () => { sel = i; paint(); });

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

function say(ok, text) {
  document.getElementById('msg').innerHTML =
    '<div class="msg ' + (ok ? 'good' : 'bad') + '">' + text + '</div>';
}

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

  return `<h1>Bank Reconciliation Statement</h1>
<p class="sub">As at ${esc(brs.asOf)}. Book and bank balances differ legitimately —
this explains the difference item by item. A residual left over is an error, and
is never rounded away (BR-22).</p>

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
    return `<h1>Cash register</h1>${form}
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

  return `<h1>Cash register</h1>${form}
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
    return `<h1>GSTR-2B</h1>
      <p class="sub">Reconcile the purchase ledger against what suppliers filed.
      Under s.16(2)(aa), credit is claimable only on an invoice that appears here.</p>
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

  return `<h1>GSTR-2B</h1>
<p class="sub">What the books claim, against what suppliers filed. Credit is
claimable only on invoices that appear in 2B (s.16(2)(aa)).</p>

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
