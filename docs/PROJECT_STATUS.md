# Project status and handoff

**Snapshot date:** 2026-10-09
**Confidence:** working-tree snapshot; verify against code and the active local
database before relying on operational details.

## Current product shape

The repo contains a local TypeScript/PostgreSQL review application, accounting
and compliance modules, a document inbox, an email-intake pilot, and planning
specs. This is an actively changing product; the original blueprint's phase
labels are not an accurate implementation status.

Recent work has focused on bank statement ingestion/reconciliation, review-only
classification for bank and bill lines, Nexus document-class suggestions,
email attachment intake, and founder/CA review flows. Refer to route handlers,
domain code, migrations, and tests for exact behavior.

## Nexus obligation timeline storage

- Phase 1a storage is implemented in migrations
  `app/src/migrations/048_obligation_timeline.sql` and
  `app/src/migrations/049_obligation_event_ordering.sql`: stable client-scoped
  obligation identity, append-only workflow events, and separate outcome fact
  records with their own lifecycle events. Migration 049 binds request keys to
  identities and serializes per-obligation event ordering.
- The domain API can list a client's obligation history, record an observed
  obligation idempotently, and append a restricted workflow event. Without a
  verified profile/rule path, events cannot transition to `open` or `prepared`.
  The API does not generate statutory obligations or infer filing, payment,
  or acknowledgment.
- Migrations 048 and 049 were applied to the configured local database on
  2026-10-09. Focused tests cover tenant isolation, duplicate requests,
  serialized event history, and absence of inferred filing. Statutory rules
  and evidence sufficiency remain subject to CA review as described in the
  Nexus plan/spec.
- After phase 1a, Node 22 typecheck passed and the full local test suite
  passed: 59 test files, 942 tests. This storage is not yet exposed in the UI.

## Client attention page

- Added read-only `/attention` for the signed-in client's open follow-ups,
  unresolved or unverified obligation timeline items (`observed`, `open`,
  `blocked`, `needs_human_review`, `prepared`, `submitted_unverified`, and
  `paid_unverified`), and up to five recently completed follow-ups. Follow-ups
  link to their review desk item; obligation cards expand to a short list of
  recorded states and timestamps without exposing free-text evidence reasons.
- The page heading comes from the shared shell. Obligation statuses distinguish
  prepared work from filed or paid outcomes, and clearly label reported filing
  or payment as unverified.
- The page reports stored workflow states only. It does not infer deadlines,
  filing, or payment and has no completion or other write action. It performs
  no outbound email.
- Verification on Node 22.23.3: `npm run typecheck` passed and
  `npm test -- --run test/attentionView.test.ts` passed (1 test; no database
  access required).

## Follow-up routing slice (Phase 2)

- Migration `app/src/migrations/051_follow_up_routing.sql` adds optional
  assignee and due date fields plus a `low`/`normal`/`high` priority to
  client-scoped follow-ups. Assignees are limited to firm users who are
  firm-scoped or scoped to the selected client; browser-provided IDs are
  checked before insert.
- `/follow-ups` now collects these fields and displays them on open and
  completed items. `/attention` shows the same routing metadata and labels a
  past due date as overdue. Existing human completion remains the only
  completion path; no AI-driven completion or accounting action was added.
- Migration 051 was applied to the configured local database on 2026-10-09.
  Apply it in each other target database with `npm run migrate`.
- Node 22.23.3 `npm run typecheck` passed. Focused tests passed:
  `npm test -- --run test/followUps.test.ts test/obligationTimeline.test.ts`
  (2 files, 8 tests) and `npm test -- --run test/attentionView.test.ts`
  (1 file, 4 tests).

### Follow-up history and human actions (Phase 2 checkpoint, 2026-10-09)

- Migration `052_follow_up_activity_history.sql` adds an append-only,
  firm/client-scoped event history for follow-up creation, blocker recording,
  snoozing, and explicit user completion. Existing follow-up rows remain in
  place; their history starts with actions recorded after this migration.
- `/follow-ups` shows the current next action and event history. A signed-in
  user can record a blocker/reason, snooze an open item to a chosen date, or
  explicitly click Mark complete. These actions only update follow-up metadata;
  they do not mark an obligation or legal filing complete. Snooze dates do not
  cause automatic state transitions or notifications.
- Migration 052 is applied to the configured local database. Apply it in each
  other target database with `npm run migrate`.
- With Node 22.23.3,
  `npm run typecheck` passed and focused tests passed:
  `npm test -- --run test/followUps.test.ts test/attentionView.test.ts`
  (2 files, 8 tests). The initial sandboxed DB connection was denied; the same
  local migration and tests then ran with approved local DB access.

## Nexus in-app alert slice

- Phase 3a adds durable client-scoped alert events in
  `app/src/migrations/050_nexus_in_app_alerts.sql`. Events are firm-RLS
  protected, append-only, and deduplicated by their source transition.
