# Defect & Gap Log

**Purpose:** every bug found so far, why it happened, and how it was caught — plus
everything knowingly left unbuilt. Kept because the *patterns* repeat: the same
three or four kinds of mistake keep reappearing in new modules, and a list of
them is cheaper to re-read than to rediscover.

**Status as of the bank-reconciliation build:** 132 tests passing, typecheck
clean, 10 migrations applied.

---

## How to read this

Each defect records **how it was caught**, because that is the actionable part.
A bug caught by a test is a process that worked. A bug caught by the user
reading a screenshot is a process that did not.

| Symbol | Meaning |
|---|---|
| 🔴 | Would have shipped and caused financial or security harm |
| 🟠 | Would have shipped and been visibly wrong |
| 🟡 | Caught during development; no route to production |
| ⚪ | Not a code bug — a wrong belief, corrected |

---

## Stage 1 — Vendor evaluation

| # | Defect | What happened | Caught by | Resolution |
|---|---|---|---|---|
| V-1 | ⚪ **Decentro KYC — I contradicted myself** | First probe returned `E00031 no subscription`, which was correct. Seeing "KYC" in the dashboard sidebar, I reversed and claimed the module *was* enabled and my endpoint paths were wrong. A third screenshot showed the KYC transaction log containing my own three probe IDs — proving the paths were right and the module genuinely is not subscribed. | User screenshot | Original diagnosis restored. **A feature appearing in a dashboard is not evidence it is provisioned.** |
| V-2 | ⚪ **"AA-as-a-service via Finbox/Perfios"** | I proposed these as a clean way around the FIU wall. They are TSPs that serve *already-regulated* FIUs; they confer no eligibility. | User found Perfios' own page stating Sahamati/FIU registration is required | Path abandoned. **Vendor marketing describes what a vendor does for licensed customers, not what it does for you.** |
| V-3 | 🟡 **Setu `/v2/consents` returns 500** | Every client-side cause ruled out (payload shape, auth headers, product instance ID, redirect URL). Server-side bug on Setu's side. | Systematic probing | Documented in `research/SETU-SANDBOX-INTEGRATION-STATUS.md`; raised with Setu. Moot after the AA decision. |
| V-4 | ⚪ **AA/FIU wall** | BharatERP cannot be a direct Account Aggregator FIU — requires RBI/SEBI/PFRDA/IRDAI regulation. | User's own reading of Setu's onboarding form | Statement upload became the primary path. Every major Indian product (Tally, Zoho, Vyapar) does the same, so this is the normal path, not a compromise. |
| V-5 | ⚪ **GSP wall** | Cannot become a GSP — ₹2 Cr paid-up capital, ₹5 Cr 3-year turnover. | Portal documentation | Route GST through a licensed partner. Sandbox (Quicko) selected and probe-validated. |

**Pattern:** four of five entries here are *my* wrong beliefs, not code. Every
one was corrected by the user pointing at primary evidence — a dashboard log, a
vendor's own page, a registration form. **Probe before asserting; a plausible
architecture is not a verified one.**

---

## Stage 2 — Environment & infrastructure

| # | Defect | What happened | Caught by | Resolution |
|---|---|---|---|---|
| E-1 | 🟡 `--experimental-strip-types` unsupported | Used the Node 22 flag on Node 20. | First run | Switched to `tsx`. |
| E-2 | 🟡 `docker compose down` → permission denied | Container cannot be stopped by the current user. | `npm run db:reset` | Wrote `src/db/reset.ts` (drops and recreates the schema; refuses any non-localhost `DATABASE_URL`). |
| E-3 | 🟠 **`npm run db:reset` shelled out to the broken docker path** | It called `docker compose down -v`, which fails (E-2) — so the script aborted and silently left the old schema in place. During the bank build this made a *fixed* migration appear not to work, because it was never re-applied. | Confusion during the bank build | Repointed at `src/db/reset.ts`. **A reset that fails to reset is worse than no reset script: it makes you distrust a correct fix.** |

---

## Stage 3 — GL engine

| # | Defect | What happened | Caught by | Resolution |
|---|---|---|---|---|
| G-1 | 🟡 **RLS rejected every `account_versions` insert** | The RLS policy resolved the firm through a subquery on `accounts`, but the BEFORE INSERT trigger fires *before* the account row exists — so the subquery found nothing and the policy denied the write. | First seed run | Denormalised `firm_id` onto `account_versions`. Fixed in place; nothing was live. |
| G-2 | 🔴 **`vouchers` had an UPDATE grant** | Needed to set `reversed_by_id` after a reversal. That single grant silently breaks the append-only guarantee that the entire audit-trail spec rests on — a posted voucher becomes editable. | Reviewing grants against AT-2 | Dropped the column. The reverse link is derived by the `vouchers_with_reversal` view. **Anything you can compute, do not store — especially if storing it requires UPDATE on an immutable table.** |
| G-3 | 🟠 **Balance Sheet retained profit: 8,60,000 instead of 1,40,000** | The P&L bucket summed income **plus** expenses instead of income *minus* expenses. | `reports.test.ts` — the balance sheet did not balance | Only `asset` uses `debit − credit`; every other root type uses `credit − debit`. **Sign conventions must be stated per root type, never assumed uniform.** |

