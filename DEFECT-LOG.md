# Defect & Gap Log

**Purpose:** every bug found so far, why it happened, and how it was caught — plus
everything knowingly left unbuilt. Kept because the *patterns* repeat: the same
three or four kinds of mistake keep reappearing in new modules, and a list of
them is cheaper to re-read than to rediscover.

**Status as of the OCR build:** 260 tests
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

### A second real file — SBI, and a money-sign bug

A real SBI net-banking PDF (password-protected) exposed a defect worse than any
of the above, plus a scoping fact that changes the roadmap.

| # | Defect | What happened | Resolution |
|---|---|---|---|
| P-14 | 🔴 **`CR` was read as negative — backwards** | SBI writes balances as `2,41,933.51CR`, no space. On an Indian statement a **CR balance means the customer HAS the money**; DR means overdrawn. The parser flagged `Cr` as negative, so a real brought-forward balance of ₹2,41,933.51 parsed as **−₹2,41,933.51** — a sign flip on the very figure BR-6 checks against, which would have reported a nonsense discrepancy of nearly ₹5 lakh and blamed the parse. **A test asserted the wrong behaviour, so it looked correct.** | `Dr` → negative, `Cr` → positive; the marker is also exposed as `suffix` for callers that need it. Test corrected. |
| P-15 | 🟠 The SBI template's date format was wrong | Declared `dd MMM yyyy`; the real file uses `01/09/2026`. It survived only because `parseDate` is permissive about separators and uses the format solely to choose day-first vs month-first — a lucky accident, not a design. One document carries **two** formats: `dd/MM/yyyy` in rows, `dd-MM-yyyy` in headers and the summary. | Corrected to `dd/MM/yyyy`. |

**P-14 is the worst defect in this log.** It is a money error, on real data, in the
direction that breaks the product's central validation — and it was protected by
a passing test that encoded the same misunderstanding.

### The PDF path is much bigger than BR-3 implies

The SBI file is a PDF, and even after text extraction it is **not delimited** —
it is whitespace-aligned fixed-width columns. Four properties make it a
different component, not a variation on the CSV reader:

- **No column header row survives extraction at all.** Only the word `Balance`
  appears. `findHeaderRow()` has nothing to find, so the entire template-matching
  approach is inapplicable.
- **Column positions shift between pages** — page 1 rows start at column 0, page 2
  at column 1 with wider columns.
- **Narrations span four to five physical lines**, with continuation text both
  *above* and *below* the line carrying the amounts (`WDL TFR` sits above).
- Repeated per-page headers and footers (`Page no. 1`, form feeds) interleave
  with the data.

BR-3 ("ship CSV/Excel first, PDF is a later concern") is right, but §5.1's
estimate of PDF as merely "good, extractable with pdfplumber" understates it: it
needs column-position inference, row grouping, and per-page recalibration. If
pilot CAs receive statements like this one, **CSV-first does not cover them** —
which makes question B1 more urgent than it looked.

### The `.xlsx` export answers B1 — and it works

A real SBI **spreadsheet** export of the same account settles the format
question decisively. Unlike the PDF, it is properly tabular:

```
Date | Details | Ref No/Cheque No | Debit | Credit | Balance
```

One row per transaction, narration in a single cell, plain unformatted amounts.
Converted to CSV, **the existing parser read it correctly on the first attempt**:

| Check | Result |
|---|---|
| Transactions read | 10 |
| Debit / credit split | **9 / 1 — matching the statement's own `Dr Count` / `Cr Count`** |
| BR-6 | PASS — `241933.51 + 50000.00 − 12120.00 = 279813.51` |
| Opening balance | mined from `Brought Forward (₹)` in the foot summary |
| Period | read from `Statement From : 01-09-2026 to 06-09-2026` |

The `Dr Count`/`Cr Count` pair is worth noting as a second, independent
completeness check: the balance test proves the *amounts* are right, the counts
prove no *row* was missed. Worth adding to BR-6 where a statement provides them.

Every fix from the two preceding sections was exercised by this file on real
data — P-11 and P-12 (opening balance in a foot summary grid, value beneath its
label), P-13 (the `Statement From` line), P-14 (`2,41,933.51CR` as positive).
Two real files were enough to validate all four.

| # | Defect | What happened | Resolution |
|---|---|---|---|
| P-16 | 🟡 **The SBI template did not match its own bank's export** | The real narration heading is `Details`, which the template did not list, so `mapColumns` returned null and the file fell through to Generic. The result was still correct — but only because Generic happened to list the alias. | Added `details`, and `ref no/cheque no` without the full stop. **The BR-5 warning added in P-6 is what caught this**, by reporting that a recognised bank's template had not fitted. |

**Conclusion for the roadmap:** BR-3 is confirmed — spreadsheet exports are the
path, and they largely work today. But note SBI's `.xlsx` is **encrypted OOXML**
(`CDFV2 Encrypted`), so the spreadsheet path needs a decryption step *and* an
`.xlsx` reader before it works without manual conversion. Neither is built.

### A second HDFC account — narration defects

A second real HDFC statement (different account) confirmed the template is
**stable across accounts**: identical column headings, identical `From : … To :`
line, identical foot summary grid, and BR-6 passing on its own figures
(`162,636.17 + 133.00 − 37,476.60 = 125,292.57`). Its `Dr Count` / `Cr Count`
of 5 / 2 again offers the free completeness check (G-15).

