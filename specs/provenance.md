# Spec: Provenance — Every Number Traceable to Its Source

**Status:** Draft — cross-cutting. **Every other spec must implement its part.**
**Owner:** —
**Depends on:** [audit-trail.md](audit-trail.md), [gl-engine.md](gl-engine.md)
**Applies to:** all modules, present and future

---

## 1. Purpose

Any figure BharatERP displays — a line in the P&L, a GST liability, a vendor
balance — must be drillable, in one motion, back to:

1. **The source document region** it was read from — the exact page and area of
   the actual bill or invoice
2. **The rule applied** — which tax rate row, which TDS section, with its
   statutory citation
3. **The arithmetic** that produced it
4. **The people** — which AI proposed it, which CA approved it

This is not an audit-trail duplicate. `audit-trail.md` answers *"who changed
what, when"* — a compliance record. Provenance answers *"why is this number
this number"* — an explainability record. Different questions, different
consumers, both required.

---

## 2. Why this matters — three problems, one mechanism

### 2.1 CA trust in AI

A CA will not stake their professional reputation on a black box. The single
most effective trust-building interaction in the product is this one:

> The CA clicks `₹11,800` in a report. The vendor's bill opens beside it, with
> the exact region that value was read from highlighted on the image.

At that moment the AI stops being something to be suspicious of and becomes a
tool that shows its work. This is `dont-scare-the-ca` expressed as
architecture rather than as marketing copy.

### 2.2 Adjudicating disputes

`bills-and-expenses.md` PB-4 requires that vendor-supplied tax figures be
independently recomputed, with mismatches routed to review rather than silently
corrected. **That rule is inert without provenance.** To decide whether the
vendor's arithmetic or ours is right, the CA needs, on one screen: the bill
image with the disputed field highlighted, what the document claimed, what we
computed, and which rate row we used.

### 2.3 Audit speed

Lesson 11 established *vouching*: an auditor samples transactions and demands
the original supporting document for each. Today that means someone digs
through folders for a week.

With provenance, the auditor's sample resolves in seconds — and the CA can hand
over a complete, self-evidencing package. **The CA's own audit work gets
faster**, which makes this a selling point aimed squarely at the buyer, and a
direct contributor to the "3× clients, same team" pitch.

---

## 3. The provenance chain

Every number sits at the end of a chain. The chain must be complete and
navigable **in both directions**.

```
  Report figure          P&L → "Office Rent  ₹25,000"
        ↓ composed of
  Ledger entries         3 entries summing to 25,000
        ↓ produced by
  Voucher                Purchase bill PB-2026-0412
        ↓ derived from
  Source document        vendor-invoice.pdf, page 1
        ↓ read at
  Field region           bbox [412, 890, 96, 22], confidence 0.94
        ↓
  ── and alongside ──
  Rule applied           GST 18% · rate row #4471 · Notification 06/2025
  Computation            10,000 × 18% ÷ 2 = 900 (CGST), 900 (SGST)
  AI proposal            model X · confidence 0.91 · 12 prior examples
  Human approval         CA Priya · 2026-09-04 14:22 · unchanged
```

**PR-1 — Forward navigation.** From any displayed figure, reach the source
document region in at most three clicks.

**PR-2 — Reverse navigation.** From any source document, list every ledger
entry, tax figure, and report line it contributed to. Needed when a vendor
issues a revised bill and the CA must find everything affected.

---

## 4. Field-level extraction provenance

This is the load-bearing technical requirement, and the one most likely to be
skipped by an engineer in a hurry.

**PR-3 — Store where each value was read from, not merely the value.**

Document AI services return, per extracted field, a page number and a bounding
box. Persist them. Without this the principle collapses to *"here is a PDF, go
find it yourself"* — which is what everyone already does badly.

