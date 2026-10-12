# BharatERP UI redesign parity checklist

This checklist tracks existing server routes and user-visible actions while
the mockup handoff is integrated. A route is complete only when its current
data, actions, role gates, and important states remain reachable in the new
shell. The mockup bundle is a visual reference; its example client and figures
must never be used as application data.

## Implementation progress — 2026-10-12

- `/nexus` now follows the Ask Nexus 11a handoff structure: a saved-chat rail,
  a focused conversation/composer, and a live evidence and attention panel.
  “New conversation” opens a blank thread while preserving prior chats. The
  right panel uses the latest saved structured-answer provenance, client
  documents, open review desk items, and recent activity; it shows an explicit
  empty evidence state when no structured sources are attached. Upload, bank
  activity, document-request answers, task consent/history, follow-up creation,
  and CA-only firm links remain connected to their existing handlers and role
  checks. No example client names or figures from the mockup were reused.

- The shared navigation, Today/Nexus entry, firm cockpit, reports, close-month,
  and customer-list integration are in the pushed first slice described in
  PROJECT_STATUS.md.
- The current follow-on slice updates /documents with selectable client
  documents and status/type filters, and /bills with review-state filters
  and an explicit next-step cue. /sales and /customers now use the same
  page heading and orientation pattern. These additions keep using the current
  server-rendered, client-scoped data and existing write endpoints.
- Bank reconciliation, statement import, BRS, cash, GSTR-1/2B/3B, TDS, fixed
  assets, and report views now share section-labelled page headings. Their
  existing domain data and action controls remain in place.
- The CA firm cockpit and Tally import also use the shared heading pattern;
  their period filter, client switch links, XML preview, ledger mapping, and
  human-confirmed import remain unchanged.
- Activity, firm email inbox, review desk, bank accounts, payables, suppliers,
  receivables, purchase returns, and client setup now follow the same heading
  system so pages without a dedicated mockup still feel part of one workspace.
- Owner and CA contextual destinations are covered by a navigation regression
  test; owner-only client actions and CA firm links are shown according to the
  existing role context.
- Firm-only screens use their firm navigation without falling back to the
  Today sub-navigation; CA email and review-desk destinations do not appear
  twice when the same route is already present in contextual navigation.
- Typecheck passes and the full suite passes: 70 files, 1,010 tests. This is
  automated behavior coverage, not a replacement for signed-in visual review.
- Dedicated Bank, GST/TDS, and Tally mockup layouts were not invented where
  their handoff pages did not specify a concrete approved change. Those
  existing workflows are retained in the shared shell. Authenticated visual
  review at desktop/mobile sizes across owner and CA roles remains open.

## Shared shell

- [x] Owner navigation: Today, Ask Nexus, Inbox, Bills, Sales, Bank, GST & TDS,
  Reports, client context, sign out.
- [x] Firm navigation: Firm cockpit, firm email inbox, review desk, Tally
  import, client workspace, sign out.
- [x] Contextual navigation exposes each existing route group; password and
  sign-out remain available from the shared header, and detail/source pages
  remain linked from their parent workflows.
- [x] Role-based visibility and write authorization remain backed by the
  existing server checks; owner/CA navigation differences have render tests.
- [x] Responsive navigation, keyboard focus indication, and skip-to-content
  support are implemented in the shared shell.
- [x] Ask drawer remains available from every rendered page and uses the
  read-only assistant endpoint.

## Existing page routes and primary workflows