Testing the narration rules against its real UPI formats found three defects:

| # | Defect | What happened | Resolution |
|---|---|---|---|
| P-17 | 🔴 **An IFSC was read as the UTR** | Real narration: `UPI-XXXXXXX7140-SBIN0000641-624861888406`. The reference is `624861888406`; `SBIN0000641` is the counterparty bank's IFSC, which also matches the UTR shape (four letters plus digits). Because a UTR is *preferred* over a positional match (BR-10), the IFSC **overwrote the correct reference**. | An IFSC is excluded by its defining property — eleven characters with `0` in the fifth position — and on a UPI line the numeric id now beats a UTR-shaped token. |
| P-18 | 🟠 A credit-card bill payment matched no rule | `IB BILLPAY DR-HDFC93-361135XXXX4700` is a card bill paid from the bank account, and no rule fired, so it would have been sent to the model to classify. | New `card_bill_payment` rule. It must settle Credit Card Payable and never an expense (§18.5) — the spend is already on the card statement. |
| P-19 | 🟠 The mandate reference was glued to the party name | `ACH C- EXAMPLE COMPANY-32256648` yielded a counterparty of `COMPANY-32256648`, so party resolution would fail on every direct debit. | Trailing digits captured as the reference; counterparty is now `EXAMPLE COMPANY`. |

**P-17 is the second-worst defect in this log**, after the CR sign inversion, and
for the same structural reason: it silently corrupts the signal the matching
engine trusts most. Its failure mode is also worse than a single wrong value —
an IFSC is identical for every transaction from that bank, so dozens of
transactions would have claimed the same reference.

**One further hazard, recorded but not yet handled:** HDFC wraps narrations
*mid-token*. `...PTYBL-Y` on one line and `ESB0PTMUPI-...` on the next is the
single token `YESB0PTMUPI`. Continuation lines must therefore be joined with
**no separator**; joining with a space or newline — the obvious choice —
corrupts the reference. This only bites once a fixed-width PDF reader exists
(G-14), so it is a note for that work rather than a defect today.

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

## Stage 8 — the `.xlsx` reader

Built dependency-free: a minimal zip reader over Node's `zlib`, plus a sheet
reader. Deliberate, because this code opens **files uploaded by users**, so
every dependency is attack surface. Decryption is the exception and is kept an
**optional** import — ECMA-376 agile encryption is AES over a SHA-512
key-derivation chain, and the available package is version 0.1.0, which is a
supply-chain call for whoever deploys rather than one to make silently.

| # | Defect | What happened | Caught by | Resolution |
|---|---|---|---|---|
| X-1 | 🔴 **A styled blank cell swallowed its neighbour** | Real Excel writes an empty-but-formatted cell as `<c r="D23" s="122"/>`. The greedy `[^>]*` attribute group consumed the trailing slash, so the cell was treated as an OPENING tag and consumed the next cell as its body — then read that cell's shared-string *index* as a value. On the real SBI statement a **₹50,000 credit became a ₹50 debit, in the wrong column**. | **BR-6, on the real file** — `dr/cr` read as 10/0 against the statement's own 9/1, and the balance was out by ₹50,050 | Non-greedy attribute group, so the `/>` branch can match. |
| X-2 | 🟠 The identical bug in the `<row>` tag | `<row r="5"/>` was likewise treated as an opening tag and swallowed the following row, shifting the summary block up and losing a transaction. | Synthetic fixture | Same fix. **Found and fixed BEFORE X-1 — and I did not think to check the cell regex for the same defect.** |

### Why the tests could not catch X-1

The fixture builder wrote blanks as **omitted** cells, which is what Excel does
for an *unstyled* blank. Real statements are formatted, so their blanks are
`<c r="D23" s="122"/>` — present, styled, self-closing. The fixtures encoded
half of reality, so sixteen passing tests said nothing about the case that
mattered.

The fixture builder now distinguishes the two (`null` = absent,
`undefined` = styled blank) and both are tested.

**This is the clearest illustration in the log of why BR-6 exists.** Every
component reported success: the file decrypted, the zip opened, the template
matched, ten rows parsed, dates and amounts all looked like dates and amounts.
Only the *arithmetic over the whole document* knew that ₹50,000 had moved to the
wrong side. A confidence score could not have found this; a checksum did.

### The full path now works on the real file

```
encrypted .xlsx → decrypt → zip → sheet → template match → BR-6
10 rows · 9 debits / 1 credit (matching the statement's own counts) · PASS
```

---

## Stage 9 — the PDF parser

Text extraction is delegated to `pdftotext -layout` (poppler-utils) and stays
**local**. Implementing PDF text extraction means fonts, encodings and CMaps,
whose failure mode is silently wrong characters. And a bank statement carries
the account number, the address and every counterparty a client pays, so
sending them to a hosted parser is a data-protection decision for the CA firm
as data fiduciary — not a library choice to make on their behalf.

Both real PDFs now parse with BR-6 passing, and each one's transaction count
matches the Dr/Cr totals the statement itself prints.