```
extracted_fields
  id                uuid PK
  source_document_id uuid NOT NULL FK
  field_path        text NOT NULL      -- 'grand_total', 'line_items[2].hsn_sac'
  raw_text          text NULL          -- exactly as it appeared: "Rs. 11,800/-"
  parsed_value      jsonb NULL         -- normalised: 11800.00
  page_number       int NULL
  bbox              numeric[4] NULL    -- [x, y, width, height], normalised 0-1
  confidence        numeric(4,3) NULL
  extraction_method enum NOT NULL      -- ocr_vlm | irp_fetch | manual | derived
  extracted_at      timestamptz NOT NULL DEFAULT now()
  model_version     text NULL
```

**PR-4 — Keep the raw text alongside the parsed value.** `"Rs. 11,800/-"` and
`11800.00` are both needed: the raw string proves what the document actually
said; the parsed value is what the system used. Parsing bugs are invisible
without both.

**PR-5 — `extraction_method` is not decoration.** A value fetched from the IRP
against an IRN (`irp_fetch`) is authoritative government data; a value OCR'd
from a photo is probabilistic. The UI must distinguish them, and confidence
routing must weight them differently.

**PR-6 — Bounding boxes are normalised (0–1), not pixel coordinates.** Images
get resized, re-compressed, and re-rendered at different zoom levels; pixel
coordinates rot.

---

## 5. Rule citation

**PR-7 — Cite the rule row that was applied, never just the resulting rate.**

Recording "18% was applied" is worthless three years later when rates have
changed twice. Record *which* date-ranged row from the rate master was used,
and carry its statutory citation.

```
applied_rules
  id, voucher_id, line_no NULL
  rule_type      enum       -- gst_rate | tds_section | itc_eligibility
                            -- | place_of_supply | rcm_applicability
  rule_table     text       -- 'gst_rates'
  rule_row_id    uuid       -- the exact row
  rule_snapshot  jsonb      -- the row's content at time of use
  citation       text       -- 'Notification 06/2025-Central Tax (Rate)'
  applied_at     timestamptz
```

`rule_snapshot` matters: even though rate rows are versioned, embedding the
values used makes a historical voucher self-explanatory without reconstructing
the master table's state at that date.

The same applies to TDS. Given that the Income Tax Act 2025 renumbered every
section, a voucher from before the change must still be able to explain which
section it used **under the numbering in force at the time**.

---

## 6. Computation trace

**PR-8 — Persist the arithmetic, not only the result.**

```
computation_traces
  id, voucher_id, line_no NULL
  output_field  text       -- 'cgst_amount'
  expression    text       -- 'taxable_value × gst_rate ÷ 2'
  inputs        jsonb      -- {taxable_value: 10000, gst_rate: 18}
  result        numeric
  rounding_rule text       -- 'round half up, 2dp, at line level'
```

Two payoffs. First, a CA questioning a figure gets an immediate answer instead
of a support ticket. Second, when our recomputation disagrees with the vendor's
document (PB-4), the trace *is* the argument for who is right.

Store traces for derived figures — tax amounts, TDS, depreciation, round-off,
currency conversion. Not for trivial sums.

---

## 7. AI decision trace

Extends `audit-trail.md` §6 (AI attribution) from *who* to *why*.

```
ai_proposals
  id, source_document_id, client_id
  stage          enum       -- extraction | vendor_resolution | classification
                            -- | settlement_matching
  model, model_version, prompt_version
  input_summary  jsonb      -- what the model was given (not the raw prompt)
  proposal       jsonb      -- what it returned
  confidence     numeric(4,3)
  evidence       jsonb      -- the prior examples that drove it
  alternatives   jsonb      -- runner-up options with their scores
  outcome        enum       -- auto_posted | approved | edited | rejected
  reviewed_by    uuid NULL
  correction     jsonb NULL -- what the CA changed it to
```

**PR-9 — Record the evidence, not just the answer.** *"Classified as Office
Supplies because the last 12 bills from this vendor for this client were Office
Supplies"* is a defensible explanation. *"Confidence 0.91"* is not.

