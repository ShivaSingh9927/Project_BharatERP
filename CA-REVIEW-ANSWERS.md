# CA Review — Answers, Applied Changes, and Open Doubts

**Reviewer:** CA advisor (first opinion)
**Date received:** 2026-09-07
**Request:** [`CA-REVIEW-REQUEST.md`](CA-REVIEW-REQUEST.md)

This records what was answered, what was changed in the code as a result, and —
kept deliberately prominent — **what should not be trusted from a single
reviewer**. Statutory answers are not opinions, but they are also not always
current, and this one has a specific, checkable gap (§ "Not covered").

---

## How disagreement is handled

The most useful outcome of the review is a structural one. Answer **A3.3**
confirmed that every statutory value must be a **row with an `effective_from`
date and a citation**, never a constant in code.

Three consequences, and they are why the rest of this document is safe to act on:

1. A second CA who disagrees changes **a row**, not a release.
2. A rate that changes arrives as a **new row with a later date**, so a voucher
   posted last year still computes with the law that applied last year.
3. Every posted number can name the notification that produced it — provenance,
   applied to tax law.

The B2C-Large threshold is the worked example: `₹2,50,000` from 2017-07-01 is
retained *and* `₹1,00,000` from 2024-08-01 is added. A GSTR-1 reworked for an
earlier period still uses the figure that applied then.

---

## Applied to the code

| # | Answer | Change |
|---|---|---|
| A4.1 | B2C-Large is **₹1,00,000**, not ₹2,50,000 — Notification 12/2024-CT, from 2024-08-01 | **A live bug.** `gstRates.ts` had the superseded value seeded as current. Now two date-ranged rows |
| A4.2 | e-Invoice AATO ₹5 Cr — Notification 10/2023-CT | Citation recorded |
| A1.2 | Purchase of Goods is charged on the **excess** over ₹50 lakh, not the full cumulative | Rows added with `deduct_on_full_cumulative = false`. Without this every large purchase would have over-deducted, silently |
| A1.4 | No-PAN punitive rate is 5% for Purchase of Goods, not 20% | Separate `no_pan` rows, as the schema already allowed |
| A1.3 | Add Commission/Brokerage (₹20,000) and Interest other than securities | Rows added |
| A2.1 | The customer-TDS rate set {0.1, 1, 2, 5, 10} is **complete** | No change — the inference was already right. Comment updated from PLACEHOLDER to reviewed |
| A2.2 | TDS on taxable value, GST excluded — CBDT Circular 23/2017 | No change — BR-16 already did this. Now cited |
| A5.1 | **CSR is blocked** under s.17(5)(fa), Finance Act 2023 | Added to the blocked list |
| A3.1 | An unmatched HSN must **refuse to post**, not default to 18% | The catch-all 18% seed row was removed. The enforcement itself is a gap — see below |
| A3.3 | Date-ranging is critical; keep the complexity | Confirmed the existing shape |

All 14 `PLACEHOLDER` markers are now resolved — into a value, or into an
explicit `UNVERIFIED` with a reason.

---

## Not applied — and why

### Section codes under the Income-tax Act, 2025

The reviewer supplied mappings: Purchase of Goods as `393(1) Table Sl. 8(ii)`,
the no-PAN rule as `397(2)`. **These could not be corroborated against the bare
Act and are NOT recorded as fact.**

A wrong section code propagates onto every TDS certificate, return and challan,
and it is wrong in a way that looks authoritative. The rates and thresholds do
not depend on the codes, so they were applied and the codes were left marked
`CODE UNVERIFIED`.

**Action:** verify against the bare Act before anything statutory prints.

### Salary TDS

Listed as a missing category. As a *category* that is correct — it is the most
common deduction an SMB makes. But it cannot be a row in a rate table: salary
TDS is deducted at the employee's **average rate of tax on estimated annual
income**, after exemptions, declared investments and the choice of regime.
There is no rate to store and no threshold to cross.

It needs a payroll module. A row here would produce a number that looks
authoritative and is arbitrary. Recorded as gap **G-20**.

---

## ⚠️ Not covered by the review