| # | Defect | What happened | Caught by | Resolution |
|---|---|---|---|---|
| D-1 | 🟠 **The address block destroyed the table's columns** | Boundaries were measured over the whole page. The account-holder address sits exactly where the table's gutters are, so no gap was found between the date and narration columns and they merged into one 85-character column. | Both real PDFs failing outright | Measure per region. |
| D-2 | 🔴 **A column empty on every transaction vanished** | Second attempt measured blocks separated by blank lines. HDFC puts blank lines BETWEEN transaction rows, so the header landed in its own block and the table was measured without it. The deposit column — empty on a month of withdrawals — had no ink, read as a gutter, and disappeared. Every column to its right shifted left and the **closing balance landed under "Deposit Amt."** | BR-6 | The table region is the span from the first dated line to the last, *including the header line above it* — the header is exactly the line that pins down columns no transaction fills. |
| D-3 | 🔴 **A header label does not sit where its values sit** | The deepest of the three, and specific to fixed-width text. Numbers are right-aligned under left-aligned labels: `Deposit Amt.` begins at character 162 while its values begin at 184. Matching template aliases against the header mapped the credit column onto an empty span and the balance column onto the deposits — five debits, **no credits**, and a balance short by exactly the credits it had lost. | BR-6, off by exactly ₹133 — the two credits | For fixed-width input the columns are **always inferred from the data**, never from the header. The header is still used to identify the bank (which supplies the date format); it is simply unusable for positions. |
| D-4 | 🟠 A reference number counted as an amount column | `0000624531110990` parses as a perfectly good number, so the reference column became a candidate for the debit column. | Inference test | A money column must also be *written* like money: a two-decimal fraction. References have no decimal point. |
| D-5 | 🟠 A continuation line's text was read from the wrong column | SBI's `WDL TFR` marker sits above the first transaction and therefore lands in the *preamble* region, which is aligned differently. Reading `columns.narration` from it found an empty cell and the marker was silently lost. | Fixture test | A continuation line has no date and no amounts by definition, so all of its cells are narration — take the text from every cell. |
| D-6 | 🟡 `Page No .: 1` was not recognised as furniture | The punctuation between "No" and the number varies more than the pattern allowed. | Fixture test | Separators matched loosely. |

### The idea worth keeping: debit vs credit from the running balance

With no header, two adjacent mostly-blank money columns are indistinguishable —
nothing about the values says which is the withdrawal. But the **running balance
does**: if the balance fell, that row's amount was a debit.

So the assignment is derived from arithmetic the statement already carries, and
the same evidence that decides it also scores it — the parser reports how many
rows agreed and how many disagreed rather than asserting a guess. On the real
SBI statement the evidence was unanimous. It also handles a layout with the
columns in credit-then-debit order without any special casing.

### Three of the six were caught by BR-6, not by tests

D-2 and D-3 both produced parses where **every component reported success**:
the PDF opened, the columns were found, the rows parsed, the dates were dates
and the amounts were amounts. Only the arithmetic over the whole document knew
that money had moved between columns. D-3 was out by exactly ₹133.00 — the two
credits it had dropped — which is what made it diagnosable at all.

Fixed-width parsing has more ways to be subtly wrong than any other format
here, and BR-6 is the reason a wrong parse is a refusal rather than a corrupt
import.

### Known limitation

Continuation lines attach to the row above by default, and a per-bank
`forwardMarkers` list (`WDL TFR`, `DEP TFR`, …) attaches downward. The two cases
are genuinely indistinguishable from text alone, so this is an explicit list
rather than a heuristic. A marker not on the list attaches to the wrong
transaction's narration — which degrades party and mode detection but cannot
affect the arithmetic, since narration carries no money.

---

## Stage 10 — seven sample statements from the web

Seven images of published sample statements (not client data, so no privacy
question). They are **736 px wide — roughly 90 DPI**, where table text is about
six pixels tall, so OCR on these specific files is not viable and none was
attempted. Their value was different and larger: four bank layouts we had never
seen, two of which broke the parser.

| Bank | Date format | What it brought |
|---|---|---|
| Federal Bank | `dd-MMM-yyyy` | **Integer amounts** — `456072`, no decimals or separators — plus a `Tran Type` C/D flag *alongside* separate withdrawal and deposit columns |
| IndusInd | `dd-MMM-yyyy` | Opening balance as a **`Brought Forward` row inside the table** |
| Karur Vysya | `dd/MM/yyyy` | A constant `Brn Code` numeric column; a summary box printing the BR-6 equation **and** `CR:67/DR:67` counts |
| Bank of Baroda | `dd-MM-yyyy` | A `Serial No` column; `-` placeholders; opening balance as an **`Opening Balance` row inside the table** |

| # | Defect | What happened | Resolution |
|---|---|---|---|
| S-1 | 🔴 **Money columns were identified by formatting** | Detection required amounts to be written with paise. Federal Bank writes `456072`, so on it **no money column was found at all** — the parse produced no balance, no debit and no credit. The rule had been added two stages earlier to stop a 16-digit reference number being mistaken for money, and it traded one failure for a worse one. | Money columns are now found by **arithmetic**: for each candidate trio, does `balance[i] − balance[i−1]` equal `credit[i] − debit[i]`? The trio satisfying that on the most rows wins. See below. |
| S-2 | 🔴 **The opening balance can be a table row** | Two of five layouts label the first table row `Brought Forward` / `Opening Balance` — a dated row with a balance and no amounts. Searching only the preamble and trailer missed it, and **without an opening balance BR-6 cannot run at all**. | Recovered from the skipped rows, matching the same opening-balance labels. |
| S-3 | 🟡 No templates for these four banks | — | Added, and the header comment now states which templates are verified against real files, which are transcribed from published samples, and which remain guesses. |

### Identifying money by arithmetic instead of by appearance