**PR-10 — Keep rejected proposals.** They serve three purposes at once: audit
defensibility, the per-client learning loop, and eval data for measuring
auto-post precision.

**PR-11 — Surface alternatives.** When the CA disagrees, offering the model's
second and third choices turns a correction into a single click.

---

## 8. UI requirements

Provenance that exists only in the database delivers none of the three benefits
in §2. The interface is not optional.

**PR-12 — Side-by-side review.** Extracted fields on one side, document image
on the other. Hovering a field highlights its region on the image; clicking a
region jumps to its field.

**PR-13 — Confidence is visible.** Low-confidence fields are visually distinct.
The CA's attention should go where the uncertainty is, not spread evenly.

**PR-14 — Every figure is drillable.** In reports, ledgers, and dashboards, any
number opens its provenance chain. Not a hidden power-user feature — the
default interaction.

**PR-15 — Disputes get an adjudication view.** When recomputation disagrees
with the document, present: the highlighted document region, the document's
claim, our computed value, the rule row and citation, the arithmetic — and
three actions: *accept document* (with reason), *accept computed*, *reject
bill*.

**PR-16 — Audit export.** Given a date range or a sampled list of transactions,
produce a self-evidencing package. Requirements are substantial enough to
warrant their own section — see §9.

---

## 9. Audit-grade export

### 9.1 The bar, stated by a practising auditor

An auditor will accept a self-evidencing export **in place of manual
vouching**, but only if three conditions hold:

1. They have successfully **tested the IT controls** of the system that
   generated the export
2. The export **undeniably proves its own completeness and accuracy**
3. The export **includes or cryptographically links to the underlying
   third-party source documentation** proving the transactions actually
   occurred

Miss any one and the auditor reverts to substantive testing — which is manual
vouching, which means the feature delivered nothing. These are not
nice-to-haves; they are the pass/fail criteria.

### 9.2 Condition 1 — IT controls (this is not a spec item)

The auditor is testing **the system**, not the data. For a SaaS this means IT
General Controls: access management, change management, and operations.

**In practice this requires a SOC 1 Type II report** (SSAE 18 / ISAE 3402 — the
financial-reporting standard, *not* SOC 2, which covers security and
availability and does not answer this question). A Type II report requires an
audit over an operating period, typically 6–12 months, so **it cannot be
arranged on demand when a customer's auditor asks.**

Engineering obligations that feed it, and which must exist from day one because
they are tested *retrospectively over a period*:

| ITGC domain | What must be demonstrable |
|---|---|
| **Access** | Role-based access enforced; provisioning and deprovisioning logged; privileged/support access logged and customer-visible (`audit-trail.md` AT-10); no shared accounts |
| **Change management** | Every production deploy traceable to a reviewed, approved change; segregated dev/staging/production; no direct production database edits — and the append-only permissions (AT-2) are themselves strong evidence here |
| **Operations** | Backups taken, restores actually tested, job failures detected and remediated, incidents logged |
| **Computation integrity** | Tax and posting logic is deterministic and version-controlled; the same inputs reproduce the same outputs |

**This belongs on the business roadmap, not only in a spec.** Cost, timeline,
and the choice of assurance firm need planning well before the first customer's
statutory audit. Flagging for the roadmap.

### 9.3 Condition 2 — proving completeness and accuracy

Completeness is the harder half: an export cannot prove a negative by
displaying what it contains. It must instead be *reconcilable*.

**PR-17 — Explicit population definition.** The export states precisely what
population it claims to cover — entity, GSTIN, date range, voucher types,
inclusion of drafts and reversals. The auditor must be able to judge whether
this is the right population before assessing anything inside it.

**PR-18 — Control-total reconciliation.** The export carries a reconciliation
statement proving its contents tie back to the books:

