/** Safe, read-only inspection of email attachments after durable import.
 * Nothing here imports bank transactions or promotes an arbitrary file to a
 * bank statement. A CA must still review and commit every statement.
 */
import { spawnSync } from 'node:child_process';
import { withFirm } from '../db/pool.ts';
import { readOriginal } from './documentWorkspace.ts';
import { autoOpenBankAccountIds, savedStatementPassword } from './bankStatementPassword.ts';
import { parseStatementBytes } from '../parse/statementFile.ts';
import { confirmStatementBankAccount } from './statement.ts';
import { isPdf } from '../parse/pdf.ts';

export type EmailAttachmentStatus = 'unreviewed' | 'other_file' | 'needs_password'
  | 'needs_review' | 'statement_ready';

/** Checking the encryption flag reveals no PDF content or password. */
function requiresPdfPassword(bytes: Buffer): boolean {
  const result = spawnSync('pdfinfo', ['-'], {
    input: bytes, encoding: 'utf8', maxBuffer: 128 * 1024, timeout: 5000,
  });
  return /incorrect password|encrypted:\s+yes/i.test(
    `${result.stderr ?? ''}\n${result.stdout ?? ''}`);
}

interface ReviewResult {
  status: EmailAttachmentStatus;
  note: string;
  bankAccountId?: string;
  rowCount?: number;
  periodFrom?: string | null;
  periodTo?: string | null;
}

async function inspectPdf(
  firmId: string, clientId: string, bytes: Buffer,
): Promise<ReviewResult> {
  const protectedPdf = requiresPdfPassword(bytes);
  const accounts = await autoOpenBankAccountIds(firmId, clientId);
  if (accounts.length === 0) return protectedPdf
    ? { status: 'needs_password', note: 'Protected PDF received; a CA must open it or enable account-scoped automatic opening.' }
    : { status: 'needs_review', note: 'PDF received; a CA must identify and review its contents.' };

  let opened = false;
  for (const accountId of accounts) {
    const password = await savedStatementPassword(firmId, clientId, accountId);
    if (!password) continue;
    try {
      const parsed = await parseStatementBytes(bytes, { password });
      opened = true;
      if (parsed.rows.length === 0) continue;
      await confirmStatementBankAccount(
        firmId, clientId, accountId, parsed.statementAccountNumber);
      return { status: 'statement_ready',
        note: 'Opened with consent and matched to this bank account; transaction review is still required.',
        bankAccountId: accountId, rowCount: parsed.rows.length,
        periodFrom: parsed.periodFrom, periodTo: parsed.periodTo };
    } catch {
      // A file may be unrelated, corrupt, use a changed password, or belong
      // to another account. Never guess its identity or post its rows.
    }
  }
  if (opened) return { status: 'needs_review',
    note: 'PDF opened but did not match a consented bank account or readable statement layout.' };
  return protectedPdf
    ? { status: 'needs_password', note: 'Saved account password did not open this PDF; a CA must review it.' }
    : { status: 'needs_review', note: 'PDF could not be verified as a statement for a consented bank account.' };
}

/** Idempotently inspect every attachment of an assigned email. */
export async function assessEmailAttachments(
  firmId: string, emailId: string,
): Promise<void> {
  const result = await withFirm(firmId, async (c) => c.query<{
    id: string; client_id: string; sha256: string; source_document_id: string;
  }>(`SELECT a.id, e.client_id, d.sha256, a.source_document_id
       FROM inbound_email_messages e
       JOIN inbound_email_attachments a ON a.email_id = e.id
       JOIN source_documents d ON d.id = a.source_document_id
       WHERE e.id = $1 AND e.firm_id = $2 AND e.status = 'assigned'
         AND a.firm_id = $2 AND d.firm_id = $2 AND d.client_id = e.client_id
         AND a.intake_status = 'unreviewed'
       ORDER BY a.id`, [emailId, firmId]));
  for (const row of result.rows) {
    let review: ReviewResult;
    try {
      const bytes = await readOriginal(firmId, row.client_id, row.sha256);
      review = isPdf(bytes)
        ? await inspectPdf(firmId, row.client_id, bytes)
        : { status: 'other_file', note: 'Non-PDF attachment received; keep for CA review.' };
    } catch {
      review = { status: 'needs_review',
        note: 'Attachment could not be inspected; the original remains available for CA review.' };
    }
    await withFirm(firmId, async (c) => c.query(
      `UPDATE inbound_email_attachments SET intake_status = $3,
         intake_note = $4, inspected_at = now(), bank_account_id = $5,
         statement_row_count = $6, statement_period_from = $7,
         statement_period_to = $8
       WHERE id = $1 AND firm_id = $2 AND intake_status = 'unreviewed'`,
      [row.id, firmId, review.status, review.note, review.bankAccountId ?? null,
        review.rowCount ?? null, review.periodFrom ?? null, review.periodTo ?? null]));
  }
}

/** Record a successful CA preview of an emailed statement without importing rows. */
export async function markReviewedEmailStatement(
  firmId: string, clientId: string, sourceDocumentId: string,
  bankAccountId: string, rowCount: number,
  periodFrom: string | null, periodTo: string | null,
): Promise<void> {
  if (!Number.isSafeInteger(rowCount) || rowCount < 1) return;
  await withFirm(firmId, async (c) => c.query(
    `UPDATE inbound_email_attachments a SET
       intake_status = 'statement_ready',
       intake_note = 'A CA previewed this file and verified its bank account; transaction review is still required.',
       inspected_at = now(), bank_account_id = $4,
       statement_row_count = $5, statement_period_from = $6,
       statement_period_to = $7
     FROM inbound_email_messages e, source_documents d
     WHERE a.email_id = e.id AND a.source_document_id = d.id
       AND a.source_document_id = $3 AND a.firm_id = $1
       AND e.firm_id = $1 AND e.client_id = $2 AND e.status = 'assigned'
       AND d.firm_id = $1 AND d.client_id = $2
       AND d.status <> 'dismissed'`,
    [firmId, clientId, sourceDocumentId, bankAccountId, rowCount,
      periodFrom, periodTo]));
}
