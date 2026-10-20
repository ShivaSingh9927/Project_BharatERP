# BharatERP application — engineering notes

> This document began as the GL-engine build guide. Its ledger invariants
> remain useful, but feature lists and test counts below are historical and may
> be stale. See [`../docs/PROJECT_STATUS.md`](../docs/PROJECT_STATUS.md) for the
> dated implementation snapshot and [`../AGENTS.md`](../AGENTS.md) for
> repository-wide engineering rules.

## Shared email inbox and Cloudflare bridge

Firm-scoped CA users can open **Email inbox** in the local app. The page shows
each client's stable reference (`inbox+REFERENCE`) and accepts sample messages
with attachments. A clear recipient reference routes to that client. A sender
explicitly trusted by a CA can also route mail, unless it conflicts with a
recipient reference. Unknown or conflicting mail stays in **Unassigned** until
a CA assigns it. Assignment registers attachments in the client's existing
Documents inbox; it never posts accounting entries. Message IDs are
idempotent, and the intake record preserves each attachment entry even when
identical file content is stored only once.

The pilot Worker and R2 importer in
[`../cloudflare/email-intake`](../cloudflare/email-intake/README.md) store raw
MIME privately while the PC is off and import it when the local importer runs.
The exact pilot address has passed an end-to-end test; the general `inbox@`
route still forwards to the verified Gmail mailbox. The local sample form
continues to use `example.test`.

Each assigned attachment gets a review classification. A PDF filename alone
is not enough to call it a statement. Nexus can answer who sent each recent
email, when Cloudflare received it, which attachment arrived, and whether a
CA dismissed it. The original remains available even when dismissed. Nothing
in this email path posts transactions.

For a protected bank PDF, a CA first adds the bank account and opens the file
in **Bank sync** with its password. After the parser verifies that the account
number matches, the CA can choose **Remember securely for this account** and
independently opt in to **Automatically open future emailed statements for this
account**. Consent can be revoked by clearing that option on a later preview
or by clicking **Forget saved password**. With consent, new attachments are
opened only for assessment; parsed rows still require CA review and manual
import. Unknown, malformed, unrelated, or mismatched attachments remain in
the review queue. A dismissed file must be restored before statement import.

## Client document inbox

The local review app now has a **Documents** page. A signed-in user can upload
originals for their selected client, list received files, and download a
verified original. A document can be opened in the existing bill review flow;
that flow re-reads the durable original at approval time. `Bharat Nexus` can
answer which files are in that client's inbox. Uploading a file does not post
an accounting entry, and bill posting requires a CA partner session.

Files are stored under `app/.data/workspace/<firm-id>/<client-id>/originals/`
by SHA-256 hash. Set `DOCUMENT_WORKSPACE_ROOT` to an absolute directory to put
the workspace elsewhere. Keep this directory on durable storage and back it up;
the database records the file's address and metadata but not its bytes. The
workspace is ignored by Git. The endpoint accepts files up to 5 MB. The
original filename is display metadata only and cannot influence the path.

The document inbox preserves the source file, supports review notes and
information requests, and keeps AI suggestions separate from human class
confirmation. Class confirmation only enables the next workflow link; the
workflow itself still performs its own parsing and review. Bill preview cards
are cached in memory for display, but the original file is durable and the
approval step reads it again from the workspace.

Bill extraction uses Poppler text and word coordinates first. If those fail or
the invoice table does not pass its checks, the app tries local PaddleOCR, then
GLM-OCR when `ZAI_API_KEY` or `ZAI_API_KEY_FILE` is configured and the firm's
extraction consent is enabled. GLM-OCR sends the original document to z.ai;
password-protected PDFs are kept local. Scanned PDFs use page-scoped PaddleOCR
tables so multiple invoices in one file remain separable. Excel statements are
read from workbook cells and do not use this OCR chain.

Implementation of [`specs/gl-engine.md`](../specs/gl-engine.md) and the
immutability guarantees in [`specs/audit-trail.md`](../specs/audit-trail.md).

## Run it

```bash
cd app
npm install
cp .env.example .env
docker compose up -d
npm run migrate
npm run seed          # creates a firm, client, FY 2026-27, and 59 accounts
npm test
```

`npx tsx src/db/reset.ts` drops and recreates the schema (refuses any
non-localhost `DATABASE_URL`).

## What exists

| Area | Status |
|---|---|
| Chart of accounts + version history | ✅ |
| India CoA template, Tally-style naming | ✅ 59 accounts |
| Fiscal years (Apr–Mar) + monthly periods | ✅ |
| Vouchers → ledger entries (two-layer) | ✅ |
| Atomic gapless voucher numbering | ✅ |
| Validation V-1…V-6, V-12 | ✅ |
| Append-only enforced by DB permission | ✅ |
| Reversal (corrections are never edits) | ✅ |
| Audit log + tamper-evident hash chain | ✅ |
| Row-level security per firm | ✅ |
| Trial Balance, P&L, Balance Sheet, Ledger | ✅ |
| Parties (customers/suppliers) | ✅ |
| GSTIN checksum + layout validation | ✅ |
| Date-ranged GST rate master | ✅ |
| Tax computation (intra/inter-state, cess, round-off) | ✅ |
| Sales invoices → GL posting | ✅ |
| Rule 46(b) invoice numbering | ✅ |
| Outstanding derived from settlements | ✅ |
| Document ingestion + extraction provenance (bboxes) | ✅ schema |
| ITC eligibility — Section 17(5) blocked credits | ✅ |
| GSTR-2B claimability gating | ✅ |
| TDS section master + threshold-crossing | ✅ |
| Reverse charge (dual-leg posting) | ✅ |
| 180-day ITC reversal monitor | ✅ |
| Supplier payment with TDS withholding | ✅ |

