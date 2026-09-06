# Spec: General Ledger (GL) Engine

**Status:** Draft — needs CA advisor review
**Owner:** —
**Depends on:** [audit-trail.md](audit-trail.md) — immutability rules apply to everything here
**Blocks:** Invoicing, Bills, Bank Reconciliation, GST Engine, TDS Engine, all reports

> **Amendment note:** `audit-trail.md` §4.2 sketched `journal_entries` +
> `journal_entry_lines` as the ledger tables. This spec supersedes that with a
> two-layer design (`vouchers` → `ledger_entries`, §5). The immutability rules
> (AT-2, AT-3, AT-4) apply unchanged to both layers.

---

## 1. Purpose

The GL Engine is the single source of financial truth. Every rupee that moves —
from an invoice, a bill, a bank payment, a depreciation run, a GST adjustment —
ends up here as a balanced double-entry record.

Everything else in BharatERP is either a **producer** (invoicing, bill capture,
bank reconciliation) or a **consumer** (Trial Balance, Balance Sheet, P&L, GST
returns) of this layer. If the GL is wrong, everything downstream is wrong, and
no amount of AI polish saves it.

**Design principle:** the ledger stores facts. Reports are queries over those
facts, never separately maintained tables. There is no "balance" column that
gets incremented — balances are always computed. This eliminates an entire
class of drift bugs and makes the append-only requirement (AT-2) natural rather
than awkward.

---

## 2. Scope

**In scope:** chart of accounts, the double-entry ledger, voucher types and
their posting rules, fiscal years and period close, opening balances,
validation rules, and the derived-report query patterns.

**Out of scope (separate specs):** GST computation, TDS computation,
depreciation schedules, inventory valuation, bank reconciliation matching. Each
of those *produces* ledger entries; how they decide what to produce is their
own spec.

---

## 3. Chart of Accounts

### 3.1 Concept

A tree of accounts. Leaf nodes hold transactions; group nodes exist only to
organise and subtotal. Every client gets their own tree, seeded from an India
template at onboarding, then customised.

### 3.2 The five root types (Lesson 1)

Every account descends from exactly one root type:

| root_type | Appears on | Increases with |
|---|---|---|
| Asset | Balance Sheet | Debit |
| Liability | Balance Sheet | Credit |
| Equity | Balance Sheet | Credit |
| Income | P&L | Credit |
| Expense | P&L | Debit |

`report_type` (Balance Sheet vs Profit and Loss) is **derived**, not stored
independently: Asset/Liability/Equity → Balance Sheet; Income/Expense → P&L.
Storing it separately invites the two to disagree.

### 3.3 Classification tags — the part that must be right

Reports depend entirely on these being correct at account-creation time. A
wrong tag here produces a wrong report forever, and the Trial Balance will
still balance perfectly (Lesson 2, error of principle — arithmetic checks
cannot catch it).

| Tag | Applies to | Values | Drives |
|---|---|---|---|
| `expense_class` | Expense accounts | `cogs` \| `opex` \| `non_operating` | The P&L waterfall (Lesson 7) |
| `liquidity_class` | Asset, Liability | `current` \| `non_current` | Balance Sheet grouping + Working Capital (Lesson 9) |
| `account_type` | All | see §3.4 | Behaviour — which accounts a given voucher type may touch |

**Deliberate difference from the reference implementation:** ERPNext infers
current-vs-non-current from the account's position in the tree (i.e. it sits
under a "Current Assets" group). We store it **explicitly** instead. Tree
position is fragile — a user reorganising their chart silently changes every
Working Capital figure they've ever reported. An explicit field means a
reclassification is a deliberate, audited act (and per `audit-trail.md` §4.3,
account changes are versioned).

### 3.4 `account_type` — behavioural classification

Not cosmetic. The engine uses it to decide what is legal.

