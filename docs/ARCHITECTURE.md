# Implemented architecture map

**Updated:** 2026-10-09

This describes the current repository implementation, not the original
architecture proposal in `05-architecture/SYSTEM-ARCHITECTURE.md`.

## Runtime

- `app/` is a TypeScript ESM application running on Node.js 22+.
- The local review app uses Node's HTTP server with server-rendered HTML.
- PostgreSQL stores firm/client data, accounting records, review history, and
  document metadata. App queries use `withFirm`; tenant isolation is reinforced
  with PostgreSQL row-level security.
- Original document bytes live in a managed local workspace under
  `app/.data/workspace/` by default. Cloudflare R2 is used by the email-intake
  pilot for private raw email storage before local import.
- AI clients and file readers are integrations around domain workflows; keep
  provider-specific behavior out of UI copy and accounting invariants.

## Main application paths

| Concern | Location |
|---|---|
| HTTP routes, sessions, role gates | `app/src/web/server.ts` |
| Server-rendered screens and browser actions | `app/src/web/views.ts` |
| Accounting and workflow rules | `app/src/domain/` |
| File parsers and extraction | `app/src/parse/` |
| PostgreSQL access and migrations | `app/src/db/`, `app/src/migrations/` |
| Automated tests | `app/test/` |
| Cloudflare email receiver and importer | `cloudflare/email-intake/` |
| Business/accounting specs | `specs/` |

## Document intake and classification

Email attachments and uploaded files are registered in the client document
inbox. Nexus can classify supported files after local extraction and
redaction. Classification is on by default, with a firm-level opt-out. AI
classification records and human class confirmations are separate histories.
The confirmed class may offer a link to a relevant workflow; confirmation does
not itself import, post, reconcile, pay, or file anything.

Protected bank statements use their separate local password-opening flow. Do
not route passwords or decrypted protected statement contents to the document
classifier.

## Change boundaries

- Add schema changes as new numbered migrations; applied history is immutable.
- Preserve separate source, AI suggestion, human review, and ledger records.
- Use the specific module spec where one exists; several specs remain drafts
  and need CA review for statutory details.