```
Entries in export:        14,882
Sum of debits:      ₹ 4,21,88,410.00
Sum of credits:     ₹ 4,21,88,410.00        ← self-balancing (Lesson 2)
Reconciles to Trial Balance as at 31-03-2027:   ✓ exact
Reconciles to filed GSTR-3B, Apr-Mar:           ✓ exact
Reconciles to filed GSTR-1 outward supplies:    ✓ exact
```

Tying to **externally filed returns** is what makes this persuasive: the
government already holds those figures, so agreement is corroborated by a third
party rather than asserted by us.

**PR-19 — Sequence continuity report.** Every voucher series is listed with its
range, count, and **every gap explicitly explained** (cancelled, reversed, void).
This is exactly why `invoicing.md` INV-2 forbids reusing a cancelled invoice
number — an unexplained gap is the first thing an officer or auditor questions.

**PR-20 — Hash-chain attestation.** Include the `audit_log` chain checkpoints
covering the period, with verification results, plus the independently stored
terminal hashes from write-once storage (`audit-trail.md` §4.5). This is the
proof that **no rows were removed** between checkpoints — the strongest
completeness evidence available, because it is verifiable without trusting us.

**PR-21 — Cut-off assertions.** State explicitly what was posted after the
period end but dated within it (backdated entries — `gl-engine.md` AT-6), and
what remains in draft. Cut-off is a standard audit assertion and hiding it
destroys credibility.

Accuracy is then carried by the provenance chain already specified: source
region (PR-3), rule citation (PR-7), computation trace (PR-8), approval record.

### 9.4 Condition 3 — third-party source documentation

Auditors weight evidence by independence. Strongest first:

| Evidence | Strength | We hold |
|---|---|---|
| **Government-signed IRP invoice** (signed invoice + signed QR) | Strongest — cryptographically attested by the tax authority | ✅ `invoicing.md` §8.4 |
| **GSTR-2B data** downloaded from GSTN | Strong — government-sourced | ✅ GST Engine |
| **Bank statements** | Strong — third-party | ✅ Bank spec |
| **Vendor bills** (external origin) | Good — third-party document | ✅ `bills-and-expenses.md` §4 |
| Our own sales invoices | Weak — internally generated | ✅ |
| Journal entries | Weakest — internal, no external corroboration | ✅ |

**PR-22 — Classify every source by independence.** Tag each document
`third_party` / `government_attested` / `internal`. An auditor sampling for
existence will prioritise the independent ones, and the export should let them
filter that way.

**PR-23 — Government attestations are the crown jewels.** The IRP returns a
**digitally signed invoice** and **signed QR code**. That signature is issued by
the tax authority, is independently verifiable against the IRP's public key,
and does not depend on trusting BharatERP at all. Include the raw signed
payloads verbatim in the export, not merely the IRN string.

This is a stronger claim than anything Tally or ERPNext can make, and it is
essentially free — we are already required to store these artefacts.

**PR-24 — Cryptographic binding.** Documents must be bound to entries so that
neither can be swapped:

- Each document referenced by its **SHA-256** (already captured for
  deduplication — `bills-and-expenses.md` BE-2)
- The manifest lists every entry with the hashes of its supporting documents
- The **manifest itself is signed**, so the auditor can verify that the package
  is intact and complete as issued

**PR-25 — Include the files, do not link to them.** A URL into our system is
worthless as audit evidence — it can change, expire, or require trusting us.
Ship the actual bytes.

### 9.5 Package structure

```
audit-export-<client>-<period>/
  manifest.json            population, control totals, document hashes — signed
  signature.p7s            detached signature over manifest.json
  reconciliation.json      PR-18: ties to TB and to filed GSTR-1 / GSTR-3B
  sequence-continuity.json PR-19: series ranges, gaps, explanations
  chain-attestation.json   PR-20: hash-chain checkpoints and verification
  cutoff.json              PR-21: backdated entries and open drafts
  entries.jsonl            every ledger entry in the population
  provenance.jsonl         per entry: source region, rule cited, arithmetic, approver
  documents/               the actual files, named by SHA-256
  attestations/            IRP signed invoices and QR codes; GSTR-2B extracts
  VERIFY.md                how to independently verify hashes and signatures
```