| account_type | Meaning / behaviour |
|---|---|
| `bank`, `cash` | Real money. Bank reconciliation targets these. |
| `receivable` | Requires a `party_id` on every ledger line (a debtor) |
| `payable` | Requires a `party_id` on every ledger line (a creditor) |
| `tax_output` | GST collected — Liability (Lesson 5) |
| `tax_input` | GST paid, claimable — Asset (Lesson 5) |
| `tds_payable` | TDS withheld, owed to govt (Lesson 6) |
| `tds_receivable` | TDS deducted from us, claimable (Lesson 6) |
| `fixed_asset` | Depreciable. Linked to an asset register entry. |
| `accumulated_depreciation` | Contra-asset (Lesson 8). Normal balance is Credit despite being under Assets. |
| `stock` | Inventory valuation. Phase 2. |
| `cogs` | Cost of goods sold |
| `equity`, `capital`, `drawings` | Owner's stake (Lesson 3) |
| `round_off` | Absorbs sub-rupee rounding differences |
| `temporary` | Suspense / opening-balance offset. Must be zero at period end. |
| `general` | Ordinary income or expense with no special behaviour |

### 3.5 Schema

```
accounts
  id                uuid PK
  firm_id           uuid NOT NULL
  client_id         uuid NOT NULL
  code              text NULL              -- optional account number
  name              text NOT NULL
  parent_id         uuid NULL FK -> accounts
  is_group          boolean NOT NULL DEFAULT false
  root_type         enum NOT NULL          -- asset|liability|equity|income|expense
  account_type      enum NOT NULL          -- see §3.4
  expense_class     enum NULL              -- cogs|opex|non_operating (Expense only)
  liquidity_class   enum NULL              -- current|non_current (Asset/Liability only)
  normal_balance    enum NOT NULL          -- debit|credit (derived from root_type,
                                           --   overridden for contra accounts)
  currency          char(3) NOT NULL DEFAULT 'INR'
  is_frozen         boolean NOT NULL DEFAULT false   -- no new postings allowed
  is_disabled       boolean NOT NULL DEFAULT false
  version           int NOT NULL DEFAULT 1
  created_at, created_by, updated_at, updated_by

  UNIQUE (client_id, name, parent_id)
  CHECK (is_group = false OR parent_id IS NOT NULL OR root_type IS NOT NULL)
```

**Tree queries:** use `parent_id` with Postgres recursive CTEs. The reference
implementation uses a nested-set model (`lft`/`rgt`), which makes reads fast but
writes expensive and error-prone — every insert renumbers siblings. Charts of
accounts are read-heavy but small (200–400 rows per client); a recursive CTE is
fast enough and far simpler to keep correct. Revisit only if profiling says so.

### 3.6 India template

Seed each new client from a template mirroring standard Indian practice. The
top-level naming follows Indian/Tally convention rather than Western — this is
a `dont-scare-the-ca` decision, since it's what CAs expect to see:

```
Application of Funds (Assets)          [asset]
  Current Assets                       [current]
    Accounts Receivable → Debtors      [receivable]
    Bank Accounts                      [bank]
    Cash In Hand → Cash                [cash]
    Loans and Advances (Assets)
    Tax Assets → Input CGST / SGST / IGST   [tax_input]
                 TDS Receivable             [tds_receivable]
    Stock Assets                       [stock]        -- Phase 2
  Fixed Assets                         [non_current]
    Furniture and Fixtures             [fixed_asset]
    Office Equipment                   [fixed_asset]
    Plant and Machinery                [fixed_asset]
    Accumulated Depreciation           [accumulated_depreciation]
  Investments                          [non_current]
  Temporary Accounts → Temporary Opening    [temporary]

Source of Funds (Liabilities)          [liability]
  Capital Account                      [non_current]
    Owner's Capital                    [capital]
    Drawings                           [drawings]
    Reserves and Surplus
  Current Liabilities                  [current]
    Accounts Payable → Creditors       [payable]
    Duties and Taxes → Output CGST / SGST / IGST  [tax_output]
                        TDS Payable                [tds_payable]
    Loans (Liabilities)

Income                                 [income]
  Direct Income → Sales, Service
  Indirect Income → Interest Received, Other Income

Expenses                               [expense]
  Direct Expenses                      [cogs]
    Purchases, Raw Materials, Factory Wages, Freight Inward
  Indirect Expenses                    [opex]
    Salary, Office Rent, Marketing, Travel, Utilities,
    Professional Fees, Depreciation, Bad Debts, Print & Stationery
  Non-Operating                        [non_operating]
    Interest on Loan, Income Tax
```

