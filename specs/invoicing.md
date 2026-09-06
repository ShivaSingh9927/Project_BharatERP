# Spec: Invoicing (Sales)

**Status:** Draft — needs CA advisor review. **Several thresholds and rates in
this spec must be re-verified at build time** — see §2.3.
**Owner:** —
**Depends on:** [gl-engine.md](gl-engine.md), [audit-trail.md](audit-trail.md)
**Blocks:** GST Engine (GSTR-1 sources from here), Receivables, WhatsApp layer

---

## 1. Purpose

Invoicing is the first **producer** module — it creates the vouchers that
everything downstream reads. It is also where BharatERP touches statutory
territory for the first time: a tax invoice is a legal document with prescribed
content, prescribed numbering, and (above a turnover threshold) a mandatory
government registration step before it is valid.

Recall from Lesson 4 that bank data only ever shows a payment arriving. The
*sale* — the revenue, the GST liability, the customer's obligation — exists
only because an invoice was raised. This module is where that fact is created.

---

## 2. Scope

### 2.1 In scope
Tax Invoice, Bill of Supply, Credit Note, Debit Note, Export Invoice, Advance
Receipt. Tax computation, invoice numbering, e-Invoice (IRN) generation,
e-Way Bill generation, GL posting, delivery to the customer.

### 2.2 Out of scope
- Purchase bills / accounts payable → separate spec
- GSTR-1 / GSTR-3B filing → GST Engine spec (this module produces the data)
- Inventory movement on sale → Phase 2, Inventory spec
- Payment collection mechanics → Receivables / Decentro spec

### 2.3 ⚠️ Volatility warning

We already discovered that TDS section numbers were renumbered wholesale by the
Income Tax Act 2025. GST is at least as volatile — rate slabs, e-invoice
turnover thresholds, and reporting time limits have all changed multiple times
since 2017.

**Therefore: nothing in this spec's numbers may be hardcoded in
implementation.** Every rate, threshold, and time limit lives in a
date-ranged master table (§4.4), exactly like the TDS section master. The
figures quoted in this document are illustrative of *shape*, not authoritative
values. Confirm each with the CA advisor before build, and design so that a
change is a data update, never a code deploy.

---

## 3. The classification that drives everything

Before any tax is computed, three questions must be answered. Almost every
downstream behaviour follows from them.

### 3.1 Who is the customer? (GST category)

| Category | GSTR-1 bucket | Notes |
|---|---|---|
| Registered — Regular | B2B | Has a valid GSTIN, claims ITC |
| Registered — Composition | B2B | Has GSTIN but cannot claim ITC |
| Unregistered | B2C | No GSTIN. Split into B2CL/B2CS by value and interstate-ness. |
| SEZ (with / without payment of tax) | SEZ | Treated like an export |
| Overseas | EXP | Export. Zero-rated. |
| Deemed Export | DEXP | Supplies to EOU/advance-authorisation holders |
| UIN Holder | B2B | Embassies, UN bodies |
| Tax Deductor / Tax Collector | B2B | Govt bodies deducting TDS-GST |
| Input Service Distributor | B2B | Distributes ITC across branches |

### 3.2 Where is the supply? (place of supply)

This single decision determines whether tax splits into CGST+SGST or becomes a
single IGST — Lesson 5's two worked examples.

```
supplier_state_code = first 2 digits of the seller's GSTIN
place_of_supply_state_code = derived per §3.4

if supplier_state_code == place_of_supply_state_code:
        → intra-state → CGST + SGST, each at half the total rate
else:
        → inter-state → IGST at the full rate
```

A GSTIN is 15 characters: `2 digits state code | 10 char PAN | 1 entity number
| Z | 1 checksum`. The state code is therefore always available for a
registered party. Validate the checksum and the structure, and verify status
via the GSTIN verification API — an invoice to a cancelled GSTIN causes the
*customer* to lose ITC, which is a relationship-damaging error.

### 3.3 What is being supplied? (GST treatment)