This replaced two separate heuristics — a formatting test for "is this money"
and a balance-direction test for "which one is the debit" — with one question
asked of every candidate trio of columns:

```
balance[i] − balance[i−1]  ==  credit[i] − debit[i]  ?
```

It is BR-6 applied row by row, and it is better than judging columns by how
they look on four counts:

- it works whether or not amounts carry decimals, separators or a currency mark
- it excludes numeric columns that are not money — a serial number, a branch
  code, a sixteen-digit UPI reference — without needing a rule for each
- it settles debit versus credit as a side effect, including on a
  credit-then-debit column order
- it reports how many rows agreed and how many disagreed, so a weak inference
  is visible instead of silent

Where nothing reproduces a balance it falls back to shape and says outright that
the parse is unverified.

### BR-6 caught an error in the test fixture

While transcribing the Bank of Baroda sample I put ₹76,000 in the debit column
on a row whose balance *rose* by ₹76,000. The parser was correct and the fixture
was wrong, and the balance check said so: `a difference of 152000.00 … the
running balance first disagrees at row 2`.

Twice now the arithmetic has corrected the person writing the tests rather than
the code. That is worth more than it sounds: it means the check is independent
of the assumptions that produced the parser.

### OCR remains unbuilt, deliberately

At 90 DPI these images would give digit errors, and digit errors in amounts are
the one category BR-6 cannot repair — it would detect them and refuse every
import, which is correct but useless. OCR is worth building against 300 DPI
scans, where BR-6 becomes a genuine accuracy gate rather than a blanket
rejection.

---

## Stage 11 — OCR, measured before it was built

LlamaParse was probed against a published sample statement (~90 DPI) **before**
any integration was written, on the principle from Stage 1 that a plausible
vendor is not a verified one.

### The measurement

It returned a clean **markdown table** — already delimited, so the entire
fixed-width apparatus is bypassed and the shared table parser handles the rest.
The header block and the account-summary box were read perfectly, including
`13,312.62 / 78,248.52 / 91,176.21 / 384.93` and `CR:67/DR:67`.

Accuracy was scored objectively, by asking of every row whether
`balance[i] − balance[i−1] == credit − debit`:

| | |
|---|---|
| Rows | 29 |
| Row-level reconciliation | **25 agreed / 3 failed — 89.3%** |
| Actual digit errors | **2 balances**, in one page |
| Debits and credits | **all correct** |

Two wrong figures in thirty rows is not good enough to import. But no
confidence score would have said *which* two — and the arithmetic says it
exactly:

```
row 16: 2082.49 + 105.00 → expected 2187.49, stated 1877.49
row 17: 1877.49 − 1000.00 → expected  877.49, stated 1887.49
row 18: 1887.49 −  800.00 → expected 1087.49, stated  387.49
```

Three consecutive failures bracketing two bad cells, because each balance is
checked against the row before and the row after.

### What that changes about the feature

**The useful output of OCR is not the statement — it is the list of cells to
fix.** That turns retyping a page into correcting two numbers, and it is only
possible because a bank statement carries its own arithmetic. The same
principle as BR-6, applied per row instead of per document.

So OCR ships as an **error locator with a human in the loop**, not as an import
path. It is opt-in twice — a key must be configured *and* the caller must pass
`ocr: true` — and it is never a silent fallback when a text layer is missing,
because a third-party upload must be someone's decision rather than the
consequence of a bad scan.

| # | Change | Why |
|---|---|---|
| O-1 | 🟠 `badRows` now reports **every** disagreeing row, not just the first | One bad row was enough to debug a mis-parse and useless for fixing a scan. |
| O-2 | 🔴 The balance walk **resumes from the stated balance** | It previously carried its own running total forward, so one misread digit made every subsequent row disagree — a thirty-row report that says nothing. Now one error stays one error. |
| O-3 | 🟠 A never-numeric column could win the money-column search | Passing a date column as the debit candidate makes the expected movement `credit − 0`, which is indistinguishable from the correct reading on every credit-only row. On a statement with more credits than debits that degenerate trio outscored the real one. Candidates that never hold a number are now dropped inside `findMoneyColumns`, so no caller has to know. |
| O-4 | 🟡 The header scan stopped at row 30 | OCR turns every line of prose into a row, so the transactions header sat at row 33 and was never reached. Raised to 60; a data row is still excluded by the numeric-cell test rather than by its position. |

### Known limitation: one page of a multi-page statement cannot pass BR-6

The sample is page 1 of a longer statement, so its rows sum to ₹31,191 of debits
against a stated total of ₹91,176.21. BR-6 correctly refuses it. Importing a
scanned statement therefore needs **every page**, or per-page opening and
closing balances — not one page at a time.

### Cost and privacy, stated plainly

The free tier is 10,000 credits. One 15-page statement × 50 clients × 12 months
does not fit inside it, so this is a recurring cost where `pdftotext` is free —
which is why OCR is reached only when there is genuinely no text layer.

And the upload is a DPDP Act decision for the CA firm as data fiduciary. The
sample statements used here came from the web, so no client data was sent; a
real client's statement must not be, without their firm knowingly choosing it.

---

## Stage 12 — PaddleOCR, measured against LlamaParse

Self-hosted OCR was probed because the LlamaParse dependency is load-bearing in
three separate ways at once — accuracy, recurring cost, and a cross-border
transfer the CA firm carries the liability for. Removing one vendor that sits on
all three is worth an afternoon.