Note how the "Direct / Indirect Expenses" split *is* the Lesson 7 COGS/OpEx
distinction, expressed the way Indian accountants already name it.

---

## 4. The ledger — core rules

**GL-1 — Every posting balances.** Sum of debits equals sum of credits, per
voucher. No exceptions, enforced before write.

**GL-2 — A line is one-sided.** Each ledger line carries either a debit or a
credit, never both. (`CHECK (NOT (debit > 0 AND credit > 0))`)

**GL-3 — Only leaf accounts take postings.** Group accounts (`is_group = true`)
exist for subtotalling; posting to them is rejected.

**GL-4 — Party required where the account demands it.** `receivable` and
`payable` accounts require a `party_id`. Without it, ageing reports and
settlement matching are impossible.

**GL-5 — Append-only.** Per `audit-trail.md` AT-2. `REVOKE UPDATE, DELETE` at
the database permission layer.

**GL-6 — Corrections are reversals.** Per AT-3/AT-4. No `is_cancelled` flag that
reports must remember to filter — a cancellation posts real reversing entries
with `reverses_entry_id` set. Reports need no special-casing, and a
period-closed report re-run later gives the same answer it gave then.

**GL-7 — Multi-currency: base is always INR.** Store the transaction amount and
currency, the exchange rate used, and the INR amount. All reporting is in INR.
Exchange gain/loss on settlement posts to a dedicated account. (Needed for
exporters; not a Phase-1 blocker.)

---

## 5. Two layers: vouchers and ledger entries

### 5.1 Why two layers

A Sales Invoice is a rich business document — customer, line items, HSN codes,
GST breakup, payment terms, an IRN. A ledger entry is a uniform four-field fact:
account, debit, credit, party.

Mixing them means either the ledger carries invoice-specific columns (bloated,
unqueryable) or invoices lose their structure (unusable for GST filing and
e-invoicing).

So: **source documents live in their own tables and *generate* ledger entries.**
The ledger is uniform regardless of what produced it, which is exactly what
makes Trial Balance a single simple query across everything.

```
     sales_invoices ─┐
    purchase_bills ─┤
          payments ─┼──generate──►  ledger_entries  ──queried by──►  reports
  journal_vouchers ─┤
     depreciation  ─┘
```

### 5.2 Voucher header (common to all source documents)

```
vouchers
  id                uuid PK
  firm_id           uuid NOT NULL
  client_id         uuid NOT NULL
  voucher_type      enum NOT NULL       -- §5.4
  voucher_number    text NOT NULL       -- per client, per type, per FY
  posting_date      date NOT NULL       -- accounting date
  fiscal_year_id    uuid NOT NULL
  narration         text
  status            enum NOT NULL       -- draft | posted | reversed
  reverses_id       uuid NULL FK -> vouchers
  reversed_by_id    uuid NULL FK -> vouchers
  source_document_id uuid NULL          -- the OCR'd bill/receipt image
  created_via       enum NOT NULL       -- ui | api | ai_proposal | tally_import | whatsapp
  ai_proposal_id    uuid NULL
  created_by        uuid NOT NULL
  approved_by       uuid NULL           -- required when AI-originated (AT-13)
  created_at        timestamptz NOT NULL DEFAULT now()

  UNIQUE (client_id, voucher_type, voucher_number, fiscal_year_id)
```

Type-specific detail (invoice line items, GST breakup, party terms) lives in
per-type tables keyed to this header. Those belong to the Invoicing and Bills
specs.

