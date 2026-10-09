# Nexus long-horizon work plan

**Status:** proposed implementation plan, 2026-10-09. This document records a
build sequence, not a claim that these features exist or that any tax rule is
legally validated.

## Outcome

For each client, Nexus should answer what happened in a past period, what is
open now, and what is due next. It should show the evidence and next human
action behind each answer. Work should survive years of conversations and
model changes without relying on chat history as the source of truth.

Nexus may investigate, summarize, and propose. Only an authorized human can
confirm a document class, accounting outcome, reconciliation, payment, filing,
or compliance-rule change. A prepared return is not a filed return; an
unverified filing remains explicitly unverified.

## Architecture and authority

1. **PostgreSQL is the record of work.** Client-scoped obligation instances,
   follow-up tasks, evidence links, agent runs, review decisions, and alert
   deliveries live there with firm RLS. Original documents stay in their
   existing managed storage. Events are retained so later corrections do not
   erase what Nexus knew at the time.
2. **Nexus coordinates.** It reads the timeline, opens bounded tasks, and
   presents a concise synthesis. It cannot elevate its own proposal to an
   approved law or a completed filing.
3. **Specialists investigate.** Start with document, banking, GST, and TDS
   task types. Each receives only its client, purpose, permitted read tools,
   relevant record IDs, and small checkpoint. Each returns structured findings:
   proposal, evidence, unresolved questions, and suggested next action.
4. **Verifier reviews proposals.** Independent code checks validate schema,
   tenant scope, arithmetic, dates, source links, and conflicts. A bounded
   verifier agent challenges interpretation and missing evidence. For legal
   rules, a qualified CA approves applicability before the rule enters the
   active master. A second model's agreement alone is not verification.
5. **Domain services execute human-confirmed actions.** Existing posting,
   filing, and reconciliation gates remain the only execution paths.

Agents communicate through persisted task IDs and structured results, not
free-form peer-to-peer chat or shared growing prompts. Every result records
agent role, model/version, input references, time, and evidence references.
The coordinator passes a short issue list back to a specialist when review
fails. The retry budget is **three retries after the initial attempt**. Each
retry must address the review findings; unchanged output does not consume the
loop indefinitely. After the budget or on a critical conflict, mark the task
`needs_human_review`, preserve all attempts, and create one follow-up. Never
turn uncertainty into a default approval.

## Legal-change verification protocol

A change watcher may propose a candidate rule from an official notification,
Act, rule, circular, or portal update. Source text is untrusted evidence, never
an instruction to an agent. Store its URL, issuing authority, document number,
publication date, retrieved copy/hash, and the exact cited passage.

The GST/TDS specialist extracts the proposed effect. The verifier checks:

- legal authority and whether a later amendment, corrigendum, or rescission
  changes it;
- tax type, jurisdiction, registration/taxpayer class, transaction type or
  HSN/SAC/section, conditions, and exceptions;
- announcement date versus effective date and which historical periods are
  affected;
- computed differences against the current date-ranged rule and affected
  client records, with regression examples at both sides of the date boundary.

The outcome is `confirmed_candidate`, `conflict`, or `insufficient_evidence`.
Even a confirmed candidate waits for CA approval before a new effective-dated
rule row or deadline override is used. Do not overwrite a historical rule or
silently rewrite posted records. If a rule changes, identify affected open
work and historical records needing human review; do not automatically amend
them. A hypothetical change such as “15% becomes 12%” must specify *what*
rate, *for whom*, and *from when* before it can be evaluated.

Use official CBIC/GST and Income Tax Department publications as primary source
registries, with the Gazette where the authoritative instrument requires it.
Portal guides and FAQs help explain a workflow but do not outrank the governing
instrument. Due-date extensions and GST filing frequency are period- and
registration-specific; avoid one global hard-coded calendar.

