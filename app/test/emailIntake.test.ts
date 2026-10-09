import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ownerPool, closePools } from '../src/db/pool.ts';
import { assignEmail, decideEmailRoute, emailInbox, emailReceiptHistory, receiveProviderEmail,
         receiveSampleEmail }
  from '../src/domain/emailIntake.ts';
import { assessEmailAttachments } from '../src/domain/emailStatementReview.ts';
import { documentClassifierEnabled, setDocumentClassifierEnabled }
  from '../src/domain/documentTypeClassifier.ts';
import { answerAssistant } from '../src/domain/assistant.ts';
import { firmForEmailRecipient, parseArchivedEmail }
  from '../src/integrations/cloudflareR2Email.ts';
import { confirmDocumentClass, dismissDocument, listDocuments, markDocumentInReview }
  from '../src/domain/documentInbox.ts';

const firmId = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
const clientC = randomUUID();
const caId = randomUUID();
const suffix = randomUUID().slice(0, 8);
let root: string;
let previous: string | undefined;

beforeAll(async () => {
  previous = process.env.DOCUMENT_WORKSPACE_ROOT;
  root = await mkdtemp(join(tmpdir(), 'bharaterp-email-test-'));
  process.env.DOCUMENT_WORKSPACE_ROOT = root;
  await ownerPool.query('INSERT INTO firms (id, name) VALUES ($1, $2)',
    [firmId, 'Email intake test firm']);
  await ownerPool.query(
    `INSERT INTO clients (id, firm_id, name) VALUES
      ($1, $4, 'Client A'), ($2, $4, 'Client B'), ($3, $4, 'Client C')`, [clientA, clientB, clientC, firmId]);
  await ownerPool.query(
    `INSERT INTO users (id, firm_id, email, display_name, role)
     VALUES ($1, $2, $3, 'Test CA', 'ca_staff')`,
    [caId, firmId, `email-ca-${suffix}@example.test`]);
});

afterAll(async () => {
  await ownerPool.query('DELETE FROM document_class_reviews WHERE firm_id = $1', [firmId]);
  await ownerPool.query('DELETE FROM document_ai_classifications WHERE firm_id = $1', [firmId]);
  await ownerPool.query('DELETE FROM inbound_email_attachments WHERE firm_id = $1', [firmId]);
  await ownerPool.query('DELETE FROM inbound_email_messages WHERE firm_id = $1', [firmId]);
  await ownerPool.query('DELETE FROM source_documents WHERE firm_id = $1', [firmId]);
  await ownerPool.query('DELETE FROM email_verified_senders WHERE firm_id = $1', [firmId]);
  await ownerPool.query('DELETE FROM email_intake_routes WHERE firm_id = $1', [firmId]);
  await ownerPool.query('DELETE FROM firm_ai_settings WHERE firm_id = $1', [firmId]);
  await ownerPool.query('DELETE FROM users WHERE firm_id = $1', [firmId]);
  await ownerPool.query('DELETE FROM clients WHERE firm_id = $1', [firmId]);
  await ownerPool.query('DELETE FROM firms WHERE id = $1', [firmId]);
  if (previous === undefined) delete process.env.DOCUMENT_WORKSPACE_ROOT;
  else process.env.DOCUMENT_WORKSPACE_ROOT = previous;
  await rm(root, { recursive: true, force: true });
  await closePools();
});

