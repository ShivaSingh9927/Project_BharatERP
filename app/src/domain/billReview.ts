/**
 * Wiring the bill-ingestion pipeline to a review screen.
 * Spec: bills-and-expenses.md §4.10
 *
 * The engine already turns a PDF into proposals and posts an approved one. The
 * screen needs two things on top: a default expense account to propose against,
 * and — the part that matters — a GUARANTEE that the proposal a reviewer
 * approves is the same proposal they saw.
 *
 * That guarantee is why preview and post both go through `assembleInput` here.
 * A proposal is deterministic in its inputs, so the same file and the same
 * reader configuration reproduce the same document number, the same figures,
 * and — critically — the same confirmations. If preview used one config and
 * post another, a reviewer could answer a question the post no longer asks, or
 * post past one it now does. Held identical, re-running the proposal at post
 * time needs no proposal to be stored, only the file.
 */

import { withFirm } from '../db/pool.ts';
import { proposeBills, postProposal, type ProposeInput, type BillProposal }
  from './billProposal.ts';
import type { CreatedBill } from './bills.ts';
import { llmClientFromEnv } from '../parse/llmTable.ts';
import { doclingClientFromEnv } from '../parse/doclingTable.ts';
import { parserClientFromEnv } from '../parse/candidateTables.ts';
import { sandboxLookupFromEnv } from '../integrations/sandboxGst.ts';

/** The readers a firm has switched on, resolved once at boot. */
export interface ReviewReaders {
  llm: ProposeInput['llm'];
  docling: ProposeInput['docling'];
  parser: ProposeInput['parser'];
  gstinLookup: ProposeInput['gstinLookup'];
}

/**
 * Resolves the optional readers from the environment.
 *
 * Each is independent and each is absent by default: no model key, no Docling
 * sidecar, no GST lookup means the deterministic path runs alone, which is the
 * safe floor. The model still also needs the firm's own consent, checked deeper
 * in `proposeBills` — a key here is capability, not permission.
 */
export async function resolveReaders(): Promise<ReviewReaders> {
  return {
    llm: llmClientFromEnv() ?? undefined,
    docling: (await doclingClientFromEnv()) ?? undefined,
    parser: (await parserClientFromEnv()) ?? undefined,
    gstinLookup: sandboxLookupFromEnv() ?? undefined,
  };
}

/** An expense account a bill's lines can post to. */
export interface ExpenseAccount { id: string; name: string; itc: string | null; }

/**
 * The expense accounts a reviewer can post a bill to.
 *
 * Every non-group account on the expense side — Purchases, Office Rent,
 * Professional Fees, and the rest — so the reviewer classifies the spend
 * rather than dropping everything into one heap. The account carries its own
 * ITC treatment, so choosing "Travel Expenses" (blocked) or "Insurance"
 * (conditional) sets how the credit is handled without a separate decision.
 */
export async function expenseAccounts(
  firmId: string, clientId: string,
): Promise<ExpenseAccount[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ id: string; name: string; itc: string | null }>(
      `SELECT id, name, itc_eligibility AS itc FROM accounts
        WHERE client_id = $1 AND root_type = 'expense' AND NOT is_group
        ORDER BY name`, [clientId]);
    return r.rows;
  });
}

/**
 * A line's description reduced to a stable key.
 *
 * Lower-cased, alphanumerics only — so "Protect Promise Fee" and "Protect
 * Promise Fee" are one memory, while "iPhone 128GB" and "iPhone 256GB" stay
 * apart. Capped so a paragraph-long product description cannot become a
 * pathological key; it simply will not match, which is the safe direction.
 */
export function lineKey(description: string): string {
  return description.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 120);
}

/** The accounts a client has habitually posted THIS supplier's lines to. */
export async function learnedDefaultsFor(
  firmId: string, clientId: string, partyId: string,
): Promise<Map<string, string>> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ line_key: string; account_id: string }>(
      `SELECT line_key, account_id FROM line_account_defaults
        WHERE client_id = $1 AND party_id = $2`, [clientId, partyId]);
    return new Map(r.rows.map((x) => [x.line_key, x.account_id]));
  });
}

/**
 * Remembers where a reviewer posted each line, so the next bill from this
 * supplier arrives pre-classified.
 *
 * The latest choice wins: a reviewer who re-files a line re-teaches it. Skipped
 * when the supplier is unmatched — a memory needs a party to hang on.
 */
export async function recordLineDefaults(
  firmId: string, clientId: string, partyId: string,
  lines: Array<{ description: string; expenseAccountId: string }>,
): Promise<void> {
  await withFirm(firmId, async (c) => {
    for (const l of lines) {
      const key = lineKey(l.description);
      if (key === '') continue;
      await c.query(
        `INSERT INTO line_account_defaults
           (firm_id, client_id, party_id, line_key, account_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (client_id, party_id, line_key) DO UPDATE
           SET account_id = EXCLUDED.account_id,
               times_seen = line_account_defaults.times_seen + 1,
               updated_at = now()`,
        [firmId, clientId, partyId, key, l.expenseAccountId]);
    }
  });
}

/** The client's Purchases account — where a reviewed bill's lines post by
 *  default. A reviewer can still split a bill elsewhere; this is the floor. */
