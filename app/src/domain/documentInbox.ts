/** Client-scoped original document registry. Accounting plugins consume IDs,
 * never caller-supplied filesystem paths. */
import { withFirm } from '../db/pool.ts';
import { documentUri, readOriginal, storeOriginal } from './documentWorkspace.ts';

export interface InboxDocument {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  hash: string;
  status: string;
  channel?: string;
  sender?: string | null;
  receivedAt: string;
  linkedVoucherId: string | null;
  available: boolean;
  reviewNote: string | null;
  reviewUpdatedAt: string | null;
  classSuggestion?: null | { documentClass: string; subtype: string | null; confidence: number;
    rationale: string; evidence: string[]; provider: string; model: string };
  classConfirmation?: null | { documentClass: string; confirmedAt: string };
}

export interface DocumentInformationRequest {
  id: string;
  documentId: string;
  question: string;
  requestedAt: string;
}

export interface DocumentRequestAnswer extends DocumentInformationRequest {
  answer: string | null;
  attachmentIds: string[];
  answeredAt: string | null;
  status: string;
}

export async function listDocumentRequestHistory(
  firmId: string, clientId: string,
): Promise<DocumentRequestAnswer[]> {
  return withFirm(firmId, async (c) => {
    const result = await c.query(
      `SELECT id, document_id, question, requested_at, status, answer,
              attachment_ids, answered_at
       FROM document_information_requests
       WHERE firm_id = $1 AND client_id = $2
       ORDER BY requested_at DESC LIMIT 100`, [firmId, clientId]);
    return result.rows.map((row) => ({
      id: row.id, documentId: row.document_id, question: row.question,
      requestedAt: new Date(row.requested_at).toISOString(), status: row.status,
      answer: row.answer, attachmentIds: row.attachment_ids,
      answeredAt: row.answered_at ? new Date(row.answered_at).toISOString() : null,
    }));
  });
}

export async function listOpenDocumentRequests(
  firmId: string, clientId: string,
): Promise<DocumentInformationRequest[]> {
  return withFirm(firmId, async (c) => {
    const result = await c.query(
      `SELECT r.id, r.document_id, r.question, r.requested_at
       FROM document_information_requests r
       JOIN source_documents d ON d.id = r.document_id
       WHERE r.client_id = $1 AND r.firm_id = $2 AND r.status = 'open'
         AND d.client_id = $1 AND d.status = 'needs_information'
       ORDER BY r.requested_at DESC`, [clientId, firmId]);
    return result.rows.map((row) => ({
      id: row.id, documentId: row.document_id, question: row.question,
      requestedAt: new Date(row.requested_at).toISOString(),
    }));
  });
}

export async function answerDocumentRequest(
  firmId: string, clientId: string, requestId: string, answeredBy: string,
  answerInput: unknown, attachmentIdsInput: unknown,
): Promise<boolean> {
  const answer = typeof answerInput === 'string' ? answerInput.trim() : '';
  const attachmentIds = Array.isArray(attachmentIdsInput) ? attachmentIdsInput : [];
  if (answer.length > 2000 || (!answer && attachmentIds.length === 0)) {
    throw new Error('write an answer or attach a file (answer limit: 2,000 characters)');
  }
  if (attachmentIds.length > 5 || attachmentIds.some((id) => typeof id !== 'string'
    || !/^[0-9a-f-]{36}$/i.test(id)) || new Set(attachmentIds).size !== attachmentIds.length) {
    throw new Error('attach up to five distinct documents');
  }
  return withFirm(firmId, async (c) => {
    const actor = await c.query(
      `SELECT 1 FROM users WHERE id = $1 AND firm_id = $2 AND role = 'owner'
         AND (client_id IS NULL OR client_id = $3)`, [answeredBy, firmId, clientId]);
    if (actor.rowCount !== 1) throw new Error('only the founder can answer this request');
    const request = await c.query(
      `SELECT r.document_id FROM document_information_requests r
       JOIN source_documents d ON d.id = r.document_id
       WHERE r.id = $1 AND r.firm_id = $2 AND r.client_id = $3
         AND r.status = 'open' AND d.client_id = $3 AND d.status = 'needs_information'
       FOR UPDATE OF r, d`, [requestId, firmId, clientId]);
    if (request.rowCount !== 1) return false;
    if (attachmentIds.length) {
      const attachments = await c.query(
        `SELECT id FROM source_documents
         WHERE firm_id = $1 AND client_id = $2 AND id = ANY($3::uuid[])`,
        [firmId, clientId, attachmentIds]);
      if (attachments.rowCount !== attachmentIds.length) {
        throw new Error('an attached document does not belong to this client');
      }
    }
    await c.query(
      `UPDATE document_information_requests
       SET status = 'answered', answer = $2, attachment_ids = $3::uuid[],
           answered_by = $4, answered_at = now()
       WHERE id = $1`, [requestId, answer, attachmentIds, answeredBy]);
    await c.query(
      `UPDATE source_documents
       SET status = 'in_review', review_note = NULL,
           review_updated_at = now(), review_updated_by = $2
       WHERE id = $1`, [request.rows[0].document_id, answeredBy]);
    return true;
  });
}