---

## Stage 4 — Invoicing

| # | Defect | What happened | Caught by | Resolution |
|---|---|---|---|---|
| I-1 | 🟡 Test asserted the wrong validator | I asserted the GSTIN *checksum* catches an OCR misread. The **layout** regex catches it first — the misread put a digit where the PAN requires a letter. | Test failure | Test corrected. Code was right. |
| I-2 | 🟡 Test arithmetic wrong | Asserted `10555 × 9% = 950.00`. It is `949.95`. | Test failure | Test corrected. Code was right. |

**Note:** both invoicing "failures" were bad tests, not bad code — the only
module so far with that record. The GST computation was written directly from
the spec's worked examples, which is likely why.

---

## Stage 5 — Bills & expenses

| # | Defect | What happened | Caught by | Resolution |
|---|---|---|---|---|
| B-1 | 🔴 **TDS returned ₹0 once the threshold was already crossed** | Used the *individual payment* as the taxable base while still subtracting prior deductions. Double-counting drove the result negative, and a `max(0)` clamp turned it into a clean, confident **₹0**. | `bills.test.ts` | When `crossesNow \|\| wasAlreadyOver`, base = `cumulative_after`; in the `singleMet` branch, `already = 0n`. **Silent under-deduction — the exact failure the module exists to prevent. A clamp that hides a negative also hides the bug that produced it.** |
| B-2 | 🟠 **Purchase-side round-off sign inverted** | Applied the sales-side round-off rule to purchases. | The deferred `V-1` DB constraint at COMMIT: `debits 12454.90, credits 12455.10` | On a **sale** the rounded figure is a DEBIT (Debtors), so rounding up needs a credit. On a **purchase** it is a CREDIT (Creditors), so rounding up needs a **debit**. Not symmetric — opposite. Round-off also excluded from RCM entirely, since both RCM legs use unrounded values. |

**B-2 is the clearest evidence the database-level constraint earns its cost.**
Application code produced an unbalanced voucher and the DB refused it. No
invalid row ever existed.

---

## Stage 6 — Bank & reconciliation

| # | Defect | What happened | Caught by | Resolution |
|---|---|---|---|---|
| K-1 | 🔴 **The BV-6 cross-tenant check was a no-op** | The trigger fetched the voucher and compared `client_id`s. But it runs as the calling role, so **RLS applies inside the trigger**: another firm's voucher is not a different `client_id`, it is *invisible*. `SELECT … INTO` left the record NULL, the comparison became `NULL <> NULL` → `NULL`, and `IF NULL` does nothing. The foreign key still resolved, because **FK checks bypass RLS**. Result: a cross-tenant match inserted cleanly through the control written to stop it. | `bank.test.ts` T-16 | Added an explicit `IF NOT FOUND THEN RAISE`. **A security control that reads correctly and enforces nothing is the most dangerous kind. Every isolation rule needs a test that actually attempts the violation.** |
| K-2 | 🟠 **`AUTO_MATCH_THRESHOLD` was unreachable** | Set to 60. The highest score achievable *without* a UTR is 50 (exact amount 30 + party 15 + date 5), and most Indian statement lines carry no UTR — so nothing would ever have auto-matched. The feature would have shipped and quietly done nothing. | `bank.test.ts` — a should-auto-match case did not | Lowered to 45, derived from the weights rather than picked round. A merely-plausible line (tolerance 15 + party 15 + date 5 = 35) still stays below the bar. Both boundaries now tested. **A threshold is only meaningful relative to the score distribution it filters; check the maximum achievable score, not just the intent.** |
| K-3 | 🟡 Test had the discrepancy sign backwards | A dropped *debit* makes the computed closing too high, so `declared − computed` is negative. | Test failure | Test corrected. Code was right. |

### Deliberate divergence from the spec

`bank_transactions` has **no `status` or `matched_amount` column**, though
§4 of the spec lists both. Both are derived by the
`bank_transactions_reconciled` view instead — same reasoning as "no stored
balances" in the GL. A stored `matched_amount` is a second source of truth that
drifts the first time a match is reversed outside the one code path that
maintains it.

### Spec correction — BR-16

The spec's example implies TDS is a percentage of the invoice **gross**. It is
not: where GST is shown separately, TDS is deducted on the value **excluding
GST** (CBDT Circular 23/2017). A ₹50,000 + 18% invoice = ₹59,000, and 10% TDS
is ₹5,000, not ₹5,900. Checking the shortfall against the gross would miss
every invoice carrying tax — which is most of them. Implemented against
`taxable_value`. **Needs CA confirmation.**

