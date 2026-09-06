# BharatERP — GL Engine

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
npm test              # 29 acceptance tests
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

Not yet: HTTP API, e-Invoice IRP calls, e-Way Bill, the LlamaParse/DeepSeek
extraction calls themselves, bank reconciliation, GST returns, period close,
multi-currency, cost centers.

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
