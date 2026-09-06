# Spec: Bank & Reconciliation

**Status:** Draft — needs CA advisor review
**Owner:** —
**Depends on:** [gl-engine.md](gl-engine.md), [invoicing.md](invoicing.md),
[bills-and-expenses.md](bills-and-expenses.md), [provenance.md](provenance.md)
**Blocks:** Cash-flow reporting, receivables/payables ageing accuracy

---

## 1. Purpose

This module answers *"did the money actually move, and against what?"*

Invoicing records what customers **owe**. Bills record what the client
**owes**. Neither knows whether anything was actually paid. Bank reconciliation
closes that loop — and it is the **#2 ranked feature** by hours saved
(estimated 2–3 hours per client per month), because matching hundreds of bank
lines to open invoices by hand is exactly the mechanical work CAs currently
spend their evenings on.

Recall from Lesson 4 why this is a separate step: under accrual accounting, the
sale is recorded at invoice time (step 1) and the cash arrives later (step 2).
The bank statement only ever shows step 2. Reconciliation is what joins them.

---

## 2. Scope

**In scope:** bank and cash accounts, statement ingestion and parsing, Decentro
virtual-account feeds, the matching engine, statement-only transactions (bank
charges, interest), cheque float, the Bank Reconciliation Statement, and the
resulting GL postings.

**Out of scope:** payment *execution* (Payments spec — Cashfree/Decentro
payouts), Account Aggregator (deferred — see §3), credit-card and
corporate-card feeds (Phase 2), foreign-currency accounts (Phase 2).

---

## 3. Why statement upload is the primary path

Settled earlier and recorded in memory: BharatERP cannot be a direct Account
Aggregator FIU (not RBI/SEBI/PFRDA/IRDAI regulated), and TSPs like Setu and
Perfios serve only regulated FIUs. AA is deferred to Phase 3 via an FIU
partnership.

This is less of a constraint than it first appears. **Every major Indian
accounting product runs statement upload as its primary path** — Tally, Zoho
Books, Vyapar. Even where AA is available it succeeds perhaps 40–60% of the
time (bank downtime, consent expiry, missing FIPs), so statement upload remains
the reliable fallback regardless. We are building the thing everyone actually
depends on, not a compromise.

Two paths therefore exist:

| Path | Coverage | Latency | Structure |
|---|---|---|---|
| **Statement upload** | Every bank, every account | Manual, periodic | Parsed — imperfect |
| **Decentro virtual accounts** | Only inbound payments to VAs we issued | Real-time webhook | Structured — exact |

The second is narrow but perfect. The first is universal but noisy. Both feed
the same reconciliation engine.

---

## 4. Data model

```
bank_accounts
  id, firm_id, client_id
  account_id          uuid FK -> accounts     -- the GL account (account_type = bank)
  bank_name           text
  account_number_last4 text                   -- never store the full number
  account_number_hash text                    -- for matching statements to accounts
  ifsc                text
  account_type        enum    -- current | savings | od | cc | fd
  is_virtual_account  boolean -- Decentro-issued
  decentro_va_id      text NULL
  opening_balance     numeric(18,2)
  opening_date        date

bank_statements                               -- one uploaded file
  id, bank_account_id, source_document_id
  period_from, period_to      date
  opening_balance, closing_balance  numeric(18,2)
  row_count           int
  parse_status        enum    -- parsed | failed | partial
  parser_version      text
  uploaded_by, uploaded_at

bank_transactions                             -- one statement line. IMMUTABLE.
  id, firm_id, client_id, bank_account_id
  statement_id        uuid NULL FK            -- null when from a Decentro webhook
  txn_date            date NOT NULL
  value_date          date NULL
  narration           text NOT NULL           -- raw, exactly as the bank wrote it
  debit               numeric(18,2) NOT NULL DEFAULT 0
  credit              numeric(18,2) NOT NULL DEFAULT 0
  running_balance     numeric(18,2) NULL
  reference_number    text NULL               -- UTR / cheque no / UPI ref (§6)
  payment_mode        enum NULL               -- upi|neft|rtgs|imps|cheque|cash|nach|card|charge
  counterparty_name   text NULL               -- parsed from narration
  content_hash        text NOT NULL           -- dedup (§5.3)
  status              enum    -- unmatched | matched | partially_matched
                              -- | posted | ignored
  matched_amount      numeric(18,2) NOT NULL DEFAULT 0
  source              enum    -- statement | decentro_webhook | manual
  created_at

reconciliation_matches
  id, bank_transaction_id, voucher_id
  amount              numeric(18,2) NOT NULL
  match_type          enum    -- exact | rule | ai_proposed | manual
  confidence          numeric(4,3) NULL
  evidence            jsonb                   -- why (provenance PR-9)
  proposed_by         enum    -- system | ai | user
  approved_by         uuid NULL
  created_at
```