| Treatment | Tax charged | Appears in returns |
|---|---|---|
| Taxable | Yes, at applicable rate | Yes |
| Zero-rated | 0%, but ITC still claimable | Yes — exports, SEZ |
| Nil-rated | 0% by rate schedule | Yes |
| Exempt | No tax, ITC **not** claimable | Yes, separately |
| Non-GST | Outside GST entirely (e.g. petrol, alcohol) | Separately |

Zero-rated and exempt look identical to a beginner but differ crucially: with
zero-rated, the seller keeps their input credit; with exempt, they don't.

### 3.4 Place-of-supply rules (the part that gets it wrong)

Not simply "the customer's address."

| Supply type | Place of supply |
|---|---|
| Goods, with movement | Where the movement terminates for delivery |
| Goods, no movement | Location of goods at delivery time |
| Services, registered recipient | Recipient's registered location |
| Services, unregistered recipient | Recipient's address if on record; else supplier's location |
| Immovable property (rent, construction) | Where the property is |
| Events, training, admission | Where the event is held |
| Transport of passengers | Where the passenger boards |
| Restaurant, personal grooming, fitness | Where performed |
| Telecom, banking, insurance | Recipient's location on the supplier's records |
| Export of goods | Outside India |

Store `place_of_supply` explicitly on the invoice. Default it intelligently,
allow override, and never silently recompute it after posting.

---

## 4. Data model

### 4.1 Invoice header

Extends the `vouchers` table from `gl-engine.md` §5.2 with sales-specific
fields.

```
sales_invoices
  voucher_id            uuid PK FK -> vouchers
  document_type         enum NOT NULL   -- tax_invoice | bill_of_supply | credit_note
                                        -- | debit_note | export_invoice | advance_receipt
  customer_id           uuid NOT NULL FK
  customer_gstin        char(15) NULL   -- null for B2C
  supplier_gstin        char(15) NOT NULL   -- the client's own GSTIN used
  gst_category          enum NOT NULL   -- §3.1
  place_of_supply       char(2) NOT NULL    -- state code
  is_reverse_charge     boolean NOT NULL DEFAULT false
  is_export             boolean NOT NULL DEFAULT false
  export_type           enum NULL       -- with_payment | without_payment
  shipping_bill_no      text NULL       -- exports
  shipping_bill_date    date NULL
  port_code             text NULL
  billing_address       jsonb NOT NULL  -- snapshot, not FK — see §4.3
  shipping_address      jsonb NULL
  due_date              date NULL
  payment_terms         text NULL
  taxable_value         numeric(18,2) NOT NULL
  total_cgst            numeric(18,2) NOT NULL DEFAULT 0
  total_sgst            numeric(18,2) NOT NULL DEFAULT 0
  total_igst            numeric(18,2) NOT NULL DEFAULT 0
  total_cess            numeric(18,2) NOT NULL DEFAULT 0
  round_off             numeric(18,2) NOT NULL DEFAULT 0
  grand_total           numeric(18,2) NOT NULL
  amount_paid           numeric(18,2) NOT NULL DEFAULT 0   -- derived, see §4.5
  reference_invoice_id  uuid NULL FK    -- credit/debit note → original
  reason_code           text NULL       -- credit note reason
```

### 4.2 Invoice lines

```
sales_invoice_items
  id                uuid PK
  voucher_id        uuid NOT NULL FK
  line_no           int NOT NULL
  item_id           uuid NULL FK        -- null for free-text lines
  description       text NOT NULL
  hsn_sac_code      text NOT NULL       -- §4.6
  quantity          numeric(18,3) NOT NULL
  uom               text NOT NULL
  unit_price        numeric(18,4) NOT NULL
  discount_pct      numeric(6,3) NOT NULL DEFAULT 0
  discount_amount   numeric(18,2) NOT NULL DEFAULT 0
  taxable_value     numeric(18,2) NOT NULL
  gst_treatment     enum NOT NULL       -- §3.3
  gst_rate          numeric(5,2) NOT NULL
  cgst_amount       numeric(18,2) NOT NULL DEFAULT 0
  sgst_amount       numeric(18,2) NOT NULL DEFAULT 0
  igst_amount       numeric(18,2) NOT NULL DEFAULT 0
  cess_rate         numeric(5,2) NOT NULL DEFAULT 0
  cess_amount       numeric(18,2) NOT NULL DEFAULT 0
  income_account_id uuid NOT NULL FK -> accounts
```

