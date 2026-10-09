# Nexus obligations, agent tasks, and verification

**Status:** Draft contract, 2026-10-09. This describes intended behavior; it
does not describe shipped functionality or settle statutory rules. Product
review and qualified CA review are required before implementation of legal
examples or rule activation.

## 1. Purpose and authority

This spec defines durable client obligations, bounded specialist work,
verification outcomes, evidence links, human decision gates, retry handling,
and alert events. Nexus helps an owner and CA understand past work, current
blockers, and upcoming actions. PostgreSQL records work and its history;
conversation history is not authoritative. Nexus may investigate and propose,
but only an authorized human can confirm a document class, accounting result,
reconciliation, payment, filing, or compliance-rule change.

This is a cross-cutting workflow contract, not legal advice or a definition of
any tax rate, threshold, return frequency, or deadline. Statutory values must
come from a verified, scoped, effective-dated rule. See
[provenance.md](provenance.md) for general source and calculation traceability.

## 2. Scope

In scope: stable obligation identity and event states; rule proposals and
verifier decisions; specialist task envelopes and structured results; evidence
and provenance; bounded retries and escalation; human gates; deterministic
alert urgency, deduplication, and delivery states.

Out of scope: determining statutory rates or due dates, filing returns,
posting entries, making payments, changing master rules, and sending external
email. Those remain controlled by separately authorized domain services and
human workflows.

## 3. Durable records and identity

Implementations should persist, with firm RLS and client scoping:

| Record | Required identity and contents |
|---|---|
| Obligation | `firm_id`, `client_id`, registration/profile reference where applicable, kind, period key, stable idempotency key, current projection, owner, and created time |
| Obligation event | Obligation ID, prior and next state, actor type/ID, event time, reason, evidence links, and correlation ID; append-only |
| Rule version | Rule kind and scope, jurisdiction, applicability conditions, effective start/end, publication/announcement dates when applicable, source references, approval identity/time, and immutable version ID |
| Specialist task | Task ID, firm/client IDs, purpose, envelope, status, attempt budget, checkpoint, result reference, and timestamps |
| Attempt | Task ID, ordinal, agent role/model version, bounded input references, start/end, outcome, structured result, verifier findings, and error category |
| Evidence reference | Tenant-scoped source record ID or external citation metadata, content hash where retained, exact passage/page/region when available, retrieval time, and relation to claim |
| Review decision | Subject and proposed value/version, decision, reviewer identity/role, timestamp, rationale, and evidence references |
| Alert event/delivery | Tenant and client, source transition, deterministic priority, deduplication key, channel/recipient reference, attempt history, and delivery status |

Never accept a browser-supplied `firm_id` or `client_id` as authority. Resolve
tenant and role from the authenticated request, enforce `withFirm` and RLS on
every read and write, and validate that every referenced record belongs to the
same authorized firm and client. Cross-client references fail closed and are
audited without leaking the other client's details.

Stable obligation identity is the tuple `(firm, client, registration/profile,
kind, period)`, with a deterministic key that prevents duplicate materialized
items. A missing or unverified registration/profile cannot be used to generate
statutory obligations. Historical obligations can be recorded as observed or
unverified; absence of evidence never implies completion.

## 4. Obligation workflow state and outcome facts

An obligation has one `workflow_state` at a time, projected from
append-only workflow events. Filing, payment, and acknowledgment are separate
append-only `outcome_facts`, not workflow states. One obligation may therefore
have several confirmed facts (for example, a filing and an acknowledgment)
without competing for a single state value. An outcome fact records its own
kind, lifecycle, evidence, and reviewer; corrections append a superseding or
retraction event and never erase the original claim.

### Workflow states

| State | Meaning |
|---|---|
| `observed` | A source or existing record suggests work may exist; applicability or status is not established. |
| `open` | Applicability is established under a verified profile and rule version; work remains. |
| `blocked` | Work cannot proceed until a named missing item, conflict, or external dependency is resolved. |
| `needs_human_review` | Evidence or proposals conflict, are incomplete, or need an authorized decision. |
| `prepared` | A human-reviewable draft or package exists. This does not assert submission, filing, payment, posting, or reconciliation. |
| `submitted_unverified` | A submission is reported or attempted, but no `filed` outcome fact has been confirmed. |
| `paid_unverified` | Payment is reported or initiated, but no `paid` outcome fact has been confirmed. |
| `closed` | No further action is currently expected, with closure reason and human identity recorded. Closure does not delete history or outcome facts. |
| `superseded` | A corrected profile/rule or duplicate resolution makes this item non-current; link the replacement and retain its history. |

