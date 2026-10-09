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