### 5.3 Ledger entries

```
ledger_entries
  id                  bigserial PK
  firm_id             uuid NOT NULL
  client_id           uuid NOT NULL
  voucher_id          uuid NOT NULL FK -> vouchers
  line_no             int  NOT NULL
  posting_date        date NOT NULL      -- denormalised from voucher, indexed
  fiscal_year_id      uuid NOT NULL      -- denormalised
  account_id          uuid NOT NULL FK -> accounts
  debit               numeric(18,2) NOT NULL DEFAULT 0
  credit              numeric(18,2) NOT NULL DEFAULT 0
  party_type          enum NULL          -- customer | supplier | employee
  party_id            uuid NULL
  cost_center_id      uuid NULL
  settles_voucher_id  uuid NULL FK -> vouchers   -- which invoice this payment clears
  against_accounts    text[] NULL        -- the contra side, for Tally-style display
  is_opening          boolean NOT NULL DEFAULT false
  finance_book_id     uuid NULL          -- §7.3
  txn_currency        char(3) NULL
  txn_amount          numeric(18,2) NULL
  exchange_rate       numeric(18,6) NULL
  created_at          timestamptz NOT NULL DEFAULT now()

  CHECK (debit >= 0 AND credit >= 0)
  CHECK (NOT (debit > 0 AND credit > 0))
  CHECK (debit > 0 OR credit > 0)
```

**Indexes** (reports live and die on these):
`(client_id, posting_date)`, `(client_id, account_id, posting_date)`,
`(client_id, party_id, posting_date) WHERE party_id IS NOT NULL`,
`(voucher_id)`, `(settles_voucher_id) WHERE settles_voucher_id IS NOT NULL`.

**`against_accounts`** is denormalised purely for Tally-style presentation
(`Cash A/c Dr. To Sales A/c`). It is display data, never used in computation.

### 5.4 Voucher types and Tally F-key mapping

Tally mode is mandatory (`dont-scare-the-ca`), so the voucher taxonomy mirrors
Tally's, including keyboard shortcuts. A CA's fingers already know these.

| Voucher type | Tally key | What it records | Typical posting |
|---|---|---|---|
| `contra` | **F4** | Cash ↔ bank movement | Bank Dr / Cash Cr |
| `payment` | **F5** | Money out | Creditor or Expense Dr / Bank Cr |
| `receipt` | **F6** | Money in | Bank Dr / Debtor or Income Cr |
| `journal` | **F7** | Adjustments, no cash | Any Dr / Any Cr |
| `sales` | **F8** | Sales invoice | Debtor Dr / Sales + Output GST Cr |
| `purchase` | **F9** | Purchase bill | Expense + Input GST Dr / Creditor Cr |
| `credit_note` | **Ctrl+F8** | Sales return / reduction | Sales + Output GST Dr / Debtor Cr |
| `debit_note` | **Ctrl+F9** | Purchase return / reduction | Creditor Dr / Expense + Input GST Cr |
| `opening` | — | Opening balances at go-live | §7.2 |
| `depreciation` | — | Periodic depreciation run | Depreciation Dr / Accum. Depn Cr |
| `period_close` | — | Year-end P&L transfer to Equity | §7.4 |

### 5.5 Posting rules

Each voucher type has a deterministic posting template. This is Lesson 1's DEAD
CLIC, automated — and it is **pure code, no AI** (per
`ai-harness-architecture`, the model may choose *which account*, never *which
side*).

**Sales invoice, intra-state, ₹10,000 + 18% GST** (Lesson 5):
```
Debtors (party = customer)     Dr  11,800
    Sales                          Cr  10,000
    Output CGST Payable            Cr     900
    Output SGST Payable            Cr     900
```

**Purchase bill, intra-state, ₹10,000 + 18% GST:**
```
Purchases / Expense            Dr  10,000
Input CGST Credit              Dr     900
Input SGST Credit              Dr     900
    Creditors (party = supplier)   Cr  11,800
```