**BR-1 — `bank_transactions` is append-only.** Per `audit-trail.md` AT-2. A
statement line is a *fact reported by a third party*; it is evidence, not
something we may edit. Corrections happen through matching decisions, never by
altering the line.

**BR-2 — Never store full account numbers.** Last four digits plus a hash is
sufficient for matching and display, and materially reduces breach impact.

---

## 5. Statement ingestion

### 5.1 Formats, in order of preference

| Format | Reliability | Notes |
|---|---|---|
| **Excel / CSV** | Highest | Most Indian net-banking portals export this. Build first. |
| **PDF (text layer)** | Good | Extractable with `pdfplumber`; layout varies per bank |
| **PDF (scanned)** | Poor | Needs OCR; treat as last resort |
| **Decentro webhook** | Perfect | Structured JSON, no parsing (§7) |

**BR-3 — Ship CSV/Excel before PDF.** It covers most cases at a fraction of the
effort and gets the reconciliation engine — where the real value is — into a
CA's hands sooner.

**BR-4 — Password-protected PDFs are the norm.** Indian banks routinely email
statements encrypted with a PAN-plus-date-of-birth pattern. Prompt for the
password; never store it.

### 5.2 Per-bank parsers

Target the top banks first: HDFC, ICICI, SBI, Axis, Kotak, Yes, IDFC First,
PNB, Bank of Baroda, Canara. Each needs its own column mapping and date format.

```
bank_statement_templates
  id, bank_name, format enum, version
  column_map          jsonb   -- {date: 'Txn Date', narration: 'Description', ...}
  date_format         text
  amount_convention   enum    -- separate_dr_cr | single_signed
  header_row_offset   int
  detection_pattern   text    -- how to auto-identify this bank's file
  effective_from      date    -- banks change formats; templates are versioned
```

**BR-5 — Auto-detect the bank, but let the user override.** Detection from
header text and column names works most of the time; the override prevents a
silent mis-parse.

### 5.3 The arithmetic self-check — the most valuable validation here

**BR-6 — A parsed statement must reconcile against itself:**

```
opening_balance + Σ credits − Σ debits == closing_balance
```

If it doesn't, **the parse is wrong** — rows dropped, a number misread, a page
missed. Reject the import and show the discrepancy rather than importing
corrupted data.

This is the bank-statement analogue of the Trial Balance from Lesson 2: a
cheap, deterministic checksum that catches an entire class of extraction
failure. It is far more reliable than any OCR confidence score, because it
tests the *whole document* rather than individual fields. Where a running
balance column exists, verify it line by line to locate the exact failing row.

**BR-7 — Deduplicate on content hash.** Overlapping uploads are routine — a
user imports January, then imports January–February. Hash
`(bank_account, txn_date, debit, credit, narration, running_balance)`. Import
only new rows; report the overlap rather than silently skipping it.

**BR-8 — Detect gaps.** If the last import ended 31 January and this one starts
5 February, four days are missing. Warn — an unnoticed gap makes every
subsequent reconciliation wrong.

---

## 6. Parsing Indian bank narrations

A genuinely high-leverage piece of engineering, and one where **rules beat AI**.

Indian bank narrations look cryptic but are largely **semi-structured**:

```
UPI/123456789012/Payment from/ramesh@okhdfcbank/UPI
NEFT-CITIN52024061012345-ACME TRADING PVT LTD-UTR123456789
IMPS/P2A/412345678901/RAMESH KUMAR/HDFC
RTGS-HDFCR52024061098765-SHREE ENTERPRISES
CHQ PAID - 123456
NACH DR-INDUSIND-ABC FINANCE-MANDATE123
ACH C- SALARY CREDIT XYZ TECHNOLOGIES
BY CASH - BRANCH 0234
ATM WDL 123456 MUMBAI
INT.PD:01-04-2026 TO 30-06-2026
SMS CHARGES 07/2026 + GST
```