---

## Recurring patterns

Four failure modes account for nearly every 🔴 and 🟠 above.

**1. The control that silently does nothing.** G-2, K-1. A rule exists, reads
correctly, and never fires. *Countermeasure:* for every guarantee, write the
test that attempts the violation. A test that only proves the happy path proves
nothing about the guard.

**2. A clamp or default that hides the bug producing it.** B-1. `max(0)` turned
a negative into a plausible zero. *Countermeasure:* if a value should never be
negative, assert it — do not clamp it.

**3. Assumed symmetry between mirrored operations.** B-2, G-3. Sales↔purchase,
asset↔liability. The mirror is usually *not* a sign flip on the same formula.
*Countermeasure:* derive each side independently, then compare.

**4. Parameters chosen by intent rather than against the data.** K-2. A number
that sounds strict but is unreachable. *Countermeasure:* compute the achievable
range before setting a cutoff inside it.

And a fifth, from Stage 1: **asserting an integration works before probing it.**
Four of five vendor entries are corrected beliefs.

---

## Known gaps — knowingly unbuilt

### Blocking before any pilot

| # | Gap | Why it matters |
|---|---|---|
| G-2 | **All GST rates, TDS sections, and ITC categories are `PLACEHOLDER`** | The *shape* is committed, the *numbers* are not verified. Every one needs CA sign-off before a real filing |
| G-3 | `business_type` is hardcoded `NULL` in `bills.ts` | So *conditional* ITC always routes to a human. Safe, but it means the transport/catering exceptions never auto-resolve |
| G-4 | Period close does not call `assertReconciledForClose()` | BR-23 is implemented but not wired into the close path |

### Built partially

| # | Gap | Detail |
|---|---|---|
| G-5 | **No statement file parsers** | `importStatement()` takes already-parsed rows. No CSV/Excel reader, no `bank_statement_templates` table, no per-bank column maps. BR-3 says ship CSV/Excel first — not started |
| G-6 | **Learned rules do not apply** | `bank_transaction_rules` table exists; nothing reads it. Layer 3 of the matching engine is absent, so T-11 is untested |
| G-7 | **1:N matching not implemented** | One payment against five invoices (T-9) — very common in B2B. The schema supports it; no code allocates it |
| G-8 | **Decentro webhook path untested** | Layer 0 in `proposeMatch()` is written but has no test. **BR-13 (VA settlement double-counting) is not implemented at all** — flagged in the spec as the most likely source of a double-count bug |
| G-9 | Mixed-ITC bills treated as wholly blocked | If any line is blocked, the whole bill is. Splitting is left to the caller |
| G-10 | `verifyTaxFigures` uses only line 1's GST rate | PB-4 cross-check is weaker than it looks on a multi-rate bill |
| G-11 | AI layer 4 is not wired | Match proposal, counterparty resolution, and anomaly flags (§14.2) are specified, not built |

### Not started

- e-Invoice (IRP) and e-Way Bill
- GST return generation — GSTR-1, 3B, 2B reconciliation
- GST portal session management (spec written in `gst-engine.md` §9.1)
- Audit-grade export and the two-tool auditor access (`provenance.md` §9, §10)
- Cash book (§16.4 — many Indian SMBs run significant cash)
- OD/CC accounts (§16.6 — credit balances, different interest treatment)
- Payments execution (Cashfree/Decentro payouts)
- Any user interface

### Open questions needing a human answer

| From | Question |
|---|---|
| invoicing §14.2, gst-engine §15.3 | **Is a client one GSTIN, or one PAN with several?** Affects the tenancy model — should be answered before more schema is written |
| bank §16.1 | Which banks do the pilot CAs' clients actually use? Build those parsers, not a guessed top-ten |
| bank §16.2 / bills §13.2 | Will a CA allow high-confidence matches to auto-post? Materially changes the hours-saved figure |
| bank §16.3 | Monthly at close, or continuous? Shapes the entire reconciliation UI |
| bank §16.5 | Auto-apply TDS inference, or always ask? *Currently: always ask* |

### External dependencies

- LlamaParse and Sandbox rate cards not obtained
- Taxpayer-session concurrency untestable until the user's GST registration is live (gst-engine §15.10)
- Sandbox keys are **live** (`key_live_`/`secret_live_`), running on free credits — no sandbox tier exists

---

## Test coverage by module

| Module | Tests | Notably untested |
|---|---|---|
| GL engine | 19 | — |
| Reports | 10 | Cash flow statement |
| Invoicing | 29 | e-Invoice failure cases (§8.5) |
| Bills | 26 | GSTR-2B matching against real 2B data |
| Bank | 48 | Decentro webhook path, 1:N allocation, learned rules |
| **Total** | **132** | |