const cleanName = (name: string): string => {
  const leaf = name.split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f]/g, '').trim() ?? '';
  return leaf.slice(0, 180) || 'document';
};

const rowView = (r: {
  id: string; original_name: string | null; mime_type: string | null;
  file_size: string | number | null; sha256: string; status: string;
  received_at: Date | string; linked_voucher_id: string | null;
  original_blob_uri: string;
  review_note: string | null; review_updated_at: Date | string | null;
  class_document_class?: string | null; class_subtype?: string | null;
  class_confidence?: number | null; class_rationale?: string | null;
  class_evidence?: string[] | null; class_provider?: string | null; class_model?: string | null;
  confirmed_document_class?: string | null; class_confirmed_at?: Date | string | null;
  channel?: string; sender?: string | null;
}, firmId: string, clientId: string): InboxDocument => ({
  id: r.id, originalName: r.original_name ?? 'document',
  mimeType: r.mime_type ?? 'application/octet-stream',
  size: Number(r.file_size ?? 0), hash: r.sha256, status: r.status,
  channel: r.channel ?? 'upload', sender: r.sender ?? null,
  receivedAt: new Date(r.received_at).toISOString(),
  linkedVoucherId: r.linked_voucher_id,
  available: r.original_blob_uri === documentUri(firmId, clientId, r.sha256),
  reviewNote: r.review_note,
  reviewUpdatedAt: r.review_updated_at === null ? null
    : new Date(r.review_updated_at).toISOString(),
  classSuggestion: r.class_document_class ? {
    documentClass: r.class_document_class, subtype: r.class_subtype ?? null,
    confidence: Number(r.class_confidence ?? 0), rationale: r.class_rationale ?? '',
    evidence: r.class_evidence ?? [], provider: r.class_provider ?? '', model: r.class_model ?? '',
  } : null,
  classConfirmation: r.confirmed_document_class ? {
    documentClass: r.confirmed_document_class,
    confirmedAt: new Date(r.class_confirmed_at!).toISOString(),
  } : null,
});

const DOCUMENT_CLASSES = ['bank_statement','purchase_bill','sales_invoice','expense_receipt',
  'tds_document','gst_document','payroll','contract_legal','other','uncertain'] as const;

