# Defect & Gap Log

**Purpose:** every bug found so far, why it happened, and how it was caught — plus
everything knowingly left unbuilt. Kept because the *patterns* repeat: the same
three or four kinds of mistake keep reappearing in new modules, and a list of
them is cheaper to re-read than to rediscover.

**Status as of the statement-parser and reconciliation-screen build:** 184 tests
passing, typecheck clean, 10 migrations applied.

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

## Stage 7 — Statement parsing & the reconciliation screen

Ten defects, and notably **three of them were found only by using the screen**,
not by any test. That is the argument for building the UI when we did.

| # | Defect | What happened | Caught by | Resolution |
|---|---|---|---|---|
| P-1 | 🔴 **Tenant context leaked onto a pooled connection** | The web server set `app.firm_id` with `is_local = false` on a connection borrowed from the pool. That setting outlives the request and stays on the connection for whoever borrows it next — one firm's RLS context applied to another firm's query. | Code review while fixing P-8 | Replaced with `withFirm()`, which scopes the setting to the transaction. **The safe helper already existed; the bug was hand-rolling the unsafe version next to it.** Harmless in a single-firm local tool and fatal in production, which is the worst combination — it would not have shown up until multi-tenancy. |
| P-2 | 🔴 **Money coerced through `Number()`** | The derived-opening-balance path used `BigInt(Math.round(Number(v) * 100))` — the exact float round-trip banned everywhere else in the codebase — and its BigInt division also produced the wrong SIGN for balances under ₹1 (`-0.50` printed as `0.50`). | Code review before running | Rewritten with `paise()`/`money()`. Feeding a rounding artefact into the figure BR-6 checks against would have made the arithmetic check itself unreliable. |
| P-3 | 🟠 **`cr` matched inside "description"** | Column aliases were matched as plain substrings. `cr` is a substring of "des**cr**iption", so the narration column was claimed as the credit column, and every amount read from it threw. | `statementFile.test.ts` | Aliases now match on token boundaries. The failure surfaced as `"OPENING" is not a recognisable amount` — an error about amounts, thrown from a column-mapping bug. |
| P-4 | 🟠 **Every file parsed as "Generic"** | Templates were ranked by how many columns they resolved. A generic template declares looser aliases and therefore always resolves *more* columns than the specific one that actually fits, so the named bank templates could never win. | `statementFile.test.ts` | Priority now dominates the column count; a bank name found in the file outranks both. **A scoring function can be monotonic in the wrong direction — check that the intended winner can actually win.** (Same shape as K-2.) |
| P-5 | 🟠 **Kotak's template hijacked plain signed-amount files** | `mapColumns` never required the Dr/Cr flag column that the `amount_plus_type` convention depends on. Kotak (priority 90) matched a `Date/Description/Amount/Balance` file on its other columns, then skipped every row for "no Dr/Cr marker" — producing zero transactions while confidently reporting the bank name. | `statementFile.test.ts` | A convention's required columns are now part of whether the template matched at all. |
| P-6 | 🟠 **Bank detection ignored column signatures** | Only the bank *name* was used to detect a layout. Real exports frequently omit it while still having a distinctive column layout. | Own test fixture failing | All templates are now candidates; the name is a large bonus rather than a filter. Added a warning for the case where a file names a bank whose template does *not* fit — which is what a format change looks like from here. |
| P-7 | 🟠 **The queue proposed matches against unrelated invoices** | A ₹15,000 cash deposit and a ₹9,000 interest credit were each offered a "proposed match" scoring 5 and 2 — the score coming purely from two invoices happening to fall in the same month. | **Using the screen** | Added `MIN_PROPOSAL_SCORE`. A near-zero score is not a weak match, it is *no* match, and rendering it as a proposal invites a wrong click. |
| P-8 | 🟠 **…and then the floor hid real matches** | Set at 20, it discarded a ₹10,000 part payment from a known customer against their ₹25,000 invoice — scoring 17 on party plus date, because on a partial payment the amount legitimately cannot match. | **Using the screen** | Lowered to 15: "at least one signal stronger than date proximity". Both boundaries are now covered by the end-to-end test. |
| P-9 | 🟠 **`Promise.all` on one pg client** | Three queries issued concurrently on a single connection. `pg` warns today and throws in v9. | A deprecation warning in the server log | Serialised. The parallelism that matters is scoring in memory, not overlapping round trips. |
| P-10 | 🟡 Demo seed posted to a group account | Used `Capital Account` (a group) instead of the `Owner's Capital` leaf. | The `V-4` database trigger | **The GL's own validation caught a seeding bug** — the constraint working exactly as designed. |

### Validated against a real file

A real HDFC savings-account PDF export (from the user, page 1 only) confirmed the
HDFC template's columns and `dd/MM/yy` date format exactly — one of seven
placeholder templates now verified. It also broke the parser in three ways that
no invented fixture had reached:

