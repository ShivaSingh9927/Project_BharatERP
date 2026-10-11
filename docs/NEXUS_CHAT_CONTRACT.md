# Nexus chat workspace contract

**Status:** Design contract with a partial Phase 1–2 implementation,
2026-10-10. The `/nexus` page stores Q&A in durable, client-scoped cases and
renders saved text messages. A guided bank activity control now saves and
renders a validated read-only summary, metrics, table, and daily chart in the
case. General natural-language questions still use the existing text-answer
path. The immediately preceding user question in the same case can resolve a
period follow-up such as “what about last month?”; previous assistant answers
and document contents are not added to the routing context. Bank review and
reconciliation remain in their existing domain workflows, and no
consequential action is available from chat.

Bank transaction source references in Nexus response blocks now link to a
read-only bank-line evidence page. The page re-reads the transaction, linked
account, and statement period under the signed-in firm/client scope; arbitrary
URLs and non-bank source kinds are never turned into links. Other provenance
types remain labels until they have a suitable client-scoped detail route.

## 1. Response envelope

Persist and validate a versioned envelope on the server. The model may suggest
prose and block layout; trusted domain queries supply figures, record
references, permissions, and action effects. Reject unknown versions/types,
invalid references, malformed money, and unsupported actions. Never render
model-provided HTML, SQL, executable links, or component properties directly.

```json
{
  "schema_version": 1,
  "blocks": [],
  "generated_at": "2026-10-10T09:30:00Z"
}
```

Blocks are ordered and have a server-generated or validated stable `id` and a
`type`. A block may include `title`. Every factual block carries provenance:

```json
{
  "as_of": "2026-10-10T09:25:00Z",
  "sources": [{ "kind": "bank_transaction", "id": "<scoped-record-id>", "label": "Bank statement · 8 Oct" }],
  "coverage": {
    "scope": "Selected account, statement period 1–8 Oct 2026",
    "completeness": "partial",
    "limitations": ["One transaction has no confirmed purpose"]
  }
}
```

`as_of` is an ISO-8601 timestamp with timezone; a date-only source may use
`YYYY-MM-DD` plus an explicit timezone policy in its label. `sources` are
client-scoped opaque references checked again on every read or action. Do not
put private file paths or document bytes in the envelope. `completeness` is
`complete`, `partial`, or `unknown`; explain partial/unknown coverage in
`limitations`. Factual metrics, tables, and charts require this provenance.
Interaction blocks may omit it only when they make no factual claim; link
their `source_refs` to evidence where relevant. Missing coverage must be shown
as unknown, not silently treated as zero or complete.

### Allowed block types

| Type | Required payload | Interaction and validation |
| --- | --- | --- |
| `paragraph` | `text` (plain text or restricted markdown) | Explain a result or limitation. Escape HTML; links are generated from a safe route allowlist. |
| `metrics` | `items[]: {label, value, unit, period?, source_refs[]}` | Money values are decimal strings, never JS floats. Distinguish book balance, statement balance, and available cash. Each item resolves to provenance. |
| `table` | `columns[]`, `rows[]`; each row has stable `id`, typed `cells`, optional `source_refs` | Server validates cell types and scoped references. Sorting/filtering/paging is local to the authorized result. Selecting a row opens its evidence. |
| `chart` | allowlisted `kind` (`line`, `bar`; `donut` planned), `series[]`, `accessible_summary`, `table_fallback` | Values come from a domain query; money is a decimal string. Every point has a label and optional source refs. Selection opens evidence; never derive totals in the browser. |
| `progress` | `status`, `steps[]`, `next_action?` | Status is from the case state list below. Steps show user-safe milestones, not hidden chain of thought or raw model logs. |
| `question` | `prompt`, `options[]`, `allow_free_text`, `source_refs[]` | Ask one specific blocking question at a time. `Unsure`/`I don’t know` is available when uncertainty is valid and leaves the case unresolved. |
| `review_action` | `proposal_id`, `subject_refs[]`, `rationale`, `evidence_refs[]`, `effects[]`, `choices[]`, `precondition_version` | A proposal only. `effects` are domain-computed, exact, and explicit. Choices map to an existing authorized workflow; no endpoint, SQL, or action body comes from the model. Re-read state and permission at decision time; stale proposals require refresh. |

`effects[]` should name the affected record/account, debit/credit direction
where applicable, exact amount and currency, and whether the workflow will
save a review, reconcile, or post. If the effect cannot be computed or is not
applicable, state that plainly. A review card must name its required decision
and the resulting destination/state. A decision records actor, time, proposal
version, visible evidence references, choice, and resulting record ID.