`paddlepaddle 3.3.1` + `paddleocr 3.7.0` (PP-OCRv6_medium det + rec), CPU only,
in a `uv` venv outside the repo. Models cache to `~/.paddlex` (~100 MB).

### The apples-to-apples comparison

Same Karur Vysya image, same scorer — the statement's own row arithmetic:

| | LlamaParse | PaddleOCR |
|---|---|---|
| Rows reconciled | 25 / 28 = **89.3%** | 28 / 28 = **100%** |
| Misread balances | 2 | 0 |
| Per page | ~10 s | 93 s |
| Cost | metered | zero |
| Data leaves India | yes | no |

Across all seven sample images: **122 agreed / 5 failed = 96.1%**, mean
recognition confidence 0.981–0.998, 47–93 s per page.

### All five failures were the harness or the document, not the OCR

Worth recording in full, because the first run reported 61.5% on Federal Bank
and that number was entirely my own probe's fault:

| Case | Apparent | Actual cause |
|---|---|---|
| Federal Bank, 5 rows | OCR misread | **Probe.** `Withdrawals` and `Deposits` are mutually exclusive, so clustering x-centres merged them into one column. Fixed by using the `C`/`D` type column → 100% |
| ICICI, 2 rows | OCR misread | **Probe.** That statement prints `1,14,197.8 1` — broken kerning in the source PDF. The probe's number test rejected it, so it compared against a stale previous row |
| ICICI `Total:` row | OCR misread | **Probe.** A summary line is not a transaction |
| Bank of Baroda | OCR misread | **Probe.** The MICR code `382012141` from the preamble was scored as a balance |
| IndusInd `_.jpeg` row 24 | OCR misread | **The document is wrong.** 48,827.03 − 8,105.00 = 40,722.03, but it prints 41,722.03. Verified by cropping and upscaling the pixels |

**Genuine digit misreads across seven statements: zero.**

### The errors it does make are in letters and punctuation

Never in a digit, which is the opposite of what LlamaParse got wrong — and it
matters, because two of these three would have caused real damage:

| Read as | Should be | Consequence |
|---|---|---|
| `BARBOMANSAX` | `BARB0MANSAX` | 🟠 letter `O` for digit `0`. The 5th character of an IFSC is **always** `0`, so `IFSC_RE` rejects it — the IFSC/UTR guard from P-17 silently stops working |
| `10,176.90cz` | `10,176.90cr` | 🔴 **the Dr/Cr direction marker.** This is the P-14 defect class exactly: a mangled suffix means an unparseable sign, and a permissive reading means an inverted one |
| `22.196.90` | `22,196.90` | 🟠 comma read as a full stop — digits correct, value destroyed |

So an integration must treat the *marker* characters as the untrusted part. The
probe's `SUFFIX` regex accepts `c[rzi]` / `d[rz]` deliberately; that is a
guess about which glyph confusions occur and needs widening against more
samples, not narrowing.

### What this changes

PaddleOCR replaces LlamaParse as the default OCR path: it is more accurate on
the one image where both were measured, free, and removes the DPDP transfer and
the open ICAI confidentiality question entirely. LlamaParse stays supported as
an opt-in second opinion — a *second reading* of a page whose arithmetic already
failed is genuinely useful, and disagreement between two engines localises the
bad cell as well as the arithmetic does.

Unchanged: **neither is an import path.** 96.1% per row is not importable, and
the value is still locating the cells a human corrects.

### An unplanned finding worth keeping

The IndusInd sample is internally inconsistent by exactly ₹1,000 — a fabricated
template from the web. BR-6 caught it without being asked to. Detecting a
**doctored statement** is a real product capability for a CA reviewing a loan
file or an unfamiliar client's records, and it costs nothing extra: it is the
same check, already running.

### Known limitations

- 47–93 s per page on CPU, versus ~10 s for the hosted service. A 15-page
  statement is ~15 minutes, so this must be a background job, not a request.
- `enable_mkldnn=False` is **required**: paddle's oneDNN CPU backend fails with
  `ConvertPirAttribute2RuntimeAttribute not support`. It is not a tuning flag.
- Nothing is integrated yet. The probe reimplements row and column clustering in
  Python; the real path should render boxes onto a fixed-width text canvas and
  reuse `fixedWidth.ts` and `columnRoles.ts`, which are already tested and
  already handle the Dr/Cr suffix, the C/D flag and the preamble.
- `python3-venv` is absent on this machine; `uv` was used instead. A deployment
  needs one of them present.

---

## Stage 13 — wiring PaddleOCR in

The measurement in Stage 12 scored OCR alone: given the text, do the balances
move by the right amounts? Integration scores something much harder — OCR, plus
column inference, plus row grouping, plus finding the opening and closing
balances, plus BR-6 over the whole document. One dropped row fails it.

That stricter question found four defects, **two of which were in the shared
fixed-width path and therefore affected PDF imports as well**.

### The architecture, and why

OCR boxes are rendered onto a character canvas and handed to the *same*
`parseLayoutText` the PDF reader uses. `pdftotext -layout` output and a rendered
OCR canvas are the same problem in the same units, and that problem cost six
defects on real HDFC and SBI files, so there is now exactly one implementation
of it (`layout.ts`, extracted from `pdf.ts`).

This was decided by the Stage 12 evidence: the throwaway probe that did its own
clustering produced four apparent OCR failures that were all its own.