**Tax is stored per line, not only in the header.** GSTR-1 requires
rate-wise and HSN-wise aggregation; recomputing that from a header total is
impossible when an invoice mixes rates.

### 4.3 Address and party snapshots

`billing_address` is stored as a **JSON snapshot**, not a foreign key to the
customer master.

An invoice is a legal document recording what was true *when it was issued*. If
a customer changes address next year, last year's invoice must still show last
year's address. Foreign keys would silently rewrite history — precisely the
class of problem `audit-trail.md` exists to prevent. Snapshot `customer_gstin`,
legal name, and address at issue time.

### 4.4 Rate and threshold masters (date-ranged)

Following the TDS master pattern discovered in the reference:

```
gst_rates
  id, hsn_sac_prefix, description,
  effective_from date NOT NULL, effective_to date NULL,
  gst_rate numeric(5,2), cess_rate numeric(5,2),
  source_notification text        -- citation for auditability

compliance_thresholds
  key text,                       -- 'e_invoice_aato', 'e_waybill_value', ...
  effective_from date, effective_to date,
  value numeric, unit text,
  source_notification text
```

Rate lookup is always *as of the invoice's posting date*, never "current". A
credit note issued today against a March invoice must use March's rate.

**Record which row was used, not just the resulting rate** — see
[provenance.md](provenance.md) PR-7. Storing "18% was applied" is worthless
three years later; storing the rate row id plus its source notification lets a
historical figure be defended after rates have changed twice.

### 4.5 Outstanding amount is derived, never stored

`amount_paid` is computed from `ledger_entries.settles_voucher_id` (gl-engine
§5.3), not maintained as a mutable counter. Same principle as balances: a
stored counter drifts; a query cannot.

### 4.6 HSN / SAC codes

- Goods use **HSN**; services use **SAC**, which always begins `99`
- Valid lengths: 4, 6, or 8 digits
- Required digit count depends on the client's aggregate turnover — a
  threshold, so it lives in `compliance_thresholds`
- HSN-wise summary is a mandatory GSTR-1 table, so the code must be captured
  per line, never left blank

---

## 5. Invoice numbering — statutory rules

This resolves open question **12.2** from `gl-engine.md`.

**CGST Rules, Rule 46(b)** prescribes that a tax invoice number must be:

1. A **consecutive serial number**
2. **Not exceeding 16 characters**
3. Containing only alphabets, numerals, and the special characters **hyphen (-)
   and slash (/)**
4. **Unique within a financial year**

**Implications for implementation:**

- **INV-1 —** Numbering resets each financial year (1 April). Series prefix
  should encode the FY (`INV/26-27/0001`).
- **INV-2 —** Gaps are a compliance risk. "Consecutive" is read strictly by
  officers; unexplained missing numbers invite questions about suppressed
  sales. Therefore: **a cancelled invoice retains its number.** Never reuse it,
  never renumber to close a gap. The cancellation is visible (per gl-engine
  GL-6, cancellation is a reversal, not a deletion), which is exactly the
  explanation an officer needs.
- **INV-3 —** Number assignment must be atomic and gapless under concurrency.
  Use a per-client, per-series, per-FY counter with row-level locking — not
  `MAX(number)+1`, which races.
- **INV-4 —** Multiple series are permitted (e.g. separate series per branch or
  per document type), each independently consecutive.
- **INV-5 —** Validate the 16-character limit and permitted character set at
  entry. This is a frequent cause of **e-invoice rejection** at the IRP.

---

## 6. Tax computation

Deterministic. Pure code, no AI. (`ai-harness-architecture`: the model may
propose *which* account or *which* HSN; it never computes a tax amount.)