## 2. Case state and action boundaries

Case state is a durable user-facing projection, not a replacement for
`nexus_specialist_tasks`, follow-ups, alerts, assistant runs, or accounting
records. Record transitions as attributed events; derive the displayed state
from those events. Initial state graph:

```text
open -> working | cancelled
working -> needs_user | with_ca | blocked | completed | open | cancelled
needs_user -> working | blocked | cancelled
with_ca -> working | needs_user | blocked | completed | cancelled
blocked -> working | needs_user | with_ca | cancelled
completed -> (terminal; reopen through a new linked case)
cancelled -> (terminal)
```

`completed` means the requested investigation/review was completed. It does
not imply a ledger action, reconciliation, payment, or filing is complete.
Only show `with_ca` when an authorized assignment exists. A failed task may
leave its case `blocked` or `needs_user`; preserve task status separately.

| Operation | Nexus | Founder | Authorized CA/finance user |
| --- | --- | --- | --- |
| Read scoped evidence and prepare explanation/proposal | Yes, through declared read paths | Read own client scope | Read assigned/authorized client scope |
| Ask, answer, mark unsure, defer, or correct a proposal | May ask; cannot answer for a person | Yes, within existing client permission | Yes, within existing client permission |
| Confirm document class, import, classify a bank line, reconcile, post, pay, file, or change a rule | Never | Only where existing workflow grants the action and asks for explicit confirmation | Only where existing workflow grants the action and asks for explicit confirmation |
| Assign/hand off a case | May recommend | Where role permits | Where role permits |

The action API derives firm, client, user, and role from the authenticated
session; it never trusts browser-supplied tenant IDs. Before any consequential
action, verify role and consent, re-read source state and proposal version,
show exact effects, require a deliberate user confirmation, and invoke the
existing domain action exactly once with idempotency protection. The model
cannot turn text, a tool result, or user-uploaded instructions into approval.
Posted history remains append-only. Consent to send data to an AI provider is
separate from consent to take an accounting action; show provider/data-sharing
disclosure before enabling a workflow that sends client data externally.

## 3. Responsive interaction wireframes

These text wireframes are design fixtures, not a claim that these screens are
implemented.

### Founder: bank review case

```text
┌ Bharat Nexus · Acme Foods                         [Cases] ┐
│ Needs you · Review bank activity · Account ending 1234     │
│ Nexus checked statement 1–8 Oct · 18 lines · 14 matched    │
│ [Balance/coverage summary]       [small trend chart]        │
│ Unmatched transactions                                     │
│ Date | Description | Amount | Status                        │
│ 08 Oct | UPI/8471 | ₹2,400.00 | Purpose unclear [Inspect]   │
│ Evidence: statement row → original statement (if permitted) │
│ Nexus: I can’t identify the purpose from this reference.    │
│ What was this payment for? [Business] [Personal] [Transfer] │
│ [Unsure] [Add context…]                                     │
│ After the purpose is supported: proposed accounting effect  │
│ [Review details] [Confirm in bank review] [Defer]            │
│ Chat composer: “Review my bank activity”              [Send] │
└─────────────────────────────────────────────────────────────┘
```

At narrow widths, stack summary, chart, table, then question/action cards;
row evidence opens in a full-height drawer with a close/back control. Keep the
case title, current state, and composer reachable without horizontal scroll.
The example's UPI line remains `needs_user` when the founder selects `Unsure`;
that choice records uncertainty and does not classify, reconcile, or post.
Do not show a confirmable accounting proposal for that unresolved answer. On
an actionable proposal, show evidence and exact effect before routing the
explicit confirmation to the existing bank workflow. Never imply the chat
posted it merely because the case now displays a decision.

### CA: same case, deeper inspection

```text
┌ Client: Acme Foods · Nexus case · Needs user/CA review ─────┐
│ Summary and coverage | 18 statement lines | 14 matched      │
│ [Chart + accessible data table]                              │
│ Unmatched table  [date/account/status filters]               │
│ Selected UPI row → original, parsed fields, match history    │
│ Source links | classification proposal | exact effect        │
│ Case events · founder answer · Nexus question · CA notes     │
│ [Correct proposal] [Defer] [Open reconciliation workflow]    │
│ Assistant/task details: collapsed, inspectable on demand     │
└──────────────────────────────────────────────────────────────┘
```