**BR-9 — Rules first, model for the residue.** A regex library keyed by
`payment_mode` extracts the reference number, counterparty, and mode
deterministically. This is fast, free, auditable, and correct. Send only the
lines that fail all patterns to the LLM.

Expect rules to handle the large majority of lines. That directly serves the
harness principle: **do not spend model calls on structure you can parse.**

**BR-10 — The UTR is the strongest matching signal available.** NEFT, RTGS, and
IMPS transfers carry a Unique Transaction Reference. If the client recorded the
UTR when raising the invoice or when the customer confirmed payment, matching is
*exact* rather than probabilistic. Extract and index it always.

**BR-11 — Store the raw narration verbatim, forever.** Parsing improves over
time; the original is the evidence. Re-parsing historical lines with a better
parser must always be possible (provenance PR-4).

---

## 7. Decentro virtual accounts — the real-time path

We already hold Decentro keys for virtual accounts and UPI collections.

A virtual account is a unique account number issued per customer (or per
invoice). When a customer pays into it, we know **exactly who paid and against
what** — no narration parsing, no ambiguity.

```
Invoice raised → VA number + UPI link sent on WhatsApp
              → customer pays
              → Decentro webhook fires
              → bank_transaction created (source = decentro_webhook)
              → matched to the invoice with certainty
              → receipt voucher posted, receivable cleared
```

**BR-12 — Webhook-sourced transactions bypass the matching engine.** The link
is known at creation, not inferred. Confidence is definitional, not scored.

**BR-13 — But they still appear on the real statement.** Funds settle from the
virtual account into the client's actual bank account. That settlement line
*will* be in the uploaded statement and must not be double-counted. Match
settlement lines against the batch of VA collections they represent.

BR-13 is the subtle one, and the most likely source of a double-counting bug.

---

## 8. The matching engine

### 8.1 Layered, cheapest-first

| Layer | Method | Confidence |
|---|---|---|
| **0. Known link** | Decentro webhook (§7) | Certain |
| **1. Exact reference** | UTR / cheque number matches a recorded voucher | Very high |
| **2. Deterministic score** | Amount + date proximity + party (§8.2) | High when unambiguous |
| **3. Learned rules** | Recurring patterns this client has confirmed before (§8.4) | High |
| **4. AI proposal** | Everything remaining | Scored, always reviewed |

**BR-14 — Never invoke the model on a line an earlier layer resolved.** Most
lines should never reach layer 4. If they do, the rule library is
underdeveloped.

### 8.2 Deterministic scoring

Weighted, not additive-flat — reference and amount are far more diagnostic than
date proximity:

| Signal | Weight |
|---|---|
| Reference number (UTR/cheque) matches exactly | 50 |
| Amount matches exactly | 30 |
| Amount matches within tolerance (bank charges deducted) | 15 |
| Party resolved and matches the voucher's party | 15 |
| Date within 3 days of the voucher | 5 |
| Date within 30 days | 2 |

Auto-match only when the top candidate clears a threshold **and** leads the
runner-up by a clear margin. **BR-15 — Ambiguity is never resolved silently.**
Two invoices for ₹11,800 from the same customer is a case for the CA, not a
coin flip.

### 8.3 Match types

| Type | Example |
|---|---|
| **1 : 1** | One payment settles one invoice |
| **1 : N** | One payment settles five invoices (common in B2B) |
| **N : 1** | Instalments against one invoice |
| **Partial** | ₹10,000 received against a ₹15,000 invoice — ₹5,000 stays outstanding |
| **With deduction** | Customer pays ₹49,000 on a ₹50,000 invoice after deducting ₹1,000 TDS |
| **Unmatched** | Bank charge, interest — no voucher exists (§9) |

**BR-16 — Customer-deducted TDS is not a shortfall.** A customer paying ₹49,000
against a ₹50,000 invoice has deducted ₹1,000 TDS (Lesson 6, from the payee's
side). The invoice is **fully settled**; the ₹1,000 becomes **TDS Receivable**,
claimable against the client's own income tax. Treating it as an unpaid balance
leaves a permanently stuck receivable and loses the client a real tax credit.

This is a frequent, silent, expensive error in manual bookkeeping — and a
strong AI flag, because the shortfall is usually a recognisable percentage of
the invoice value.