- Notices are created transactionally for explicit follow-up creation and
  completion, and obligation transitions to `blocked` or
  `needs_human_review`. Copy and priority are deterministic; no statutory
  deadlines or AI-selected priorities are used. `/attention` shows recent
  up to ten recent notices, with the total count. A source link appears only
  when its target is present in the visible review list; stale or closed
  sources are labeled without a misleading link.
- This slice has no outbound email/provider, alert preferences, or read-state
  workflow. It does not post or file records. Migration 050 was applied to the
  configured local database on 2026-10-09; apply it in each other target DB.
- Node 22.23.3 `npm run typecheck` passed. Focused integration/UI tests passed:
  `npm test -- --run test/attentionView.test.ts test/obligationTimeline.test.ts`
  (2 files, 7 tests).

### Nexus alert email outbox (Phase 3b checkpoint, 2026-10-09)

- Migrations `053_nexus_alert_email_outbox.sql` and
  `054_nexus_alert_outbox_write_boundary.sql` add client-scoped preferences
  and a durable outbox, with firm RLS and composite client-scope constraints.
  New preferences default to email disabled and `pending_review`. The current
  schema has no
  proof of outgoing recipient mailbox ownership or authority; queue rows stay
  held until a reviewer records verification and a human opts in.
- Migration `055_nexus_alert_outbox_snapshot_boundary.sql` fixes alert-time
  recipient snapshots: recipients added later do not receive historical
  alerts, and an address cannot be edited on an existing preference. The
  reviewer flag records a human review, not mailbox ownership proof.
- Migration `056_nexus_alert_outbox_consent_boundary.sql` keeps pre-opt-in or
  pre-review alerts held permanently. Disabling a preference moves queued or
  retrying deliveries to `held_disabled`; later re-enabling does not revive
  them. Only alerts created while a preference is enabled and reviewed enter
  the queue.
- Alert inserts and preference changes idempotently materialize one outbox row
  per alert/recipient. Payloads contain only the alert's deterministic title
  and message; they do not copy documents, attachments, email bodies, or
  accounting records. Attempt count, retry timing, error code, and provider ID
  fields are ready for a later sender integration. No sender is implemented,
  and no email has been sent.
- This checkpoint has no preference UI, digest, or quiet-hour behavior. The
  sender choice is Cloudflare Email Service on the existing domain; outbound
  sending onboarding/configuration remains a required integration step and is
  separate from inbound routing. The recipient must also pass Cloudflare's
  verified-destination requirements before sending can be enabled. Migrations
  053–056 were applied to the configured local database; apply all four in
  each other target database.
- Node 22.23.3 typecheck passed. `npm test -- --run
  test/alertEmailOutbox.test.ts` passed (1 file, 3 tests), covering default
  holds, opt-in and reviewer gating, alert-time recipient snapshots,
  consent revocation and re-enable behavior, immutable recipient addresses,
  deduplication, tenant scoping, and denial of direct outbox writes by the
  application role.

### Nexus specialist task storage foundation (Phase 4 checkpoint, 2026-10-10)

- Migration 057 adds firm/client-scoped task records with server-generated IDs,
  a version-1 structured envelope, mutable status/checkpoint/advisory-result
  projection, and a fixed four-attempt budget. Attempts and task events are
  append-only, tenant protected, and linked with composite task/firm/client
  foreign keys. Unique task and attempt idempotency keys plus serialized task
  appends prevent duplicate records and ordinal races.
- The domain API supports task create/read/list and recording a structured
  attempt result. It validates specialist roles and supported source document,
  obligation, bank statement, and purchase bill references within the selected
  client. `permitted_reads` accepts only the fixed `source_document.read`,
  `bank_statement.read`, `obligation.read`, and `purchase_bill.read` capability
  names. Migration 058 adds append-only `status_changed` events in a database
  trigger, so direct application-role status updates are recorded in the same
  transaction. Results do not authorize accounting changes. There is no model
  call, worker, tool execution enforcement, verifier, or exhaustion follow-up.
- Migrations 057 and 058 are applied to the configured local database; apply
  both in each other target database with `npm run migrate`. Node 22.23.3
  `npm run typecheck` passed, and `npm test -- --run
  test/nexusTasks.test.ts` passed (1 file, 3 tests), covering tenant isolation,
  idempotency, safe capability names, same-client reference checks, immutable
  attempt/event history, database status auditing, concurrent ordinals, and
  the four-attempt limit.
- **Phase 4 transition guard (2026-10-10):** migration 059 adds a database
  trigger enforcing an explicit task status graph. The domain API exposes a
  compare-and-set status transition and attempt recording requires `running`
  for specialists or `verifying` for the verifier. Specialist outcomes move
  into review, blocked, or failed states; only the explicit coordinator
  transition can prepare a retry. Invalid status jumps fail even through a
  direct application-role update. Migration 059 is applied to the configured
  local database. Node 22.23.3 typecheck passed and the focused task tests
  passed (1 file, 3 tests), including rejected state jumps and serialization.
  Model execution, verifier decision records, read-tool enforcement, worker
  resume, and exhaustion follow-up remain unimplemented.