describe('shared email intake', () => {
  it('enables document suggestions by default and honors an explicit firm opt-out', async () => {
    expect(await documentClassifierEnabled(firmId)).toBe(true);
    await setDocumentClassifierEnabled(firmId, false, caId, 'deepseek', 'deepseek-chat');
    expect(await documentClassifierEnabled(firmId)).toBe(false);
    await setDocumentClassifierEnabled(firmId, true, caId, 'deepseek', 'deepseek-chat');
    expect(await documentClassifierEnabled(firmId)).toBe(true);
    // Keep the remaining integration fixtures offline and deterministic.
    await setDocumentClassifierEnabled(firmId, false, caId, 'deepseek', 'deepseek-chat');
  });

  it('keeps AI class suggestions separate from an append-only human confirmation', async () => {
    const token = (await emailInbox(firmId)).clients.find((client) => client.id === clientC)!.token;
    const received = await receiveSampleEmail(firmId, caId, {
      externalId: `class-review-${suffix}`, sender: `class-${suffix}@example.test`,
      recipients: [`inbox+${token}@example.test`], subject: 'October statement',
      attachments: [{ name: 'statement.pdf', mimeType: 'application/pdf',
        bytes: Buffer.from(`statement class review ${suffix}`) }],
    });
    const document = (await listDocuments(firmId, clientC)).find((item) => item.originalName === 'statement.pdf');
    expect(document).toBeDefined();
    expect(document!.classConfirmation).toBeNull();
    expect(await confirmDocumentClass(firmId, clientC, document!.id, caId, 'bank_statement')).toBe(true);
    const confirmed = (await listDocuments(firmId, clientC)).find((item) => item.id === document!.id);
    expect(confirmed?.classConfirmation?.documentClass).toBe('bank_statement');
    expect(confirmed?.classSuggestion).toBeNull();
    expect(received.status).toBe('assigned');
    await expect(confirmDocumentClass(firmId, clientA, document!.id, caId, 'made_up'))
      .rejects.toThrow('choose a valid document class');
    expect(await confirmDocumentClass(firmId, clientB, document!.id, caId, 'bank_statement')).toBe(false);
  });
  it('holds ambiguous or conflicting routing evidence', () => {
    const token = 'a'.repeat(20);
    const routes = new Map([[token, clientA]]);
    expect(decideEmailRoute(['inbox@example.test'], routes, null).clientId).toBeNull();
    expect(decideEmailRoute([`inbox+${token}@example.test`], routes, clientB).clientId)
      .toBeNull();
    expect(decideEmailRoute([`inbox+${'b'.repeat(20)}@example.test`], routes, clientA).clientId)
      .toBeNull();
  });

  it('routes a referenced message, then lets the CA assign and verify an unknown sender', async () => {
    const clients = (await emailInbox(firmId)).clients;
    const tokenA = clients.find((client) => client.id === clientA)!.token;
    const tokenB = clients.find((client) => client.id === clientB)!.token;
    const first = await receiveSampleEmail(firmId, caId, {
      externalId: `reference-${suffix}`, sender: `vendor-${suffix}@example.test`,
      recipients: [`inbox+${tokenA}@example.test`], subject: 'Invoice A',
      attachments: [{ name: 'invoice-a.pdf', mimeType: 'application/pdf',
        bytes: Buffer.from('test invoice A') },
      { name: 'copy-of-invoice-a.pdf', mimeType: 'application/pdf',
        bytes: Buffer.from('test invoice A') }],
    });
    expect(first.status).toBe('assigned');
    const originals = await listDocuments(firmId, clientA);
    expect(originals).toHaveLength(1);
    expect(['invoice-a.pdf', 'copy-of-invoice-a.pdf']).toContain(originals[0]!.originalName);
    expect((await emailInbox(firmId)).messages.find((item) => item.id === first.id)
      ?.attachmentCount).toBe(2);
    expect(await receiveSampleEmail(firmId, caId, {
      externalId: `reference-${suffix}`, sender: `vendor-${suffix}@example.test`,
      recipients: [`inbox+${tokenA}@example.test`], subject: 'Invoice A',
      attachments: [{ name: 'invoice-a.pdf', mimeType: 'application/pdf',
        bytes: Buffer.from('test invoice A') },
      { name: 'copy-of-invoice-a.pdf', mimeType: 'application/pdf',
        bytes: Buffer.from('test invoice A') }],
    })).toMatchObject({ id: first.id, duplicate: true, status: 'assigned' });

    const unknown = await receiveSampleEmail(firmId, caId, {
      externalId: `unknown-${suffix}`, sender: `other-${suffix}@example.test`,
      recipients: ['inbox@example.test'], subject: 'Bank statement',
      attachments: [{ name: 'statement.pdf', bytes: Buffer.from('test statement') }],
    });
    expect(unknown.status).toBe('unassigned');
    expect(await assignEmail(firmId, caId, unknown.id, clientB, true)).toBe(true);
    expect((await listDocuments(firmId, clientB)).map((doc) => doc.originalName))
      .toContain('statement.pdf');

    const senderRouted = await receiveSampleEmail(firmId, caId, {
      externalId: `sender-${suffix}`, sender: `other-${suffix}@example.test`,
      recipients: ['inbox@example.test'], subject: 'Another receipt',
    });
    expect(senderRouted.status).toBe('assigned');
    const inbox = await emailInbox(firmId);
    expect(inbox.messages.find((item) => item.id === senderRouted.id)?.clientId).toBe(clientB);

    const conflicting = await receiveSampleEmail(firmId, caId, {
      externalId: `conflict-${suffix}`, sender: `other-${suffix}@example.test`,
      recipients: [`inbox+${tokenA}@example.test`], subject: 'Conflicting evidence',
    });
    expect(conflicting.status).toBe('unassigned');
    expect((await emailInbox(firmId)).messages.find((item) => item.id === conflicting.id)
      ?.routingReason).toContain('conflicts');
  });

  it('imports a raw provider email by its plus-addressed client token', async () => {
    const token = (await emailInbox(firmId)).clients.find((client) => client.id === clientA)!.token;
    const recipient = `inbox+${token}@nueralogic.com`;
    const rawMime = Buffer.from([
      'From: Vendor <vendor@example.test>',
      `To: ${recipient}`,
      'Subject: October invoice',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="test-boundary"',
      '',
      '--test-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Please review.',
      '--test-boundary',
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('test invoice content').toString('base64'),
      '--test-boundary--',
      '',
    ].join('\r\n'));
    const key = `incoming/${createHash('sha256').update(recipient).update('\0')
      .update(rawMime).digest('hex')}.eml`;
    const parsed = await parseArchivedEmail(key, rawMime, {
      from: 'vendor@example.test', to: recipient,
      sha256: createHash('sha256').update(rawMime).digest('hex'),
      received: '2026-10-07T10:31:04.822Z',
    });
    expect(parsed.attachments?.[0]?.bytes.toString()).toBe('test invoice content');
    const first = await receiveProviderEmail(firmId, parsed);
    expect(first.status).toBe('assigned');
    await assessEmailAttachments(firmId, first.id);
    const history = await emailReceiptHistory(firmId, clientA);
    const receipt = history.find((message) => message.id === first.id)!;
    expect(receipt.receivedAt).toBe('2026-10-07T10:31:04.822Z');
    expect(receipt.attachments[0]).toMatchObject({
      name: 'invoice.pdf', status: 'other_file',
    });
    const nexus = await answerAssistant(firmId, clientA,
      'Who shared statements and when?', '/documents');
    expect(nexus.answer).toContain('email listed vendor@example.test as sender; invoice.pdf');
    expect(nexus.answer).toContain('7 Oct 2026');
    expect(nexus.answer).toContain('other file, not verified as a statement');
    const documentId = receipt.attachments[0]!.documentId!;
    expect(await dismissDocument(firmId, clientA, documentId, caId,
      'Unrelated test attachment')).toBe(true);
    expect((await emailReceiptHistory(firmId, clientA)).find((message) => message.id === first.id)
      ?.attachments[0]?.documentStatus).toBe('dismissed');
    expect(await markDocumentInReview(firmId, clientA, documentId, caId)).toBe(true);
    expect((await emailReceiptHistory(firmId, clientA)).find((message) => message.id === first.id)
      ?.attachments[0]?.documentStatus).toBe('in_review');
    // A PDF filename must never turn arbitrary bytes into a bank statement.
    await assessEmailAttachments(firmId, first.id);
    expect((await emailReceiptHistory(firmId, clientA))
      .find((message) => message.id === first.id)?.attachments[0]?.status).toBe('other_file');
    expect((await emailInbox(firmId)).messages.find((mail) => mail.id === first.id)
      ?.clientId).toBe(clientA);
    expect(await receiveProviderEmail(firmId, parsed)).toMatchObject({
      id: first.id, duplicate: true, status: 'assigned',
    });
    const stored = await ownerPool.query('SELECT raw_mime FROM inbound_email_messages WHERE id = $1',
      [first.id]);
    expect(stored.rows[0]?.raw_mime).toEqual(rawMime);
  });

  it('holds an unknown plus reference outside tenant inboxes', async () => {
    await expect(firmForEmailRecipient(
      `inbox+${'f'.repeat(20)}@nueralogic.com`, firmId,
    )).rejects.toThrow('unknown client reference');
    await expect(firmForEmailRecipient('inbox+test@nueralogic.com', firmId))
      .rejects.toThrow('unrecognized intake recipient');
    expect(await firmForEmailRecipient('inbox@nueralogic.com', firmId))
      .toBe(firmId);
  });
});
