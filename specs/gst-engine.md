# Spec: GST Engine

**Status:** Draft — needs CA advisor review. **Every deadline, rate, and
threshold below must be re-verified at build time** (standing rule — see
[invoicing.md](invoicing.md) §2.3).
**Owner:** —
**Depends on:** [invoicing.md](invoicing.md), [bills-and-expenses.md](bills-and-expenses.md),
[gl-engine.md](gl-engine.md), [provenance.md](provenance.md)
**Vendor:** Sandbox (`api.sandbox.co.in`, via Quicko GSP) — probe-validated

---

## 1. Purpose

The GST Engine is where BharatERP's compliance moat actually lives. Invoicing
produces outward-supply data; bills produce inward-supply data. This module
turns both into **filed returns**, and — more importantly for the client's cash
— determines how much **input tax credit** they may legitimately claim.

Two of the top-ranked features by hours saved live here:
**2A/2B reconciliation** (#3) and **GSTR-1/3B computation and filing** (#4).

Recall Lesson 5: net GST payable = output tax collected − input credit
claimable. Everything in this spec exists to make both halves of that
subtraction defensible.

---

## 2. Scope

**In scope:** GSTR-1, GSTR-3B, GSTR-9, GSTR-1A; GSTR-2A/2B retrieval; the
Invoice Management System (IMS); purchase reconciliation; the three government
ledgers; ITC set-off computation; filing via GSP; deadline tracking; interest
and late-fee computation.

**Out of scope:** invoice creation ([invoicing.md](invoicing.md)), e-Invoice
IRN and e-Way Bill (also invoicing — they are invoice-time events, not
return-time), bill capture ([bills-and-expenses.md](bills-and-expenses.md)),
TDS returns (TDS Engine spec), GST refunds and appeals (Phase 3).

---

## 3. The returns landscape

| Return | What it is | Filed by | Typical due date |
|---|---|---|---|
| **GSTR-1** | Outward supplies — every sales invoice, in detail | Regular taxpayers | 11th of following month |
| **GSTR-1A** | Amendment to a filed GSTR-1, before 3B | Optional | Before 3B filing |
| **GSTR-3B** | Summary return **and tax payment** | Regular taxpayers | 20th of following month |
| **GSTR-2A** | Auto-drafted inward supplies — **dynamic**, changes as suppliers file | System-generated | Read-only |
| **GSTR-2B** | **Static** ITC statement, frozen on generation | System-generated ~14th | Read-only |
| **IMS** | Invoice Management System — accept / reject / keep pending each inward invoice | Recipient action | Before 2B lock |
| **GSTR-9** | Annual return | Turnover above threshold | 31 December following FY |
| **CMP-08 / GSTR-4** | Composition scheme | Composition dealers | Quarterly / annual |

**GE-1 — GSTR-2B, not 2A, is the authoritative basis for claiming ITC.**
2A is dynamic and keeps changing as suppliers file late; 2B is frozen at
generation. Claiming against a moving target produces figures that cannot be
reproduced later. Use 2A for *investigation*, 2B for *claiming*.

**GE-2 — GSTR-1 must be filed before GSTR-3B.** The sequence is enforced by
GSTN. The CA console's per-client status must reflect this dependency, not
present them as independent tasks.

**GE-3 — GSTR-3B cannot be revised.** There is no amendment mechanism. An error
is corrected in a *subsequent* period's return. This surprises people
constantly, and it means pre-filing validation matters far more than it would
in a system with revisions. Treat the submit action as irreversible in the UI.

---

## 4. QRMP — the scheme most of your clients will be on

Taxpayers with aggregate annual turnover up to a threshold (commonly ₹5 crore)
may opt for **Quarterly Return, Monthly Payment**:

- **GSTR-1 filed quarterly** (or invoices uploaded monthly via IFF — Invoice
  Furnishing Facility — so customers get their ITC without waiting a quarter)
- **Tax paid monthly** via challan **PMT-06**, using either a fixed-sum method
  (35% of last period's cash paid) or self-assessment
- **GSTR-3B filed quarterly**, with due dates staggered by state group

**GE-4 — QRMP is a different workflow, not a setting.** Given BharatERP targets
SMBs, **most clients will be on QRMP**, so this cannot be a Phase-2
afterthought. The monthly-payment / quarterly-return split changes the deadline
calendar, the CA console's task list, and what "am I compliant this month?"
means.

**GE-5 — IFF is a real workflow.** A B2B client on QRMP who does *not* upload
via IFF makes their own customers wait up to a quarter for ITC. Their customers
will complain. Surface IFF as a monthly action, not an optional extra.

---

## 5. GSTR-1 — outward supplies

### 5.1 Tables, and where each comes from

Every table maps deterministically from invoicing data. This is the core
mapping the engine implements.

| Table | Contents | Source |
|---|---|---|
| **B2B** | Supplies to registered persons, invoice-wise | `gst_category` ∈ registered (§3.1 of invoicing) |
| **B2CL** | Supplies to unregistered, **inter-state above value threshold**, invoice-wise | Unregistered + inter-state + above limit |
| **B2CS** | All other B2C — **rate-wise consolidated**, not invoice-wise | Unregistered, remainder |
| **CDNR** | Credit/debit notes issued to **registered** persons | Credit/debit notes, B2B |
| **CDNUR** | Credit/debit notes to **unregistered** persons | Credit/debit notes, B2C |
| **EXP** | Exports — split `EXPWP` (with payment of tax) / `EXPWOP` (without) | `is_export` + `export_type` |
| **AT** | Advances received on which tax is payable | Advance receipts |
| **TXP / TXPD** | Tax paid on advances, adjusted against invoices | Advance adjustments |
| **NIL / EXEMPT** | Nil-rated, exempt, non-GST supplies | `gst_treatment` |
| **HSN** | **HSN-wise summary** of outward supplies | Aggregated from invoice lines |
| **SUPECOM** | Supplies made through e-commerce operators | E-commerce flagged supplies |
| **DOC_ISSUE** | Serial ranges of documents issued, cancelled, net | Voucher numbering |

**GE-6 — B2CS is consolidated, B2B is invoice-wise.** A common source of
mismatch: aggregating B2B or itemising B2CS both produce a return GSTN rejects.

**GE-7 — HSN summary is mandatory and requires per-line HSN.** This is why
[invoicing.md](invoicing.md) SI-5 forbids blank HSN codes. A missing HSN is not
a cosmetic gap — it makes the return unfileable.

**GE-8 — DOC_ISSUE is why cancelled invoice numbers must be retained.** This
table declares the serial ranges issued and cancelled. It is the mechanism that
makes [invoicing.md](invoicing.md) INV-2 (never reuse a cancelled number)
statutorily necessary rather than merely tidy.

### 5.2 Amendment tables

Every table has an amendment counterpart (`B2BA`, `B2CLA`, `CDNRA`, `HSNA`…)
for correcting a previously filed period. Amendments carry the **original**
invoice reference plus the revised values, and are subject to the same
time limit as credit notes (broadly, by 30 November following the FY).

---

## 6. GSTR-3B — the summary and the payment

Not a detailed return — a summary that also *effects payment*.

| Section | Contents |
|---|---|
| **3.1** | Outward supplies and inward liable to reverse charge |
| **3.1.1** | Supplies via e-commerce operators (§9(5) cases) |
| **3.2** | Of 3.1, inter-state supplies to unregistered / composition / UIN |
| **4** | **Eligible ITC** — available, reversed, net |
| **5** | Exempt, nil-rated, non-GST inward supplies |
| **5.1** | Interest and late fee |
| **6.1** | **Payment of tax** — cash and credit utilisation |

**GE-9 — Table 4 is where reconciliation output lands.** ITC available (from
2B), less reversals (blocked credits per §17(5), the 180-day rule, ineligible
by place-of-supply), gives net claimable. Every figure must trace back to the
specific bills that produced it (§11).

---

## 7. GSTR-2B, IMS, and reconciliation

### 7.1 The Invoice Management System

IMS is a relatively recent GSTN mechanism and it changes the ITC flow
materially. For each inward invoice reported by a supplier, the recipient may:

| Action | Effect |
|---|---|
| **Accept** | Flows into GSTR-2B as available ITC |
| **Reject** | Excluded from 2B; supplier's liability is affected |
| **Pending** | Deferred to a later period's 2B |
| *(No action)* | Deemed accepted |

**GE-10 — "No action means accepted" is a trap.** A client who ignores IMS
silently accepts invoices they may not be entitled to claim — including ones
that are wrong, duplicated, or from a supplier they never transacted with. The
CA console must surface pending IMS items as a **deadline-bearing task**, not a
passive list.

**GE-11 — Rejecting is not free.** Rejection affects the supplier's reported
liability and will produce a phone call. Reject with a recorded reason, and
prompt the CA to notify the supplier.

### 7.2 The reconciliation engine

Matches the client's recorded purchases (from
[bills-and-expenses.md](bills-and-expenses.md)) against GSTR-2B, per period.

Match statuses — richer than a binary matched/unmatched:

| Status | Meaning | Action |
|---|---|---|
| **Exact Match** | GSTIN, invoice no., date, taxable value, tax all agree | Claim |
| **Suggested Match** | High-confidence match with minor variance (rounding, date ±few days, invoice-number formatting) | Review, then claim |
| **Mismatch** | Matched to an invoice but values differ materially | Investigate before claiming |
| **Manual Match** | A human paired them despite weak signals | Claim, reason recorded |
| **Missing in 2B** | We hold the bill; supplier hasn't reported | **Do not claim.** Chase supplier. |
| **Missing in Books** | Supplier reported; we have no bill | Request the document — may be a genuinely missing purchase |
| **Amended** | Supplier amended a previously reported invoice | Re-evaluate |
| **Pending** | Deferred via IMS or awaiting 2B generation | Defer |
| **Ignored** | Explicitly excluded by the CA | Reason recorded |

**GE-12 — Matching keys, in priority order:** supplier GSTIN + invoice number +
invoice date + taxable value + tax amount. Invoice-number normalisation is
essential — suppliers write `INV/26-27/001`, `INV-26-27-001`, and `inv2627001`
for the same document. Normalise aggressively for *matching*, but always store
and display both raw strings.

**GE-13 — Deterministic first, AI for the residue.** Exact matching is pure
code. Only genuinely ambiguous cases reach the model, which proposes a
*Suggested Match* with evidence — never an auto-claim.

**GE-14 — Reconciliation is not a report, it is a workflow.** Each unmatched
row needs an owner, an action, and a follow-up. "Chase the supplier" is the
actual work, and the product should generate the WhatsApp message.

---

## 8. The three ledgers and ITC set-off

GSTN maintains three ledgers per GSTIN, retrievable via the vendor API:

| Ledger | Contents |
|---|---|
| **Electronic Cash Ledger** | Money deposited via challan |
| **Electronic Credit Ledger** | ITC available, by head (IGST / CGST / SGST / Cess) |
| **Electronic Liability Register** | Tax, interest, penalty payable |

**GE-15 — Set-off order is prescribed, not optional.** IGST credit must be
utilised first, and only then may CGST/SGST credit be applied — with
restrictions on cross-utilisation (CGST credit cannot pay SGST liability, and
vice versa). Computing set-off in the wrong order produces a return GSTN will
reject, or a cash payment the client did not need to make.

**GE-16 — Mirror the government ledgers; never treat them as the source of
truth for the books.** Our ledger (from [gl-engine.md](gl-engine.md)) and
GSTN's must **reconcile**, and a divergence is an exception worth surfacing —
but the client's books are ours, and GSTN's balances are a third-party
statement, much like a bank statement.

**GE-17 — Rule 86B and mandatory cash payment.** Certain taxpayers above a
turnover threshold must discharge at least 1% of their liability in cash even
when credit is available. If applicable to a client, set-off computation must
respect it or the filing fails.

---

## 9. Filing flow

Via Sandbox (Quicko GSP). Endpoints below were located during vendor
validation; the `gstr-2b-reconciliation` endpoint was probe-confirmed live.

```
1. Taxpayer auth        POST /gst/compliance/.../taxpayer/authentication/generate_otp
                        POST .../verify_otp
                        → OTP-based. We never store GST portal passwords.
2. Fetch 2B             POST .../taxpayer/gstr-2b/document
3. Reconcile            POST /gst/analytics/gstr-2b-reconciliation   [validated]
4. CA reviews exceptions, resolves IMS actions
5. Compute GSTR-1 from invoicing data (§5)
6. Save GSTR-1          POST .../taxpayer/gstr-1/file/save
7. CA reviews the prepared return
8. File GSTR-1          POST .../taxpayer/gstr-1/file/file
9. Compute GSTR-3B, including ITC and set-off (§8)
10. Save / File 3B      POST .../taxpayer/gstr-3b/save   →   .../file
11. Store acknowledgement (ARN) immutably
```

**GE-18 — Sessions are long-lived and reusable, so bulk filing works.**
Confirmed behaviour:

- Verifying a client's OTP yields a session token valid for **6 hours**
- A taxpayer can extend that window up to **30 days** by configuring API access
  settings on the GST portal — no fresh OTP needed within the window
- The session is **fully reusable** across calls: fetch, validate, save, and
  file all run under the same token

The consequence is that **OTP collection and heavy processing are separate
phases**. A CA establishes sessions once, then all the actual work — fetching
2B, reconciling, computing, filing — is queued and executed in the background
while sessions remain valid. This is the fan-out pattern from
`ai-harness-architecture`: one stateless worker per client, each holding its
own session, returning a structured verdict.

See §9.1 for the session model this requires.

### 9.1 Session management

**GE-18(0) — There are two independent token layers. Do not conflate them.**

| Layer | Obtained via | Scope | Lifetime | Concurrency |
|---|---|---|---|---|
| **Platform** | `POST /authenticate` | BharatERP's whole workspace | **24 hours** (probe-confirmed) | Safe — see below |
| **Taxpayer session** | `verify_otp` | A single client GSTIN | 6 hours, or 30 days | Unknown — §15.10 |

The platform token is issued against our API key, not against any client. Token
claims observed: `workspace_id`, `sub = <api_key>`, `aud = API`,
`exp − iat = 24.0 hours`. **One platform token serves every client**; the
per-client taxpayer session layers on top of it.

Consequences:

- A single background job refreshes the platform token daily. It is not
  per-client and does not belong in `gst_sessions`.
- **Concurrent `/authenticate` calls are safe** (probe-confirmed): two calls
  return different tokens and *both remain valid* — the second does not
  invalidate the first. Workers refreshing concurrently cannot kill one
  another's sessions.
- Never log the platform token; it grants workspace-wide access.

`gst_sessions` below models the **taxpayer** layer only.

**GE-18a — A GST session is a first-class entity, not a transient variable.**

```
gst_sessions
  id, firm_id, client_id
  gstin              char(15) NOT NULL
  token_encrypted    bytea NOT NULL      -- never stored in plaintext
  established_at     timestamptz NOT NULL
  expires_at         timestamptz NOT NULL
  established_by     uuid NOT NULL       -- who collected the OTP
  extended_validity  boolean NOT NULL    -- detected, not declared — GE-18d(ii)
  revoked_at         timestamptz
  revoked_reason     text                -- offboarding | manual | client_request
  UNIQUE (client_id, gstin) WHERE revoked_at IS NULL
```

**GE-18a(i) — Attribute every operation to the user who performed it, not to
the user who established the session.**

A session is scoped to a GSTIN, not to a person. Staff member A collects the
OTP on Monday; staff member B files the return under that same session on
Thursday. If the audit log records only `established_by`, the return is
attributed to the wrong person.

That is not a tidiness problem. Filing is a statutory act with a responsible
individual attached, and §15.6 asks precisely who that is. So:

- `gst_sessions.established_by` — who authenticated
- `audit_log.actor_user_id` on **every** operation run under the session — who
  actually did the thing

Both are needed and they are frequently different people. Recording only the
first is unfixable retroactively; recording both costs nothing at design time.

**GE-18a(ii) — Revoke sessions on offboarding, immediately.**

A 30-day session outliving the engagement means BharatERP retains API access to
a business's GST data **after the relationship has ended**. Letting a token age
out is not acceptable.

Revocation is therefore a mandatory step whenever:

- a CA firm stops serving a client
- a client leaves BharatERP (alongside the audit export required by
  `audit-trail.md` AT-12)
- the client withdraws consent, or asks for it
- rolling renewal is switched off for that client — GE-18d(iv)

Purge the token rather than marking the row inactive, record
`revoked_reason`, and log the revocation. Any in-flight work under that session
fails into the re-queue path (GE-18c) rather than continuing.

**GE-18b — Encrypt tokens at rest and purge on expiry.** A live token grants
API access to that client's GST portal data. Holding a few hundred of them
simultaneously is a smaller version of the stored-password problem, not the
absence of one. Encrypt with the per-firm KMS key (provenance.md §9.6), delete
on expiry rather than merely marking expired, and never log a token.

**GE-18c — Check expiry before every operation, not once per batch.** A 6-hour
session can lapse mid-run. A worker whose session has expired must fail
cleanly, re-queue its item, and surface *"needs re-authentication"* — never
error out in a way that looks like a filing failure.

**GE-18d — 30-day validity is a manual onboarding step the CA performs, and
BharatERP must stay out of it.**

Confirmed mechanics: the setting lives on the GST **web portal**, not the API —
`My Profile → Manage API Access → Enable API Request = Yes → 30 Days →
Confirm`. Saving it triggers **no OTP**. Which means anyone holding the
client's portal username and password can enable it, and CAs commonly do hold
those.

**GE-18d(i) — Never store GST portal passwords. Never automate the portal.**
There is an obvious temptation here: CAs already have the credentials, so let
BharatERP store them and script the login for all 200 clients at once. Reject
it on two grounds:

1. It would make BharatERP a repository of hundreds of GST portal passwords —
   precisely the breach-target problem that choosing OTP-based API auth avoided
   in the first place.
2. Browser automation against a government portal is brittle and likely
   contrary to its terms.

**The correct design is that this is a manual step the CA performs in their own
browser.** They already hold the credentials; we simply tell them exactly what
to click. BharatERP's only involvement is showing the instructions and knowing
whether it has been done.

**GE-18d(ii) — Detect extended validity; do not ask for it.** On first
authentication, read the returned token's expiry. Roughly 6 hours means the
setting is off; roughly 30 days means it is on. Store the result on
`gst_sessions.extended_validity`.

This is better than a checklist item the CA ticks manually: there is nothing to
maintain, nothing to go stale, and no self-reporting to be wrong. Derive the
state from observed behaviour.

**GE-18d(iii) — Renew sessions on a rolling basis, never in a pre-deadline
batch.** A 30-day session can be established at any time, so there is no reason
to wait for the 10th. Refresh a handful of clients each day, continuously, so
every session is live before any deadline arrives.

This removes the filing-day scramble entirely: with rolling renewal, the number
of OTPs needed on the 10th is normally **zero**. The console surfaces sessions
expiring within the next several days and the CA works through them at leisure.

Where extended validity is *not* enabled, the client falls back to 6-hour
sessions and does need an OTP per filing run — which is exactly the population
the console should nudge the CA to fix.

**GE-18d(iv) — Rolling renewal is opt-in, never a default.**

It is a background action taken on someone else's behalf, and it has two
visible consequences that make silent enablement wrong:

1. **An OTP arrives on the client's phone unprompted.** A GST OTP appearing at
   a random moment, with no filing underway, reads as either a mistake or an
   attack. A client who was not told this happens monthly will be alarmed —
   and the ones who *aren't* alarmed have been trained to ignore unexpected
   OTPs, which is worse.
2. **BharatERP holds standing API access to that client's GST data for 30
   days**, without a human initiating each use.

Requirements:

- **Off by default.** The CA switches it on explicitly, per client or per firm.
- **The client is told at onboarding** that periodic OTP requests will occur,
  what they are for, and who they will come from. This is what makes the OTP
  expected rather than suspicious, and it pairs with the fraud-script concern
  in GE-18e.
- **Enablement is audited** — who turned it on, when, for which clients
  (`audit-trail.md` AT-10 reasoning: no invisible standing access).
- **Revocable at any time**, and revocation purges live tokens immediately
  rather than letting them age out.
- **Renewal failures surface, never retry silently.** If a client stops
  responding to OTP requests, the CA needs to know before a deadline, not
  after.

**GE-18e — Collect OTPs over WhatsApp, not by telephone.**

The OTP goes to the **client's** registered mobile, not the CA's. Without a
better channel, filing for 30 clients means 30 phone calls, serially, while a
6-hour clock runs.

WhatsApp collapses this: BharatERP messages each client *"your CA is filing
your GST return — please share the OTP you just received"*, all 30 in parallel,
each answered whenever the client gets to it. Replies feed straight into
session establishment.

This makes the WhatsApp layer **load-bearing for GST filing**, not merely a
convenience for receipt capture — worth reflecting in build priority, since the
CA console's bulk-filing claim depends on it.

**GE-18f — The console needs a session board.** Which clients have live
sessions, which expire soon, which need re-auth, and which do **not** have
extended validity enabled (GE-18d) — the last group being the CA's action list,
since each one costs an OTP every filing cycle until fixed.

With rolling renewal working (GE-18d(iii)), this board should be quiet most of
the time. A busy board means renewal has fallen behind.

**GE-19 — Filing is irreversible; validate hard beforehand.** Given GE-3 (no
revision), every check in §10 runs before submit, and the CA sees a full
preview with drill-down (§11) before the action is available.

**GE-20 — Store the ARN and the exact payload filed.** The acknowledgement
number is the proof of filing. The payload is the evidence in any later
dispute. Both immutable, per [audit-trail.md](audit-trail.md).

---

## 10. Deadlines, interest, late fees

**GE-21 — Deadline tracking is a first-class feature, per client per period.**
This is arguably the single most valuable thing the CA console does: 200 clients
× multiple returns × staggered QRMP dates is not manageable by memory.

Consequences of lateness (verify current values):

| Consequence | Basis |
|---|---|
| **Interest** on late tax payment | ~18% p.a. on the unpaid amount |
| **Interest** on excess ITC claimed | ~24% p.a. — higher, deliberately punitive |
| **Late fee** | ~₹50/day (₹25 CGST + ₹25 SGST), reduced for nil returns, capped |
| **Cascade** | GSTR-1 late blocks GSTR-3B (GE-2), which blocks the next period |
| **Customer impact** | Late GSTR-1 delays the *customer's* ITC — a commercial problem, not just a compliance one |

**GE-22 — Interest and late fee are computed, not typed.** Compute them from
actual filing dates, show the arithmetic (provenance PR-8), and let the CA
override with a reason if they disagree.

**GE-23 — Warn before, not after.** The value is a proactive alert at T−7,
T−3, T−1 — via the console and WhatsApp — not a report of what was already
missed.

---

## 11. Validation

Runs before any save or file. Given GE-3 and GE-19, this is the last line of
defence.

| # | Rule |
|---|---|
| GV-1 | Every invoice in the period is included; none double-counted |
| GV-2 | Σ table values = header totals for every GSTR-1 table |
| GV-3 | B2B is invoice-wise; B2CS is rate-wise consolidated (GE-6) |
| GV-4 | Every line has a valid HSN/SAC (GE-7) |
| GV-5 | DOC_ISSUE serial ranges are continuous, with cancellations declared (GE-8) |
| GV-6 | Intra/inter-state classification consistent with place of supply |
| GV-7 | GSTR-1 filed before GSTR-3B attempted (GE-2) |
| GV-8 | GSTR-3B outward figures reconcile to the filed GSTR-1 |
| GV-9 | ITC claimed ≤ ITC available per 2B, unless overridden with a recorded reason |
| GV-10 | No ITC claimed on `itc_eligibility = blocked` accounts (bills §6.2) |
| GV-11 | 180-day reversals applied (bills §6.4) |
| GV-12 | Section 16(4) deadline not breached for any claimed credit |
| GV-13 | Set-off order correct; Rule 86B respected where applicable (GE-15, GE-17) |
| GV-14 | Liability after set-off matches the payment challan |
| GV-15 | Our GST ledger balances reconcile to GSTN's ledgers; divergence surfaced (GE-16) |
| GV-16 | Period not already filed (no double filing) |
| GV-17 | Client's GST registration active for the whole period |
| GV-18 | All IMS items actioned or explicitly deferred (GE-10) |

---

## 12. Provenance obligations

Per [provenance.md](provenance.md) §12:

- **Every return figure drills to its invoices.** A CA clicking `₹4,21,880` in
  GSTR-1 table B2B sees the invoices composing it, and onward to each source
  document. This is also what makes the audit export's reconciliation
  (PR-18) tie to *filed returns* — the strongest completeness evidence
  available, because the government already holds those numbers.
- **2B match evidence retained** — which keys matched, the variance, and the
  alternatives considered (PR-9, PR-11).
- **Set-off arithmetic traced** (PR-8) — the order applied and why.
- **Interest / late-fee computation traced** — inputs, rate row, and citation.
- **Filed payload and ARN retained verbatim** (GE-20).
- **GSTN-sourced data tagged `government_attested`** (PR-22) — 2B extracts and
  ledger balances are third-party evidence and carry real audit weight.

---

## 13. BharatERP-specific

### 13.1 The CA console's compliance calendar

The highest-leverage screen in the product. Per firm, across all clients:

- Every client × every return × its due date, colour-coded by urgency
- QRMP vs monthly filers correctly differentiated (GE-4)
- Blockers surfaced: unreconciled bank accounts, unresolved 2B exceptions,
  pending IMS actions, missing HSN codes
- Bulk actions where legally possible, with per-client audit rows (AT-8)
- A single honest number: *"how many clients are at risk this week"*

### 13.2 AI hooks

Four, all advisory:

1. **Suggested Match** proposals for reconciliation residue (GE-13)
2. **HSN suggestion** for lines missing a code, before it blocks filing
3. **Anomaly flags** — ITC claimed is 30% above the trailing average; a supplier
   who has never appeared in 2B; output tax inconsistent with turnover trend
4. **Draft supplier-chase messages** for `Missing in 2B` rows (GE-14)

The model never computes tax, never sets a figure in a return, and never files.

---

## 14. Test cases

| # | Given | When | Then |
|---|---|---|---|
| T-1 | 40 B2B + 300 B2C invoices | Generate GSTR-1 | B2B invoice-wise; B2C consolidated rate-wise (GV-3) |
| T-2 | An invoice line with no HSN | Generate | Blocked with the offending line identified (GV-4) |
| T-3 | Invoice 0007 cancelled | Generate | DOC_ISSUE declares the cancellation; no gap unexplained (GE-8) |
| T-4 | 3B attempted before GSTR-1 | File | Blocked (GV-7) |
| T-5 | 3B outward ≠ filed GSTR-1 | File | Blocked with the difference shown (GV-8) |
| T-6 | Bill present in books, absent from 2B | Reconcile | `Missing in 2B`; ITC not claimed (GV-9) |
| T-7 | Supplier reported an invoice we don't hold | Reconcile | `Missing in Books`; document requested |
| T-8 | Invoice numbers `INV/26-27/001` vs `INV-26-27-001` | Reconcile | Matched after normalisation; both raw strings retained (GE-12) |
| T-9 | Restaurant bill with GST | Prepare 3B | Excluded from ITC as blocked credit (GV-10) |
| T-10 | Bill unpaid 190 days, ITC previously claimed | Prepare 3B | Reversal applied (GV-11) |
| T-11 | IGST credit available, CGST liability | Compute set-off | IGST utilised first, per prescribed order (GV-13) |
| T-12 | Client above the Rule 86B threshold | Compute | ≥1% of liability paid in cash despite available credit (GE-17) |
| T-13 | QRMP client, month 1 of a quarter | Console | PMT-06 payment due; GSTR-1 not yet due (GE-4) |
| T-14 | QRMP B2B client, no IFF upload | Console | Flagged — customers' ITC is being delayed (GE-5) |
| T-15 | Unactioned IMS items at period end | File 3B | Blocked or explicitly deferred, never silently accepted (GV-18) |
| T-16 | Period already filed | File again | Blocked (GV-16) |
| T-17 | 3B filed with an error | Attempt revision | No revision path offered; correction routed to next period (GE-3) |
| T-18 | Return filed 5 days late | Compute | Interest and late fee computed with arithmetic shown (GE-22) |
| T-19 | Due date in 3 days, client has unresolved exceptions | Scheduled job | Alert to CA console and WhatsApp (GE-23) |
| T-20 | Our ITC ledger ≠ GSTN's credit ledger | Reconcile | Divergence surfaced as an exception (GV-15) |
| T-21 | A filed GSTR-1 B2B figure | Click it | Drills to the composing invoices and their documents (§12) |
| T-22 | 30 clients due for GSTR-1 | Bulk file | Sessions established up front, processing queued concurrently; 30 audit rows, shared batch id (GE-18) |
| T-23 | Session expires mid-batch | Worker runs | Item re-queued, flagged "needs re-authentication", not reported as a filing failure (GE-18c) |
| T-24 | Client has extended validity enabled | New filing cycle | No fresh OTP required within the window (GE-18d) |
| T-25 | Session token at rest | Inspect storage | Encrypted; purged on expiry; absent from all logs (GE-18b) |
| T-26 | 30 clients need OTPs | Start filing run | 30 WhatsApp requests sent in parallel; replies feed session establishment (GE-18e) |
| T-27 | Staff A establishes the session, staff B files under it | Inspect audit log | Return attributed to **B**; session records A as `established_by` (GE-18a(i)) |
| T-28 | Client offboarded with a live 30-day session | Offboard | Token purged immediately, not left to expire; revocation logged (GE-18a(ii)) |
| T-29 | Rolling renewal switched off for a client | Disable | Live token purged, not left running (GE-18d(iv)) |
| T-30 | Rolling renewal enabled | Inspect audit log | Who enabled it, when, for which clients — no invisible standing access (GE-18d(iv)) |

---

## 15. Open questions — for the CA advisor

**15.1 Current values for everything in §3, §4, §10.** Due dates, the QRMP
turnover threshold, B2CL value limit, interest rates, late-fee amounts and
caps, GSTR-9 applicability threshold, Rule 86B threshold. All are illustrative
here and must be confirmed before build.

**15.2 ~~OTP session mechanics.~~ — RESOLVED.** Sessions last **6 hours**,
extendable to **30 days** via the taxpayer's GST portal settings, and are fully
reusable across calls. Bulk filing is feasible: collect OTPs up front, then
queue processing. Design consequences are specified in §9.1.

Follow-on questions this raises:

**15.8 ~~Extended-validity adoption.~~ — RESOLVED.** The setting is changed on
the GST web portal (`My Profile → Manage API Access`) and requires **no OTP**,
so a CA holding the client's portal credentials can enable it without involving
the client at all. Design consequences in GE-18d: BharatERP treats it as a
manual CA step, never stores portal passwords, detects the outcome from token
expiry, and renews sessions on a rolling basis.

*Still worth confirming:* what proportion of CAs actually hold their clients'
GST portal credentials? GE-18d assumes it is common. Where it is not, the
client must make the change themselves and the fallback is 6-hour sessions.

**15.10 Taxpayer-session concurrency — untested, must be settled in pilot.**

If two staff members authenticate the same client GSTIN, does the second
session invalidate the first? If it does, a batch running under session one
dies mid-flight when a colleague authenticates.

The **platform** layer was probe-tested and is safe (GE-18(0)) — but that
result does **not** transfer, because taxpayer session behaviour is governed by
GSTN, not by the GSP. Testing it requires a real client GSTIN with portal
access and a live OTP, so it cannot be settled before pilot.

Mitigation until known: **serialise session establishment per GSTIN** (an
advisory lock keyed on the GSTIN, the same pattern the audit hash chain uses
per firm). If it later proves that concurrent sessions coexist safely, the lock
can be removed; if they invalidate each other, the lock has already prevented
the failure. Cheap insurance either way, and it should be in place before any
concurrent worker pool touches filing.

**15.9 WhatsApp OTP relay and consent.** GE-18e routes client OTPs through
WhatsApp — but note this now applies only to the **6-hour fallback**
population, since clients with extended validity need an OTP roughly monthly
and those can be handled by rolling renewal (GE-18d(iii)) rather than under
deadline pressure.

The concern stands regardless: *"please share the OTP you just received"* is
the standard fraud script in India, and routinely sending it trains clients to
comply with exactly the message they should refuse. Questions for the CA
advisor: how are OTPs obtained from clients today; should onboarding capture
explicit consent for the arrangement; and how should the message be worded —
naming the CA firm, the specific return and period — so it is plainly
distinguishable from a scam.

**15.3 Multiple GSTINs per client.** Still open from
[invoicing.md](invoicing.md) §14.2 and it lands hardest here — returns are filed
**per GSTIN, per state**. Is one BharatERP client one GSTIN or one PAN with
several? The most expensive data-model decision remaining.

**15.4 IMS adoption in practice.** Are target CAs actively using IMS today, or
ignoring it? If widely ignored, surfacing it well is a differentiator; if
universally used, it is table stakes.

**15.5 2B override policy.** Should a CA be able to claim ITC on a bill missing
from 2B (sometimes legitimate — supplier files late)? What justification must
be recorded? Repeats bills §13.4 because it is enforced here.

**15.6 Who actually presses "file"?** The CA, or the client? This is a
liability question as much as a UX one, and it determines the approval chain
and what the audit trail must capture.

**15.7 Composition clients.** Do target CAs serve composition dealers (CMP-08 /
GSTR-4)? Different return set entirely — Phase 1 or defer?

---

## 16. Reference studied

`india-compliance/gst_india/utils/{gstr_1/, gstr_2/, gstr3b/}` and
`doctype/{gstr_1, gstr_3b_report, gst_inward_supply,
purchase_reconciliation_tool, gst_invoice_management_system, gst_return_log}`.

Observations that informed this spec:

- Their GSTR-1 section modules (`b2b`, `b2cl`, `b2cs`, `cdnr`, `cdnur`,
  `exports`, `advances`, `nil_rated`, `hsn`, `doc_issue`, `supecom`) confirm the
  authoritative table set. Adopted wholesale — the return format dictates it,
  not design preference. `supecom` in particular is a table we would have
  missed.
- Their reconciliation status taxonomy — **Exact Match, Suggested Match,
  Mismatch, Manual Match, Missing in …, Amended, Pending, Ignored** — is
  richer than a binary matched/unmatched and reflects real operational
  categories. Adopted (§7.2); `bills-and-expenses.md` §6.3 should be updated to
  use it rather than its simpler five-state version.
- They implement IMS as a first-class doctype, confirming it is current and
  operationally significant rather than a curiosity. Adopted as §7.1.
- Their separate `gstr_2a` and `gstr_2b` handling reinforces GE-1 — they are
  genuinely different objects, not two views of one thing.
- Their deferred ITC claim period with Section 16(4) deadline logic (studied
  earlier for bills §6.5) is enforced at filing time here.
- A dedicated return-log doctype for filing acknowledgements supports GE-20.

**Rejected / diverged:** they have no compliance calendar across many clients
(§13.1) — unsurprising, since ERPNext serves one company per install, whereas
the multi-client console is the entire premise of BharatERP. They also have no
proactive deadline alerting (GE-23), no supplier-chase workflow (GE-14), and no
provenance drill-down from a return figure to its source documents (§12).

Nothing from the reference is reproduced.