On mobile, evidence occupies a drawer; the same case events, provenance, and
decision controls remain in a single-column sequence. CA-only controls are
shown only after server authorization. The CA can inspect specialist attempts
and findings but should not have to read them to identify the evidence,
uncertainty, next action, or accounting effect.

## 4. Accessibility and trust requirements

- Use semantic headings, landmarks, table headers/captions, labels, and
  keyboard-operable buttons. Maintain visible focus and logical tab order.
- Announce case-state changes and submitted answers through a restrained
  `role="status"`/live region; do not make the entire transcript continuously
  announce itself.
- Charts include a concise text summary and an equivalent keyboard-readable
  data table. Color is never the only status cue; honor reduced motion and
  adequate contrast.
- Review choices are explicit buttons with descriptive names, not unlabeled
  icons or click-only rows. Confirmations state the consequential effect.
- Treat uploads, PDFs, OCR, email, statement descriptions, model output, and
  imported records as untrusted data, never instructions. Escape output and
  validate all IDs and action choices server-side.
- Drill-downs repeat firm/client authorization checks. Do not reveal another
  client's existence through lookup errors. Original documents are shown only
  through existing authorized paths; never expose storage paths or bytes in a
  block payload.
- Keep exact currency strings and source attribution through rendering. Label
  freshness and coverage beside the figure, not only in a distant footnote.

## 5. Example: review a synthetic UPI payment

User asks: **“Review my bank activity for 1–8 Oct.”** The server scopes the
selected account and statement period, retrieves reconciliation queue data,
and returns a `paragraph` (18 lines checked; 14 matched), a sourced `metrics`
block, a `chart` with table fallback, and a `table` of unmatched lines. Each
summary carries statement/account scope, query timestamp, and limitations.

For `08 Oct · UPI/8471 · debit ₹2,400.00`, Nexus cannot infer the purpose from
the reference. It returns a `question` with `Business expense`, `Personal`,
`Transfer`, and `Unsure`. If the user selects `Unsure`, the case records the
answer and remains `needs_user`; no classification is made. If the user
supplies context, the system may prepare a `review_action` only after
deterministic validation and a domain-computed effect. The action card links
the statement line and supporting evidence, identifies uncertainty, and
states the proposed ledger effect. Explicit confirmation calls the existing
`reviewBankTransaction`/reconciliation workflow after rechecking the source;
only its returned result is described as saved, posted, or reconciled. A stale
or already reconciled line disables confirmation and refreshes the proposal.

## 6. Phase 0 exit gate and decisions

Phase 0 is ready for implementation when founder and CA reviewers can use the
same example to identify the source, as-of time, coverage gap, uncertainty,
next action, and exact accounting effect; approve the schema and permission
matrix; and confirm that every consequential action routes through its
existing workflow. The UPI `Unsure` path must remain unresolved. Phase 0 adds
no application behavior or database migration.

Open decisions to resolve during review:

1. Which existing identity/role predicates define founder versus CA and
   finance permissions for case handoff and each bank action?
2. Should `with_ca` require an explicit case assignee, or may it represent an
   unassigned CA review queue? This contract assumes explicit assignment.
3. What statement timestamp/timezone convention should `as_of` display when
   the source provides only a transaction date? The default above preserves
   the source date and separately timestamps the query.
4. Which existing bank path is the final confirmation destination for each
   classification, especially categories that only save a review and do not
   create a voucher? Do not implement the card until the effect mapping is
   verified against current domain behavior.

## 7. Implementation snapshot

- Migrations 065–068 add append-only, tenant-scoped case state, messages, and
  evidence references. `/nexus` creates cases for Q&A, saves user/Nexus
  messages, lists recent cases, and scopes case selection to the session's
  client. A saved case remains open for additional questions; completed and
  cancelled cases start a new case.
- `app/src/web/nexusBlocks.ts` validates and renders escaped paragraph,
  metrics, table, and line/bar chart blocks with provenance and accessible
  chart tables. `app/src/domain/nexusBankActivity.ts` supplies sourced,
  exact-decimal bank totals, up to 25 visible rows, and a daily debit/credit
  chart where the selected period supports one.
- The read-only bank activity builder is connected to the live case chat and
  its response blocks are persisted with the Nexus message. Rich evidence
  drill-downs, file-to-case routing, bank review proposals, approval role
  gates, and confirmation flows remain future work. Natural-language
  questions do not yet invoke the typed block path. Never treat this
  implementation snapshot as proof that the complete interaction contract is
  already live.
