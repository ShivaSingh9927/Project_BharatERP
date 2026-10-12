# Nexus chat workspace plan

**Status:** proposed implementation plan, 2026-10-10. This describes work to
build, not behavior already present. It complements
[`NEXUS_LONG_HORIZON_PLAN.md`](NEXUS_LONG_HORIZON_PLAN.md); the existing
obligation, follow-up, alert, and specialist-task records remain their own
sources of truth.

## Product outcome

A founder should be able to ask Nexus to investigate and prepare routine
finance work, see the result in a readable conversation, and make only the
decisions that require a person. A CA should be able to open the same case and
inspect the underlying records and detailed workspace.

The primary object is a **case**: a durable, client-scoped request with a
status, messages, evidence links, prepared results, decisions, and next action.
The conversation is its interface, not the accounting record. A case may be
started from a prompt, document, email, alert, or existing review item. It
must remain understandable after a restart or months of inactivity.

## Interaction contract

- **One composer:** type a request or attach files. Nexus identifies the
  client, intent, available records, and possible next step. It asks a short
  question when purpose or evidence is missing.
- **One case timeline:** show what Nexus checked, what it prepared, what needs
  a human, and what happened after a decision. Collapse internal specialist
  and verifier detail; make it inspectable when needed.
- **Typed response blocks:** concise paragraphs, metrics, tables, charts,
  document previews, progress, questions, and review cards. Each financial
  figure displays its period/as-of time, source, and coverage limitation.
  Charts and totals come from domain queries using exact money arithmetic.
- **Contextual evidence panel:** selecting a row, point, or proposed action
  opens its source record, original document where authorized, rationale,
  current state, and proposed effect. Mobile uses a drawer.
- **Decision boundary:** Nexus may read, compare, classify provisionally,
  draft, and follow up. Confirming document class, importing, posting,
  reconciliation, payment, filing, and rule changes use explicit authorized
  human actions in the existing domain workflows. A case never executes one
  of those actions merely because its model output says to.
- **Clear ownership:** show `Nexus working`, `Needs you`, `With CA`, `Blocked`,
  and `Done`, with one next action. `Unsure` is a valid response and keeps the
  item open. A completed Nexus investigation is not a completed filing or
  ledger action.

The founder's default surface is Nexus with a compact Today / In progress /
Waiting on you / Upcoming view. Detailed modules remain accessible to CA and
finance users, and both views refer to the same case and business records.

## Build sequence

### 0. Define the experience and contracts

**Build:** Draw responsive screens for the empty state, rich answer, active
case, uncertainty question, review card, and completed case. Specify the
versioned response-block contract and the case/action state machines before
building a renderer. Use four real product questions as design fixtures:
`How much money do we have?`, `Review my bank activity`, `Handle this invoice`,
and `What needs attention this month?`

**Rules:** Distinguish book balance, bank statement balance, and available
cash; do not label any of them simply `money we have` without explaining
coverage. Define which blocks can display sensitive details and which require
a user action to reveal them. Define provider disclosure for AI-bound data.

**Exit gate:** A founder and a CA can walk through the same bank case in the
prototype and identify the source, uncertainty, next action, and accounting
effect without opening another module. The block schema and authorization
matrix are reviewed before implementation.

### 1. Add durable cases and safe response blocks

**Build:** Add new numbered migrations for client-scoped cases, append-only
case events/messages, source links, block snapshots or references, and
decision/action references. Do not overload `assistant_runs` (today a separate
append-only question/answer log) or `nexus_specialist_tasks` (today bounded
specialist execution records). Link them to cases where useful. Include
idempotency keys, actor attribution, timestamps, server-generated IDs, and
firm/client RLS. Derive a current case projection from recorded events.

Render only a server-validated allowlist of block types and domain-generated
data. An LLM may request a block or supply prose; it cannot provide HTML,
SQL, chart totals, links to arbitrary records, or action endpoints. Store
record references and recheck access on every drill-down.

**Exit gate:** A case survives reload/restart; a second client cannot view or
act on it; repeated requests do not duplicate cases or events; untrusted
document text is rendered as data and cannot create a UI action.

### 2. Make Nexus the chat-first home, starting read-only

**Build:** Replace the current text-only answer stream and dense right rail
with a focused conversation, persistent composer with attachments, compact
case list, and contextual evidence panel. Bring the existing attention,
follow-up, document, and task states into the Today view without copying their
business logic. Provide accessible table navigation, chart text summaries,
loading/error states, and a usable narrow-screen layout.

Start with trusted read-only blocks: bank/book balance and freshness,
unmatched transaction table, received-document list, follow-up list, and
recorded obligation timeline. Show `unknown` or `unverified` explicitly. Use
existing domain read functions behind the assistant routes; the model may
explain the result but cannot invent a figure or a statutory date.

**Exit gate:** The four fixture questions return useful, sourced answers;
table rows and chart points open the right client-scoped evidence; keyboard
and mobile interactions work; the UI gives a specific reason when the data
cannot support an answer.

### 3. Complete one end-to-end case: bank review

**Prerequisite:** Audit every bank read and confirmation route for same-client
ownership and explicit reviewer-role checks. The current reconciliation page
accepts an account ID from the URL, and its existing mutation routes need a
documented role matrix before chat cards can use them. Keep confirmation
disabled until these checks and proposal freshness checks are in place.