**PR-26 — Ship a verification procedure.** `VERIFY.md` explains how to
recompute every hash, validate the manifest signature, and verify the IRP
signatures against the authority's public key — using standard tools, without
BharatERP. An export the auditor can only check by trusting us proves nothing.

### 9.6 Signing key custody

**Decision: per-firm asymmetric keys in a managed Cloud KMS, rotated
annually.**

**PR-27 — Per-firm keys. Never a single global master key.** A global key is a
catastrophic single point of failure: compromise it and the integrity of every
client's audit history is destroyed simultaneously. Per-tenant keys confine the
blast radius to one firm.

**PR-28 — Managed Cloud KMS, not a bare HSM.** AWS KMS, Google Cloud KMS, or
Azure Key Vault. These are already backed by FIPS-validated HSMs while
abstracting away raw HSM operations. Generate an asymmetric key pair (ECDSA or
RSA) per firm inside the KMS. **The private key never leaves the KMS** — the
application sends the manifest hash to the KMS API and receives a signature.
There is no code path in BharatERP that can read a private key, which is itself
a control an auditor can test.

**PR-29 — Rotate annually; record the key version in the package.** Without
rotation, a compromise is retroactively total — every export that firm ever
issued becomes untrustworthy. With rotation and a recorded key version,
compromise is bounded to the exports signed within that key's active window.
The historical archive survives.

**PR-30 — Anchor key authenticity outside the package.** Shipping the public
key inside the export is convenient but circular: an attacker forging a package
would simply include their own public key. Verification must anchor to
something the auditor can reach independently.

Maintain an **append-only, timestamped public-key directory** at a stable
well-known endpoint, listing every firm's key versions with their validity
windows. `VERIFY.md` (PR-26) directs the auditor there. Optionally cross-sign
firm public keys with an **offline root key** — note this reintroduces a master
key, but only for *key attestation*, never for data, so it can be kept
air-gapped and its compromise does not by itself forge any export.

**PR-31 — Public keys outlive rotation by the full retention period.** A key
rotated out in 2027 must remain published and verifiable until at least 2035,
because exports signed with it are still within the 8-year retention window
(`audit-trail.md` AT-11). Rotation retires a key from *signing*, never from
*verification*.

**PR-32 — Revocation carries an effective date.** If a key is compromised,
publish revocation stating from when it is untrusted, so an auditor can tell
which exports remain reliable and which need re-issuing under a fresh key.

---

## 10. Auditor access — two tools, two purposes

The offline package does not eliminate the need for auditor access to the live
system. They answer different questions, and conflating them leaves a gap.

| | **Offline export package** | **Scoped read-only auditor login** |
|---|---|---|
| **Purpose** | Data & transaction vouching | Environment & configuration auditing |
| **Audit activity** | Substantive testing | IT General Controls testing, walkthroughs |
| **Question answered** | *"Are these transactions real and complete?"* | *"Can this system be relied upon?"* |
| **Trust model** | Verifiable without trusting us (§9) | Observing our live environment directly |

An auditor cannot sign off on controls by inspecting exported data, because
controls are properties of the *system*, not of the numbers. They must see the
environment.

**PR-33 — Provide a scoped, read-only auditor role** exposing:

1. **User access and roles** — the current permission matrix, who holds
   administrative rights, and the provisioning/deprovisioning history
2. **System configuration** — active approval workflows and limits, password
   and MFA policy, materiality thresholds, which auto-post categories are
   enabled and who enabled them
3. **Walkthrough capability** — the ability to follow a real transaction
   through the UI end to end, which is how an auditor confirms the documented
   process matches the actual one

