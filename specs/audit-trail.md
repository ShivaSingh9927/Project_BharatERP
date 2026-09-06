# Spec: Audit Trail / Immutable Books of Account

**Status:** Draft — needs CA advisor review
**Owner:** —
**Depends on:** GL Engine schema (not yet spec'd)
**Blocks:** Everything that writes to the ledger. Build this first.

---

## 1. Purpose

Every change to a customer's books of account must be permanently recorded —
who changed what, when, and what the value was before and after. The record
must survive attempts to erase it, including by an administrator, including
by BharatERP itself.

This is not a feature we are choosing to build. For any customer registered as
a company, it is illegal to maintain books in software that lacks it.

---

## 2. Legal basis

**Companies (Accounts) Rules, 2014 — Rule 3(1), as amended by MCA
Notification dated 24 March 2021.** Enforcement was deferred twice and became
effective for financial years beginning **1 April 2023 (FY 2023-24)**.

The rule requires that accounting software used by a company:

1. Have a feature recording an **audit trail of each and every transaction**
2. Create an **edit log of each change** made in books of account, **along with
   the date when such changes were made**
3. Ensure the audit trail **cannot be disabled**

Additionally, the company's statutory auditor must report — in their audit
report — whether the software had this feature, whether it operated throughout
the year, and whether it was tampered with. A negative finding is a reportable
audit qualification against the customer.

**Consequence for BharatERP:** if we get this wrong, our customer's auditor
reports it, the customer's directors face penalty exposure, and the CA who
recommended us takes the reputational hit. This is the single highest-stakes
correctness requirement in the product. See the `dont-scare-the-ca` product
philosophy — nothing destroys CA trust faster than causing an audit
qualification.

---

## 3. Scope

### 3.1 In scope — "books of account"

Any entity whose creation, change, or cancellation affects the general ledger,
asset valuation, or stock valuation. At minimum:

**Ledger-affecting transactions**
- Journal Entry
- Sales Invoice, Credit Note
- Purchase Invoice / Bill, Debit Note
- Payment Entry (receipt, payment, contra)
- Period Closing entry

**Valuation-affecting transactions**
- Fixed Asset (creation, disposal, revaluation)
- Depreciation schedule and posted depreciation
- Stock Entry, Stock Reconciliation, Delivery Note, Purchase Receipt
  *(Phase 2 — when inventory ships)*

**Compliance filings**
- GSTR-1 / GSTR-3B submission records
- TDS return submission records
- e-Invoice IRN and e-Way Bill generation/cancellation logs

**Configuration that changes accounting outcomes**
- Chart of Accounts (account creation, rename, reclassification)
- Tax rate / TDS section master overrides at client level
- Fiscal year and period-close settings
- The audit-trail enablement flag itself

### 3.2 Out of scope

- Read-only actions (viewing a report) — logged separately as access logs, not
  as audit trail. Different retention, different table, much higher volume.
- Non-financial masters with no ledger impact (user preferences, UI settings,
  notification config)
- Draft documents that were never submitted — see §5.4 for the nuance

### 3.3 Explicitly not exempt

- Corrections made by a CA
- Entries created by AI and approved by a CA
- Bulk/batch operations
- Data imported during Tally migration
- Anything done by a BharatERP support engineer

---

## 4. Data model

### 4.1 Two classes of data, two different mechanisms

This distinction is the core architectural decision. Getting it wrong makes
everything downstream painful.

| Class | Examples | Mechanism | Can the row change? |
|---|---|---|---|
| **Transactional** | Journal entries, invoice postings, payments | **Append-only.** Never updated, never deleted. Corrections are new reversing entries. | No — immutable |
| **Master / config** | Chart of accounts, vendor, customer, tax rates | **Versioned.** Rows may change, but every prior version is retained. | Yes — but history kept |

**Why the split:** a posted journal entry represents an event that happened. It
cannot "become" different — history doesn't change. A vendor's address, by
contrast, legitimately changes over time; we need the current value plus the
ability to reconstruct what it was on any past date.

### 4.2 Transactional data — append-only ledger

> **Superseded by [gl-engine.md](gl-engine.md) §5.** The GL Engine spec splits
> this into two layers — `vouchers` (business documents) and `ledger_entries`
> (uniform double-entry rows) — which is the authoritative schema. The sketch
> below is retained because the *immutability* rules (AT-2, AT-3, AT-4) it
> illustrates apply unchanged to both layers.

```
journal_entries
  id                  uuid PK
  client_id           uuid    NOT NULL   -- the SMB, scoped under a CA firm
  firm_id             uuid    NOT NULL   -- the CA firm (multi-tenant boundary)
  voucher_type        enum    NOT NULL   -- sales, purchase, payment, receipt,
                                         -- journal, contra, credit_note, debit_note
  voucher_number      text    NOT NULL   -- human-facing, per client per FY
  posting_date        date    NOT NULL   -- accounting date (may differ from created_at)
  narration           text
  source_document_id  uuid    NULL FK    -- the invoice/bill/receipt this came from
  reverses_entry_id   uuid    NULL FK    -- set only on reversal entries
  reversed_by_id      uuid    NULL FK    -- set on the original when reversed
  created_by          uuid    NOT NULL   -- human user
  created_via         enum    NOT NULL   -- ui | api | ai_proposal | tally_import | whatsapp
  approved_by         uuid    NULL       -- CA who approved (see §6)
  ai_proposal_id      uuid    NULL FK    -- if AI-originated
  created_at          timestamptz NOT NULL DEFAULT now()   -- SERVER time, never client
  UNIQUE (client_id, voucher_type, voucher_number)

journal_entry_lines
  id            uuid PK
  entry_id      uuid NOT NULL FK -> journal_entries
  line_no       int  NOT NULL
  account_id    uuid NOT NULL FK -> accounts
  debit         numeric(18,2) NOT NULL DEFAULT 0
  credit        numeric(18,2) NOT NULL DEFAULT 0
  party_id      uuid NULL          -- debtor/creditor when applicable
  cost_center_id uuid NULL
  CHECK (debit >= 0 AND credit >= 0)
  CHECK (NOT (debit > 0 AND credit > 0))   -- a line is one side, never both
```

**Enforcement:** database-level `REVOKE UPDATE, DELETE` on both tables for the
application role. Not an application convention — an actual permission. The
application role can only `INSERT` and `SELECT`. This means a bug, a rogue
migration, or a compromised API key cannot rewrite history.

### 4.3 Master data — versioned

```
accounts                        -- current state, one row per account
  id, client_id, code, name, account_type, root_type,
  cogs_or_opex, current_or_noncurrent, is_group, parent_id,
  version int NOT NULL, updated_at, updated_by

account_versions                -- append-only history
  id            uuid PK
  account_id    uuid NOT NULL
  version       int  NOT NULL
  snapshot      jsonb NOT NULL   -- full row as of this version
  changed_by    uuid NOT NULL
  changed_at    timestamptz NOT NULL DEFAULT now()
  UNIQUE (account_id, version)
```

Same pattern for `vendors`, `customers`, `items`, and any tax-rate override
table. Write the version row in the same transaction as the update — a trigger
is preferable to application code, so it cannot be bypassed.

### 4.4 The audit log itself

One table, every mutation across the system.

```
audit_log
  id            bigserial PK
  firm_id       uuid NOT NULL
  client_id     uuid NULL          -- null for firm-level actions
  entity_type   text NOT NULL      -- 'journal_entry', 'account', 'gstr1_filing', ...
  entity_id     uuid NOT NULL
  action        enum NOT NULL      -- create | update | cancel | reverse | submit | approve | reject
  before        jsonb NULL         -- null on create
  after         jsonb NULL         -- null on delete-equivalents
  actor_user_id uuid NULL          -- null only for system/scheduled jobs
  actor_type    enum NOT NULL      -- human | ai_agent | system_job | support_engineer
  ai_model      text NULL          -- model identifier when actor_type = ai_agent
  approved_by   uuid NULL          -- CA who authorised, when AI-originated
  session_id    uuid NULL
  ip_address    inet NULL
  user_agent    text NULL
  occurred_at   timestamptz NOT NULL DEFAULT now()   -- SERVER clock only
```

**Enforcement:** `REVOKE UPDATE, DELETE` for the application role, same as the
ledger. Append-only at the permission layer.

### 4.5 Tamper evidence

Immutability by permission is necessary but not sufficient — someone with
direct database access could still alter rows. Add a hash chain:

```
audit_log.prev_hash   text NOT NULL
audit_log.row_hash    text NOT NULL   -- sha256(prev_hash || canonical_json(row fields))
```

Each row's hash incorporates the previous row's hash, per `firm_id`. A nightly
job verifies the chain end-to-end and alerts on any break. This makes silent
tampering detectable even by someone with database credentials — which is
exactly the assurance an auditor needs, and what "cannot be tampered with"
requires in practice.

Store a periodic checkpoint (e.g. daily terminal hash per firm) in
write-once storage (S3 Object Lock) so the chain cannot simply be rebuilt
wholesale.

---

## 5. Business rules

Numbered so tests can reference them.

**AT-1 — Always on.**
The audit trail has no off switch. There is no setting, no environment
variable, no feature flag, and no support-tool override that disables it.

*Note on the reference implementation:* India Compliance ships this as an
opt-in toggle that is one-way (once enabled, cannot be disabled) — because it
retrofits onto existing ERPNext installations that predate the requirement.
BharatERP is greenfield, so we skip the toggle entirely. Simpler, and strictly
more compliant.

**AT-2 — No update, no delete on posted transactions.**
Once a journal entry is posted, its rows are immutable. Enforced at the
database permission layer (§4.2), not by application convention.

**AT-3 — Corrections are reversals.**
To correct a posted entry: create a reversal entry (same lines, debits and
credits swapped, `reverses_entry_id` set), then create the corrected entry.
All three remain permanently visible. Set `reversed_by_id` on the original in
the same transaction.

**AT-4 — Cancellation is a reversal, not a deletion.**
"Cancelling" an invoice posts a reversal and marks the original cancelled. The
original never disappears from the ledger or from reports run for prior dates.

**AT-5 — Server time only.**
`occurred_at`, `created_at`, and `changed_at` are set by the database
(`now()`), never accepted from a client. `posting_date` is user-supplied and is
a *different field* — it is the accounting date and may legitimately be
backdated within an open period.

**AT-6 — Backdating is allowed but always visible.**
A user may post to an earlier date within an open fiscal period. The audit log
records both `posting_date` (what they claimed) and `occurred_at` (when they
actually did it). A report showing entries where these diverge by more than N
days is an auditor's first stop. Once a period is closed, backdating into it is
rejected.

**AT-7 — Drafts are exempt until submitted.**
A draft invoice being edited before submission is not yet part of the books.
Track draft edits in a lightweight table with short retention, not in the audit
trail. The moment a document is submitted, it becomes a book of account and
AT-2 applies from that point forward.
*Open question — see §9.1.*

**AT-8 — Bulk operations log per record.**
Filing GSTR-1 for 30 clients writes 30 audit rows, not 1. A batch identifier
groups them (`batch_id`), but each client's books get their own entry.

**AT-9 — Imports are logged.**
Every record created during Tally migration is logged with
`created_via = 'tally_import'` and a reference to the import batch. An auditor
must be able to distinguish imported opening data from transactions originated
in BharatERP.

**AT-10 — Support access is logged and visible to the customer.**
When a BharatERP engineer accesses a client's books, `actor_type =
'support_engineer'`, and the CA can see this in their own audit report. No
invisible support access, ever.

**AT-11 — Retention: 8 years minimum.**
Section 128(5) of the Companies Act requires books of account to be preserved
for **8 financial years** preceding the current year. Audit trail records are
part of that. Never hard-delete; archive to cold storage with the hash chain
intact. Note this interacts with DPDP Act erasure rights — see §9.3.

**AT-12 — Audit trail survives client offboarding.**
If a CA firm stops using BharatERP, the customer's audit trail must be
exportable in a readable, verifiable form (including the hash chain) before
any data removal. Offboarding cannot silently destroy books.

---

## 6. BharatERP-specific: AI attribution

This has no equivalent in the reference implementations, because they have no
AI. It is a genuine new requirement and it must be designed in, not added
later.

**The problem:** when AI drafts a journal entry and a CA approves it, who made
the change? An auditor asking "who authorised this entry?" must get a truthful,
complete answer.

**The rule:** every AI-originated entry records **both** parties.

| Field | Value | Meaning |
|---|---|---|
| `actor_type` | `ai_agent` | The proposal was machine-generated |
| `ai_model` | e.g. `deepseek-v3` | Which model produced it |
| `ai_proposal_id` | FK | Links to the stored proposal, its inputs, and its confidence score |
| `approved_by` | CA's user id | The human who authorised it |
| `created_by` | CA's user id | Legal responsibility rests with the human |

**AT-13 — No AI entry without a human approver.**
`actor_type = 'ai_agent'` requires a non-null `approved_by`. Enforced as a
database constraint.

This holds even for auto-posted entries. "Auto-post" in the harness
architecture means *a CA pre-authorised this pattern*, not *no human is
responsible*. The audit log records which CA set that rule, when, and for which
category — so the approval chain is never broken, only shifted earlier in time.

**AT-14 — The AI proposal is retained, including rejected ones.**
Store what the model was given, what it proposed, its confidence, and what the
CA changed. This serves three purposes at once: audit defensibility, the
per-client learning loop, and eval data for measuring auto-post precision.

**AT-15 — Model changes are logged at firm level.**
When the model backing a client's classification changes, log it. An auditor
reviewing a year's books should be able to see that entries before March used
one model and after March another — the same way they'd expect to know if the
bookkeeping staff changed.

---

## 7. Reports (CA-facing)

The legal requirement is that the data exists. The *useful* part is that a CA
can answer an auditor's question in thirty seconds instead of a day.

| Report | Answers |
|---|---|
| **Change log by document** | "Show me everything that ever happened to invoice INV-2043" |
| **Activity by user** | "What did this junior accountant change last quarter?" |
| **Activity by client** | Firm-level view across the CA's whole book |
| **Backdated entries** | Entries where `posting_date` and `occurred_at` diverge — first thing an auditor looks for |
| **Reversals and corrections** | Every reversal, with reason and who did it |
| **AI vs human breakdown** | What proportion was AI-drafted, what the CA changed. Doubles as the "hours saved" evidence for the ICP value pitch. |
| **Support access log** | Every BharatERP staff access, customer-visible |
| **Chain integrity** | Hash chain verification status, per period |

All reports scoped to `firm_id` and, where applicable, `client_id`. A CA can
never see another firm's audit data. Export to PDF and Excel — auditors ask
for both.

---

## 8. Test cases

| # | Given | When | Then |
|---|---|---|---|
| T-1 | A posted journal entry | Application attempts `UPDATE` | Database rejects — permission denied, not an application error |
| T-2 | A posted journal entry | Application attempts `DELETE` | Database rejects |
| T-3 | An audit_log row | Any attempt to modify it | Database rejects |
| T-4 | A wrong posted entry | CA corrects it | Three entries exist: original, reversal, correction. All queryable. |
| T-5 | Any entry | Client sends `created_at` in the payload | Ignored; server clock used |
| T-6 | A closed fiscal period | User posts with a date inside it | Rejected with a clear message |
| T-7 | An open period, 10 days back | User posts a backdated entry | Accepted; appears in the backdated-entries report |
| T-8 | AI proposes an entry | Entry saved with `approved_by = NULL` | Constraint violation (AT-13) |
| T-9 | Auto-post enabled for a category | Entry auto-posts | `approved_by` = the CA who enabled the rule; rule-enablement event also in the log |
| T-10 | 30 clients | Batch GSTR-1 filing | 30 audit rows sharing one `batch_id` |
| T-11 | Tally import of 5,000 entries | Import completes | All 5,000 tagged `created_via = 'tally_import'` with batch reference |
| T-12 | An audit_log row altered via direct DB access | Chain verification job runs | Break detected and alerted, with the position identified |
| T-13 | A CA logged into firm A | Requests audit data for firm B | Denied; the denial itself is logged |
| T-14 | Support engineer opens a client's ledger | CA views their audit report | The access is visible to the CA |
| T-15 | Entry with debits 11,800 and credits 10,900 | Attempt to post | Rejected before any audit row is written — invalid entries never enter the books |

---

## 9. Open questions — for the CA advisor

**9.1 Draft edits.** AT-7 exempts pre-submission drafts. Is that defensible to
an auditor, or do they expect the trail to start at document creation? Cheaper
to over-log than to discover we under-logged. *Lean: log drafts too, with
shorter retention.*

**9.2 Period close.** What exactly should closing a period lock? Only posting
into it, or also amendments to masters that would change how closed-period
reports render?

**9.3 DPDP Act vs 8-year retention.** India's DPDP Act gives individuals
erasure rights; Companies Act mandates 8-year preservation. Where personal data
appears inside books (a vendor who is an individual), which wins? Likely the
statutory retention obligation, but needs a legal read before we design the
erasure flow.

**9.4 Non-company clients.** Proprietorships and partnerships aren't covered by
Rule 3(1). Do we run the same trail for them anyway? *Lean: yes — uniform
architecture, no configuration surface, and it's a selling point.*

**9.5 Auditor read-only access.** Should an external auditor get a scoped
read-only login to inspect the trail directly? Would be a genuine
differentiator, but it's a new permission tier and a new attack surface.

---

## 10. Reference studied

`india-compliance/india_compliance/audit_trail/` — studied for scope
definition and enforcement approach. Specific observations that informed this
spec:

- Their scope list is defined as "anything that makes a GL entry" plus
  asset/stock valuation documents. Adopted, and extended to compliance filings.
- They protect the version records themselves from edit and deletion — not just
  the source documents. Adopted as §4.4's append-only audit log.
- They also block schema-level changes (form customisation, property setters)
  that could disable change-tracking. Closing that loophole matters; our
  equivalent is that tracking is not configurable at all (AT-1).
- Their enablement flag is one-way (enable-only). We omit the flag entirely —
  greenfield, so no retrofit path is needed.

Nothing from the reference implementation is reproduced here. This spec
describes BharatERP's own design for a Postgres/Fastify stack, and adds the
AI-attribution requirements (§6) and hash-chain tamper evidence (§4.5), which
have no counterpart in the reference.