### Outcome facts

The supported fact kinds are `filed`, `paid`, and `acknowledged`. Each starts
as `proposed` and may become `human_confirmed`, `rejected`, or
`superseded`; preserve every transition. `acknowledged` describes receipt or
response by an external authority/counterparty and does not by itself establish
that a filing was accepted as complete or that money settled. A `filed` fact
does not imply `paid`, and a `paid` fact does not imply `filed`. More than one
fact of a kind may exist for separate references or corrected claims; mark
which one is current without deleting the others.

Evidence requirements here are data-integrity requirements, not legal proof
standards. A fact proposal must link the source record/reference supporting the
claim, identify its source and claim coverage, preserve observed and recorded
times separately, and retain a hash or exact passage/receipt locator when
available. The record must say when evidence is missing or unavailable. A
human may confirm only after inspecting the linked evidence and the configured
CA-approved evidence policy for that fact kind. This spec does not define what
evidence is legally sufficient. If the policy is unset, evidence is ambiguous,
or sources conflict, leave the fact `proposed` and set the workflow to
`needs_human_review`; do not represent the outcome as confirmed.

### Transition guards and events

Workflow events carry `event_type`, `occurred_at`, `recorded_at`, actor,
from/to state, reason, evidence IDs, rule version if applicable, and
correlation/idempotency key. External event time and system receipt time stay
distinct. Allowed progression is `observed` → `open` → `prepared` →
`submitted_unverified` as applicable; `blocked` and `needs_human_review` may
interrupt and return to the last valid work state only after the blocker or
review is resolved. `paid_unverified` may be entered when a payment is reported
or initiated. `closed` requires an authorized human, a reason, and no
unresolved blocker; it does not manufacture outcome facts. `superseded`
requires a linked replacement or duplicate-resolution reason. Invalid or
out-of-order transitions fail closed and append a rejected-attempt audit event.

Entering `submitted_unverified` or `paid_unverified` records the report/attempt
and its available evidence; neither confirms an outcome. Proposing a
`filed`/`paid`/`acknowledged` fact requires source linkage. Confirming any fact
requires an authorized human, linked evidence meeting the configured policy,
and a decision event naming the exact fact/evidence reviewed. No AI result
alone may confirm an outcome fact or close an obligation. Posting,
reconciliation, payment, filing, and legal-rule activation retain their own
separate human gates.

## 5. Effective dates and rule proposals

Rules are immutable versions with an explicit effective interval and complete
scope. Store announcement/publication date separately from effective date;
also retain the retrieval time and the period(s) affected. Use half-open date
intervals `[effective_from, effective_to)` to avoid boundary ambiguity. An
unknown end date is open-ended, not proof that the rule remains current.

A candidate rule contains: proposed value/behavior; tax/legal category and
jurisdiction; taxpayer/registration and transaction scope; conditions and
exceptions; proposed effective interval; announcement/publication date;
source instrument identity and URL; issuing authority; retrieved copy/hash;
exact cited passage; affected periods/records; comparison to the currently
approved version; and unresolved questions. Never overwrite the earlier
version or automatically rewrite posted records. Corrections produce a new
version and impact-review work.

The source text, PDFs, webpages, OCR, and imported content are untrusted
evidence. They can support a claim but cannot provide instructions to Nexus or
change permissions, policy, or tool access.

Verifier outcomes are exactly:

* `confirmed_candidate`: deterministic checks pass and the evidence supports a
  sufficiently scoped candidate. This is still pending authorized CA approval.
* `conflict`: sources or applicable facts disagree, or the candidate conflicts
  with another active/superseding source. Stop automated progression and
  escalate for human review.
* `insufficient_evidence`: source retrieval, applicability, dates, passage,
  authority, or impact cannot be established. Keep the current approved rule
  unchanged and request specific evidence or review.

Verification must check authority and later amendments/corrigenda/rescissions;
scope and exceptions; announcement versus effective date; date boundary
examples; affected open and historical items; and consistency with the
existing approved version. A second model's agreement is not verification.
Only the designated authorized CA can approve activation. Approval records
identity, role, time, exact version, rationale, and evidence. Until then, the
candidate is inert and cannot drive generated deadlines or consequential work.