/** Append an explicit human decision; AI suggestions are never treated as approval. */
export async function confirmDocumentClass(
  firmId: string, clientId: string, documentId: string, confirmedBy: string,
  classInput: unknown,
): Promise<boolean> {
  if (typeof classInput !== 'string' || !DOCUMENT_CLASSES.includes(classInput as typeof DOCUMENT_CLASSES[number])) {
    throw new Error('choose a valid document class');
  }
  return withFirm(firmId, async (c) => {
    const actor = await c.query(
      `SELECT 1 FROM users WHERE id = $1 AND firm_id = $2
         AND (client_id IS NULL OR client_id = $3)
         AND role IN ('owner','ca_partner','ca_staff')`, [confirmedBy, firmId, clientId]);
    if (actor.rowCount !== 1) throw new Error('authorized reviewer access required');
    const doc = await c.query(
      `SELECT 1 FROM source_documents WHERE id = $1 AND firm_id = $2 AND client_id = $3`,
      [documentId, firmId, clientId]);
    if (doc.rowCount !== 1) return false;
    await c.query(
      `INSERT INTO document_class_reviews
         (firm_id, client_id, source_document_id, document_class, confirmed_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [firmId, clientId, documentId, classInput, confirmedBy]);
    return true;
  });
}

export async function receiveDocument(
  firmId: string, input: {
    clientId: string; uploadedBy: string; name: string; bytes: Buffer;
    mimeType?: string;
  },
): Promise<{ document: InboxDocument; duplicate: boolean }> {
  // Check ownership before writing a byte into a tenant's workspace. The
  // session supplies these IDs, but domain tools must defend their own edge.
  await withFirm(firmId, async (c) => {
    const result = await c.query(
      `SELECT 1 FROM clients cl JOIN users u ON u.firm_id = cl.firm_id
       WHERE cl.id = $1 AND cl.firm_id = $2 AND u.id = $3
         AND (u.client_id IS NULL OR u.client_id = cl.id)`,
      [input.clientId, firmId, input.uploadedBy]);
    if (result.rowCount !== 1) throw new Error('client or uploader is not authorized');
  });

  const stored = await storeOriginal(firmId, input.clientId, input.bytes);
  const name = cleanName(input.name);
  const mimeType = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(input.mimeType ?? '')
    ? input.mimeType! : 'application/octet-stream';
  const result = await withFirm(firmId, async (c) => {
    const inserted = await c.query(
      `INSERT INTO source_documents
       (firm_id, client_id, channel, original_blob_uri, original_name,
        mime_type, file_size, sha256, status, sender)
       VALUES ($1,$2,'upload',$3,$4,$5,$6,$7,'received',$8)
       ON CONFLICT (client_id, sha256) DO NOTHING
      RETURNING id, original_name, mime_type, file_size, sha256, status,
                 received_at, linked_voucher_id, original_blob_uri,
                 review_note, review_updated_at`,
      [firmId, input.clientId, stored.uri, name, mimeType,
       input.bytes.length, stored.hash, input.uploadedBy]);
    if (inserted.rows[0]) return { row: inserted.rows[0], duplicate: false };
    // A bill may have registered the same hash earlier with the review
    // prototype's placeholder URI. Receiving the real original repairs that
    // pointer without changing its posted status or linked voucher.
    const existing = await c.query(
      `UPDATE source_documents
       SET original_blob_uri = $3,
           original_name = COALESCE(original_name, $4),
           file_size = COALESCE(file_size, $5)
       WHERE client_id = $1 AND sha256 = $2
       RETURNING id, original_name, mime_type, file_size, sha256, status,
                 received_at, linked_voucher_id, original_blob_uri,
                 review_note, review_updated_at`,
      [input.clientId, stored.hash, stored.uri, name, input.bytes.length]);
    return { row: existing.rows[0], duplicate: true };
  });
  return { document: rowView(result.row, firmId, input.clientId), duplicate: result.duplicate };
}

/** Moves an assigned email attachment into the same original-file registry as uploads. */
export async function receiveInboundEmailDocument(
  firmId: string, input: {
    clientId: string; sender: string; name: string; bytes: Buffer; mimeType?: string;
  },
): Promise<InboxDocument> {
  await withFirm(firmId, async (c) => {
    const client = await c.query('SELECT 1 FROM clients WHERE id = $1 AND firm_id = $2',
      [input.clientId, firmId]);
    if (client.rowCount !== 1) throw new Error('client is not in this firm');
  });
  const stored = await storeOriginal(firmId, input.clientId, input.bytes);
  const name = cleanName(input.name);
  const mimeType = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(input.mimeType ?? '')
    ? input.mimeType! : 'application/octet-stream';
  const row = await withFirm(firmId, async (c) => {
    const inserted = await c.query(
      `INSERT INTO source_documents
       (firm_id, client_id, channel, original_blob_uri, original_name,
        mime_type, file_size, sha256, status, sender)
       VALUES ($1,$2,'email',$3,$4,$5,$6,$7,'received',$8)
       ON CONFLICT (client_id, sha256) DO NOTHING
       RETURNING id, original_name, mime_type, file_size, sha256, status,
                 received_at, linked_voucher_id, original_blob_uri,
                 review_note, review_updated_at`,
      [firmId, input.clientId, stored.uri, name, mimeType,
        input.bytes.length, stored.hash, input.sender]);
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await c.query(
      `UPDATE source_documents
       SET original_blob_uri = $3,
           original_name = COALESCE(original_name, $4),
           file_size = COALESCE(file_size, $5)
       WHERE client_id = $1 AND sha256 = $2
       RETURNING id, original_name, mime_type, file_size, sha256, status,
                 received_at, linked_voucher_id, original_blob_uri,
                 review_note, review_updated_at`,
      [input.clientId, stored.hash, stored.uri, name, input.bytes.length]);
    return existing.rows[0];
  });
  return rowView(row, firmId, input.clientId);
}

export async function listDocuments(
  firmId: string, clientId: string, limit = 100,
): Promise<InboxDocument[]> {
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
  return withFirm(firmId, async (c) => {
    const r = await c.query(
      `SELECT d.id, d.original_name, d.mime_type, d.file_size, d.sha256, d.status,
              d.channel, d.sender,
              d.received_at, d.linked_voucher_id, d.original_blob_uri,
              d.review_note, d.review_updated_at,
              cls.document_class AS class_document_class, cls.subtype AS class_subtype,
              cls.confidence AS class_confidence, cls.rationale AS class_rationale,
              cls.evidence AS class_evidence, cls.provider AS class_provider,
              cls.model AS class_model,
              review.document_class AS confirmed_document_class,
              review.confirmed_at AS class_confirmed_at
       FROM source_documents d
       LEFT JOIN LATERAL (
         SELECT document_class, subtype, confidence, rationale, evidence, provider, model
           FROM document_ai_classifications
          WHERE source_document_id = d.id ORDER BY created_at DESC LIMIT 1
       ) cls ON true
       LEFT JOIN LATERAL (
         SELECT document_class, confirmed_at FROM document_class_reviews
          WHERE source_document_id = d.id ORDER BY confirmed_at DESC LIMIT 1
       ) review ON true
       WHERE d.client_id = $1
       ORDER BY d.received_at DESC, d.id DESC LIMIT $2`, [clientId, bounded]);
    return r.rows.map((row) => rowView(row, firmId, clientId));
  });
}

export async function getDocumentBytes(
  firmId: string, clientId: string, documentId: string,
): Promise<{ document: InboxDocument; bytes: Buffer }> {
  const document = await withFirm(firmId, async (c) => {
    const r = await c.query(
      `SELECT id, original_name, mime_type, file_size, sha256, status,
              received_at, linked_voucher_id, original_blob_uri,
              review_note, review_updated_at
       FROM source_documents WHERE id = $1 AND client_id = $2`,
      [documentId, clientId]);
    return r.rows[0];
  });
  if (!document) throw new Error('document not found');
  if (document.original_blob_uri !== documentUri(firmId, clientId, document.sha256)) {
    throw new Error('original file is not in the managed workspace');
  }
  return { document: rowView(document, firmId, clientId),
    bytes: await readOriginal(firmId, clientId, document.sha256) };
}

export async function markDocumentInReview(
  firmId: string, clientId: string, documentId: string, reviewedBy: string,
): Promise<boolean> {
  return withFirm(firmId, async (c) => {
    const updated = await c.query(
      `UPDATE source_documents
          SET status = 'in_review', review_note = NULL,
              review_updated_at = now(), review_updated_by = $4
        WHERE id = $1 AND client_id = $2 AND firm_id = $3
          AND status IN ('received', 'needs_information', 'in_review', 'dismissed')`,
      [documentId, clientId, firmId, reviewedBy]);
    if (updated.rowCount === 1) {
      await c.query(
        `UPDATE document_information_requests SET status = 'superseded'
         WHERE document_id = $1 AND client_id = $2 AND status = 'open'`,
        [documentId, clientId]);
    }
    return updated.rowCount === 1;
  });
}

/** Preserve the original and audit trail while removing irrelevant mail from the work queue. */
export async function dismissDocument(
  firmId: string, clientId: string, documentId: string,
  reviewedBy: string, reasonInput: unknown,
): Promise<boolean> {
  const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
  if (!reason || reason.length > 1000) {
    throw new Error('write why this file is irrelevant or incorrect (up to 1,000 characters)');
  }
  return withFirm(firmId, async (c) => {
    const updated = await c.query(
      `UPDATE source_documents
          SET status = 'dismissed', review_note = $4,
              review_updated_at = now(), review_updated_by = $5
        WHERE id = $1 AND client_id = $2 AND firm_id = $3
          AND status IN ('received', 'in_review', 'needs_information')
          AND linked_voucher_id IS NULL`,
      [documentId, clientId, firmId, reason, reviewedBy]);
    if (updated.rowCount === 1) {
      await c.query(
        `UPDATE document_information_requests SET status = 'superseded'
         WHERE document_id = $1 AND client_id = $2 AND status = 'open'`,
        [documentId, clientId]);
    }
    return updated.rowCount === 1;
  });
}

export async function requestDocumentInformation(
  firmId: string, clientId: string, documentId: string,
  reviewedBy: string, noteInput: unknown,
): Promise<boolean> {
  if (typeof noteInput !== 'string' || noteInput.trim().length === 0 || noteInput.trim().length > 1000) {
    throw new Error('write what information is missing (up to 1,000 characters)');
  }
  return withFirm(firmId, async (c) => {
    const updated = await c.query(
      `UPDATE source_documents
          SET status = 'needs_information', review_note = $4,
              review_updated_at = now(), review_updated_by = $5
        WHERE id = $1 AND client_id = $2 AND firm_id = $3
          AND status <> 'processed'`,
      [documentId, clientId, firmId, noteInput.trim(), reviewedBy]);
    if (updated.rowCount === 1) {
      await c.query(
        `UPDATE document_information_requests SET status = 'superseded'
         WHERE document_id = $1 AND client_id = $2 AND status = 'open'`,
        [documentId, clientId]);
      await c.query(
        `INSERT INTO document_information_requests
           (firm_id, client_id, document_id, requested_by, question)
         VALUES ($1, $2, $3, $4, $5)`,
        [firmId, clientId, documentId, reviewedBy, noteInput.trim()]);
    }
    return updated.rowCount === 1;
  });
}
