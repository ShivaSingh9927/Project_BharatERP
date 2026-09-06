# CA Advisor Review Request

> ## ✅ ANSWERED — 2026-09-07
>
> A CA has answered every question. The response, what was applied to the code,
> and **what still needs a second opinion**, are recorded in
> [`CA-REVIEW-ANSWERS.md`](CA-REVIEW-ANSWERS.md).
>
> This document is kept as the original request, unedited, so the questions can
> be re-asked of a second reviewer without the first reviewer's answers
> anchoring them.


**What this is:** a single consolidated list of everything in BharatERP that
needs a chartered accountant's answer. Split into two parts:

- **Part A — statutory values** we have coded as placeholders and cannot verify
  ourselves. Each needs a correct value and, ideally, the notification or
  section to cite.
- **Part B — product judgement calls** where the right answer depends on how a
  CA firm actually works, not on what the law says.

Part A is factual and can be filled in directly. Part B is a conversation, and
those five answers will change what we build next — so they matter more than
they look.

**Please do not skip the "why we ask" notes on Part A.** Several of these
values change the *accounting entry*, not just a report figure, so a wrong one
propagates into the books rather than sitting in a corner.

---

# Part A — Statutory values to verify

## A1. TDS sections, rates and thresholds

Our current placeholder table. The Income Tax Act 2025 renumbered the entire
194-series, so we expect **both the codes and the rates** to need correction.

| Category | Payee type | Rate we assumed | Per-transaction threshold | Annual threshold | Code we guessed |
|---|---|---|---|---|---|
| Contractor payments | Individual / HUF | 1% | ₹30,000 | ₹1,00,000 | 393(3) - 1006 |
| Contractor payments | Company | 2% | ₹30,000 | ₹1,00,000 | 393(3) - 1006 |
| Contractor payments | No valid PAN | 20% | ₹30,000 | ₹1,00,000 | 393(3) - 1006 |
| Professional fees | Individual | 10% | ₹30,000 | ₹50,000 | 393(1) - 1007 |
| Professional fees | Company | 10% | ₹30,000 | ₹50,000 | 393(1) - 1007 |
| Professional fees | No valid PAN | 20% | ₹30,000 | ₹50,000 | 393(1) - 1007 |
| Rent — plant & machinery | Company | 2% | ₹50,000 | ₹6,00,000 | 393(1) [2(ii).D(a)] - 1008 |
| Rent — land & building | Company | 10% | ₹50,000 | ₹6,00,000 | 393(1) [2(ii).D(b)] - 1009 |

**Questions:**

**A1.1** Are the rates, thresholds and codes above correct as at FY 2026-27?
Where wrong, what are the correct values?

**A1.2** **Which sections charge TDS on the full cumulative amount once the
annual threshold is crossed, and which charge only the excess?**

*Why we ask:* we have assumed **full cumulative** for all of them. Concretely —
threshold ₹1,00,000, you pay a contractor ₹28,000 (no TDS), then ₹80,000. We
deduct 2% of ₹1,08,000 = **₹2,160**, not 2% of ₹80,000 = ₹1,600. If any section
actually charges only the excess, we are over-deducting on it. This is the
single most consequential answer in Part A.

**A1.3** Which other categories should we add before a pilot? Commission and
brokerage, purchase of goods, salary, and interest are the obvious candidates —
what does a typical SMB client actually trigger?

**A1.4** For the "no valid PAN" punitive rate — is it a flat 20%, or "20% or
the normal rate, whichever is higher"? Our code treats it as a separate rate row.

---

## A2. Customer-deducted TDS — the rates we infer from

When a customer pays less than the invoice, we detect whether the shortfall is
a TDS deduction rather than a genuine short payment.

Rates we currently treat as plausible: **0.1%, 1%, 2%, 5%, 10%.**

**A2.1** Is that set right for a typical SMB's customers? Should any be added
or removed?

**A2.2** **We compute the deduction on the invoice's taxable value, excluding
GST** — on the basis that where GST is shown separately, TDS is deducted on the
value excluding it (we believe CBDT Circular 23/2017). **Is that correct?**

*Why we ask:* on a ₹50,000 + 18% GST invoice (₹59,000 total), we expect 10% TDS
to be ₹5,000, not ₹5,900. If we have this backwards, we will fail to recognise
the deduction on **every invoice that carries GST** — which is most of them —
and each one leaves a receivable that can never be collected plus a tax credit
thrown away.

---

## A3. GST rates

Deliberately a thin placeholder set — we did not want to guess at a full HSN
schedule. What we need is not the whole schedule but the answer to how we
should source and maintain it.

| HSN/SAC prefix | Description | Rate assumed |
|---|---|---|
| *(fallback)* | Default when nothing matches | 18% |
| 99 | Services (SAC) | 18% |
| 1006 | Rice, branded | 5% |
| 3004 | Medicaments | 5% |
| 0401 | Fresh milk | 0% |
| 2402 | Cigarettes | 28% + 5% cess |
| 7318 | Iron/steel fasteners | 18% |
| 3506 | Prepared adhesives | 18% |
| 4819 | Cartons, boxes | 18% |

**A3.1** Is an **18% default fallback** acceptable, or is defaulting to any rate
dangerous enough that an unmatched HSN should refuse to post and demand a
human decision instead?

**A3.2** How do you currently keep rates current in practice — a purchased
master, the CBIC schedule, or per-client item masters built once and rarely
revisited?

**A3.3** Do rate slabs need to be **date-ranged**, or in practice do firms just
overwrite the current rate? We have built date-ranging (so a voucher from two
years ago still explains itself under the rate then in force). It is
significant extra complexity — is it worth keeping?

---

## A4. Compliance thresholds

