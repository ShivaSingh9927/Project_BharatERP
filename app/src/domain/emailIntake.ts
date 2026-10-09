/** Firm-scoped email intake shared by samples and the Cloudflare R2 importer. */
import { createHash, randomUUID } from 'node:crypto';
import { withFirm } from '../db/pool.ts';
import { receiveInboundEmailDocument } from './documentInbox.ts';
import { assessEmailAttachments } from './emailStatementReview.ts';
import { llmClientFromEnv } from '../parse/llmTable.ts';
import { suggestDocumentClass } from './documentTypeClassifier.ts';

export interface SampleEmail {
  externalId?: string;
  sender: string;
  recipients: string[];
  subject: string;
  bodyText?: string;
  attachments?: Array<{ name: string; mimeType?: string; bytes: Buffer }>;
}
export interface ProviderEmail extends SampleEmail {
  externalId: string;
  rawMime: Buffer;
  /** Cloudflare's receipt time, not the time the local importer woke up. */
  receivedAt?: string;
}
export interface IntakeClient { id: string; name: string; token: string }
export interface IntakeMessage {
  id: string; sender: string; recipients: string[]; subject: string;
  bodyText: string; receivedAt: string; status: string;
  suggestedClientId: string | null; routingReason: string;
  clientId: string | null; clientName: string | null;
  routingMethod: string | null; processingError: string | null;
  attachmentCount: number; attachmentNames: string[]; documentIds: string[];
  attachmentReviews?: Array<{ name: string; status: string; note: string | null }>;
}
export interface EmailInbox { clients: IntakeClient[]; messages: IntakeMessage[] }

export interface EmailReceiptHistory {
  id: string; sender: string; subject: string; receivedAt: string;
  attachments: Array<{ name: string; status: string; note: string | null;
    documentId: string | null; documentStatus: string | null;
    bankName: string | null; bankLast4: string | null;
    rowCount: number | null; periodFrom: string | null; periodTo: string | null }>;
}