The initial route policy is: `owner` and `ca_partner` may confirm/reconcile or
post bank accounting effects; `ca_staff` may import source statements and save
non-posting review states but cannot post; `auditor` may read scoped bank
records only; other roles are denied bank capabilities. Account setup and
firm-wide Nexus bank-classifier consent are limited to `owner` and
`ca_partner`. This policy is enforced at server routes and reflected in the
review UI; domain queries must still enforce firm/client ownership.

**Build:** From `Review my bank activity`, collect the selected account and
period, show matches and unresolved lines, and let Nexus ask one short
question per ambiguous transaction. Use current bank classification and
reconciliation rules to prepare a proposal. A review card shows the original
bank line, proposed classification or match, supporting records, exact
accounting effect, and what remains uncertain. The user may correct, defer,
or confirm. Reuse existing authorized domain actions; do not create a second
posting/reconciliation path in chat. Re-read source state before confirmation
and reject a stale proposal.

**Exit gate:** A synthetic UPI payment with no clear purpose stays unresolved
when the user chooses `Unsure`. A clearly explained proposal can be confirmed
through the existing workflow exactly once. The case records who decided,
what evidence was visible, and the resulting record ID. No model call alone
changes the books.

### 4. Add reliable background work and specialist coordination

**Build:** Give cases a task plan made of bounded steps with dependencies,
checkpoints, retry limits, timeout/cancellation, and one visible next action.
Connect the existing `nexus_specialist_tasks` runner to suitable cases rather
than exposing specialist selection as the primary founder interaction. Repair
interrupted-task recovery before advertising long-running work. Fetch current
facts by scoped record ID, not by replaying years of chat. Preserve separate
specialist, verifier, deterministic checks, and human review records. The
current verifier may share the configured model with the specialist; never
present its agreement as independent proof.

**Exit gate:** Stop/restart/resume and duplicate-run tests pass. A failed or
uncertain run leaves a clear case state and follow-up. Internal task chatter
does not overwhelm the user, but attempts and findings remain inspectable.

### 5. Expand the case pattern to documents and bills

**Build:** A file or email starts or joins a case. Present its suggested
document class for human confirmation, then use the confirmed class to offer
the relevant statement, bill, invoice, or other supported workflow. Show
extraction and accounting proposals alongside the original. Handle duplicate,
irrelevant, unreadable, wrong-client, and protected files as explicit case
outcomes. Keep statement passwords and decrypted protected PDFs in the
existing local opening flow and outside LLM inputs.

**Exit gate:** Synthetic fixtures for statement, purchase bill, sales invoice,
unrelated PDF, duplicate, and protected PDF all reach the appropriate review
or blocker state. No class suggestion silently imports or posts a record.

### 6. Add proactive cases, period memory, and role handoff

**Build:** Derive Today and Upcoming from recorded follow-ups, alerts,
obligation states, and verified schedules. Create a case when a real source
event merits investigation or human attention; deduplicate it across retries.
Show a compact daily/period brief and let a user ask `What changed since last
month?` or `What is waiting on my CA?`. Summaries retrieve scoped records and
case decisions, with source and as-of dates; conversation history is not the
sole memory. Founder and CA can hand off a case with assignment and a specific
question. Outbound email remains behind the existing opt-in, recipient
verification, and sender integration gates.

**Exit gate:** Multi-month fixtures survive restart, distinguish prepared from
filed/paid, reveal missing proof, and generate no duplicate case or alert. A
handoff retains the evidence and decision history for both authorized roles.

### 7. Evaluate before making Nexus the default entry point

**Build:** Run representative founder and CA tasks against the old and new
paths. Measure time and clicks to identify an issue, completion of the next
human action, unsupported-answer rate, evidence coverage, stale proposal
rejection, duplicate actions, and task resume success. Include keyboard and
mobile review. Audit logs and test cases must demonstrate zero unconfirmed
accounting actions and tenant isolation. Review sensitive-data flows and
statutory claims with the appropriate CA/security reviewers.

**Exit gate:** The bank and document journeys are demonstrably easier to
finish, all consequential actions retain their human gate, and failure states
remain understandable. Then make Nexus the founder default; preserve expert
workspaces and an easy way back to them.

## First delivery slice

Implement phases 0–3 as the first user-visible milestone. It should let a
founder ask Nexus to review one bank account and period, inspect a sourced
summary/table, answer an ambiguous UPI question, and approve or defer a
prepared item without losing the case. Do not wait for every specialist,
compliance flow, or outbound notification before testing this interaction.

## Existing code to reuse

- `app/src/web/views.ts` and `app/src/web/server.ts`: current Nexus UI,
  assistant, upload, task, and review routes.
- `app/src/domain/assistant.ts` and migration `031_assistant_runs.sql`:
  read-only book answers and audited question/answer history.
- `app/src/domain/nexusTasks.ts`, `nexusTaskRunner.ts`, and migrations
  `057`–`064`: bounded specialist task storage, scoping, and verifier loop.
- `app/src/domain/followUps.ts`, `alerts.ts`, and obligation timeline:
  current attention and long-term state.
- Existing banking, document, bill, and ledger domain actions: the only
  execution paths for a confirmed outcome.

Use a focused test for each user-visible behavior and new numbered migrations
for schema changes. Preserve existing working-tree changes and avoid a broad
frontend rewrite before the first bank case proves the interaction.