| Threshold | Value assumed |
|---|---|
| B2C-Large invoice value (inter-state, unregistered) | ₹2,50,000 |
| e-Invoice mandatory above AATO | ₹5,00,00,000 (₹5 Cr) |

**A4.1** Are both current as at FY 2026-27?

**A4.2** Is the e-Invoice AATO threshold likely to drop again? If so we should
treat it as date-ranged data rather than a constant.

---

## A5. Blocked input tax credit — Section 17(5)

Categories we treat as blocked or conditional:

| Category | Our treatment | Unblocked for |
|---|---|---|
| Motor vehicles (≤13 seats) | Conditional | Transport, driving school, vehicle dealer |
| Food, beverages, outdoor catering | Conditional | Catering, restaurant |
| Beauty treatment, health services | Conditional | Healthcare, salon |
| Club / fitness membership | Blocked outright | — |
| Rent-a-cab, life & health insurance | Conditional | Insurance |
| Employee travel benefits (LTA) | Blocked outright | — |
| Works contract — immovable property | Conditional | Construction, works contract |
| Goods/services for personal consumption | Blocked outright | — |
| Goods lost, stolen, written off, gifted, free samples | Blocked outright | — |
| Purchases from a composition-scheme supplier | Blocked outright | — |

**A5.1** Is this list complete and correctly classified? Anything missing that
you see disallowed in practice?

**A5.2** **When ITC is blocked, we add the GST to the expense** rather than to
an input-credit account:

```
ITC eligible:  Expense Dr 10,000 + Input GST Dr 1,800 / Creditors Cr 11,800
ITC blocked:   Expense Dr 11,800                      / Creditors Cr 11,800
```

Is that the treatment you would expect? *Why we ask:* it moves reported profit
by the tax amount, so it is not a presentation choice.

**A5.3** Right now, if **any** line on a bill is blocked we mark the **whole
bill** blocked, and expect the user to split it. Is that acceptable, or do
mixed bills need proper per-line handling from day one?

**A5.4** For the conditional categories — is asking the user once for the
client's business type sufficient, or does eligibility vary invoice by invoice
even within one client?

---

## A6. The 180-day ITC reversal rule

We warn from **day 150** that a bill is approaching the 180-day limit, after
which claimed ITC must be reversed with interest.

**A6.1** Is 150 days the right warning point, or too late to be useful?

**A6.2** Does the 180-day clock run from the **invoice date** or from the
**due date**? We have used invoice date.

**A6.3** When the reversal does become due, do you expect the system to post it
automatically, or to raise it for approval?

---

## A7. Reverse charge

We post both legs on an RCM bill — the input credit and the output liability —
even though they usually net to zero.

**A7.1** Is that what you would expect to see in the ledger?

**A7.2** We currently **exclude round-off from RCM postings entirely**, because
both legs use unrounded values. Correct?

**A7.3** The credit is only claimable after the liability is actually paid in
cash. Should the system block the claim until it sees that payment, or just
flag it?

---

# Part B — Product judgement calls

These five change what we build, and no amount of research answers them. Rough
answers are far better than none.

## B1. Which banks do your clients actually use?

We can only build statement parsers one bank at a time, and each needs its own
column mapping and date format. **Naming the five or six that cover most of
your client base is worth more to us than a generic top-ten list.**

Also: do clients send **CSV/Excel exports**, or **PDF statements**? PDFs are
several times the work, so if everyone sends PDFs we need to know now rather
than after building the spreadsheet path.

And: are the PDFs password-protected (the PAN-plus-date-of-birth pattern)?

---

## B2. Would you let high-confidence matches post without review?

Our matching engine can be certain in some cases — a UTR that matches an
invoice exactly leaves no ambiguity.

**Would you allow those to post automatically, or must every match be seen by a
human before it hits the books?**

*Why it matters:* this single answer roughly halves or doubles the time saved.
If everything needs review, we are building a faster review queue rather than
automation — which is still valuable, but it is a different product.

Same question for bills: would you let a high-confidence extracted bill post
without review?

---

## B3. Do you reconcile monthly at close, or continuously?

**Monthly** favours a bulk workflow — import everything, clear it in one
sitting. **Continuous** favours a live feed and a persistent queue.

This shapes the entire screen, so we would rather match your actual habit than
impose one.

---

## B4. How do your clients handle cash?

Many Indian SMBs run significant cash that never touches a bank.

- How is the cash book maintained today?
- How is it verified — is it verified at all?
- What would make it better, in your words?

---

## B5. Overdraft and cash-credit accounts

OD and CC accounts carry credit balances and interest computations that differ
from current accounts.

**Are they common enough among your clients to need handling in the first
release, or can they wait?**

---

# Part C — Two questions on structure

Small in words, large in consequence — both are cheap to change now and
expensive later.

**C1. Is a "client" one GSTIN, or one PAN with several GSTINs under it?**

A business registered in three states has three GSTINs but one PAN, one set of
books, and one income tax return. We need to know which is the unit you think
in, because it determines how everything else is organised. Getting this wrong
is a rebuild, not a refactor.

**C2. Would a reversing-entry-only system be acceptable?**

Nothing in our system can ever be edited or deleted. A mistake is corrected by
posting a reversing entry and then a correct one — the original stays visible
forever. This is what the MCA audit-trail rules require, and it is what makes
the audit story strong.

**But it is stricter than Tally, where a voucher can be altered.** Is that
strictness something your team would accept as a feature, or would it be a
daily irritation that makes people avoid the software?

---

## What we will do with the answers

Part A goes straight into date-ranged master tables with your citation
recorded against each row, so any figure can be explained years later under the
rules in force at the time.

Part B and C determine what we build next.

Anything you think we have got structurally wrong is more useful to us than a
correction to a single rate.