/** Client-scoped provenance for Nexus. Email text is never model context. */
export async function emailReceiptHistory(
  firmId: string, clientId: string, limit = 100,
): Promise<EmailReceiptHistory[]> {
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  return withFirm(firmId, async (c) => {
    const messages = await c.query<{
      id: string; sender: string; subject: string; received_at: Date;
    }>(`SELECT id, sender, subject, received_at FROM inbound_email_messages
        WHERE firm_id = $1 AND client_id = $2 AND status = 'assigned'
        ORDER BY received_at DESC, id DESC LIMIT $3`,
      [firmId, clientId, bounded]);
    if (messages.rows.length === 0) return [];
    const attachments = await c.query<{
      email_id: string; original_name: string; intake_status: string;
      intake_note: string | null; source_document_id: string | null;
      document_status: string | null;
      bank_name: string | null; account_number_last4: string | null;
      statement_row_count: number | null;
      statement_period_from: string | null; statement_period_to: string | null;
    }>(`SELECT a.email_id, a.original_name, a.intake_status, a.intake_note,
             a.source_document_id, d.status AS document_status,
             b.bank_name, b.account_number_last4,
             a.statement_row_count, a.statement_period_from::text,
             a.statement_period_to::text
        FROM inbound_email_attachments a
        JOIN inbound_email_messages e ON e.id = a.email_id
        LEFT JOIN source_documents d ON d.id = a.source_document_id
        LEFT JOIN bank_accounts b ON b.id = a.bank_account_id
       WHERE a.firm_id = $1 AND e.firm_id = $1 AND e.client_id = $2
         AND a.email_id = ANY($3::uuid[])
       ORDER BY a.email_id, a.id`,
      [firmId, clientId, messages.rows.map((row) => row.id)]);
    const byEmail = new Map<string, EmailReceiptHistory['attachments']>();
    for (const row of attachments.rows) {
      const items = byEmail.get(row.email_id) ?? [];
      items.push({ name: row.original_name, status: row.intake_status,
        note: row.intake_note, documentId: row.source_document_id,
        documentStatus: row.document_status,
        bankName: row.bank_name, bankLast4: row.account_number_last4,
        rowCount: row.statement_row_count,
        periodFrom: row.statement_period_from, periodTo: row.statement_period_to });
      byEmail.set(row.email_id, items);
    }
    return messages.rows.map((row) => ({
      id: row.id, sender: row.sender, subject: row.subject,
      receivedAt: row.received_at.toISOString(),
      attachments: byEmail.get(row.id) ?? [],
    }));
  });
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const normalizeAddress = (input: string): string => input.trim().toLowerCase();
const routeToken = (address: string): string | null =>
  /^inbox\+([a-f0-9]{20})@[^\s@]+$/i.exec(address)?.[1]?.toLowerCase() ?? null;

export interface RouteDecision {
  clientId: string | null;
  reason: string;
  method: 'recipient_reference' | 'verified_sender' | null;
}

/** A conflicting or unknown recipient reference always stops automatic routing. */
export function decideEmailRoute(
  recipients: string[], tokenClients: Map<string, string>,
  senderClientId: string | null,
): RouteDecision {
  const tokens = [...new Set(recipients.map(routeToken).filter((v): v is string => v !== null))];
  if (tokens.some((token) => !tokenClients.has(token))) {
    return { clientId: null, reason: 'Unknown client reference in recipient address', method: null };
  }
  const clients = [...new Set(tokens.map((token) => tokenClients.get(token)!))];
  if (clients.length > 1) {
    return { clientId: null, reason: 'Recipient references point to different clients', method: null };
  }
  if (clients.length === 1) {
    if (senderClientId && senderClientId !== clients[0]) {
      return { clientId: null, reason: 'Recipient reference conflicts with verified sender', method: null };
    }
    return { clientId: clients[0]!, reason: 'Matched client reference in recipient address',
      method: 'recipient_reference' };
  }
  if (senderClientId) return { clientId: senderClientId,
    reason: 'Matched a CA-verified sender', method: 'verified_sender' };
  return { clientId: null, reason: 'No verified client match', method: null };
}

async function assertFirmCa(firmId: string, actorId: string): Promise<void> {
  await withFirm(firmId, async (c) => {
    const actor = await c.query(
      `SELECT 1 FROM users WHERE id = $1 AND firm_id = $2
         AND client_id IS NULL AND role IN ('ca_partner', 'ca_staff')`,
      [actorId, firmId]);
    if (actor.rowCount !== 1) throw new Error('a firm-scoped CA must manage the email inbox');
  });
}

export async function emailInbox(firmId: string): Promise<EmailInbox> {
  return withFirm(firmId, async (c) => {
    const clients = await c.query(
      `SELECT cl.id, cl.name, r.token FROM clients cl
       JOIN email_intake_routes r ON r.client_id = cl.id
       WHERE cl.firm_id = $1 ORDER BY cl.name`, [firmId]);
    const messages = await c.query(
      `SELECT e.id, e.sender, e.recipients, e.subject, e.body_text,
              e.received_at, e.status, e.suggested_client_id, e.routing_reason,
              e.client_id, cl.name AS client_name, e.routing_method, e.processing_error,
              count(a.id)::int AS attachment_count,
              coalesce(array_agg(a.original_name ORDER BY a.id)
                FILTER (WHERE a.id IS NOT NULL), '{}') AS attachment_names,
              coalesce(json_agg(json_build_object('name', a.original_name,
                'status', a.intake_status, 'note', a.intake_note) ORDER BY a.id)
                FILTER (WHERE a.id IS NOT NULL), '[]'::json) AS attachment_reviews,
              coalesce(array_remove(array_agg(a.source_document_id), NULL), '{}') AS document_ids
       FROM inbound_email_messages e
       LEFT JOIN clients cl ON cl.id = e.client_id
       LEFT JOIN inbound_email_attachments a ON a.email_id = e.id
       WHERE e.firm_id = $1
       GROUP BY e.id, cl.name
       ORDER BY e.received_at DESC, e.id DESC LIMIT 100`, [firmId]);
    return {
      clients: clients.rows,
      messages: messages.rows.map((row) => ({
        id: row.id, sender: row.sender, recipients: row.recipients,
        subject: row.subject, bodyText: row.body_text,
        receivedAt: new Date(row.received_at).toISOString(), status: row.status,
        suggestedClientId: row.suggested_client_id, routingReason: row.routing_reason,
        clientId: row.client_id, clientName: row.client_name,
        routingMethod: row.routing_method, processingError: row.processing_error,
        attachmentCount: row.attachment_count, attachmentNames: row.attachment_names,
        attachmentReviews: row.attachment_reviews,
        documentIds: row.document_ids,
      })),
    };
  });
}

export async function receiveSampleEmail(
  firmId: string, actorId: string, input: SampleEmail,
): Promise<{ id: string; duplicate: boolean; status: string }> {
  await assertFirmCa(firmId, actorId);
  const result = await receiveEmail(firmId, 'sample', input);
  if (result.status === 'assigned') await assessEmailAttachments(firmId, result.id);
  return result;
}

/** Only an importer holding R2 credentials should call this service entry point. */
export async function receiveProviderEmail(
  firmId: string, input: ProviderEmail,
): Promise<{ id: string; duplicate: boolean; status: string }> {
  if (!Buffer.isBuffer(input.rawMime) || input.rawMime.length < 1
    || input.rawMime.length > 8 * 1024 * 1024) {
    throw new Error('raw email must be between 1 byte and 8 MB');
  }
  if (!input.externalId?.trim()) throw new Error('provider message needs an object ID');
  if (input.recipients.length !== 1
    || !/^inbox(?:\+[^\s@]+)?@nueralogic\.com$/i.test(input.recipients[0] ?? '')) {
    throw new Error('provider recipient is not the configured intake address');
  }
  return receiveEmail(firmId, 'provider', input);
}

async function receiveEmail(
  firmId: string, source: 'sample' | 'provider', input: SampleEmail | ProviderEmail,
): Promise<{ id: string; duplicate: boolean; status: string }> {
  const sender = normalizeAddress(input.sender ?? '');
  const recipients = Array.isArray(input.recipients)
    ? [...new Set(input.recipients.map(normalizeAddress))] : [];
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  const bodyText = typeof input.bodyText === 'string' ? input.bodyText.trim() : '';
  const attachments = input.attachments ?? [];
  if (!ADDRESS.test(sender) || sender.length > 254 || recipients.length < 1
    || recipients.length > 10 || recipients.some((address) => !ADDRESS.test(address)
      || address.length > 254)) {
    throw new Error('enter a valid sender and at least one recipient');
  }
  if (subject.length > 500 || bodyText.length > 20000 || attachments.length > 5) {
    throw new Error('email exceeds the local intake limits');
  }
  let totalBytes = 0;
  const prepared = attachments.map((attachment) => {
    if (!Buffer.isBuffer(attachment.bytes) || attachment.bytes.length < 1
      || attachment.bytes.length > 5 * 1024 * 1024) {
      throw new Error('each attachment must be between 1 byte and 5 MB');
    }
    totalBytes += attachment.bytes.length;
    if (typeof attachment.name !== 'string' || !attachment.name.trim()
      || attachment.name.length > 180) throw new Error('attachment needs a valid name');
    const mimeType = typeof attachment.mimeType === 'string' && attachment.mimeType.length <= 120
      && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(attachment.mimeType)
      ? attachment.mimeType : 'application/octet-stream';
    return { ...attachment, name: attachment.name.trim(), mimeType,
      hash: createHash('sha256').update(attachment.bytes).digest('hex') };
  });
  if (totalBytes > 5 * 1024 * 1024) throw new Error('attachments exceed the 5 MB email limit');
  const externalId = input.externalId?.trim() || randomUUID();
  if (externalId.length > 200) throw new Error('message ID is too long');
  const receivedAt = source === 'provider' && (input as ProviderEmail).receivedAt
    ? new Date((input as ProviderEmail).receivedAt!) : new Date();
  if (!Number.isFinite(receivedAt.getTime())
    || receivedAt.getTime() > Date.now() + 5 * 60_000) {
    throw new Error('email receipt time is invalid');
  }
  const payloadHash = createHash('sha256').update(JSON.stringify({
    sender, recipients, subject, bodyText,
    attachments: prepared.map(({ name, mimeType, hash }) => ({ name, mimeType, hash })),
    rawMimeHash: source === 'provider'
      ? createHash('sha256').update((input as ProviderEmail).rawMime).digest('hex') : null,
  })).digest('hex');
  const created = await withFirm(firmId, async (c) => {
    const tokens = [...new Set(recipients.map(routeToken).filter((v): v is string => v !== null))];
    const routes = await c.query(
      'SELECT token, client_id FROM email_intake_routes WHERE firm_id = $1 AND token = ANY($2::text[])',
      [firmId, tokens]);
    // The sender's address in an Internet email is not proof of identity.
    // Live mail requires a recipient reference until authenticated sender
    // evidence is wired into this importer.
    const verified = source === 'sample' ? await c.query(
      'SELECT client_id FROM email_verified_senders WHERE firm_id = $1 AND email = $2',
      [firmId, sender]) : { rows: [] };
    const decision = decideEmailRoute(recipients,
      new Map(routes.rows.map((row) => [row.token, row.client_id])),
      verified.rows[0]?.client_id ?? null);
    const inserted = await c.query(
      `INSERT INTO inbound_email_messages
        (firm_id, source, external_id, payload_hash, sender, recipients,
         subject, body_text, raw_mime, suggested_client_id, routing_reason,
         received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (firm_id, source, external_id) DO NOTHING
       RETURNING id`,
      [firmId, source, externalId, payloadHash, sender, recipients, subject,
        bodyText, source === 'provider' ? (input as ProviderEmail).rawMime : null,
        decision.clientId, decision.reason, receivedAt]);
    if (!inserted.rows[0]) {
      const existing = await c.query(
        `SELECT id, payload_hash, status FROM inbound_email_messages
         WHERE firm_id = $1 AND source = $2 AND external_id = $3`,
        [firmId, source, externalId]);
      if (existing.rows[0]?.payload_hash !== payloadHash) {
        throw new Error('message ID already belongs to a different email');
      }
      return { id: existing.rows[0].id as string, duplicate: true,
        status: existing.rows[0].status as string, decision };
    }
    const id = inserted.rows[0].id as string;
    for (const attachment of prepared) {
      await c.query(
        `INSERT INTO inbound_email_attachments
          (firm_id, email_id, original_name, mime_type, byte_size, sha256, bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [firmId, id, attachment.name, attachment.mimeType,
          attachment.bytes.length, attachment.hash, attachment.bytes]);
    }
    return { id, duplicate: false, status: 'unassigned', decision };
  });
  if (!created.duplicate && created.decision.clientId && created.decision.method) {
    await assignEmailInternal(firmId, created.id, created.decision.clientId,
      created.decision.method, null, false);
  }
  const final = await withFirm(firmId, async (c) => c.query(
    'SELECT status, client_id FROM inbound_email_messages WHERE id = $1 AND firm_id = $2',
    [created.id, firmId]));
  if (final.rows[0]?.status === 'assigned' && final.rows[0]?.client_id) {
    // Classification is independently opt-in inside suggestDocumentClass.
    // Intake remains successful if DeepSeek is unavailable or rejects a file.
    await assessEmailAttachments(firmId, created.id).catch(() => {});
    await suggestEmailDocumentClasses(firmId, created.id, final.rows[0].client_id);
  }
  return { id: created.id, duplicate: created.duplicate, status: final.rows[0].status };
}

async function assignEmailInternal(
  firmId: string, emailId: string, clientId: string,
  method: 'recipient_reference' | 'verified_sender' | 'ca_assignment',
  actorId: string | null, rememberSender: boolean,
): Promise<boolean> {
  const claimed = await withFirm(firmId, async (c) => {
    const client = await c.query('SELECT 1 FROM clients WHERE id = $1 AND firm_id = $2',
      [clientId, firmId]);
    if (client.rowCount !== 1) throw new Error('client is not in this firm');
    const result = await c.query(
      `UPDATE inbound_email_messages
       SET status = 'processing', client_id = $3, routing_method = $4,
           processing_error = NULL
       WHERE id = $1 AND firm_id = $2 AND status IN ('unassigned', 'failed')
         AND (client_id IS NULL OR client_id = $3)
       RETURNING sender`, [emailId, firmId, clientId, method]);
    return result.rows[0]?.sender as string | undefined;
  });
  if (!claimed) return false;
  try {
    const attachments = await withFirm(firmId, async (c) => c.query(
      `SELECT id, original_name, mime_type, bytes, source_document_id
       FROM inbound_email_attachments WHERE email_id = $1 AND firm_id = $2
       ORDER BY id`, [emailId, firmId]));
    for (const attachment of attachments.rows) {
      if (attachment.source_document_id) continue;
      if (!attachment.bytes) throw new Error('staged attachment is missing');
      const document = await receiveInboundEmailDocument(firmId, {
        clientId, sender: claimed, name: attachment.original_name,
        mimeType: attachment.mime_type, bytes: attachment.bytes,
      });
      await withFirm(firmId, async (c) => c.query(
        `UPDATE inbound_email_attachments
         SET source_document_id = $3, bytes = NULL
         WHERE id = $1 AND email_id = $2 AND firm_id = $4`,
        [attachment.id, emailId, document.id, firmId]));
    }
    await withFirm(firmId, async (c) => {
      if (rememberSender && actorId) {
        await c.query(
          `INSERT INTO email_verified_senders (firm_id, email, client_id, verified_by)
           VALUES ($1,$2,$3,$4) ON CONFLICT (firm_id, email) DO NOTHING`,
          [firmId, claimed, clientId, actorId]);
        const mapped = await c.query(
          `SELECT client_id FROM email_verified_senders WHERE firm_id = $1 AND email = $2`,
          [firmId, claimed]);
        if (mapped.rows[0]?.client_id !== clientId) {
          throw new Error('sender is already verified for another client');
        }
      }
      await c.query(
        `UPDATE inbound_email_messages
         SET status = 'assigned', assigned_by = $3, assigned_at = now(),
             processing_error = NULL
         WHERE id = $1 AND firm_id = $2 AND status = 'processing'`,
        [emailId, firmId, actorId]);
    });
    return true;
  } catch (error) {
    await withFirm(firmId, async (c) => c.query(
      `UPDATE inbound_email_messages SET status = 'failed', processing_error = $3
       WHERE id = $1 AND firm_id = $2 AND status = 'processing'`,
      [emailId, firmId, (error as Error).message.slice(0, 500)]));
    throw error;
  }
}

export async function assignEmail(
  firmId: string, actorId: string, emailId: string, clientId: string,
  rememberSender = false,
): Promise<boolean> {
  await assertFirmCa(firmId, actorId);
  const assigned = await assignEmailInternal(firmId, emailId, clientId,
    'ca_assignment', actorId, rememberSender);
  if (assigned) {
    await assessEmailAttachments(firmId, emailId);
    await suggestEmailDocumentClasses(firmId, emailId, clientId);
  }
  return assigned;
}

async function suggestEmailDocumentClasses(
  firmId: string, emailId: string, clientId: string,
): Promise<void> {
  const docs = await withFirm(firmId, async (c) => c.query<{ id: string }>(
    `SELECT source_document_id AS id FROM inbound_email_attachments
      WHERE email_id = $1 AND firm_id = $2 AND source_document_id IS NOT NULL`,
    [emailId, firmId]));
  const llm = llmClientFromEnv();
  for (const doc of docs.rows) {
    await suggestDocumentClass({ firmId, clientId, documentId: doc.id, llm }).catch(() => {});
  }
}