**PR-34 — Configuration must be viewable as history, not only as current
state.** This is the requirement most easily missed. The ITGC question is *"was
MFA enforced throughout the financial year?"* — not *"is it on today."* All
configuration is therefore versioned master data under `audit-trail.md` §4.3,
and the auditor view must render it as a timeline across the audit period.

**PR-35 — Auditor access constraints.**
- Read-only enforced at the database permission layer, not merely hidden in the
  UI
- Scoped to the specific client(s) under audit; no visibility of other clients
  or other firms
- **Time-boxed** to the engagement, auto-expiring rather than lingering
- Granted by the CA firm, never provisioned by BharatERP support
- The auditor's own access is logged and visible to the CA (AT-10)

**Relationship to SOC 1 Type II (§9.2):** a Type II report is how condition 1
is satisfied *at scale* — one report serves every customer's auditor. The
auditor login serves auditors who still perform their own walkthroughs, or who
are auditing before a Type II report is available. Both are needed; neither
replaces the other.

---

## 11. Why this is a moat

Neither Tally nor ERPNext has any of this. Tally stores a voucher with an
optional scanned attachment and no field-level linkage at all. ERPNext is
keyed-in by hand, so the question doesn't arise.

The strategic point: **provenance is cheap if designed in from the start and
brutally expensive to retrofit.** Bounding boxes must be captured at extraction
time — they cannot be reconstructed later. Rule citations must be recorded at
posting time — the rate master will have moved on. A competitor who ships
without this cannot add it retroactively to their existing customers' data.

It also converts BharatERP's biggest perceived risk into its most persuasive
demo. *"How do I know your AI got it right?"* is answered not with a claim, but
by clicking the number.

---

## 12. What each spec must implement

| Spec | Provenance obligation |
|---|---|
| [bills-and-expenses.md](bills-and-expenses.md) | Bounding boxes on every extracted field; adjudication view for PB-4 mismatches; AI decision trace |
| [invoicing.md](invoicing.md) | Rate row citation per line; IRN response payload retained; computation trace for tax |
| [gl-engine.md](gl-engine.md) | Every ledger entry reaches its voucher and source document; every report figure drills to its entries |
| GST Engine *(pending)* | Every GSTR-1/3B figure traces to the invoices composing it; 2B match evidence retained |
| TDS Engine *(pending)* | Section row cited under the numbering in force at the time; threshold-crossing computation traced |
| Bank Reconciliation *(pending)* | Match evidence — why this bank line was paired with this invoice; alternatives considered |
| Reports | Drill-down on every figure (PR-14) |

**Any new spec must state what provenance it captures and how it surfaces it.**

---

## 13. Test cases