### 8.4 Learned rules

Every CA confirmation becomes a client-scoped rule:

```
bank_transaction_rules
  id, client_id, priority
  narration_conditions jsonb   -- contains / starts_with / regex
  payment_mode         enum NULL
  amount_min, amount_max numeric NULL
  action               enum    -- classify_as | match_party | create_voucher
  target_account_id    uuid NULL
  party_id             uuid NULL
  auto_post            boolean NOT NULL DEFAULT false
  created_by, confirmed_count int
```

After the same pattern is confirmed a few times — `"SMS CHARGES"` → Bank
Charges — it applies automatically. Client-scoped only; no cross-client
leakage.

---

## 9. Statement-only transactions

Some things exist **only** on the bank statement. No invoice, no bill — the
bank simply did it.

| Transaction | Posting |
|---|---|
| Bank charges, SMS charges, AMC | `Bank Charges Dr / Bank Cr` |
| GST on bank charges | Input GST Credit (claimable — a genuine ITC often missed) |
| Interest credited (savings/FD) | `Bank Dr / Interest Income Cr` |
| **TDS deducted by the bank on interest** | See BR-17 |
| Interest charged (OD/CC) | `Interest Expense Dr / Bank Cr` |
| Cheque return charges | `Bank Charges Dr / Bank Cr` |
| Direct debit (NACH/ECS) | Usually matches a bill; else creates one |

**BR-17 — Bank interest arrives net of TDS.** The bank credits interest after
deducting tax. The gross must be recorded, with the deduction as TDS
Receivable:

```
Bank                Dr   9,000     -- what actually landed
TDS Receivable      Dr   1,000     -- deducted by the bank
    Interest Income     Cr  10,000 -- the gross earned
```

Recording only the ₹9,000 understates income *and* silently forfeits a ₹1,000
tax credit. Reconcile against Form 26AS, which shows what the bank reported.

**BR-18 — Statement-only transactions still require CA approval before
posting** until a learned rule (§8.4) has been confirmed for that pattern.

---

## 10. Cheques and the float

India remains cheque-heavy, and cheques create a genuine timing gap.

A cheque issued on 5 September may not be presented until 20 September. The
books show the payment on the 5th; the bank shows it on the 20th. **Both are
correct.** The difference is the float, and it is the main reason a Bank
Reconciliation Statement exists.

```
cheque_register
  id, voucher_id, bank_account_id
  cheque_number, cheque_date
  direction        enum   -- issued | received
  amount
  status           enum   -- pending | cleared | bounced | cancelled | stale
  cleared_date     date NULL
  bounce_reason    text NULL
```

- **BR-19 — Issued cheques post to the ledger on issue date**, then clear
  against the bank line when presented. Clearance is a matching event, not a
  new posting.
- **BR-20 — Bounced cheques need a full reversal**, plus the bank's return
  charge, plus reinstatement of the receivable. For received cheques this may
  also carry legal consequences under Section 138 of the Negotiable Instruments
  Act — flag prominently rather than treating it as a routine reversal.
- **BR-21 — Cheques go stale after three months.** Uncleared beyond that, they
  must be reversed and reissued. A scheduled job should surface them.

---

## 11. The Bank Reconciliation Statement (BRS)

The classic report, and the one a CA will look for immediately.

Book balance and bank balance legitimately differ. The BRS explains the
difference item by item:

```
Balance as per books (ledger)                        4,85,000
Add:  Cheques issued but not yet presented              62,000
Less: Deposits made but not yet credited              (18,000)
Less: Bank charges not yet recorded in books             (450)
Add:  Interest credited not yet recorded in books        2,150
Less: Cheque returned unpaid                           (25,000)
──────────────────────────────────────────────────────────────
Balance as per bank statement                        5,05,700   ✓
```

**BR-22 — The BRS must tie exactly.** A residual difference means an error on
one side. Surface it as an exception; never round it away.

**BR-23 — Generate the BRS per account per period**, and treat an unreconciled
account as a blocker for period close (`gl-engine.md` §7.4). Closing a period
with unreconciled bank accounts is how errors become permanent.

---

## 12. Validation

