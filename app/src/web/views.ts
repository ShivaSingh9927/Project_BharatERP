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
.ask-toggle { white-space: nowrap; border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
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
@media (prefers-reduced-motion: no-preference) {
  .ask-drawer { animation: ask-in .16s ease-out; }
  @keyframes ask-in { from { transform: translateX(18px); opacity: .7; } }
}
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
/* A link that sits beside a button and should read as one. */
/* Who is signed in, and the way out. Deliberately a form and not a link:
   signing out changes state, and a GET that changes state can be triggered by
   anything that renders a URL. */
.who { margin-left: auto; display: flex; align-items: center; gap: 8px;
  font-size: 12px; color: var(--muted); }
.who button { padding: 3px 9px; font: inherit; font-size: 12px; }
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
  header { flex-wrap: wrap; }
  nav { order: 3; width: 100%; overflow-x: auto; }
  .sales-grid { grid-template-columns: 1fr; }
  .invoice-meta { grid-template-columns: repeat(2, minmax(130px, 1fr)); }
  .customer-form { grid-template-columns: 1fr 1fr; }
  .ledger-proof { position: static; }
  .entry-scroll { overflow-x: auto; }
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
  session: { clientName: string; displayName?: string; email?: string };
  accounts: Array<{ id: string; bank_name: string; last4: string }>;
  active: string;
  accountId?: string;
  body: string;
}): string {
  const q = a.accountId ? `?account=${encodeURIComponent(a.accountId)}` : '';
  const link = (href: string, key: string, label: string): string =>
    `<a href="${href}" class="${a.active === key ? 'on' : ''}">${label}</a>`;
  const prompts: Record<string, string[]> = {
    bills: ['How does this page work?', 'What needs attention?'],
    payables: ['How much do we owe suppliers?', 'What needs attention?'],
    receivables: ['How much do customers owe?', 'What needs attention?'],
    reconcile: ['Prepare reconciliation review', 'How many bank transactions need reconciliation?'],
    gstr2b: ['How much GST credit is at risk?', 'How does this page work?'],
    gstr1: ['What is our GST position?', 'What needs attention?'],
    gstr3b: ['What is our GST position?', 'What needs attention?'],
    firm: ['What needs attention?', 'How much do we owe suppliers?'],
    home: ['What needs attention?', 'How much GST credit is at risk?'],
  };
  const quick = prompts[a.active] ?? ['What needs attention?', 'How does this page work?'];
  const pageName = a.active === 'gstr2b' ? 'GSTR-2B'
    : a.active === 'gstr1' ? 'GSTR-1'
    : a.active === 'gstr3b' ? 'GSTR-3B'
    : a.active.charAt(0).toUpperCase() + a.active.slice(1);

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
    ${link('/firm', 'firm', 'Firm')}
    ${link('/assistant-runs', 'assistant-runs', 'AI log')}
    ${link('/', 'home', 'Home')}
    ${link('/accounts', 'accounts', 'Accounts')}
    ${link('/sales', 'sales', 'Sales')}
    ${link('/tally', 'tally', 'Tally import')}
    ${link('/bills', 'bills', 'Bills')}
    ${link('/payables', 'payables', 'Payables')}
    ${link('/suppliers', 'suppliers', 'Suppliers')}
    ${link('/import', 'import', 'Import')}
    ${link(`/reconcile${q}`, 'reconcile', 'Reconcile')}
    ${link(`/brs${q}`, 'brs', 'BRS')}
    ${link('/cash', 'cash', 'Cash')}
    ${link('/gstr2b', 'gstr2b', 'GSTR-2B')}
    ${link('/gstr1', 'gstr1', 'GSTR-1')}
    ${link('/gstr3b', 'gstr3b', 'GSTR-3B')}
    ${link('/tds', 'tds', 'TDS')}
    ${link('/receivables', 'receivables', 'Receivables')}
    ${link('/assets', 'assets', 'Assets')}
    ${link('/returns', 'returns', 'Returns')}
  </nav>
  <button type="button" class="ask-toggle" id="ask-toggle" aria-controls="ask-drawer"
    aria-expanded="false">Ask Bharat</button>
  <form method="post" action="/logout" class="who">
    <span title="${esc(a.session.email ?? '')}">${esc(a.session.displayName ?? '')}</span>
    <button type="submit">Sign out</button>
  </form>
</header>
<main>${a.body}</main>
<div class="ask-shade" id="ask-shade" hidden></div>
<aside class="ask-drawer" id="ask-drawer" aria-label="Ask Bharat" hidden>
  <div class="ask-head">
    <div><h2>Ask Bharat</h2>
      <div class="ask-context">${esc(a.session.clientName)} · ${esc(pageName)}</div></div>
    <button type="button" class="ask-close" id="ask-close" aria-label="Close Ask Bharat">×</button>
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
        aria-label="Question for Ask Bharat">
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
  const input = document.getElementById('ask-input');
  const send = document.getElementById('ask-send');
  const messages = document.getElementById('ask-messages');
  const setOpen = (open) => {
    drawer.hidden = !open; shade.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) input.focus(); else toggle.focus();
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
  toggle.onclick = () => setOpen(true); close.onclick = () => setOpen(false);
  shade.onclick = () => setOpen(false);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer.hidden) setOpen(false);
  });
  form.onsubmit = (event) => { event.preventDefault(); ask(input.value); };
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
    ? `DeepSeek · ${esc(r.intent ?? 'unsupported')}`
    : r.routingMode === 'deepseek_fallback' ? 'DeepSeek unavailable · local fallback'
    : 'Local deterministic tool';
  return `<section class="card wide"><h1>Ask Bharat AI log</h1>
    <p class="muted">A read-only record of what was asked, what route was used, and the evidence shown to this client.</p>
    ${runs.length === 0 ? '<p>No Ask Bharat questions have been recorded for this client yet.</p>' :
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
): string {
  if (accounts.length === 0) {
    return renderBankAccountSetup(today, '/accounts');
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
  </table></div>
  <details style="margin-top:16px"><summary>Add another bank account</summary>
    ${bankAccountForm(today, '/accounts')}
  </details>`;
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
      <label>Opening balance in your books
        <input id="opening-balance" value="0.00" inputmode="decimal">
      </label>
      <label>Balance date
        <input id="opening-date" type="date" value="${esc(today)}">
      </label>
    </div>
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
          openingBalance: document.getElementById('opening-balance').value,
          openingDate: document.getElementById('opening-date').value,
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
  return `<h1>Add your bank account</h1>
    <p class="sub">This connects the ledger to statement imports. It cannot move money.</p>
    ${bankAccountForm(today, returnTo)}`;
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

  return `<div class="sales-head">
  <div><h1>Sales invoices</h1>
    <p class="sub">Raise a GST invoice and post it to the ledger in one step.</p></div>
</div>
${a.created ? `<div class="msg good"><b>Invoice ${esc(a.created)} posted.</b> It is now in receivables and GSTR-1.</div>` : ''}
${a.draft ? '<div class="msg warn"><b>AI-prepared draft.</b> It has not posted anything. Confirm the description, HSN/SAC, amount, GST and dates before posting.</div>' : ''}

<details class="panel" ${desk.customers.length === 0 ? 'open' : ''}>
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
  return `<h1>Import from Tally</h1>
  <p class="sub">Start with a safe preview. Nothing is added to the books until
  the ledgers are mapped and you confirm the import.</p>

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
    suggestedAccountId?: string }>;
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
): string {
  const badge = p.status === 'ready'
    ? '<span class="tag good">Ready to post</span>'
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
    const chosen = l.suggestedAccountId ?? defaultAccountId ?? '';
    return `
    <tr>
      <td>${esc(l.description || 'Line ' + (i + 1))}${
        l.hsn ? ` <span class="muted">HSN ${esc(l.hsn)}</span>` : ''}</td>
      <td class="num">${inr(l.amount)}</td>
      <td>
        <select class="lineacct" data-line="${i}">${opt(chosen)}</select>
        ${l.suggestedAccountId ? '<span class="learned" title="learned from a previous bill">learned</span>' : ''}
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
      ${canPost
        ? `<button class="primary post" data-index="${p.index}" data-token="${esc(token)}">
             ${p.status === 'needs_answer' ? 'Confirm & post' : 'Approve & post'}</button>`
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
}): string {
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
    return `<div class="panel strip">
      <div class="stat"><b class="good">${c.ready}</b><span>ready</span></div>
      <div class="stat"><b class="${c.needs_answer ? 'warn' : ''}">${c.needs_answer}</b><span>need an answer</span></div>
      <div class="stat"><b class="${c.blocked ? 'bad' : ''}">${c.blocked}</b><span>blocked</span></div>
    </div>`;
  })();

  const postedRows = a.posted.map((b) => `
    <tr><td class="mono">${esc(b.number)}</td><td>${esc(b.party)}</td>
        <td>${esc(b.date)}</td><td class="num">${inr(b.total)}</td></tr>`).join('');

  return `<h1>Bills</h1>
<p class="sub">Every figure is read on the page and checked before it can post.
Nothing posts without you approving it.</p>

${a.hasExpenseAccount ? '' :
  '<div class="msg bad">This client has no Purchases account, so a bill has nowhere to post. Seed the chart of accounts first.</div>'}

${upload}
<div id="msg"></div>

${summary}
<div id="cards">
  ${a.proposals.map((p) => proposalCard(p, p.token ?? a.token ?? '', a.accounts, a.defaultAccountId)).join('')}
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
const say = (ok, t) => { document.getElementById('msg').innerHTML =
  '<div class="msg ' + (ok ? 'good' : 'bad') + '">' + t + '</div>'; };

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
      out.innerHTML = '<span class="good">Ready. Review and post the expense.</span>';
      const actions = card.querySelector(':scope > .billactions');
      actions.innerHTML = '<button class="primary post" data-index="' + box.dataset.index +
        '" data-token="' + box.dataset.token + '">Approve ₹' + box.dataset.total +
        ' expense</button>';
      wirePost(actions.querySelector('button.post'));
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
      out.innerHTML = '<span class="good">Saved — this bill now posts.</span>';
      const actions = card.querySelector(':scope > .billactions');
      if (actions && !actions.querySelector('button.post')) {
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
      out.innerHTML = '<span class="good">These hold together — you can post now.</span>';
      const actions = card.querySelector(':scope > .billactions');
      if (actions && !actions.querySelector('button.post')) {
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
}

export function renderDashboard(a: DashboardV): string {
  const picker = `
    <form method="get" action="/" class="row">
      <label>Period
        <select name="period" onchange="this.form.submit()">
          ${a.periods.map((p) =>
            `<option value="${esc(p)}" ${p === a.period ? 'selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
      </label>
    </form>`;

  const tile = (value: string, label: string, cls = '', href = ''): string => {
    const inner = `<b class="${cls}">${esc(value)}</b><span>${esc(label)}</span>`;
    return href
      ? `<a class="tile" href="${href}">${inner}</a>`
      : `<div class="tile">${inner}</div>`;
  };

  const risk = a.creditAtRisk === null
    ? tile('—', 'run a 2B reconciliation', 'muted', '/gstr2b')
    : tile(inr(a.creditAtRisk), 'credit booked, not yet filed',
           a.creditAtRisk === '0.00' ? 'good' : 'bad', '/gstr2b');

  const issues = a.registrationIssues.length === 0 ? '' : `
    <div class="msg bad"><b>${a.registrationIssues.length} supplier(s) with a
    registration that is not active.</b> Credit on their invoices needs a look.
    <ul class="warns">${a.registrationIssues.map((r) =>
      `<li>${esc(r.party)} — ${esc(r.gstin)} — <b>${esc(r.status)}</b></li>`).join('')}</ul>
    </div>`;

  const recent = a.recentBills.length === 0
    ? '<p class="empty">No bills posted yet. <a href="/bills">Upload some invoices.</a></p>'
    : `<div class="panel" style="padding:0"><table>
        <tr><th>Invoice</th><th>Supplier</th><th>Date</th><th class="num">Total</th></tr>
        ${a.recentBills.map((b) => `<tr>
          <td class="mono">${esc(b.number)}</td><td>${esc(b.party)}</td>
          <td>${esc(b.date)}</td><td class="num">${inr(b.total)}</td></tr>`).join('')}
      </table></div>`;

  return `<h1>Overview</h1>
<p class="sub">Where the client stands this period — and what still needs you.</p>

${picker}

<div class="tiles">
  ${risk}
  ${tile(a.creditSupported !== null ? inr(a.creditSupported) : inr(a.creditClaimed),
         a.creditSupported !== null ? 'credit 2B supports' : 'input credit claimed', 'good')}
  ${tile(String(a.openReconItems), 'reconciliation items open',
         a.openReconItems ? 'warn' : '', '/gstr2b')}
  ${tile(String(a.billsPosted), 'bills posted this period', '', '/bills')}
  ${tile(inr(a.purchaseValue), 'purchase value', '')}
  ${tile(inr(a.totalPayable), 'owed to suppliers', '', '/payables')}
  ${tile(inr(a.overduePayable),
         a.overdueCount ? a.overdueCount + ' bill(s) overdue' : 'nothing overdue',
         a.overduePayable === '0.00' ? 'good' : 'bad', '/payables')}
</div>

${issues}

<h2 class="mt">Recently posted</h2>
${recent}`;
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

  return `<h1>Payables</h1>
<p class="sub">What the client owes, oldest first. A payment posts to the ledger
and clears the bill.</p>

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
  return `<h1>Suppliers</h1>
<p class="sub">Everyone the client buys from. Open one for its full history.</p>
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
<h1>${esc(s.name)}</h1>
<p class="sub">${esc(s.legalName && s.legalName !== s.name ? s.legalName + ' · ' : '')}
  <span class="mono">${esc(s.gstin ?? 'no GSTIN')}</span>
  ${s.stateCode ? ` · state ${esc(s.stateCode)}` : ''} · ${esc(s.gstCategory)}</p>
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

  return `<h1>GSTR-1</h1>
<p class="sub">Outward supplies for the period — what the client sold, sorted
into the boxes the return files. The tax total below is the liability declared.</p>

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

  return `<h1>GSTR-3B</h1>
<p class="sub">The net: output tax owed, less the input credit available, is the
cash to pay. Credit is set off in the order the law fixes (Rule 88A).</p>

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

  return `<h1>Fixed assets</h1>
<p class="sub">What the client owns, what it has depreciated, and what it is
carried at. Accumulated depreciation sits as a contra-asset, so the cost stays
visible — what was paid and what is left are different questions.</p>

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
  customerName: string; invoiceDate: string; dueDate: string;
  grandTotal: string; outstanding: string; tdsWithheld: string;
  daysOverdue: number; bucket: string;
}

export function renderReceivables(a: {
  invoices: OutstandingInvoiceV[];
  accounts: Array<{ id: string; name: string }>;
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

  return `<h1>Receivables</h1>
<p class="sub">What customers owe, oldest first. Read from the ledger rather
than from a status column, so a receipt, a credit note and a write-off all
reduce it without anything being maintained by hand.</p>

<div class="panel strip">
  ${['not_due', 'd0_30', 'd31_60', 'd61_90', 'd90_plus'].map((k) =>
    `<div class="stat"><b class="${
      k === 'd90_plus' && buckets[k] ? 'bad' : k === 'd61_90' && buckets[k] ? 'warn' : ''
    }">${rupees(buckets[k] ?? 0n)}</b><span>${RBUCKET_LABEL[k]}</span></div>`).join('')}
  <div class="stat"><b>${rupees(total)}</b><span>total receivable</span></div>
</div>

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

  return `<h1>Purchase returns</h1>
<p class="sub">Goods that went back, and the bills they reduce. A debit note is
OUR document: it records that we are paying less and it reverses the input
credit we took. It does not reduce the supplier's liability — under s.34 only
their credit note does that, so each one below is tracked until it arrives.</p>

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
    return `<h1>TDS</h1>
<p class="sub">Nothing has been withheld yet. A bill posted to a head that
attracts TDS — professional fees, contract payments, rent, commission — asks
before it posts, and what is withheld shows up here with its deposit date.</p>`;
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

  return `<h1>TDS</h1>
<p class="sub">Tax withheld on bills, and what is owed to the government. The
deadline hangs off the month the tax was DEDUCTED in, not the month somebody
gets round to paying it — so a March deduction is payable by 30 April however
late the bill was entered.</p>

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

interface CockpitRowV {
  clientId: string; name: string; gstin: string | null;
  outputTax: string; creditAtRisk: string; reconciled: boolean;
  overduePayable: string; overdueCount: number; billsPosted: number;
  registrationIssues: number;
  gstr1Due: string; gstr3bDue: string;
  daysToGstr1: number; daysToGstr3b: number; attention: number;
}

export function renderCockpit(a: {
  period: string; periods: string[]; today: string;
  rows: CockpitRowV[];
  totals: { clients: number; outputTax: string; creditAtRisk: string;
    overduePayable: string; needingAttention: number };
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

  return `<h1>The firm</h1>
<p class="sub">Every client, sorted by what needs you. Deadlines are the
standard monthly dates — clients on the QRMP scheme file to a different
calendar this does not know about.</p>

${picker}

<div class="panel strip">
  <div class="stat"><b>${a.totals.clients}</b><span>clients</span></div>
  <div class="stat"><b class="${a.totals.needingAttention ? 'bad' : 'good'}">${a.totals.needingAttention}</b><span>need attention</span></div>
  <div class="stat"><b>${inr(a.totals.outputTax)}</b><span>tax declared</span></div>
  <div class="stat"><b class="${a.totals.creditAtRisk === '0.00' ? '' : 'bad'}">${inr(a.totals.creditAtRisk)}</b><span>credit at risk</span></div>
  <div class="stat"><b>${inr(a.totals.overduePayable)}</b><span>overdue payables</span></div>
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
