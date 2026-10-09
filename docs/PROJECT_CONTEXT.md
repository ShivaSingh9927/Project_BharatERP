# BharatERP project context

**Updated:** 2026-10-09

## Objective

Build an AI-assisted ERP and accounting workspace for Indian businesses and
their CAs. Owners and accountants should be able to collect source documents,
keep bank and book records in sync, prepare sales and purchase records, and
review tax and compliance work from one client-scoped system.

The agent's role is to make routine work easier to understand and prepare. It
must give useful reasons, evidence, and next steps while leaving accounting,
tax, and legal decisions to an authorized human.

## Product principles

1. **Human-confirmed outcomes.** AI classifies and recommends; people confirm
   before a consequential workflow continues. Posting, payment, filing, and
   reconciliation require their own explicit review actions.
2. **Traceable books.** A user should be able to see the source document,
   transaction, rule, and reviewer behind an accounting result.
3. **Correctable intake.** Email and uploads can contain irrelevant, wrong,
   duplicate, unreadable, encrypted, or malicious material. Keep uncertain
   items reviewable; do not force them into a ledger workflow.
4. **Tenant privacy.** Firms and clients are isolated. Share only the data
   needed for a clearly stated feature, and make external AI data flows visible.
5. **Indian accounting first.** Support Indian fiscal years, GST, TDS, banking
   practices, and Tally migration, while keeping legal/tax rules configurable
   and subject to CA validation.

## Product language

- The user-facing assistant and AI suggestion feature is named **Nexus**.
- Use plain explanations and label suggestions as suggestions.
- Say when evidence is incomplete; ask a specific question instead of inventing
  an answer.

## Repository reality

This repo began as an ERP blueprint. The numbered `01-...` to `10-...`
directories contain that planning and research material. The working product
is the TypeScript/PostgreSQL application in `app/`, with a Cloudflare Worker
and R2 email-intake pilot in `cloudflare/email-intake/`. Do not assume that the
old blueprint's proposed Next.js/Fastify/Python architecture is implemented.

For current implementation and unresolved checks, see
[`PROJECT_STATUS.md`](PROJECT_STATUS.md). For the code map, see
[`ARCHITECTURE.md`](ARCHITECTURE.md). For decisions that should not be
re-litigated casually, see [`DECISIONS.md`](DECISIONS.md).