| Defect | Grade | What happened |
|---|---|---|
| **I-1** `isDatedLine` missed a leading serial number | 🔴 | Bank of Baroda prints a `Serial No` column, so its rows read `2   01-06-2022  …` and **none of them counted as a transaction line**. `pageToGrid` then measured the header and opening-balance row as one region and the transactions as another; the two disagreed about column positions by one column, so the opening row's description landed in the debit column. **Affects PDFs too** — BoB is a top-five bank |
| **I-2** a column boundary cut a number in half | 🔴 | The widest debit on an Axis page was `30000.00`; every other was five or six characters. Money is right-aligned so it grows LEFTWARD, and the gutter histogram's 5% tolerance let a boundary derived from the narrow values fall inside it. The slice produced `"…LTD  3000"` and `"0.00"`, the row was dropped as unparseable, and the statement came out **₹30,000 short**. `sliceCells` now snaps a split off the middle of a token, giving it to whichever cell holds most of it. **Affects PDFs too** |
| **I-3** the glyph rules did not compose | 🟠 | `22.196.90cr` carries a dotted thousands separator *and* a suffix. The marker rule rejected it (its second letter is already correct) and the number rule rejected it (it does not end in a digit), so nothing fired, `parseAmount` threw, and one cell killed the entire import. Each rule now sees only its own part of the token |
| **I-4** BR-6 passed a statement with a misread balance | 🔴 | `ok` was `difference === 0n` alone. Corrupt one *intermediate* running balance and leave the amounts alone: the totals still reconcile, because the balance column contributes nothing to `opening + credits − debits`. So a scan with a misread digit **would have imported silently**. `ok` now also requires `badRows` to be empty — we cannot tell from here whether the misreading was the balance (harmless) or an amount (not), and guessing is not available |

I-4 is the most important of the four. It was found by a test that corrupted a
balance and expected a refusal; it got a pass. Every prior stage had treated
BR-6 as the last line of defence, and it had a hole in it the whole time.

### Two regressions I introduced and reverted

Recorded because the reasoning was persuasive and wrong, and only re-measuring
caught it. ICICI's dense 90-DPI page fuses tokens (`Tds:7.70.001,14,267.81`), so
the canvas was made to search for a character width with no collisions:

1. Starting the search at the unsqueezed estimate and stopping at the first
   attempt with zero collisions took **Bank of Baroda from 15 rows and a passing
   check to 6 rows and a failing one**. *Zero collisions is not evidence of a
   good canvas* — a canvas compressed enough to merge two columns has no
   collisions either, because merged columns are one column and one column
   cannot overlap itself.
2. Narrowing further than `SQUEEZE` took **Karur Vysya from 29 rows to 13** and
   lost its opening balance. This falsified the claim written at the top of
   `ocrCanvas.ts` that spreading is harmless: spreading widens the gaps *inside*
   a cell too, so once the gap between a value date and its description passes
   `WIDE_GAP`, one logical column becomes two.

ICICI never improved under either search. Trading two working statements for
nothing is not a fix, so both were reverted and the file now says why.

### End-to-end result on the seven web samples

| Statement | Result |
|---|---|
| Axis | ✅ PASS — 23 rows (was failing until I-2) |
| Federal Bank | ✅ PASS — 14 rows |
| Bank of Baroda (scribd) | ✅ PASS — 15 rows |
| Karur Vysya | ⚠️ Correct refusal — page 1 of a multi-page statement (G-19); `badRows=[1]` only, so its 29 rows are internally consistent |
| IndusInd | ❌ `badRows=[2,5]` — row 5 is the **document's own ₹1,000 error** verified against the pixels; row 2 is a ₹20,500 withdrawal printed in the deposit column |
| Bank of Baroda (`_ (1)`) | ❌ `badRows=[2,11]`; the document also contains `31/09/22`, a date that does not exist |
| ICICI | ❌ Ours — token fusion on a dense three-table page at ~90 DPI |

Three clean passes, one correct refusal, two failures caused by fabricated
sample documents, one real limitation. Regression-checked against the real
files: **SBI PDF and HDFC PDF both still PASS with unchanged row counts**, and
283 tests pass.

### Privacy and cost, restated

Nothing leaves the machine. `pdftoppm` renders scanned PDF pages at 300 DPI and
every temporary file — the written image, the rendered pages — is removed in a
`finally`, as with the decrypted spreadsheet and the password-protected PDF.

⚠️ `pdftoppm` takes its password on the command line, exactly as `pdftotext`
does. Same exposure, same reason (no stdin channel), and it widens G-18 to a
second call site.

### Still not an import path

Unchanged by any of this. Three of seven scans reconcile, and the value remains
naming the cells a person must correct.

---

## Recurring patterns

Four failure modes account for nearly every 🔴 and 🟠 above.

**1. The control that silently does nothing.** G-2, K-1. A rule exists, reads
correctly, and never fires. *Countermeasure:* for every guarantee, write the
test that attempts the violation. A test that only proves the happy path proves
nothing about the guard.

**9. A fix that trades one failure for a worse one.** S-1. Requiring decimals to
identify money stopped a reference number being read as an amount, and in doing
so made an entire bank unparseable. *Countermeasure:* when narrowing a rule to
exclude a false positive, check what the narrowing now excludes that it should
not — and prefer a test grounded in the domain's own arithmetic over one
grounded in formatting.