| # | Given | When | Then |
|---|---|---|---|
| T-1 | A P&L figure | Click it | Contributing ledger entries listed |
| T-2 | A ledger entry | Click through | Voucher, then source document, opens |
| T-3 | A source document open | View | Extracted fields highlighted in place on the image |
| T-4 | A field hovered | — | Corresponding document region highlights |
| T-5 | A source document | Ask "what did this produce?" | Every entry and report line it fed (PR-2) |
| T-6 | A GST amount | Click | Rate row, citation, and arithmetic shown |
| T-7 | A voucher from before a rate change | View provenance | Shows the rate in force *then*, not now |
| T-8 | Document says CGST ₹900, computed ₹950 | Review | Adjudication view with both, plus three actions (PR-15) |
| T-9 | An AI-classified expense | Click "why?" | Prior examples that drove it, plus alternatives |
| T-10 | A CA corrects a proposal | Save | Original proposal retained; correction recorded (PR-10) |
| T-11 | Auditor samples 40 transactions | Export | Package with entries, documents, provenance, approvals (§9.5) |
| T-11a | Any export | Check reconciliation | Control totals tie exactly to Trial Balance and to filed GSTR-1/3B (PR-18) |
| T-11b | A cancelled invoice in the period | Check continuity report | Gap present and explained, not hidden (PR-19) |
| T-11c | An export package | Verify independently using VERIFY.md | All hashes and the manifest signature validate without BharatERP (PR-26) |
| T-11d | An e-invoiced sale in the period | Inspect attestations | IRP signed invoice and QR present verbatim; verifiable against the authority's public key (PR-23) |
| T-11e | A document swapped after export | Verify | Hash mismatch detected against the signed manifest (PR-24) |
| T-11f | Entries backdated into the period after year-end | Export | Disclosed in `cutoff.json`, not silently included (PR-21) |
| T-11g | Firm A's signing key compromised | Assess | Only firm A affected; other firms' exports unaffected (PR-27) |
| T-11h | Key rotated in 2028 | Verify a 2026 export | Still verifies against the 2026 key version (PR-29, PR-31) |
| T-11i | Forged package carrying an attacker's public key | Verify | Key not present in the public-key directory; verification fails (PR-30) |
| T-11j | Any signing operation | Inspect code paths | No path exists by which the application can read a private key (PR-28) |
| T-11k | Auditor login, mid-engagement | Query another client | Denied; attempt logged (PR-35) |
| T-11l | Auditor asks whether MFA was enforced all year | Open config view | Timeline across the period, not just today's setting (PR-34) |
| T-11m | Audit engagement ends | Auditor attempts login | Access auto-expired (PR-35) |
| T-12 | Value fetched via IRN | View | Marked `irp_fetch`, visually distinct from OCR (PR-5) |
| T-13 | Document image re-rendered at another zoom | View | Highlights still align (PR-6) |
| T-14 | Field read as "Rs. 11,800/-" | View | Both raw text and parsed 11800.00 available (PR-4) |
| T-15 | Low-confidence field | Review screen | Visually flagged for attention (PR-13) |

---

## 14. Open questions

**14.1 Storage cost.** Bounding boxes and rule snapshots on every field of
every document, retained 8 years (AT-11). Estimate the per-client footprint —
likely modest versus the document images themselves, but worth measuring before
committing.

**14.2 Retention symmetry.** Should provenance persist as long as the documents
(8 years), or can the AI decision trace be pruned earlier? The compliance
requirement covers books of account; the AI trace is arguably operational data.
*Lean: keep everything — storage is cheaper than a lost audit defence.*

**14.3 Hand-entered values.** When a CA types a figure directly rather than
accepting an extraction, provenance is "a human said so." Sufficient, or should
the system prompt for a reason or an attachment above a materiality threshold?
Note these are also the weakest rows under PR-22's independence classification.

**14.4 SOC 1 Type II timing.** Type II requires an operating period, so it must
be started well before the first customer statutory audit. When, which
assurance firm, and what does it cost? A business/roadmap decision — now
tracked in `08-roadmap/BUILD-ROADMAP.md`. Engineering must nonetheless build
the evidence trail (§9.2) from day one, because it is tested retrospectively.

**14.5 Key-directory availability.** PR-30 makes the public-key directory a
verification dependency. If it is unreachable, exports cannot be verified. Does
it need independent hosting, mirroring, or publication to a third-party
transparency log so verification survives BharatERP being down — or gone?

**14.6 Offline root key.** PR-30 offers cross-signing firm keys with an
air-gapped root. Worth the ceremony overhead (secure generation, custody,
periodic signing sessions), or is the published directory sufficient on its
own?

---

### Resolved

**~~Do auditors actually want this?~~** Yes — confirmed with a practising
auditor. A self-evidencing export replaces manual vouching subject to three
conditions, now specified in §9.1 and implemented across §9.

**~~Signing key custody.~~** Per-firm asymmetric keys in a managed Cloud KMS,
rotated annually, with key version recorded in each package. See §9.6.

**~~Is an auditor login still needed?~~** Yes, but with a redefined purpose.
The offline package handles data and transaction vouching; the login handles
environment and configuration auditing. Two tools, two questions. See §10.