**Payment to a vendor with TDS 10%** (Lesson 6):
```
Creditors (party = supplier)   Dr  50,000
    TDS Payable                    Cr   5,000
    Bank                           Cr  45,000
```

**Receipt settling an invoice** — note `settles_voucher_id`, which is what
closes the receivable and drives ageing:
```
Bank                           Dr  11,800
    Debtors (party = customer)     Cr  11,800   [settles_voucher_id = INV-2043]
```

Inter-state variants replace the CGST/SGST pair with a single IGST account.
Rate selection, place-of-supply logic, and reverse-charge belong to the GST
Engine spec; the GL Engine only receives the resolved account/amount pairs.

---

## 6. Validation — the deterministic gate

These run on every posting attempt, in code, **after** any AI involvement and
before any write. This is stage 5 of the harness pipeline. A model that
hallucinates cannot produce a bad ledger entry — only a rejected proposal.

| # | Rule | On failure |
|---|---|---|
| V-1 | Σ debits = Σ credits | Reject |
| V-2 | At least two lines | Reject |
| V-3 | Every line one-sided, amount > 0 | Reject |
| V-4 | All accounts exist, belong to this client, are leaves, not frozen/disabled | Reject |
| V-5 | Party present where `account_type` requires it | Reject |
| V-6 | `posting_date` falls in an open fiscal year and an unclosed period | Reject |
| V-7 | `posting_date` not in the future beyond a configurable tolerance | Warn |
| V-8 | Voucher number unique per client/type/FY | Reject |
| V-9 | Tax amounts recomputed independently and matched against submitted values | Reject on mismatch |
| V-10 | Rounding difference ≤ ₹1 absorbed to `round_off`; beyond that, reject | Reject |
| V-11 | Currency and exchange rate present when non-INR | Reject |
| V-12 | AI-originated voucher has a non-null `approved_by` (AT-13) | Reject |
| V-13 | Duplicate detection: same client + party + amount + date + document ref | Warn, require confirmation |

V-9 is the load-bearing one for AI safety: never trust a submitted tax figure.
Recompute from taxable value × rate and compare.

---

## 7. Time: fiscal years, periods, opening balances, books

### 7.1 Fiscal year

India runs **1 April to 31 March**. Every client has fiscal-year records; every
voucher and ledger entry carries `fiscal_year_id`. Support short first years
(a company incorporated in November has a 1 Nov – 31 Mar first FY).

### 7.2 Opening balances

At go-live (usually mid-year, or at Tally migration), the client's existing
balances must be loaded. One `opening` voucher per client per fiscal year, with
`is_opening = true` on every line.

The two sides must balance — and they will, because the source system's Trial
Balance balanced. If they don't, the difference goes to a `temporary` suspense
account and is surfaced loudly to the CA as a migration exception. **Never
silently absorb a difference.**

