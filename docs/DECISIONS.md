# Decision log

Record durable product or architecture choices here. Add new dated entries;
do not silently rewrite history. This is a summary, not a substitute for the
relevant migration, test, or spec.

## 2026-10-09 — Nexus document classification is on by default

- Nexus may suggest a document class for new email attachments and uploads by
  default. A firm can turn the feature off.
- First-page text and filenames may be sent to the configured AI service after
  local redaction. Redaction is not a promise of anonymity, so the UI must
  disclose this data flow.
- A human must confirm or correct the class before the app offers the next
  workflow. The suggestion is never approval to import or post.
- Encrypted/protected PDFs are not decrypted for this classifier; no statement
  password is sent to the model.

## Ledger integrity

- Posted accounting records are append-only. Corrections use reversal or
  another explicit correction workflow.
- Reports derive balances from ledger entries; they are not an independently
  mutable source of truth.
- Application access uses a restricted database role and tenant-scoped
  queries/RLS.

## AI and operator control

- The in-product assistant is called Nexus, regardless of the configured
  model/provider.
- Recommendations must carry reasons/evidence where possible and stay
  reviewable. No AI action silently posts, pays, reconciles, or files.