The following was the not-yet-built list when this GL-engine guide was first
written. It is historical rather than a current gap list: check the current
routes, migrations, tests, and `docs/PROJECT_STATUS.md` before using it to plan
work.

- e-Invoice IRP calls and e-Way Bill integrations
- Full external extraction-provider integrations
- Period close, multi-currency, and cost centers

## Two decisions worth knowing before you change anything

**1. Immutability is a database permission, not a convention.**

`migrations/007_append_only.sql` revokes `UPDATE` and `DELETE` on `vouchers`,
`ledger_entries`, `audit_log`, and `account_versions` from the application
role. The app connects as `bharaterp_app` (`APP_DATABASE_URL`), never as the
schema owner.

This means a bug, a bad migration, or a leaked connection string **cannot**
rewrite posted history. Tests `AT T-1`…`AT T-3` assert the database refuses.

Consequence: nothing on a posted voucher can be mutated. That is why
`reversed_by_id` is *not* a column — the reverse link is derived by the
`vouchers_with_reversal` view. If you find yourself wanting an `UPDATE` on a
ledger table, the design is wrong, not the permission.

**2. Reports are queries. There are no stored balances.**

No `balance` column exists anywhere. Trial Balance, P&L and Balance Sheet all
aggregate `ledger_entries` on demand. This removes drift bugs and is what makes
the append-only ledger natural rather than awkward.

If Trial Balance gets slow at volume, add a monthly rollup as a *derived
cache* that can be rebuilt from scratch — never as the source of truth.

## Validation runs twice, deliberately

- **Application** (`src/domain/posting.ts`) — clear, rule-tagged errors for
  callers. Error messages carry the spec rule, e.g. `V-1: debits 11800.00 ≠
  credits 10900.00`.
- **Database** (constraints + triggers) — the actual guarantee. `V-1` is a
  `DEFERRABLE INITIALLY DEFERRED` constraint trigger checked at `COMMIT`, so a
  multi-line voucher is verified as a whole and an unbalanced one cannot exist
  even if application validation is skipped entirely.

## Money is never a float

Amounts are `string` in TypeScript and `numeric(18,2)` in Postgres.
`pg` is configured to return numerics as strings. Arithmetic in
`src/domain/posting.ts` uses `BigInt` paise. IEEE-754 cannot represent `0.01`,
and a rounding artefact in a ledger is an unbalanced voucher.

## Tests map to spec rules

`test/gl-engine.test.ts` implements `gl-engine.md` §11 T-1…T-17 and
`audit-trail.md` §8. `test/reports.test.ts` uses the **worked examples from the
accounting lessons**, so expected figures are ones derived by hand:

- Lesson 7's manufacturing P&L — Gross ₹2,50,000
- Lesson 3 — Assets = Liabilities + Equity; Drawings reduce equity and never
  touch the P&L
- Lesson 8 — Accumulated Depreciation nets against Fixed Assets (₹3,00,000 −
  ₹30,000 = ₹2,70,000)
- Lesson 9 — Working Capital from `liquidity_class`

`test/invoicing.test.ts` covers `invoicing.md` §13 — GSTIN validation, the
intra/inter-state split, Rule 46(b) numbering under concurrency, rate
resolution from the date-ranged master, and address snapshotting.

Two bugs were caught by writing these rather than by reading the code: an RLS
policy that could not see its own parent row during a `BEFORE INSERT` trigger,
and a Balance Sheet sign error that summed income *plus* expenses and reported
retained profit as ₹8,60,000 instead of ₹1,40,000.

## Round-off polarity is inverted between sales and purchases

Not a symmetry to be tidied away. On a sales invoice the rounded figure sits on
the **debit** side (Debtors), so rounding up needs an extra credit. On a
purchase bill it sits on the **credit** side (Creditors), so rounding up needs
an extra **debit**. Reverse-charge postings use unrounded values on both sides
and take no round-off at all.

Getting this wrong produced `V-1: unbalanced — debits 12454.90, credits
12455.10` and was caught by the deferred constraint at COMMIT rather than by
review.

## Identifier validation is two-layered, and both layers earn their place

`src/domain/gstin.ts` checks **layout** and then **check digit**. The DeepSeek
OCR probe misread a vendor GSTIN as `27AAFP54321L1ZK` — a digit landed where
the PAN requires a letter, so the layout check rejects it before the checksum
runs. A transposition that preserves the shape (`AAPFS` → `AAPSF`) slips past
layout and is caught only by the check digit. Both cases are tested.

This matters because on that misread invoice **every arithmetic check passed** —
lines summed to the taxable total, tax equalled taxable × 18%, the grand total
was consistent. Arithmetic cannot catch a corrupted identifier. These two
checks cost microseconds and are the only thing that can.