```
For each line:
  gross            = quantity × unit_price
  taxable_value    = gross − discount
  rate             = lookup(hsn_sac, posting_date)    -- §4.4, date-ranged

  if intra_state:                                     -- §3.2
        cgst = round(taxable_value × rate / 2, 2)
        sgst = round(taxable_value × rate / 2, 2)
        igst = 0
  else:
        igst = round(taxable_value × rate, 2)
        cgst = sgst = 0

  cess = round(taxable_value × cess_rate, 2)

Header:
  totals   = Σ line values
  round_off = round(grand_total) − grand_total       -- to nearest rupee
  Cross-check: Σ line taxes == header totals, else reject
```

**Rounding:** round at the line level, then sum. Rounding the total instead
produces per-line figures that don't reconcile — and GSTR-1 reports line-level
detail, so the mismatch surfaces at filing time.

**Reverse charge (RCM):** where applicable, the *recipient* pays the GST, not
the supplier. The invoice shows the tax as payable under reverse charge but the
supplier does not collect it — so no Output GST liability is posted. Flag
`is_reverse_charge` and post accordingly.

**Composition dealers** cannot collect GST at all. They issue a **Bill of
Supply**, not a Tax Invoice, and it must carry the prescribed declaration. Gate
`document_type` on the client's registration type.

---

## 7. GL posting

Per `gl-engine.md` §5.5. The invoice module resolves accounts and amounts; the
GL Engine applies the template and validates (V-9 independently recomputes tax).

**Tax invoice, intra-state, ₹10,000 + 18%:**
```
Debtors (party = customer)   Dr  11,800
    Sales                        Cr  10,000
    Output CGST Payable          Cr     900
    Output SGST Payable          Cr     900
```

**Inter-state:** the two 900s collapse into `Output IGST Payable  Cr 1,800`.

**Export without payment of tax:** no output tax lines at all — `Debtors Dr
10,000 / Sales Cr 10,000`.

**Credit note (sales return):** the reverse — Sales and Output GST are debited,
Debtors credited. Note this *reduces* the client's GST liability in the period
the credit note is issued.

**Advance receipt:** GST is payable on advances for services at receipt time,
before any invoice exists. Post to an Advance Received (liability) account with
output tax, then adjust when the invoice is finally raised. Treatment differs
between goods and services — flag for CA advisor (§12.3).

---

## 8. e-Invoice (IRN)

### 8.1 What it is

Above an aggregate-turnover threshold, B2B invoices must be registered with the
government's Invoice Registration Portal (IRP) **before** they are legally
valid. The IRP returns an **IRN** (Invoice Reference Number), a digitally
**signed invoice**, and a **signed QR code** that must be printed on the
invoice.

An unregistered invoice, where registration was required, is not a valid tax
invoice — and the customer cannot claim ITC on it.

### 8.2 Applicability

Applies to **B2B, SEZ, exports, and deemed exports** — not B2C. Determined by
the client's **aggregate annual turnover** against a threshold that has been
lowered repeatedly since 2020. Store it in `compliance_thresholds`; never
hardcode. Turnover is assessed on prior-FY aggregate turnover across all GSTINs
under one PAN.

### 8.3 Flow

```
1. Invoice created and validated locally
2. Check applicability (client turnover, document type, party category)
3. Build the IRP payload from invoice data
4. Sign and submit to IRP via the GSP
5. Receive IRN + signed invoice + signed QR + acknowledgement no. & timestamp
6. Store all of it in an immutable e_invoice_log
7. Render the QR on the printed/PDF invoice
```

### 8.4 Log table

```
e_invoice_logs
  id, voucher_id, irn, ack_no, ack_date,
  signed_invoice text, signed_qr text,
  request_payload jsonb, response_payload jsonb,
  status enum,                  -- pending | generated | cancelled | failed
  is_sandbox boolean,
  cancelled_at, cancel_reason_code, cancel_remark,
  created_at
```

Append-only, per `audit-trail.md`. Store both request and response — when the
IRP disputes something months later, the payload sent is the only evidence.