**8. Fixing a bug in one place and not looking for it in the sibling.** X-1 and
X-2 are the same greedy-regex defect in the row tag and the cell tag. The row
one was fixed first, and the cell one shipped anyway. *Countermeasure:* when a
defect is found in a parser, grep for the same construct across the file before
closing it.

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

**7. Fixtures that share the author's assumptions.** P-11 to P-15. Thirty-six
tests written alongside the parser missed five layout facts that two real files
exposed in minutes — and in P-14's case a test actively *asserted* the wrong
behaviour, so the bug was protected by green CI. *Countermeasure:* validate every
template against a genuine export, redacted, before trusting it; and when a test
encodes a domain convention, check the convention rather than the test.

**6. Coercing at the wrong boundary.** P-2, P-3. Money through `Number()`; a raw
`1,00,000.00` returned from a parser and failing three modules later. Both
produced errors far from their cause. *Countermeasure:* coerce where the format
is known, and let the type carry the guarantee onwards.

**12. A grep is not a call graph.** G-23. `gst_rates` was recorded as "written by
the seed and read by nothing" on the strength of grepping for the table name in
TypeScript. The reader called a SQL function by name instead, so the grep was
silent and the gap entry, the commit message and the plan built on it were all
wrong. *Countermeasure:* before declaring code unreachable, look for the thing
that would USE it — the function, the view, the route — not only for the
identifier you have in mind. And when the fix turns out to be unnecessary, say
so rather than quietly building it anyway; the two real defects here were only
found by opening the code that supposedly did not exist.

**11. The last line of defence was never tested against the thing it defends.**
I-4. BR-6 is described throughout this log as the control that makes a wrong
parse a refusal rather than a corrupt import, and eleven stages relied on it —
but no test had ever corrupted a single figure and demanded a refusal. When one
finally did, it got a pass. *Countermeasure:* for the controls you trust most,
write the test that breaks the data rather than the test that exercises the
code. A guard is only as good as the specific violation it has been shown.

**10. The measuring instrument is the defect.** Stage 12. A throwaway probe
scored PaddleOCR at 61.5% on Federal Bank and 84.6% on IndusInd; all of it was
the probe's own column clustering and number parsing, and the real figure was
100%. Had that first run been reported as a vendor result, a good engine would
have been rejected on the strength of my own bug. *Countermeasure:* before
believing a bad score, reproduce one failing case by hand against the source —
here, cropping the pixels showed both that the OCR was right and that the
*document* was wrong. A benchmark harness needs the same scepticism as the thing
it benchmarks, and a scrappy one deserves more.

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
| G-2 | ~~All GST rates, TDS sections, ITC categories are `PLACEHOLDER`~~ — **partly closed 2026-09-07** | CA review received; see [`CA-REVIEW-ANSWERS.md`](CA-REVIEW-ANSWERS.md). All 14 markers resolved into a value or an explicit `UNVERIFIED` with a reason. **Still open:** the Income-tax Act 2025 section codes could not be corroborated and are marked `CODE UNVERIFIED` — a wrong code prints on every certificate and return |
| G-19b | **HSN rates predate the 2025-09-22 GST rate rationalisation** | The review did not mention it at all, despite two of its answers being about rates. The 12% and 28% slabs were collapsed; every seeded HSN rate is older than that. Marked `UNVERIFIED` rather than given a false citation. Needs a second opinion |
| G-22 | ~~`clients` is GSTIN-level; it must be PAN-level~~ — **CLOSED** | Migration `011_registrations.sql`. `client_registrations` holds one row per GSTIN; `clients.gstin` and `clients.state_code` were **dropped**, not deprecated, so no query can read a stale one. Invoices carry `registration_id` NOT NULL; bills carry it nullable, because a client below the GST threshold keeps books without a GSTIN. Two invariants are enforced by the database rather than by convention: `state_code` must equal the GSTIN's first two characters, and a client may have at most one primary registration |
| G-3 | ~~`business_type` is hardcoded `NULL` in `bills.ts`~~ — **CLOSED** | Migration `013_business_type.sql`. Two facts were missing, not one: the business type was a literal `SELECT NULL::text`, **and `blockedCategory` was never passed to `decideItc` at all** — so the exception lookup returned undefined every time and no client's trade could unblock anything. `blockedCategory` was exercised only by unit tests calling `decideItc` directly: covered, passing, unreachable from the path that posts. Also split *settled* from *undecided* — a known trade that does not qualify is `blocked` with nothing to ask, while an unrecorded trade is `conditional` and answerable by one question at the client level (A5.4). Reporting both as `blocked` had made the `conditional` branch of `canClaimItc` dead too |
| G-4 | ~~Period close does not call `assertReconciledForClose()`~~ — **CLOSED** | There was no close path to wire it into: `accounting_periods.is_closed` existed, `resolve_open_fiscal_year` already refused to post into a closed period, and **no function in the codebase could set the flag**. BR-23 was a control with no moment at which to fire. `domain/periodClose.ts` adds `periodCloseCheck`, `closePeriod` and `reopenPeriod`. An untied bank account **blocks** rather than warns — a warning at close time is read by someone whose goal at that moment is to close. An override is allowed but demands a reason and records it, because refusing absolutely just moves the close to a hand-written `UPDATE` with no record of who decided it |
| G-23 | ~~No HSN → rate lookup exists at all~~ — **CLOSED, and the original diagnosis was wrong** | I recorded "read by nothing" from a grep for `gst_rates` across the TypeScript, which missed it because sales invoicing calls the SQL function `resolve_gst_rate()` by name. The lookup existed and already refused an unmatched HSN. Two real defects were found in its place: `resolve_gst_rate` ordered only by prefix length, so **two rows sharing a prefix tied and a rate change resolved at random** — silently defeating the date-ranging the review endorsed; and purchase bills had no lookup at all, defaulting to `?? '0'`, which is worse than the 18% fallback because 0% looks deliberate. Both fixed in `014_gst_rate_resolution.sql`; the function now returns its `source_notification` so an unverified rate says so where it is used |