Starting source registries: [CBIC GST notifications](https://cbic-gst.gov.in/hindi/central-tax-notifications.html),
[CBIC GST rate notifications](https://cbic-gst.gov.in/hindi/central-tax-rate.html),
[Income Tax Department Acts, rules, circulars, and notifications](https://www.incometaxindia.gov.in/),
and the [Gazette of India](https://egazette.gov.in/). Verify the individual
instrument and its amendments; an index page is only a discovery aid.

## Build sequence

### 0. Specify and test the contracts

- Write a focused spec for obligation states, rule proposals, verifier
  decisions, task envelopes, retry semantics, alert urgency, and permissions.
- Build labeled fixtures: ordinary filing, QRMP/registration variation,
  deadline extension, later amendment, contradictory source, failed source
  retrieval, wrong client, duplicate alert, and three failed reviews.
- Exit gate: CA reviews the statutory examples and the product team agrees on
  what evidence proves `filed`, `paid`, and `acknowledged`.

### 1. Add the client obligation timeline

- New migrations for registration/tax profiles and period obligations with
  stable keys (client, registration, kind, period), status events, owner,
  due-date source/version, and links to source documents or acknowledgments.
- First supported types: GSTR-1, GSTR-3B, TDS deposit, quarterly TDS statement.
  Materialize future items only from a verified profile and rule version.
- Backfill existing data as `observed` or `unverified` where proof is missing;
  never infer that a historical filing occurred.
- Exit gate: a user can inspect last period, current blockers, and next period
  for one client, with every status traceable to evidence.

### 2. Build `/attention` and follow-up routing

- **Phase 2 routing slice (2026-10-09):** migration 051 stores optional
  client-valid assignee, explicit due date, and low/normal/high priority.
  `/follow-ups` collects and displays the values; `/attention` displays them
  and marks past due dates as overdue. Assignment is validated against firm
  and client scope. Completion remains an explicit human action.
- **Follow-up activity checkpoint (2026-10-09):** migration 052 adds append-only
  user-attributed history for creation, blocker recording, snooze, and explicit
  completion. The review desk displays history and the current next action.
  Blocker and snooze only modify follow-up metadata; no obligation or filing is
  marked complete, and snooze causes no automatic state change.
- Remaining: linked obligation/document and a stronger confirmation criterion.
  Avoid duplicate tasks for the same event.
- Show `needs decision`, `blocked`, `due soon`, `overdue`, and `recently done`.
- Exit gate: each item has one clear next action and an audit trail; an AI
  suggestion cannot mark a filing complete.

### 3. Add in-app and email alerts

**Phase 3a progress (2026-10-09):** migration 050 adds append-only,
client-scoped in-app alert events for explicit follow-up creation/completion
and obligation `blocked`/`needs_human_review` transitions. `/attention` shows
up to ten recent notices and their total count. It links only to sources in
the visible review list; stale or closed sources are labeled without a link.
Notice priority is fixed by event type; no legal deadline or priority is
inferred. External delivery remains out of scope.

- Derive alert events from obligation/task transitions with deterministic
  priority rules. Critical events are timely; routine items go into a
  configurable digest. Include direct links, minimal private data, delivery
  preferences, quiet hours, deduplication keys, retry/outbox records, and
  delivery status.
- Send email only to verified, authorized recipients after the sender and
  opt-in/preferences are configured. A failed email remains visible in-app.
- Exit gate: tests prove no cross-client delivery, no duplicate notices on a
  job retry, and accurate "done" versus "needs attention" summaries.

### 4. Add durable Nexus tasks and bounded specialist runs

- Persist task envelopes, checkpoints, attempts, budgets, and final results.
  Keep task input small and retrieve current facts by ID at run time.
- Coordinator routes work; specialists have allowlisted tools and cannot call
  write paths. Independent tasks may run in parallel within per-client limits.
  GST/TDS specialists remain advisory until phase 5's legal verifier and CA
  approval path are working.
- Exit gate: stop/restart/resume works; the same task cannot accidentally run
  twice into a consequential action; Nexus answers from records and cites them.

### 5. Add verifier and legal-change intake

- Introduce source registry, candidate rules, effective-date impact analysis,
  deterministic checks, verifier feedback, up to three retries, and CA review.
- Show the CA old/new rule, official source, affected periods/clients,
  exceptions, and test cases before approval. Record the approval identity.
- Exit gate: stale, unsupported, contradictory, or inapplicable claims fail
  closed; an approved rule affects only its verified date and scope.

### 6. Add long-term memory and evaluation

- Store verified client profile facts and durable decisions separately from
  agent-generated hypotheses. Keep per-task checkpoints and immutable source
  references. Build time- and client-scoped retrieval rather than loading years
  of chat into a prompt.
- Evaluate with multi-month scenarios: missing acknowledgment, superseded law,
  missed deadline, repeated document, reassigned reviewer, and resumed task.
- Exit gate: Nexus can answer "what did we do last month, what's pending, and
  why?" after a restart, citing live records and admitting missing proof.

## Existing integration points

- `app/src/domain/followUps.ts` and migration `035_follow_up_queue.sql` are a
  basic open/completed queue; they do not yet model due dates or ownership.
- `app/src/domain/tdsCompliance.ts` and migration `026_tds_compliance.sql`
  already model some date-ranged deadlines and challan facts.
- `app/src/domain/firmCockpit.ts` has a limited GST deadline view; it explicitly
  does not model QRMP.
- `app/src/domain/assistant.ts` already uses read-only, tool-backed answers.
- `app/src/migrations/008_invoicing.sql` and `009_bills.sql` contain
  date-ranged GST and TDS rate masters. The new verifier should propose
  additions through a controlled review workflow, not mutate them directly.

## Open decisions before email delivery or rule activation

- Which verified sender domain/provider and recipient roles will send and
  receive alert email?
- Who is the authorized CA reviewer for each registration/client?
- Which official source feeds can be monitored reliably, and which changes
  must be entered manually with an official citation?
- What retention and access policy applies to agent run summaries and copies
  of source notifications?

These decisions do not block phases 0-2 or an in-app-only alert prototype.