### 8.5 Failure and edge cases — these matter more than the happy path

| Case | Handling |
|---|---|
| **Duplicate IRN** ("already generated") | IRP returns the existing IRN. Treat as success, store it, do not error. Common after a timeout-and-retry. |
| **Network timeout** | Status `pending`. A background job retries and reconciles. **Never** create a second invoice — the IRN is keyed on supplier GSTIN + doc type + number + FY, so a retry is naturally idempotent. |
| **Validation rejection** | Surface the IRP's specific error to the CA. Common causes: invalid HSN, invoice number character violations (INV-5), GSTIN inactive, place-of-supply mismatch. |
| **Cancellation window** | An IRN can be cancelled on the IRP only within a short window (currently 24 hours) and only if no e-Way Bill is active against it. **After the window, the only remedy is a credit note.** The UI must make this distinction obvious — CAs get caught by it constantly. |
| **Reporting time limit** | Above a turnover threshold, invoices must be reported to the IRP within a fixed number of days of the invoice date. Late reporting is rejected outright. Track and warn ahead of the deadline. |
| **Sandbox vs production** | Flag every log row. Sandbox IRNs must never appear on a customer-facing document. |

### 8.6 Bulk generation

CAs work in batches. Support generating IRNs for many invoices asynchronously,
with per-invoice success/failure surfaced individually — one bad invoice must
not fail the batch. Per `audit-trail.md` AT-8, log each invoice separately.

---

## 9. e-Way Bill

### 9.1 What it is

Required for the **movement of goods** above a value threshold (commonly
₹50,000, but states set their own intra-state limits — hence a state-wise
threshold table). It is about *transport*, not about the sale, so it can exist
without an invoice (e.g. stock transfer) and an invoice can exist without it
(services, or below threshold).

### 9.2 Two parts

- **Part A** — invoice and consignment details (who, what, value, from, to)
- **Part B** — vehicle number and transporter details

Part B may be filled later, by the transporter. The bill isn't valid for
movement until both parts exist.

### 9.3 Validity and extension

Validity is distance-based — roughly one day per 200 km, with a minimum of one
day. If goods are delayed in transit, validity can be **extended**, but only
within a narrow window around expiry.

**Scheduled extension is a genuinely useful feature:** a CA can mark a bill for
automatic extension so it doesn't lapse overnight. The reference implementation
does this and it's worth matching.

### 9.4 Flow and edge cases

Generate (standalone, or piggy-backed on the IRN response), update vehicle
info, update transporter, extend validity, cancel (only within 24 hours and
only if not verified in transit).

| Case | Handling |
|---|---|
| Goods returned / trip cancelled | Cancel within window; else generate a new bill for the return leg |
| Vehicle breakdown, vehicle changed | Update Part B — allowed multiple times |
| Multi-vehicle consignment | Multiple Part B entries against one Part A |
| Bill expires in transit | Cannot be extended after a grace period. Goods are liable to detention. Alert loudly *before* expiry. |
| Generated together with IRN | The IRP can return both. Prefer this — one call, guaranteed consistency. |

---

## 10. Credit notes, debit notes, returns

- **Credit note** — reduces the amount owed (sales return, price reduction,
  deficiency). Must reference the original invoice.
- **Debit note** — increases it (price increase, extra charges).
- Both carry their own consecutive numbering series (INV-1 through INV-5 apply).
- **CN-1 —** A credit note reduces GST liability only if issued within the
  statutory window (broadly, by 30 November following the end of the financial
  year, or the date of filing the annual return, whichever is earlier). Beyond
  that, a commercial credit note can still be issued but **without** GST
  adjustment. The system must warn on the boundary.
- **CN-2 —** After the e-invoice cancellation window closes (§8.5), a credit
  note is the *only* way to reverse an invoice. Route the user there
  automatically rather than showing a failed cancel.
- Credit notes against e-invoiced invoices are themselves e-invoiceable.

---

## 11. Validation rules

Run before posting, in code, in addition to the GL Engine's V-1…V-13.

