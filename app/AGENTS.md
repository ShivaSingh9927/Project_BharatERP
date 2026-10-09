# Application-specific agent instructions

The root [`../AGENTS.md`](../AGENTS.md) applies here. This file adds commands
and rules for the local application.

## Runtime and structure

- Node.js 22 or newer; TypeScript ESM.
- PostgreSQL is the system of record. `src/db/pool.ts` separates the schema
  owner pool from the restricted application pool and scopes app queries with
  `withFirm`.
- `src/domain/` contains business rules; `src/web/server.ts` routes HTTP;
  `src/web/views.ts` renders the server-side UI; `src/parse/` handles file
  parsing; `src/migrations/` is the ordered schema history; `test/` contains
  Vitest tests.
- `.env` and `app/.data/` contain local secrets or client records. Never read
  them wholesale, print their contents, commit them, or use real client files
  in a test that sends data externally without the user's clear instruction.

## Common commands

Run from `app/`:

```bash
npm run typecheck
npm test
npm test -- --run test/<focused-file>.test.ts
npm run db:up
npm run migrate
npm run seed
npm run web
```

Database-backed tests require the local PostgreSQL service and a working test
database configuration. Do not use `db:reset` unless the user explicitly asks
for a destructive reset; it drops the local schema.

## Financial and document workflows

- Suggestions from Nexus are proposals. Keep human class confirmation separate
  from AI classification; only confirmed classes may show the next workflow.
- Document classification is on by default with a firm-level opt-out. The UI
  must disclose that redacted text and filenames go to the configured AI
  service; redaction does not guarantee anonymity.
- Protected statement passwords and decrypted protected PDFs must stay in the
  local/account-scoped opening flow. Never send a password or decrypted
  protected PDF to an LLM.
- Email receipt, assignment, document registration, and classification must
  not silently post books or file returns.
- Preserve source originals and append-only review/audit history.