| # | Defect | What happened | Resolution |
|---|---|---|---|
| P-11 | 🔴 **The opening balance was unfindable on a real statement** | HDFC puts it in a `STATEMENT SUMMARY` block at the **foot** of the file. `mineLabel` searched only the preamble, so it returned null — and BR-6, the check the entire import rests on, silently could not run. It fell back to deriving the balance from the running-balance column, which happens to work on this file and would not on one without that column. | Both balances are now searched above *and* below the transactions. |
| P-12 | 🟠 **Summary labels and values sit on different rows** | The block is `Opening Balance │ Dr Count │ Cr Count │ …` with the values on the *next* row. `mineLabel` only ever looked for a number on the label's own row. | The label's **column index** is now carried down to the following rows, so a value is read from beneath its own heading rather than from wherever a number happens to appear. |
| P-13 | 🟠 The period line was not recognised | HDFC writes `From : 01/07/2026`. The pattern required `from` followed directly by a digit and did not allow the colon, so the statement period fell back to the first and last transaction dates. | Colon and spacing made optional. |

Also confirmed: the summary block writes `Closing Bal`, not `Closing Balance`,
and narrations wrap across two physical lines inside one table cell.

**All three are the same lesson: the fixtures were written by the same person
who wrote the parser, so they encoded the same assumptions.** One real file
found in ten minutes what thirty-six invented tests had not.

### Deliberate divergence from the spec

§5.2 models per-bank templates as a versioned `bank_statement_templates`
table. They live in **code** instead: git already versions, reviews and tests
them, and a database table buys the ability to add a bank without a deploy —
which is not worth having before there is anyone to deploy for. Recorded so the
decision is visible when support engineers exist.

### On the value of the screen

P-7 and P-8 are the same defect approached from two sides, and **neither was
reachable by a unit test**, because both are judgements about what a human
should be shown rather than about whether a number is right. The engine was
correct in both cases; the presentation was misleading. That is a category of
defect that only appears when someone looks at the thing.

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

**4. Parameters chosen by intent rather than against the data.** K-2, P-4, P-7,
P-8. A number that sounds strict but is unreachable; a ranking monotonic in the
wrong direction; a floor set without checking what falls below it.
*Countermeasure:* compute the achievable range, and confirm the intended winner
can actually win.

**5. Hand-rolling the unsafe version of an existing safe helper.** P-1. The
`withFirm()` wrapper existed specifically to prevent the tenant leak that was
then reintroduced fifteen lines from it. *Countermeasure:* if a helper exists
for a concern, no code path may open that concern directly.

**7. Fixtures that share the author's assumptions.** P-11, P-12, P-13. Thirty-six
tests written alongside the parser missed three layout facts that one real file
exposed immediately. *Countermeasure:* validate every template against a genuine
export, redacted, before trusting it.

**6. Coercing at the wrong boundary.** P-2, P-3. Money through `Number()`; a raw
`1,00,000.00` returned from a parser and failing three modules later. Both
produced errors far from their cause. *Countermeasure:* coerce where the format
is known, and let the type carry the guarantee onwards.

And one from Stage 1: **asserting an integration works before probing it.**
Four of five vendor entries are corrected beliefs.

Finally, from Stage 7: **three defects were reachable only by using the
software.** P-7 and P-8 were both about what a human should be shown rather than
whether a number was right — the engine was correct and the presentation
misleading. No unit test can hold that opinion.

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
| G-5 | **No `.xlsx` or PDF reader** | CSV/TSV/delimited is done, with templates for HDFC, ICICI, SBI, Axis, Kotak and two generics. True `.xlsx` needs a dependency decision; PDF (BR-4, often password-protected) is untouched. **Every template's column headings are unverified against real files** — see B1 |
| G-6 | **Learned rules do not apply** | `bank_transaction_rules` table exists; nothing reads it. Layer 3 of the matching engine is absent, so T-11 is untested |
| G-7 | **1:N matching not implemented** | One payment against five invoices (T-9) — very common in B2B. The schema supports it; no code allocates it |
| G-8 | **Decentro webhook path untested** | Layer 0 in `proposeMatch()` is written but has no test. **BR-13 (VA settlement double-counting) is not implemented at all** — flagged in the spec as the most likely source of a double-count bug |
| G-9 | Mixed-ITC bills treated as wholly blocked | If any line is blocked, the whole bill is. Splitting is left to the caller |
| G-10 | `verifyTaxFigures` uses only line 1's GST rate | PB-4 cross-check is weaker than it looks on a multi-rate bill |
| G-11 | AI layer 4 is not wired | Match proposal, counterparty resolution, and anomaly flags (§14.2) are specified, not built |
| G-12 | **The review server has no authentication** | Binds to 127.0.0.1 only and is explicitly not production. It exists to get answers to §16.2 and §16.3 from a real CA. Do not expose it |
| G-13 | The screen covers reconciliation only | No invoice entry, no bill review, no reports in the UI. Everything else is still function calls |

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
| Statement files | 42 | `.xlsx`; password-protected PDFs; banks other than HDFC |
| End-to-end flow | 10 | Resolving the ambiguous pair; bulk accept |
| **Total** | **184** | |
