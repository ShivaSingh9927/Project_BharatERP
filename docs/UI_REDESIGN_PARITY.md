# BharatERP UI redesign parity checklist

This checklist tracks existing server routes and user-visible actions while
the mockup handoff is integrated. A route is complete only when its current
data, actions, role gates, and important states remain reachable in the new
shell. The mockup bundle is a visual reference; its example client and figures
must never be used as application data.

## Implementation progress — 2026-10-12

- The shared navigation, Today/Nexus entry, firm cockpit, reports, close-month,
  and customer-list integration are in the pushed first slice described in
  PROJECT_STATUS.md.
- The current follow-on slice updates /documents with selectable client
  documents and status/type filters, and /bills with review-state filters
  and an explicit next-step cue. /sales and /customers now use the same
  page heading and orientation pattern. These additions keep using the current
  server-rendered, client-scoped data and existing write endpoints.
- Focused views and workflow tests pass for documents, bills, sales, and the
  shared shell. Authenticated visual review across owner and CA roles, and
  remaining Bank, GST/TDS, and Tally mockup-specific refinements, are still
  open. All routes remain reachable through the shared navigation.

## Shared shell

- [ ] Owner navigation: Today, Ask Nexus, Inbox, Bills, Sales, Bank, GST & TDS,
  Reports, client context, sign out.
- [ ] Firm navigation: Firm cockpit, firm email inbox, review desk, Tally
  import, client workspace, sign out.
- [ ] Contextual sub-navigation keeps every existing route reachable.
- [ ] Role-based visibility remains backed by server authorization.
- [ ] Responsive, keyboard-operable navigation and accessible focus states.
- [ ] Ask drawer remains available from every page and stays read-only.

## Existing page routes and primary workflows

| Route | Mockup / destination | Existing behavior to preserve | State |
|---|---|---|---|
| `/` | Today 12a | Dashboard totals, attention, alerts, obligations, setup, follow-ups | [ ] |
| `/firm` | Today 12b | CA firm cockpit, client attention and period filter | [ ] |
| `/setup` | Restyle in shared shell | Client setup progress | [ ] |
| `/activity` | Restyle in shared shell | Client activity history | [ ] |
| `/documents` | Inbox 10a | Upload/email documents, classification suggestion and human confirmation, review/request info/dismiss/restore, source download | [ ] |
| `/email-inbox` | Inbox 10c | Firm email intake, assignment, trusted sender behavior | [ ] |
| `/nexus` | Ask Nexus 11a/11c | Durable cases, saved response blocks/evidence, read-only bank activity, bounded long-running review tasks and consent | [ ] |
| `/attention` | Restyle in shared shell | Alerts, obligation attention and source links | [ ] |
| `/follow-ups` | Today 12c | Create, assign, complete, block, snooze, history | [ ] |
| `/assistant-runs` | Restyle in shared shell | Audited assistant run history | [ ] |
| `/bills` | Bills 9a–9c | Read/preview/fill/post workflow, classifier consent, duplicate and exception review | [ ] |
| `/payables` | Bills 15a | Supplier balances and payment recording | [ ] |
| `/suppliers`, `/suppliers/:id` | Bills 15b | Supplier list, supplier detail and GST status | [ ] |
| `/returns` | Bills returns | Purchase returns and credit/debit notes | [ ] |
| `/sales`, `/sales/:id` | Sales 13b–13c | Customer/invoice creation, invoice detail, print/share | [ ] |
| `/receivables` | Sales 13a | Receipts, TDS withholding and write-off review | [ ] |
| `/customers` | Sales 13d | Client-scoped customer list, add customer via existing form, customer statement | [ ] |
| `/accounts` | Bank 16a | Account setup, opening balance, account-specific BRS link | [ ] |
| `/import` | Bank 8b | Statement preview/import, protected PDF opening, password controls, coverage | [ ] |
| `/reconcile` | Bank 8a | Match/classify/ignore/review, Nexus suggestions, bulk and keyboard actions | [ ] |
| `/brs` | Bank 8c | Exact bank reconciliation statement | [ ] |
| `/cash` | Bank 16b | Cash register and below-zero checks | [ ] |
| `/gstr2b` | GST & TDS 14a | Import/fetch, match, resolve and credit risk | [ ] |
| `/gstr1` | GST & TDS 14b | Sales return preparation | [ ] |
| `/gstr3b` | GST & TDS 14c | Liability, set-off, draft and recorded filing state | [ ] |
| `/tds` | GST & TDS 14d | TDS position and challan recording | [ ] |
| `/assets` | Reports 17d | Fixed assets and depreciation workflow | [ ] |
| `/tally` | Firm 17f | Tally preview, mapping, import and result | [ ] |
| `/password` | Authentication | Authenticated password change; session invalidation behavior | [ ] |
| `/nexus/source/bank-transaction` | Ask Nexus evidence | Read-only client-scoped source statement line; no accounting action | [ ] |

## Existing supporting actions and endpoints

These are current routes backing the views above. They remain on the existing
server/domain paths and keep their current authorization and append-only rules;
the redesign must not call around them or create parallel write paths.

| Area | Existing actions to keep reachable | State |
|---|---|---|
| Authentication | `POST /logout`; password change page and submit | [ ] |
| Inbox | upload/download, classifier consent, confirm class, in-review, request information, dismiss/restore; firm email sample and assignment/trust actions | [ ] |
| Nexus | ask question, read-only bank activity, task consent/create/run; follow-up list/create/update/history | [ ] |
| Sales | create customer and invoice; invoice print/share; receipts, TDS withheld, write-off | [ ] |
| Bills | classifier consent, preview/fill/post, supplier creation, reverse-charge rate, supplier payment, returns and credit notes | [ ] |
| Banking | account setup, password forget, statement preview/import, opening balance, classify/review/ignore bank line; BRS and reconciliation views | [ ] |
| GST & TDS | run/resolve 2B matching; prepare returns; record TDS challan | [ ] |
| Fixed assets and reports | approve/post depreciation; period close and audited override reason using the server-rendered form | [ ] |
| Tally | preview import, map ledgers, confirm import | [ ] |

The mockup handoff also depicts Reports 17a–17c. These screens are wired to
the existing report and close-period domain logic through client-scoped pages;
the report view only formats ledger-derived values. The customer list has a
page route that reuses the existing customer read model and create form.
No database migration or JSON/public API route is added for this redesign.

## Explicitly deferred capabilities

- [ ] Do not add mockup-only health scoring, bank payouts, cash diary import,
  automatic document routing, supplier reminders, or expanded Tally migration
  unless separately authorized and specified.
- [ ] Do not remove any route merely because it lacks a dedicated mockup; adapt
  its current view to the shared shell.

## Final acceptance

- [ ] Every existing route, control, action, role gate, and important empty,
  loading, error, blocked, and completed state is accounted for above.
- [ ] Representative owner, CA partner, CA staff, and auditor workflows pass.
- [ ] No AI suggestion alone posts, pays, files, imports, or reconciles.
- [ ] Focused UI/domain tests and the complete app test suite pass.