export async function purchasesAccount(
  firmId: string, clientId: string,
): Promise<string | null> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM accounts
        WHERE client_id = $1 AND name = 'Purchases' AND NOT is_group
        ORDER BY created_at LIMIT 1`, [clientId]);
    return r.rows[0]?.id ?? null;
  });
}

function assembleInput(
  clientId: string, expenseAccountId: string, createdBy: string,
  file: Buffer, readers: ReviewReaders,
): ProposeInput {
  return {
    clientId, expenseAccountId, createdBy, file,
    llm: readers.llm, docling: readers.docling, parser: readers.parser,
    gstinLookup: readers.gstinLookup,
    sourceUri: 'review-upload',
  };
}

/** Proposes bills from an uploaded file, for display. Stores nothing. */
export async function previewBills(
  firmId: string, clientId: string, expenseAccountId: string,
  createdBy: string, file: Buffer, readers: ReviewReaders,
): Promise<BillProposal[]> {
  return proposeBills(firmId,
    assembleInput(clientId, expenseAccountId, createdBy, file, readers));
}

/**
 * Posts one document from a file the reviewer approved.
 *
 * The file is proposed AGAIN — deterministically, so the proposal at index `i`
 * is the one the reviewer saw — and that one is posted on the reviewer's own
 * authority (AT-13). The confirmations they answered travel through; a proposal
 * that has become blocked, or whose questions are unanswered, is refused by
 * `postProposal` rather than posted on stale approval.
 */
export async function postReviewedBill(
  firmId: string, clientId: string, defaultAccountId: string,
  file: Buffer, index: number, confirm: Record<string, string>,
  approvedBy: string, readers: ReviewReaders,
  overrides: {
    expenseAccountId?: string; lineAccounts?: Array<string | null>;
    blockItc?: boolean;
  } = {},
): Promise<CreatedBill> {
  // Proposed with the default account — the account changes no figure and no
  // confirmation, so this reproduces exactly the proposal the reviewer saw.
  const proposals = await proposeBills(firmId,
    assembleInput(clientId, defaultAccountId, approvedBy, file, readers));
  const proposal = proposals.find((p) => p.index === index);
  if (proposal === undefined || proposal.input === null) {
    throw new Error(`document ${index} is no longer ready to post`);
  }

  // The reviewer's classification: post every line to the account they chose,
  // and honour their decision to withhold credit. Applied to the freshly
  // re-run proposal, never to a stored one.
  // Per line first — each line to the head the reviewer chose for it — then a
  // whole-bill account as the fallback for any line left unset. The re-run is
  // deterministic, so lineAccounts[i] lines up with the line the reviewer saw.
  proposal.input.lines.forEach((line, i) => {
    const perLine = overrides.lineAccounts?.[i];
    if (perLine) line.expenseAccountId = perLine;
    else if (overrides.expenseAccountId) line.expenseAccountId = overrides.expenseAccountId;
  });
  if (overrides.blockItc) proposal.input.forceBlockItc = true;

  const bill = await postProposal(firmId, proposal, {
    approvedBy, confirm, sourceUri: 'review-upload',
  });

  // Learn from what was just approved — but only what a human actually decided.
  // A failed post never reaches here, so nothing is learned from a bill that
  // did not stand.
  if (proposal.partyId !== null) {
    await recordLineDefaults(firmId, clientId, proposal.partyId,
      proposal.input.lines.map((l) => ({
        description: l.description, expenseAccountId: l.expenseAccountId,
      })));
  }
  return bill;
}

/** The view model for one proposal — everything the screen shows, serialisable. */
export interface ProposalView {
  index: number;
  status: 'ready' | 'needs_answer' | 'blocked';
  documentNumber: string | null;
  partyName: string | null;
  supplierGstin: string | null;
  billDate: string | null;
  readBy: BillProposal['readBy'];
  taxable: string | null;
  tax: string | null;
  total: string | null;
  registrationStatus: string | null;
  /** One entry per posting line, so the reviewer can classify each. Empty on a
   *  blocked proposal, which has no lines to post. */
  partyId: string | null;
  lines: Array<{
    description: string; amount: string; hsn: string | null;
    /** A learned default, when this supplier's line has been classified before.
     *  Set by the review layer, not the pure proposal. */
    suggestedAccountId?: string;
  }>;
  warnings: string[];
  blockers: string[];
  confirmations: BillProposal['confirmations'];
}

/** Reduces a proposal to what the screen needs. */
export function proposalView(p: BillProposal): ProposalView {
  const status: ProposalView['status'] =
    p.blockers.length > 0 ? 'blocked'
    : p.confirmations.length > 0 ? 'needs_answer'
    : 'ready';
  const tax = p.table.readable
    ? String(
        (Number(p.table.sums.cgst ?? '0') + Number(p.table.sums.sgst ?? '0')
         + Number(p.table.sums.igst ?? '0')).toFixed(2))
    : null;
  return {
    index: p.index, status,
    documentNumber: p.documentNumber, partyName: p.partyName,
    supplierGstin: p.supplierGstin, billDate: p.billDate ?? null, readBy: p.readBy,
    taxable: p.table.sums.taxable ?? null,
    tax,
    total: p.table.sums.total ?? null,
    registrationStatus: p.registration?.status ?? null,
    partyId: p.partyId,
    lines: (p.input?.lines ?? []).map((l) => ({
      description: l.description, amount: l.unitPrice, hsn: l.hsnSac ?? null,
    })),
    warnings: p.warnings, blockers: p.blockers, confirmations: p.confirmations,
  };
}
