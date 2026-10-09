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