| # | Rule |
|---|---|
| SI-1 | Customer GSTIN structurally valid (15 chars, state code, checksum) and active |
| SI-2 | Supplier GSTIN belongs to this client and is active for the posting date |
| SI-3 | B2B invoice must carry a customer GSTIN |
| SI-4 | `place_of_supply` present and a valid state code |
| SI-5 | Every line has an HSN/SAC of valid length for the client's turnover band |
| SI-6 | Line tax split matches intra/inter-state determination — never both CGST/SGST *and* IGST on one line |
| SI-7 | Σ line taxes = header tax totals |
| SI-8 | Tax recomputed independently from taxable value × rate (gl-engine V-9) |
| SI-9 | Invoice number ≤ 16 chars, permitted characters only, unique per client/series/FY |
| SI-10 | Posting date within an open period; not before the client's GST registration date |
| SI-11 | Composition dealer cannot issue a Tax Invoice with GST collected |
| SI-12 | Export invoice requires shipping bill details when applicable |
| SI-13 | Credit note references an existing, posted invoice of the same client |
| SI-14 | Credit note total ≤ the original invoice's un-credited balance |
| SI-15 | Reverse-charge invoice posts no Output GST liability |
| SI-16 | e-Invoice-applicable invoice cannot be delivered to the customer before its IRN exists |

SI-16 is worth calling out: sending an invoice PDF without the QR code, when
one was required, hands the customer a document they cannot claim ITC against.

---

## 12. BharatERP-specific

### 12.1 Delivery — WhatsApp first

Invoice delivery is a first-class feature, not a print button. On posting, the
CA or owner can send the invoice via **WhatsApp**, email, or SMS, with a
**UPI payment link** attached (Decentro — the collections module we already
have keys for). Payment against that link flows back through the virtual
account and auto-settles the receivable via `settles_voucher_id`.

That closes the loop end to end: invoice raised → sent on WhatsApp → customer
pays by UPI → receipt auto-posted → receivable cleared → GST liability already
recorded. No manual step anywhere.

### 12.2 AI hooks

Exactly three, all advisory, none bypassing §11:

1. **HSN/SAC suggestion** from item description — high value, since wrong HSN
   is a top cause of both e-invoice rejection and rate errors
2. **Customer resolution** — free-text name → customer master entry
3. **Anomaly flags** at draft time — "this customer's GSTIN was cancelled last
   month", "this rate differs from the last 12 invoices for this item",
   "invoice number breaks the series"

The AI never sets a rate, computes tax, or assigns an invoice number.

### 12.3 Tally mode

F8 opens sales voucher entry. Keyboard-only path from customer → items →
save. Print layout follows the familiar Indian tax-invoice format, with the
e-invoice QR code placed where CAs expect it.

---

## 13. Test cases

| # | Given | When | Then |
|---|---|---|---|
| T-1 | Supplier 27 (MH), place of supply 27 | Post ₹10,000 @18% | CGST 900 + SGST 900, IGST 0 |
| T-2 | Supplier 27, place of supply 29 (KA) | Post ₹10,000 @18% | IGST 1,800, CGST/SGST 0 |
| T-3 | Invoice mixing 5% and 18% lines | Post | Per-line tax correct; header = Σ lines (SI-7) |
| T-4 | Invoice number `INV/2026-2027/000001/A` (>16 chars) | Post | Rejected (SI-9) |
| T-5 | Customer GSTIN cancelled | Post | Blocked with a clear message (SI-1) |
| T-6 | B2C invoice, no GSTIN | Post | Accepted; GSTR-1 bucket = B2C |
| T-7 | Export without payment of tax | Post | No output tax lines; zero-rated treatment |
| T-8 | Two users create invoices simultaneously | Post both | Consecutive numbers, no duplicate, no gap (INV-3) |
| T-9 | Invoice cancelled | View series | Number retained, not reused (INV-2) |
| T-10 | IRP returns "duplicate IRN" | Generate IRN | Existing IRN stored, treated as success (§8.5) |
| T-11 | IRP times out, job retries | Retry | Same IRN returned; exactly one invoice exists |
| T-12 | IRN generated 30 hours ago | Attempt cancel | Blocked; user routed to credit note (CN-2) |
| T-13 | e-invoice-applicable invoice, no IRN | Attempt WhatsApp send | Blocked (SI-16) |
| T-14 | Credit note ₹12,000 against ₹10,000 invoice | Post | Rejected (SI-14) |
| T-15 | Goods ₹60,000 despatched | Post | e-Way Bill required; prompted |
| T-16 | Composition dealer | Attempt Tax Invoice with GST | Rejected; Bill of Supply offered (SI-11) |
| T-17 | Credit note in Feb against a March-prior-FY invoice | Post | Rate looked up as of original invoice date (§4.4) |
| T-18 | Reverse-charge invoice | Post | No Output GST liability posted (SI-15) |
| T-19 | Invoice posted | Customer address later changed | Old invoice still shows the original address (§4.3) |
| T-20 | Rounding: ₹1,179.99 computed | Post | ₹0.01 to round_off; grand total ₹1,180 |