| # | Rule |
|---|---|
| BV-1 | Statement arithmetic reconciles (BR-6) |
| BV-2 | No duplicate transactions by content hash (BR-7) |
| BV-3 | No unexplained date gap since the previous statement (BR-8) |
| BV-4 | Matched amount never exceeds the voucher's outstanding balance |
| BV-5 | Σ matched amounts ≤ the bank transaction amount |
| BV-6 | Voucher and bank transaction belong to the same client |
| BV-7 | A bank transaction cannot be matched to a reversed or cancelled voucher |
| BV-8 | Posting date within an open period |
| BV-9 | Ambiguous matches (multiple candidates within the margin) never auto-post (BR-15) |
| BV-10 | Decentro settlement lines not double-counted against their VA collections (BR-13) |
| BV-11 | AI-proposed matches carry a human approver (AT-13) |
| BV-12 | BRS ties exactly before period close (BR-22) |

---

## 13. Provenance obligations

Per [provenance.md](provenance.md) §12, this module must capture:

- **Source linkage** — every `bank_transaction` reaches its statement file,
  page, and row; every match reaches both the bank line and the voucher
- **Match evidence (PR-9)** — *why* this pairing: which signals fired, their
  scores, and the runner-up candidates the CA can switch to in one click
  (PR-11)
- **Parser version** — so a historical line can be explained even after the
  parser has improved (BR-11)
- **Third-party classification (PR-22)** — bank statements are **third-party
  evidence**, among the strongest tiers available. Tag them accordingly; they
  will carry real weight in the audit export

---

## 14. BharatERP-specific

### 14.1 The CA's reconciliation screen

This is where the hours are actually saved, so the interface matters as much as
the engine.

- Bank lines on the left, proposed matches on the right, **sorted by
  confidence** so the CA clears the easy ones in bulk and spends attention on
  the hard ones
- **Bulk-accept** all high-confidence matches in one action
- Unmatched lines grouped by inferred pattern, so twelve months of `SMS
  CHARGES` can be classified once
- Running count of matched vs unmatched, with a live BRS difference
- Keyboard-driven throughout — a CA should never need the mouse
  (`dont-scare-the-ca`)

### 14.2 AI hooks

Three, all advisory:

1. **Match proposal** for lines that survive layers 0–3
2. **Counterparty resolution** from a parsed narration to the customer or
   vendor master
3. **Anomaly flags** — a duplicate payment to the same vendor, an unusual
   amount for a recurring pattern, a payment to a party with no corresponding
   bill

The model never decides amounts, never posts, and never resolves ambiguity
alone.

---

## 15. Test cases

| # | Given | When | Then |
|---|---|---|---|
| T-1 | Statement where opening + credits − debits ≠ closing | Import | Rejected with the discrepancy shown (BR-6) |
| T-2 | January re-imported inside a Jan–Feb file | Import | Only February rows added; overlap reported (BR-7) |
| T-3 | Previous statement ended 31 Jan, this starts 5 Feb | Import | Gap warning raised (BR-8) |
| T-4 | Narration `NEFT-...-UTR123456789` | Parse | Mode, counterparty, UTR extracted by rule — no model call (BR-9) |
| T-5 | UTR matches a recorded invoice | Match | Layer-1 exact match; model never invoked (BR-14) |
| T-6 | Two open invoices of ₹11,800, same customer | Match | Ambiguity surfaced; no auto-match (BR-15) |
| T-7 | ₹49,000 received against a ₹50,000 invoice | Match | Recognised as TDS deduction; invoice fully settled; ₹1,000 to TDS Receivable (BR-16) |
| T-8 | ₹10,000 received against ₹15,000 invoice | Match | Partial; ₹5,000 remains outstanding and correctly aged |
| T-9 | One ₹50,000 payment against five invoices | Match | 1:N allocation across all five |
| T-10 | Bank interest ₹9,000 credited net of ₹1,000 TDS | Post | Gross ₹10,000 income; ₹1,000 TDS Receivable (BR-17) |
| T-11 | `SMS CHARGES` confirmed 3 times | 4th occurrence | Auto-classified by learned rule (§8.4) |
| T-12 | Cheque issued 5 Sep, presented 20 Sep | Both dates | Ledger dated 5 Sep; appears in BRS as unpresented until cleared (BR-19) |
| T-13 | Received cheque bounces | Process | Reversal, return charge, receivable reinstated, S.138 flag raised (BR-20) |
| T-14 | Cheque uncleared for 4 months | Scheduled job | Flagged stale for reversal and reissue (BR-21) |
| T-15 | Decentro VA collection, then its settlement line in the statement | Both ingested | Settlement matched to the VA batch; no double count (BR-13) |
| T-16 | Payment matched to a voucher of another client | Attempt | Rejected (BV-6) |
| T-17 | Attempt to match ₹20,000 to an invoice with ₹15,000 outstanding | Attempt | Rejected (BV-4) |
| T-18 | Unreconciled bank account | Attempt period close | Blocked (BR-23) |
| T-19 | BRS with a residual ₹120 difference | Generate | Exception raised, not rounded away (BR-22) |
| T-20 | Parser improved after 6 months | Re-parse an old line | Original raw narration still available; version recorded (BR-11) |