| Route | Mockup / destination | Existing behavior to preserve | State |
|---|---|---|---|
| `/` | Today 12a | Dashboard totals, attention, alerts, obligations, setup, follow-ups | Restyled; dashboard and full-suite tests pass |
| `/firm` | Today 12b | CA firm cockpit, client attention and period filter | Restyled; cockpit and full-suite tests pass |
| `/setup` | Restyle in shared shell | Client setup progress | Retained; full-suite tests pass |
| `/activity` | Restyle in shared shell | Client activity history | Retained; full-suite tests pass |
| `/documents` | Inbox 10a | Upload/email documents, classification suggestion and human confirmation, review/request info/dismiss/restore, source download | Redesigned; inbox view/workflow tests pass |
| `/email-inbox` | Inbox 10c | Firm email intake, assignment, trusted sender behavior | Restyled; email intake and role navigation tests pass |
| `/nexus` | Ask Nexus 11a/11c | Durable cases, saved response blocks/evidence, read-only bank activity, bounded long-running review tasks and consent | Redesigned; Nexus view tests pass; signed-in responsive visual checks remain |
| `/attention` | Restyle in shared shell | Alerts, obligation attention and source links | Retained; attention view/domain tests pass |
| `/follow-ups` | Today 12c | Create, assign, complete, block, snooze, history | Retained; follow-up domain tests pass |
| `/assistant-runs` | Restyle in shared shell | Audited assistant run history | Retained; assistant view/domain tests pass |
| `/bills` | Bills 9a–9c | Read/preview/fill/post workflow, classifier consent, duplicate and exception review | Redesigned; bill view/workflow tests pass |
| `/payables` | Bills 15a | Supplier balances and payment recording | Retained; full-suite tests pass |
| `/suppliers`, `/suppliers/:id` | Bills 15b | Supplier list, supplier detail and GST status | Retained; full-suite tests pass |
| `/returns` | Bills returns | Purchase returns and credit/debit notes | Retained; purchase return tests pass |
| `/sales`, `/sales/:id` | Sales 13b–13c | Customer/invoice creation, invoice detail, print/share | Oriented in shared shell; sales view/workflow tests pass |
| `/receivables` | Sales 13a | Receipts, TDS withholding and write-off review | Retained; receivable tests pass |
| `/customers` | Sales 13d | Client-scoped customer list, add customer via existing form, customer statement | Restyled; report and sales view tests pass |
| `/accounts` | Bank 16a | Account setup, opening balance, account-specific BRS link | Retained; bank account and permission tests pass |
| `/import` | Bank 8b | Statement preview/import, protected PDF opening, password controls, coverage | Retained; statement and bank workflow tests pass |
| `/reconcile` | Bank 8a | Match/classify/ignore/review, Nexus suggestions, bulk and keyboard actions | Retained; reconciliation and bank review tests pass |
| `/brs` | Bank 8c | Exact bank reconciliation statement | Retained; bank workflow tests pass |
| `/cash` | Bank 16b | Cash register and below-zero checks | Retained; cash register tests pass |
| `/gstr2b` | GST & TDS 14a | Import/fetch, match, resolve and credit risk | Retained; GSTR-2B tests pass |
| `/gstr1` | GST & TDS 14b | Sales return preparation | Retained; GSTR-1 tests pass |
| `/gstr3b` | GST & TDS 14c | Liability, set-off, draft and recorded filing state | Retained; GSTR-3B tests pass |
| `/tds` | GST & TDS 14d | TDS position and challan recording | Retained; TDS workflow tests pass |
| `/assets` | Reports 17d | Fixed assets and depreciation workflow | Retained; fixed-asset tests pass |
| `/tally` | Firm 17f | Tally preview, mapping, import and result | Retained; Tally workflow tests pass |
| `/password` | Authentication | Authenticated password change; session invalidation behavior | Retained; authentication tests pass |
| `/nexus/source/bank-transaction` | Ask Nexus evidence | Read-only client-scoped source statement line; no accounting action | Retained; Nexus evidence tests pass |

## Existing supporting actions and endpoints

These are current routes backing the views above. They remain on the existing
server/domain paths and keep their current authorization and append-only rules;
the redesign must not call around them or create parallel write paths.

| Area | Existing actions to keep reachable | State |
|---|---|---|
| Authentication | `POST /logout`; password change page and submit | Existing handlers retained; auth suite passes |
| Inbox | upload/download, classifier consent, confirm class, in-review, request information, dismiss/restore; firm email sample and assignment/trust actions | Existing handlers retained; inbox/email suites pass |
| Nexus | ask question, read-only bank activity, task consent/create/run; follow-up list/create/update/history | Existing handlers retained; assistant/Nexus/follow-up suites pass |
| Sales | create customer and invoice; invoice print/share; receipts, TDS withheld, write-off | Existing handlers retained; sales/invoice/receivable suites pass |
| Bills | classifier consent, preview/fill/post, supplier creation, reverse-charge rate, supplier payment, returns and credit notes | Existing handlers retained; bill/purchase-return suites pass |
| Banking | account setup, password forget, statement preview/import, opening balance, classify/review/ignore bank line; BRS and reconciliation views | Existing handlers retained; bank/account/import/reconciliation suites pass |
| GST & TDS | run/resolve 2B matching; prepare returns; record TDS challan | Existing handlers retained; GST/TDS suites pass |
| Fixed assets and reports | approve/post depreciation; period close and audited override reason using the server-rendered form | Existing handlers retained; assets/report/period-close suites pass |
| Tally | preview import, map ledgers, confirm import | Existing handlers retained; Tally suites pass |

The mockup handoff also depicts Reports 17a–17c. These screens are wired to
the existing report and close-period domain logic through client-scoped pages;
the report view only formats ledger-derived values. The customer list has a
page route that reuses the existing customer read model and create form.
No database migration or JSON/public API route is added for this redesign.

## Explicitly deferred capabilities

- Mockup-only health scoring, bank payouts, cash diary import, automatic
  document routing, supplier reminders, and expanded Tally migration remain
  deferred unless separately authorized and specified.
- Routes without dedicated mockups remain in the app and use the shared shell.

## Final acceptance

- [x] Existing routes, action families, and role distinctions are inventoried
  above; navigation regression tests cover owner route groups, CA firm links,
  and duplicate destinations.
- [ ] Signed-in visual review at desktop and mobile sizes for owner, CA partner,
  CA staff, and auditor views, including important empty/error/blocked states.
- [x] No AI suggestion alone posts, pays, files, imports, or reconciles.
- [x] Focused UI/domain tests and the complete app test suite pass (70 files,
  1,010 tests); TypeScript typecheck passes.