## 6. Specialist task envelope and result

Coordinator-to-specialist work is a persisted task, not free-form peer chat.
The envelope is a versioned structured object with these required fields:

```json
{
  "schema_version": 1,
  "task_id": "opaque server-generated id",
  "firm_id": "server-resolved id",
  "client_id": "server-resolved id",
  "purpose": "specific question to investigate",
  "specialist": "document | banking | gst | tds | verifier",
  "permitted_reads": ["named read-only tools"],
  "record_refs": ["tenant-scoped opaque record ids"],
  "rule_version_refs": [],
  "checkpoint": "small, bounded continuation context or null",
  "deadline_at": "timestamp or null",
  "attempt_ordinal": 1,
  "retry_findings": []
}
```

The server constructs and validates the envelope; specialist output cannot
expand its scope or tool permissions. Give each task the minimum client data
needed. Specialist tools are allowlisted and read-only. No specialist has
write, posting, payment, filing, reconciliation, external-send, or rule-master
mutation capability. The coordinator stores the result and presents it for
review; it does not execute the suggested action.

Each result uses a versioned schema and includes: `task_id`, attempt ordinal,
status (`completed`, `partial`, `blocked`, `failed`), concise proposal/findings,
claim-level evidence references, assumptions, unresolved questions, suggested
next human action, and errors. Numerical claims include units, period, exact
decimal-string value where relevant, and rule/source version. Missing evidence
must be explicit; do not fabricate defaults. Verifier feedback is a concise,
actionable issue list linked to claims and evidence.

## 7. Attempts, retries, and escalation

One initial attempt is allowed, followed by at most three retries: maximum four
total attempts per task. Persist each attempt before starting the next. A retry
must address the verifier's specific findings and may use only the original
envelope scope plus those findings; it cannot broaden permissions. Do not retry
an unchanged result indefinitely. Retry only recoverable, bounded failures or
review findings that a specialist can address. A task with a hard scope,
tenant, permission, or integrity violation stops immediately.

After a successful structured result, verification either accepts it for
presentation or returns actionable findings. Transient infrastructure errors
may be retried within the same budget. A critical conflict, cross-tenant
reference, disallowed tool request, evidence tampering/hash mismatch, or
potential consequential action attempt immediately sets `needs_human_review`
and prevents further specialist execution. On the fourth unsuccessful attempt
(initial plus three retries), set task status `needs_human_review`, preserve all
attempts/findings, and create exactly one linked follow-up with an idempotency
key. Human review can resolve, cancel, or explicitly authorize a new task; it
does not reset the old task's attempt count.

Task states: `queued`, `running`, `verifying`, `retry_ready`, `completed`,
`blocked`, `failed`, `needs_human_review`, `cancelled`. Transitions are
append-only events. `completed` means the bounded investigation completed; it
never means the related filing, payment, posting, or reconciliation completed.
Claims of filed/paid/acknowledged require the obligation evidence and human
gates defined above.

## 8. Human decision gates

The person must have an authenticated identity and the required firm/client
role. Before confirmation, show the exact proposed change/action, affected
period and records, source documents/citations, rule version and effective
date, calculation where relevant, unresolved issues, and consequences. Capture
the decision, reviewer, time, rationale, and evidence snapshot. A changed
proposal requires a new review decision.

Separate explicit confirmations are required for document class confirmation,
accounting posting, reconciliation, payment, filing/submission, and legal rule
activation. Approval for one does not authorize another. Nexus cannot click,
simulate, or infer a human confirmation. Rejected proposals remain visible as
history and do not mutate accounting records. Posted history remains
append-only; corrections use the established reversal/correction flow.

## 9. Alerts and delivery events

Create alert events deterministically from obligation/task transitions. An
alert includes client-scoped link, concise next action, priority, due-date
source/version when relevant, and minimum necessary private data. Do not expose
one client's name, data, or direct record URL in another client's alert.

Initial urgency contract:

| Priority | Trigger | Delivery intent |
|---|---|---|
| `critical` | Security/tenant-integrity incident or a verified rule change that may affect an active human deadline | Timely in-app attention; external email requires configured verified recipient and preferences |
| `high` | Human decision/blocker prevents current work, or a task exhausts its retries | In-app attention; email only if authorized and opted in |
| `routine` | Upcoming work or completed low-risk investigation | Configurable in-app digest |