- **Phase 4 retry evidence links (2026-10-10):** migration 060 adds immutable
  `addressed_findings` to task attempts. Verifier findings are normalized to
  server-generated IDs and a specialist retry can reference only findings on
  the latest verifier attempt. The domain rejects stale/unknown links and
  specialists cannot author verifier findings. Migration 060 is applied to
  the configured local DB; Node 22.23.3 typecheck and focused integration tests
  passed (1 file, 4 tests). The verifier decision flow and automatic retry
  coordinator remain unimplemented.
- **Phase 4 read boundary (2026-10-10):** the task domain now validates each
  specialist's capability set and exposes a read-only fetch that requires the
  task's declared capability and exact client-scoped record reference. It
  returns limited document metadata, statement metadata, obligation state, or
  purchase-bill totals; it never returns original file paths, hashes, or bytes.
  Node 22.23.3 typecheck and focused task tests passed (1 file, 5 tests). The
  capability reader is not connected to a worker or model yet.
- **Phase 4 verifier decision gate (2026-10-10):** migration 061 stores an
  explicit verifier decision on verifier attempts. A verifier can accept only
  with no findings, send non-critical findings to a retry, or escalate to
  human review. The database refuses task completion without a persisted
  verifier acceptance. Legacy prototype verifier attempts retain a null
  decision; no historical acceptance is inferred. Migration 061 is applied to
  the local DB. Typecheck and focused tests passed (1 file, 6 tests); the full
  suite passed (63 files, 960 tests). The verifier decision API is not
  connected to a model or worker, and there is no human review UI.
- **Phase 4 escalation follow-up (2026-10-10):** migration 062 stores each
  task's initiating user and adds a unique client-scoped task link on
  follow-ups. A critical verifier decision or exhausted attempt creates one
  high-priority system-attributed review item and in-app alert in the same
  transaction as the task state change. Retries cannot duplicate it. Legacy
  prototype tasks without an initiating user are not backfilled. Migration
  062 is applied locally; typecheck passed and focused tests passed (3 files,
  15 tests). The full suite passed (63 files, 961 tests). Email delivery
  remains subject to its existing opt-in gates.
- **Phase 4 retry-budget correction (2026-10-10):** migration 063 keeps the
  four-run budget on specialist calls while verifier attempts use separate
  bounded records. Database triggers serialize attempt ordinals, enforce each
  role's cap, and keep `current_attempt` as the specialist retry count. An
  integration scenario exercised three verifier-directed retries and escalated
  the fourth unsuccessful specialist run. Migration 063 is applied locally;
  typecheck and focused task tests passed (1 file, 8 tests).
- **Phase 4 runner foundation (2026-10-10):** migration 064 adds separate
  attributed firm consent for Nexus specialist tasks, default off. The domain
  runner reads only declared scoped records, invokes a specialist and verifier,
  validates structured output and source quotes, stores attempts, and routes
  retries or escalations. Concurrent duplicate invocations cannot join an
  already running task. Migration 064 is applied locally; typecheck and focused
  Nexus tests passed (2 files, 10 tests). The runner is not yet connected to a
  route or UI, and interrupted `running` tasks need a safe resume policy.

## Recently changed document workflow

- Document class suggestions are on by default; firms may explicitly turn
  them off. Migration: `app/src/migrations/047_document_classification_default_on.sql`.
- Human confirmation is stored separately from AI suggestions. Migration:
  `app/src/migrations/046_document_class_review.sql`.
- Email assignments and uploads can request a suggestion. A human confirmation
  is required before a class-specific workflow link is shown.
- The migration was applied to the local database during the 2026-10-09 work
  session. Do not assume another environment has it; run `npm run migrate`.
- The app's AI suggestion quality has only had limited fixture/smoke testing.
  Do not describe accuracy as established. Test with labeled examples and
  correct classifications before relying on it operationally.

## Verification from the latest implementation session

- `npm run typecheck` passed.
- Before the GitHub push on 2026-10-09, the complete local suite passed:
  58 test files and 937 tests, using the configured local test database.
  The Cloudflare email Worker test also passed.
- Focused document/UI tests passed: 17 tests.
- Email intake integration tests passed: 6 tests, including default-on,
  explicit opt-out, tenant-scoped human confirmation, and append-only review.
- The local web app was restarted at `http://127.0.0.1:4321`.

## Operational checks still needed

- Confirm that intended bank statement, purchase bill, sales invoice, and
  other document examples receive sensible suggestions; correct every result
  in the UI and record false positives/uncertain cases.
- Verify the email recipient-to-client mapping in the live pilot. The last
  local importer run reported an unrecognized recipient and held that message
  for review; it did not import it.
- Confirm any credentials previously exposed in local tool output have been
  rotated and replaced in the local environment. Never put secret values in
  this file or logs.
- Review statutory and tax behavior with a qualified CA; draft specs are not
  legal validation.

## Handoff convention

At the end of significant work, update this file with the date, what changed,
the tests actually run, migrations applied (and where), and unresolved risks.
Keep this factual and short so it remains useful to the next session.