---

## 16. Open questions

**16.1 Bank format coverage for the pilot.** Which banks do the pilot CAs'
clients actually use? Build those parsers first rather than guessing at a
top-ten list.

**16.2 Auto-post appetite.** Would a CA allow high-confidence matches to post
without review — even exact UTR matches? Same question as
`bills-and-expenses.md` §13.2, and it materially changes the hours-saved figure.

**16.3 Reconciliation cadence.** Do CAs reconcile monthly at close, or
continuously? Continuous favours a real-time feed and a persistent queue;
monthly favours a bulk workflow. This shapes the entire UI.

**16.4 Cash transactions.** Many Indian SMBs run significant cash that never
touches a bank. How is the cash book maintained and verified today, and what
would make it better?

**16.5 TDS-deduction inference.** BR-16 infers TDS from a shortfall. Should the
system auto-apply that when the gap equals a plausible TDS rate, or always ask?
*Lean: propose with the computed rate shown, require confirmation.*

**16.6 OD/CC accounts.** Overdraft and cash-credit accounts carry credit
balances and interest computations that differ from current accounts. Common
enough among target clients to need Phase-1 handling?

---

## 17. Reference studied

`erpnext/accounts/doctype/{bank_transaction, bank_reconciliation_tool,
bank_transaction_rule, bank_clearance, bank_statement_import}`.

Observations that informed this spec:

- Their `allocated_amount` / `unallocated_amount` pair on a bank transaction,
  with a child table of linked payments, is how partial and 1:N matching works.
  Adopted as `reconciliation_matches` with a running `matched_amount`.
- Their matching produces ranked candidates by summing binary signals
  (reference match, amount match, party match, unallocated match). The shape is
  right and is adopted — but **weighted rather than flat**, since a UTR match is
  far more diagnostic than date proximity (§8.2).
- Their `bank_transaction_rule` — description conditions, amount bounds,
  priority, mapping to account and party — is the correct model for recurring
  patterns. Adopted and extended with a confirmation counter so rules earn
  auto-apply status through repeated CA agreement (§8.4).
- Their `bank_clearance` with cheque number, cheque date and clearance date
  separates issue from clearance correctly. Adopted as `cheque_register`.
- Their statement import supports per-bank column mapping and templates.
  Adopted and versioned by effective date, since banks change formats.

**Rejected / diverged:** they have no statement-arithmetic self-check (BR-6),
no narration parsing (§6), no learned-rule promotion, and no handling for
customer-deducted TDS (BR-16) or bank-deducted TDS on interest (BR-17) — all of
which are India-specific and, in the TDS cases, financially material. The
Decentro real-time path (§7) and its double-counting hazard (BR-13) have no
counterpart there either.

Nothing from the reference is reproduced.

---

## 18. Credit cards (Phase 2) — observations from a real statement

Credit cards are out of scope for Phase 1 (§2). These notes come from a real
ICICI Bank retail card statement and exist so that whoever builds Phase 2 does
not start from guesses. **No code implements any of this.**

### 18.1 Layout

Transaction table:

```
Date | SerNo. | Transaction Details | Reward | Intl.# | Amount (in ₹)
```

- Dates `dd/MM/yyyy`
- **One amount column**, not a debit/credit pair. Direction is carried by a
  `CR` suffix — `13,603.92 CR` — which marks a payment or refund
- Transaction details wrap over several physical lines
- A separate `EMI / PERSONAL LOAN ON CREDIT CARDS` table:
  `Loan Type | Creation Date | Finish Date | No. of Installments |
   EMI/Loan Amount | Pending Installments | Outstanding | Monthly Installment`
