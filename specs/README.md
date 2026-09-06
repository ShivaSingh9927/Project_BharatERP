# BharatERP Specs

Plain-English specifications for every BharatERP module. Engineers implement
**from these specs only** — never from reference source code.

---

## Why this folder exists

BharatERP learns from two GPLv3 reference implementations:

| Repo | Location (outside this repo) | What it teaches |
|---|---|---|
| ERPNext | `/home/shiva/Documents/reference/erpnext` | GL engine, Chart of Accounts, reports, depreciation |
| India Compliance | `/home/shiva/Documents/reference/india-compliance` | GST, e-invoice, e-way bill, TDS, audit trail |

Both are **GPLv3**. Copying their code into BharatERP would force BharatERP to
be GPL too — which would destroy the closed-source SaaS business model.

**GPL covers literal code. It does not cover ideas, algorithms, data-model
concepts, or business logic.** So we use a clean-room process.

---

## The clean-room rules

1. **No reference source code ever enters this repository.** Not in a file,
   not in a comment, not pasted into a commit message, not in a chat log that
   gets committed.
2. **The reference repos live outside this repo** (`~/Documents/reference/`)
   so a stray `git add .` can never pull them in.
3. **One person reads, another implements** where team size allows. If the
   same person must do both, write the spec first, then implement from the
   spec with the reference closed.
4. **Specs describe WHAT and WHY in our own words** — data model, business
   rules, edge cases, test cases. Never "here's their function, translate it."
5. **Reference material may be used for QA.** Running the same input through
   ERPNext and BharatERP and comparing outputs is legitimate and encouraged.
6. **Cite what was studied, not what was copied.** Each spec names the
   reference module it learned from, so provenance is auditable.

If a spec cannot be written without pasting reference code, the spec is not
ready — go back and understand the logic properly.

---

## Spec index

| Spec | Module | Status |
|---|---|---|
| [audit-trail.md](audit-trail.md) | Audit Trail / immutable books | Draft |
| [gl-engine.md](gl-engine.md) | Chart of Accounts, ledger, vouchers, reports | Draft |
| [invoicing.md](invoicing.md) | Sales invoices, GST, e-Invoice, e-Way Bill | Draft |
| [bills-and-expenses.md](bills-and-expenses.md) | Vendor bills, OCR capture, ITC, TDS, RCM, expense claims | Draft |
| [bank-and-reconciliation.md](bank-and-reconciliation.md) | Statement ingestion, narration parsing, matching engine, BRS, cheques | Draft |
| [gst-engine.md](gst-engine.md) | GSTR-1/3B/9, 2A/2B, IMS, reconciliation, ITC set-off, filing | Draft |
| [provenance.md](provenance.md) | **Cross-cutting** — every number traceable to source, rule, arithmetic, approver | Draft |

**Build order:** `audit-trail` and `gl-engine` are foundational — everything
else writes into the ledger, so immutability and the posting rules must be
settled before any producer module is built. `invoicing` is the first producer.

**Cross-cutting specs apply to everything.** [provenance.md](provenance.md) is
not optional for any module — every spec must state what provenance it captures
and how it surfaces it. Bounding boxes and rule citations can only be captured
at the moment of extraction and posting; they cannot be reconstructed later, so
a module that skips this can never be retrofitted.

**⚠️ Compliance figures go stale.** We discovered mid-research that TDS section
numbers were renumbered wholesale by the Income Tax Act 2025. Assume the same
of every GST threshold and rate. No spec's numbers may be hardcoded — rates and
thresholds belong in date-ranged master tables so a change is a data update,
never a code deploy.

## Spec template

Every spec should cover:

1. **Purpose** — what problem this solves, in one paragraph
2. **Legal / compliance basis** — if any, with citation
3. **Scope** — what is and isn't covered
4. **Data model** — tables, columns, relationships, constraints
5. **Business rules** — the actual logic, numbered so tests can reference them
6. **Edge cases** — what breaks, what's ambiguous
7. **BharatERP-specific requirements** — where we deliberately differ from
   reference implementations (usually: AI, multi-client CA console, WhatsApp)
8. **Test cases** — concrete input → expected output
9. **Open questions** — to resolve with the CA advisor
10. **Reference studied** — provenance note