### Built partially

| # | Gap | Detail |
|---|---|---|
| G-20 | **Salary TDS has no home** | The review listed it as a missing category and as a category that is right — it is the most common SMB deduction. But it cannot be a rate-table row: s.192 deducts at the employee's *average rate on estimated annual income*, after exemptions, declarations and regime choice. There is no rate to store. Needs a payroll module; deliberately absent rather than approximated |
| G-21 | ~~No negative-cash-balance check~~ — **CLOSED** | `reports/cashRegister.ts`, surfaced as a **Cash** page in the review server so it is reachable rather than merely present. Walks each `cash` account **day by day**, because a dip that recovers before month end is invisible to a closing-balance check and is exactly the error this is for. `bank` accounts are excluded per B5 — an OD/CC facility going negative is what it is for, and flagging it would get the whole check switched off. A run of consecutive negative days is one episode, not one finding per day; and the pre-window opening balance is counted, or a mid-year report would flag every client who simply holds cash |
| G-5 | ~~No `.xlsx` reader~~ — **done** | Dependency-free zip + sheet reader; the real encrypted SBI export now parses end to end. Decryption is an **optional** import, so an encrypted file without the package gives a clear instruction rather than a crash. HDFC and SBI templates are validated against real files; ICICI, Axis and Kotak remain guesses |
| G-14 | ~~PDF statements~~ — **done** | Local `pdftotext` + gutter detection + column inference. Both real PDFs pass BR-6 with row counts matching the statements' own Dr/Cr totals. **Scanned PDFs still fail** (no text layer — needs OCR) and are reported as such |
| G-17 | ~~Scanned PDFs and images~~ — **built, with a human in the loop** | LlamaParse behind a double opt-in. Measured at 89.3% row-level reconciliation on a ~90 DPI sample (2 misread balances in 29 rows), so it is an **error locator**, not an import path — the arithmetic names the cells to fix. Not viable unattended; a 300 DPI source would need re-measuring |
| G-19 | **A single page of a multi-page scan cannot pass BR-6** | Its rows cannot sum to the whole statement's totals. Needs all pages, or per-page balances |
| G-18 | The PDF password is passed on the command line | `pdftotext` has no stdin channel for it, so it is briefly visible in the process list to the same user. Never written to disk or stored. Worth revisiting if PDF import becomes a shared-service path |
| G-15 | Dr/Cr counts not used as a completeness check | Statements that state them give a free second verification alongside BR-6: balances prove the amounts, counts prove no row was dropped |
| G-16 | Credit cards remain Phase 2, now specified | A real ICICI card statement is documented in `specs/bank-and-reconciliation.md` §18 — layout, the liability postings, the BR-13-shaped double-counting hazard, why a card statement can never support an ITC claim, and EMI conversion as borrowing. **No code implements any of it.** ICICI's *bank account* template is still an unvalidated guess; a card statement does not test it |
| G-6 | **Learned rules do not apply** | `bank_transaction_rules` table exists; nothing reads it. Layer 3 of the matching engine is absent, so T-11 is untested |
| G-7 | **1:N matching not implemented** | One payment against five invoices (T-9) — very common in B2B. The schema supports it; no code allocates it |
| G-8 | **Decentro webhook path untested** | Layer 0 in `proposeMatch()` is written but has no test. **BR-13 (VA settlement double-counting) is not implemented at all** — flagged in the spec as the most likely source of a double-count bug |
| G-9 | ~~Mixed-ITC bills treated as wholly blocked~~ — **CLOSED** | Migration `012_bill_itc.sql`. The **ledger was already right per line**; the header contradicted the entry it summarised — reporting `blocked` because one line was, and `itcClaimable: false` while real credit sat in the voucher. A bill is now `eligible`/`blocked` only when every line agrees, otherwise `mixed`, with `itc_claimable_value` and `itc_blocked_value` stored because a return is built from them. Conditional counts as not claimable: an undecided line must not put credit into a return on the assumption a CA will later agree |
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

- LlamaParse rate card not obtained — now lower priority, since PaddleOCR
  (self-hosted, free, more accurate on the one image where both were measured)
  is the intended default OCR path and LlamaParse only an opt-in second opinion
- Sandbox rate card not obtained
- PaddleOCR needs `python3-venv` or `uv` present at deploy time, and
  `enable_mkldnn=False` on CPU or paddle's oneDNN backend crashes
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
| Bank | 52 | Decentro webhook path, 1:N allocation, learned rules |
| Statement files | 49 | PDF/fixed-width; banks other than HDFC and SBI |
| `.xlsx` / zip | 18 | Merged cells; multi-sheet workbooks; `.xls` (pre-2007) |
| PDF / fixed-width | 31 | Forward-marker coverage |
| OCR / markdown | 14 | Live provider calls (mocked by design); multi-page scans; 300 DPI accuracy |
| End-to-end flow | 10 | Resolving the ambiguous pair; bulk accept |
| **Total** | **260** | |