Opening entries are excluded from P&L (they'd double-count prior-year income)
but included in Balance Sheet.

### 7.3 Finance books (dual depreciation)

Lesson 8 noted that Indian businesses often maintain two depreciation figures —
one under the Companies Act for statutory books, one under the Income Tax Act
(mandatory WDV, prescribed block rates) for the tax return.

`finance_book_id` handles this: entries with `finance_book_id IS NULL` are the
primary/statutory books; entries tagged to a specific finance book represent an
alternate view. Reports filter accordingly. Only depreciation uses this in
Phase 1; the mechanism is general.

### 7.4 Period close

- **Soft close (monthly):** block new postings into the closed month, with an
  override role for the CA. Reversible.
- **Hard close (year-end):** transfer all Income and Expense balances to Equity
  via a `period_close` voucher — this is Lesson 3's *"profit flows into
  Equity"*, made concrete. After it, P&L accounts start the new year at zero
  while Balance Sheet accounts carry forward.

Closing is itself a voucher, and therefore audited and reversible-by-reversal.

---

## 8. Reports are queries, not tables

No stored balances anywhere. Every report is a query over `ledger_entries`.

| Report | Query shape |
|---|---|
| **Ledger** (Lesson 2) | Filter one account, order by date, running balance |
| **Trial Balance** (Lesson 2) | `GROUP BY account_id`, `SUM(debit)`, `SUM(credit)`, as-of date |
| **P&L** (Lesson 7) | Income/Expense accounts, date *range*, grouped by `expense_class` → Gross → Operating → Net |
| **Balance Sheet** (Lesson 9) | Asset/Liability/Equity, *as-of* date, grouped by `liquidity_class` |
| **Cash Flow** (Lesson 10) | Net Profit + depreciation add-back + working-capital deltas, split operating/investing/financing |
| **Ageing (AR/AP)** (Lesson 4) | Receivable/payable lines where `settles_voucher_id` chain is unsettled, bucketed by age |
| **Working Capital** (Lesson 9) | Current Assets − Current Liabilities, straight off `liquidity_class` |

Note the **date range vs as-of** distinction: P&L covers a period; Balance Sheet
is a point in time. Getting this backwards is a classic reporting bug.

**Performance:** if Trial Balance over millions of rows gets slow, add a
monthly `account_period_balances` rollup as a *derived cache*, rebuildable from
scratch. Never let it become the source of truth — that reintroduces drift.

**Every report figure must be drillable** to the ledger entries composing it,
and onward to the source document — see [provenance.md](provenance.md) PR-14.
This is the default interaction on any number, not a hidden feature. It is also
why `voucher_id` and `source_document_id` linkage must never be optional.

---

## 9. Multi-tenancy

Two levels: **CA firm → client (the SMB) → users**.

- Every table carries `firm_id` and `client_id`
- Postgres **row-level security** keyed on the session's firm — defence in
  depth, so a missing `WHERE` clause in application code cannot leak across
  firms
- A CA user is scoped to their firm and may access clients within it
- An SMB owner user is scoped to a single client
- Cross-firm access is impossible by construction; attempts are logged (AT-13
  companion rule in `audit-trail.md` §7)

---

## 10. BharatERP-specific requirements

### 10.1 Tally mode

- Voucher entry screens mirror Tally's layout and tab order; F-keys per §5.4
- Amounts display Indian-numbering (`11,80,000` — lakh/crore grouping, not
  `1,180,000`)
- Ledger and Day Book views match Tally's column layout and the
  `Dr / To Cr` presentation convention
- Account picker behaves like Tally's — type-ahead over the full chart, keyboard
  only, no mouse required for a complete entry

### 10.2 AI integration points

The GL Engine exposes exactly two hooks to the AI layer, and neither can bypass
§6:

1. **Account suggestion** — given an extracted document and this client's chart,
   propose account IDs. The engine still applies the posting template and
   validation.
2. **Settlement matching** — given a bank line, propose a `settles_voucher_id`.
   The engine verifies the amount and party actually reconcile.

The AI never chooses debit vs credit, never computes tax, never sets a date.
Those are template and validation concerns.

### 10.3 Tally import

Tally's data maps onto this model closely — which is unsurprising, since the
voucher taxonomy was chosen to match. Ledgers → accounts, Groups → group
accounts, Vouchers → vouchers, and Tally's own Dr/Cr lines → ledger entries.
The importer must preserve original voucher numbers and dates, tag everything
`created_via = 'tally_import'` (AT-9), and reconcile the imported Trial Balance
against Tally's own before declaring success. Detail belongs in the migration
spec.

---

## 11. Test cases

| # | Given | When | Then |
|---|---|---|---|
| T-1 | Debits 11,800, credits 10,900 | Post | Rejected (V-1). Nothing written. |
| T-2 | A line with both debit and credit > 0 | Post | Rejected (V-3) |
| T-3 | Posting to a group account | Post | Rejected (V-4) |
| T-4 | Receivable line with no party | Post | Rejected (V-5) |
| T-5 | Sale ₹10,000 + 18% intra-state | Post | 4 lines: Debtors Dr 11,800; Sales Cr 10,000; CGST Cr 900; SGST Cr 900 |
| T-6 | Same, inter-state | Post | 3 lines: Debtors Dr 11,800; Sales Cr 10,000; IGST Cr 1,800 |
| T-7 | Payload claims CGST 900 but taxable × rate = 950 | Post | Rejected (V-9) |
| T-8 | Posting date in a closed period | Post | Rejected (V-6) |
| T-9 | Any set of postings | Run Trial Balance | Σ debits = Σ credits (Lesson 2) |
| T-10 | Any set of postings | Run Balance Sheet | Assets = Liabilities + Equity (Lesson 3) |
| T-11 | Posted voucher | Cancel it | Reversal voucher created; original intact; net ledger effect zero |
| T-12 | Receipt settling INV-2043 in full | Run AR ageing | INV-2043 no longer outstanding |
| T-13 | Partial receipt ₹10,000 against ₹15,000 invoice | Run AR ageing | ₹5,000 still outstanding, aged from original invoice date |
| T-14 | Opening balances that don't balance | Import | Difference posted to suspense **and** surfaced as an exception |
| T-15 | Year-end close | Run | Income/Expense → zero; net profit lands in Equity; Balance Sheet still balances |
| T-16 | AI-proposed voucher, `approved_by` null | Post | Rejected (V-12) |
| T-17 | Firm A user | Query firm B's ledger | Zero rows (RLS), attempt logged |
| T-18 | Sale ₹1,000 at 18%, rounding to ₹1,180.00 vs ₹1,179.99 | Post | ₹0.01 to round_off, accepted (V-10) |

---

## 12. Open questions — for the CA advisor

**12.1 Cost centers / accounting dimensions.** Do target SMBs actually use
them, or is this enterprise complexity? Adding later is painful (it's a column
on every ledger row); adding unused complexity now is also a cost. *Lean:
include the nullable column from day one, hide the UI until Phase 2.*

**12.2 Voucher numbering.** Per type per FY, or one continuous series? Tally
defaults to per-type. Do CAs expect gaps to be impossible (a cancelled voucher
keeps its number)? Statutory relevance for GST invoice numbering specifically.

**12.3 Multiple currencies at Phase 1.** How many target clients export? If
few, defer §GL-7 entirely and save real complexity.

**12.4 Soft-close override.** Which roles may post into a soft-closed period —
only the firm's partner CA, or any CA user?

**12.5 Suspense account tolerance.** At what balance should an unresolved
`temporary` account block period close rather than merely warn?

---

## 13. Reference studied

`erpnext/erpnext/accounts/doctype/` — specifically `gl_entry`, `account`,
`journal_entry`, `fiscal_year`, `accounting_period`, and the India chart of
accounts template. Observations that informed this spec:

- The two-layer split (business documents generating uniform GL rows) is the
  right shape and is adopted here.
- Their five `root_type` values match the five account types from first
  principles; their `report_type` is derivable, so we derive it.
- Their `account_type` enum encodes behaviour, not just labels — adopted, and
  trimmed to what an India-first SMB product actually needs.
- Their `against_voucher` linkage is how settlement and ageing work; adopted as
  `settles_voucher_id`.
- Their `finance_book` mechanism solves the dual-depreciation problem; adopted.
- They infer current-vs-non-current from tree position. **Rejected** — we store
  it explicitly (§3.3), because tree reorganisation silently corrupting
  historical Working Capital figures is unacceptable.
- They use a nested-set tree (`lft`/`rgt`). **Rejected** for a recursive CTE —
  simpler, and chart sizes don't justify the write complexity.
- They soft-flag cancellations (`is_cancelled`). **Rejected** in favour of real
  reversal postings, per `audit-trail.md` AT-4 — reports then need no
  special-casing and historical re-runs stay stable.

Nothing from the reference is reproduced. The multi-tenant model (§9), AI
integration boundary (§10.2), validation gate (§6), and Tally-mode requirements
(§10.1) have no counterpart there.