- Summary boxes: Total Amount Due, Minimum Amount Due, Previous Balance,
  Purchases/Charges, Cash Advances, Payments/Credits, Credit Limit,
  Available Credit, Cash Limit, Available Cash
- The file is a fixed-width PDF, so it needs the parser described in the PDF
  gap, not the delimited reader

### 18.2 CC-1 — the statement carries its own arithmetic check

The statement **prints the equation**, with the operators set between the
summary boxes:

```
Previous Balance + Purchases/Charges + Cash Advances − Payments/Credits
    = Total Amount Due

      5,590.89   +     22,522.67     +      0.00     −     19,194.81
    = 8,918.75                                                    ✓
```

This is BR-6 on a different instrument, and it confirms the pattern generalises:
**every well-formed Indian statement can be made to verify itself.** Apply the
same rule — if it does not balance, the parse is wrong, so reject the import.

### 18.3 CC-2 — `CR` means direction here, not a positive balance

On a savings-account *balance*, `CR` means the customer holds funds (see the
defect log: reading it as negative was a real bug). On a credit-card
*transaction line*, `CR` marks money coming **off** the card — a payment or a
refund — which reduces a liability.

Same two letters, different meaning, depending on whether the column is a
balance or a movement and whether the account is an asset or a liability. The
amount parser therefore exposes the marker as `suffix` separately from
`negative`; a card parser must read the suffix and must not reuse the balance
interpretation.

### 18.4 CC-3 — a card is a liability, so the postings differ

```
Spend        Expense Dr              / Credit Card Payable Cr
Payment      Credit Card Payable Dr  / Bank Cr
Refund       Credit Card Payable Dr  / Expense Cr
Card fee     Bank Charges Dr + Input GST Dr / Credit Card Payable Cr
```

`Total Amount Due` is the closing balance of the liability account, and it
reconciles the same way a bank account does — against the ledger balance of
`Credit Card Payable`, not against a cash figure.

### 18.5 CC-4 — the double-counting hazard, exactly as in BR-13

The card spend appears on the **card** statement. The payment to the card
appears on the **bank** statement. They are the same money seen twice, one step
apart.

Recording the card spend as an expense *and* the bank payment as an expense
doubles the cost. The bank-side line must settle the `Credit Card Payable`
liability and never touch an expense account. This is the single most likely
bug in a card feed and is the same shape as the Decentro settlement hazard.

### 18.6 CC-5 — a card statement is not a tax invoice

**No ITC may be claimed on the strength of a card statement line.** Section
16(2)(a) requires a tax invoice, and a statement line has no supplier GSTIN, no
HSN, and no tax split — it is proof of *payment*, not proof of *tax*.

So business spending on a card creates a collection problem: the merchant's
invoice must still be obtained for every claimable purchase. The card statement
is useful for *completeness* — it proves a purchase happened, so it can drive a
checklist of missing invoices — which is a genuinely valuable use of it and the
reverse of how it is usually treated.

The card issuer's **own fees** are different: the statement shows GST on them
explicitly (`... @18%` lines), and the bank does issue a tax invoice for those,
so that GST is claimable in the ordinary way (§9).

### 18.7 CC-6 — EMI conversion is borrowing, not expense

A purchase converted to EMI becomes a loan. The statement shows it amortised as
separate `Principal Amount Amortization` and `Interest Amount Amortization`
lines, plus GST on the interest.

```
Conversion   Credit Card Payable Dr / EMI Loan Cr        (reclassification)
Instalment   EMI Loan Dr + Interest Expense Dr + Input GST Dr
                                   / Credit Card Payable Cr
```

Treating the whole instalment as an expense overstates cost and understates
borrowings. The interest is a finance cost and belongs below operating profit
(Lesson 8), so getting this wrong distorts operating margin as well as the
balance sheet.

### 18.8 Open questions for Phase 2

- Do the target clients actually put business spend on cards, or on the current
  account? This determines whether Phase 2 matters at all.
- Are the cards in the **firm's** name or the proprietor's? A personal card used
  for business spend is a director's-loan / drawings question before it is a
  reconciliation question.
- Is a spreadsheet export available from the card portal, as it is for the SBI
  savings account? If so, the PDF work is avoidable here too.