**The September 2025 GST rate rationalisation.** Effective 22 September 2025 the
slab structure was reworked, collapsing 12% and 28%. Every HSN rate seeded in
`gstRates.ts` predates it, and the review did not mention it — despite A3.1 and
A3.3 both being about rates.

This is the clearest evidence that a single review is not sufficient. The rates
are now marked `UNVERIFIED — predates the 2025-09-22 rate rationalisation`
rather than being given a false citation.

**Also worth putting to a second reviewer:**

- **The A1.1 illustration is muddled.** "A ₹1,00,000 threshold crossed by an
  ₹80,000 payment → TDS on ₹1,08,000." Those numbers do not cohere. The
  principle (tax the whole aggregate once crossed) is standard and was applied;
  the example was not.
- **C2's MCA audit-trail framing applies to companies only.** Rule 3(1) of the
  Companies (Accounts) Rules binds *companies*. Many SMB clients are
  proprietorships or partnerships and are not covered. The commercial framing
  still works; it is not a legal requirement for every client.
- **TCS on sale of goods (206C(1H))** was omitted from 2025-04-01. It is the
  mirror of the Purchase of Goods deduction and clients may still expect it.
- **Professional fees and rent thresholds** were left at the previously seeded
  figures. The review did not correct them, which may mean they are right or may
  mean they were not checked.

---

## Part B — product answers, and what they settle

| | Answer | Effect |
|---|---|---|
| **B1** | Big five: HDFC, ICICI, SBI, Axis, Kotak. **PDF is the norm**, usually password-protected | Validates the PDF-first parser. ICICI, Axis and Kotak templates are still unverified against real files — the top remaining parser gap |
| **B2** | **Do not auto-post in v1**, even on a UTR match — the CA may know the payment belongs against an earlier advance. Build fast bulk-approve | Settles G-6 in favour of the existing review queue. `AUTO_MATCH_THRESHOLD` should gate *pre-selection*, never posting |
| **B3** | **Monthly at close**, driven by the GSTR-3B deadline on the 20th | The queue should be a bulk month-end workflow, not a live feed |
| **B4** | Cash books are kept offline and handed over monthly. The valuable feature is flagging a **negative cash balance** — mathematically impossible, and the most common error CAs fix | A small, high-value feature. Recorded as gap **G-21** |
| **B5** | OD/CC accounts are common; for v1 treat as bank accounts allowed to go negative. Defer interest computation | Cheap. Note this conflicts with B4's negative-balance rule, so the check must be per account type |

---

## Part C — structure

### C1. A client is one PAN with several GSTINs ← **schema change**

Confirmed: the ITR and the balance sheet are filed at PAN level. A business with
GSTINs in Delhi and Haryana has **one** set of books, one P&L, one balance sheet.

**Current state:** `clients` (migration `002_tenancy.sql`) has a single
`gstin char(15)`, and the schema comment already called this "the most expensive
open question remaining". It is GSTIN-level today, which is the wrong side of
the answer.

**Blast radius is small and shrinking is not an option later.** Only
`bills.ts` and `invoicing.ts` read `cl.gstin` / `cl.state_code`. The change is a
`client_registrations` table (one row per GSTIN, with its state code), with
vouchers referencing the registration rather than the client.

Doing it before there is production data is dramatically cheaper than after.
Recorded as gap **G-22**, and it should be done before the next module.

### C2. Reversing-entry-only is acceptable

Junior staff conditioned by Tally's alteration feature will find it irritating;
partners — who buy — will accept it framed as audit-trail compliance. No change:
the ledger is already append-only and enforced at the database.

---

## What this unblocks, in order

1. **G-22 — PAN-level client.** Schema, cheapest now, blocks multi-state
   consolidation forever if left.
2. **G-9 — per-line ITC eligibility.** A5.3 says day one; a hotel bill with
   allowable lodging and blocked food is routine.
3. **HSN → rate lookup with refuse-to-post.** A3.1. The `gst_rates` table is
   currently written by the seed and **read by nothing** — the lookup does not
   exist yet, so "refuse to post" is a requirement for when it is built.
4. **Second opinion on the rates**, specifically post-September-2025.