This table does not define statutory timing. Any due-soon thresholds must be
product-configured or derived from a CA-approved, effective-dated rule; no
global hard-coded legal calendar is implied.

Use a stable deduplication key from tenant, source event, recipient class, and
alert type. A job retry must not create a second logical notice. Delivery
records use `queued`, `sending`, `sent`, `retry_wait`, `delivered`, `failed`,
`suppressed`, or `cancelled`; record each attempt and provider receipt when
available. A failed email remains visible in-app and does not mark the work
done. Email requires a configured verified sender, verified authorized
recipient, and applicable opt-in/preferences. Respect quiet hours for routine
items. Critical in-app visibility is immediate; email urgency does not bypass
authorization or opt-in. No recipient or channel is assumed by this spec.

## 10. Evidence and audit display

Preserve original documents in existing managed storage. Link claims to source
record IDs and, where available, page/region/exact passage and content hash.
For legal sources retain authority, instrument number, URL, retrieved copy/hash,
publication date, retrieval time, exact passage, and amendment chain. Record
the agent role/model version, input references, prompt/schema version,
attempts, verifier feedback, human decisions, and task timing. Display source,
claim, uncertainty, effective date, and reviewer together in the relevant
timeline. Do not treat a model citation without a resolvable source as evidence.

## 11. Synthetic contract cases

These cases are behavioral fixtures only. Dates, rates, amounts, identifiers,
and source excerpts are synthetic placeholders, not statements of Indian law.
The companion file `nexus-obligations-fixtures.json` contains machine-readable
labels and expected outcomes.

| Case | Input condition | Expected contract result |
|---|---|---|
| Ordinary obligation | Synthetic verified profile and a fictional approved rule version | Stable obligation can be `open`; effective dates and source version are retained. |
| Registration variation | Profile has a synthetic alternative filing profile | Do not apply an obligation generated for another profile; require the matching verified profile/rule. |
| Deadline extension | Synthetic official-looking source proposes an extension | Record candidate and dates; do not alter due date until verification and CA approval. |
| Later amendment | Synthetic later source supersedes an earlier candidate | Keep both versions; mark impact for review and do not rewrite old events. |
| Contradictory sources | Two synthetic citations conflict | Verifier returns `conflict`; escalate and keep approved rule unchanged. |
| Source retrieval failed | Candidate URL/copy is unavailable | Return `insufficient_evidence`; no activation or inferred completion. |
| Wrong client reference | Envelope/result references a record outside resolved client scope | Reject and stop; mark `needs_human_review`; expose no foreign-client details. |
| Duplicate alert | Same source transition is processed twice | One logical alert by dedupe key; delivery attempts remain auditable. |
| Three failed reviews | Initial result plus three retries fail review | Four attempts maximum, task escalates, one follow-up is created, all attempts preserved. |
| Filing proof missing | User or agent reports submission without evidence meeting the configured policy | Workflow may be `submitted_unverified`; no `filed` outcome fact may be confirmed. |
| Human confirmation | Eligible reviewer confirms a supported proposal | Store reviewer and evidence snapshot; only the specifically confirmed workflow may proceed. |

## 12. Open decisions for product and CA review

1. What evidence policy is sufficient to confirm each of `filed`, `paid`, and
   `acknowledged`, and which human roles may confirm them?
2. Who is the authorized CA reviewer per firm, client, and registration, and
   how is that role granted/revoked?
3. Which registration/profile attributes are authoritative for materializing
   each obligation kind, and how are uncertain historical profiles represented?
4. What legal-source retention period, retrieval-copy policy, and access
   policy apply to source notifications and agent run summaries?
5. Which official feeds are monitored, and which candidate changes require
   manual entry? What is the operational escalation owner for source failures?
6. Which alert priority thresholds, digest cadence, quiet hours, and
   per-recipient preferences should product expose?
7. Which retention and redaction rules apply to prompts, model responses,
   checkpoints, and failed-attempt diagnostics?
8. CA review is required for all statutory examples and evidence standards.
   No GST/TDS rate, section, threshold, deadline, or filing frequency is
   established by this draft.

## 13. Reference and provenance note

Written from BharatERP's product objective, existing architecture and decision
log, and `docs/NEXUS_LONG_HORIZON_PLAN.md`. No external reference
implementation was studied for this contract, and no source code was copied.