---

## 14. Open questions — for the CA advisor

**14.1 Current thresholds and rates.** Every figure in §2.3's warning. What is
the e-invoice turnover threshold today, the reporting time limit, and the
current rate-slab structure? These need a definitive answer before build.

**14.2 Multiple GSTINs per client.** A business registered in several states
has a GSTIN per state and files separately per state. Is one BharatERP "client"
one GSTIN or one PAN with several GSTINs beneath it? This is a **data-model
decision that is very expensive to change later** — probably the single most
important question in this spec.

**14.3 Advance receipts.** Confirm current treatment for goods vs services, and
whether target SMBs encounter it often enough to build in Phase 1.

**14.4 e-Way Bill in Phase 1?** Only relevant to clients moving physical goods.
If the pilot CAs' clients are mostly services and trading-without-transport, it
could defer to Phase 2 and save meaningful effort.

**14.5 Branch-wise invoice series.** Do target clients need separate series per
branch or per location, or is one series per client sufficient?

**14.6 GSP selection.** e-Invoice and e-Way Bill both require a GSP. Which one,
and does the same GSP cover GSTR filing (relevant to the GST Engine spec)?

---

## 15. Reference studied

`erpnext/accounts/doctype/sales_invoice` and
`india-compliance/gst_india/{utils/e_invoice.py, utils/e_waybill.py,
doctype/e_invoice_log, doctype/e_waybill_log, constants/}`.

Observations that informed this spec:

- Their GST party categorisation (Regular / Composition / Unregistered / SEZ /
  Overseas / Deemed Export / UIN / Deductor / Collector / ISD) maps directly to
  GSTR-1 buckets. Adopted wholesale — it's dictated by the return format, not
  by design choice.
- Their e-invoice log captures IRN, signed invoice, signed QR, acknowledgement
  number and timestamp, plus a sandbox flag. Adopted, and extended to store the
  full request payload for dispute evidence.
- Their explicit handling of the duplicate-IRN response is the kind of detail
  only production experience teaches. Adopted (§8.5).
- Their scheduled e-Way Bill extension is a real workflow need; adopted (§9.3).
- Their state-wise e-Way Bill threshold table confirms thresholds vary by
  state — captured in `compliance_thresholds`.
- Their HSN validation (lengths 4/6/8, services prefixed `99`) adopted.
- They resolve addresses by link. **Rejected** — we snapshot to JSON (§4.3), so
  a later master-data change cannot alter a historical legal document.
- Their invoice carries 161 fields on one document. **Rejected** — we split
  header, lines, and the e-invoice/e-way-bill logs into separate tables with
  the shared voucher header from `gl-engine.md`.

Nothing from the reference is reproduced. The WhatsApp/UPI delivery loop
(§12.1), the AI hooks (§12.2), the date-ranged rate master design (§4.4), and
the numbering-concurrency requirements (INV-3) have no counterpart there.
