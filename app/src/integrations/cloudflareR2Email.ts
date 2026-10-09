/** Import archived Cloudflare Email Worker messages when the local app is on. */
import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, S3Client,
} from '@aws-sdk/client-s3';
import PostalMime from 'postal-mime';
import { ownerPool } from '../db/pool.ts';
import { receiveProviderEmail, type ProviderEmail } from '../domain/emailIntake.ts';
import { assessEmailAttachments } from '../domain/emailStatementReview.ts';

const KEY = /^incoming\/([a-f0-9]{64})\.eml$/;
const TOKEN = /^inbox\+([a-f0-9]{20})@nueralogic\.com$/i;
const ADDRESS = /^inbox(?:\+[^\s@]+)?@nueralogic\.com$/i;

export interface R2EmailConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  defaultFirmId: string | null;
}

export function r2EmailConfig(env = process.env): R2EmailConfig | null {
  const accountId = env.CLOUDFLARE_R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.CLOUDFLARE_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.CLOUDFLARE_R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.CLOUDFLARE_R2_EMAIL_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket,
    defaultFirmId: env.EMAIL_INTAKE_DEFAULT_FIRM_ID?.trim() || null };
}

export function parseArchivedEmail(
  key: string, rawMime: Buffer, metadata: Record<string, string>,
): Promise<ProviderEmail> {
  return (async () => {
    if (!KEY.test(key)) throw new Error('R2 object key is not an intake message');
    const sender = metadata.from?.trim().toLowerCase();
    const recipient = metadata.to?.trim().toLowerCase();
    if (!sender || !recipient || !ADDRESS.test(recipient)) {
      throw new Error('R2 email envelope metadata is missing or invalid');
    }
    const expectedHash = metadata.sha256?.toLowerCase();
    const receivedAt = metadata.received?.trim();
    if (!receivedAt || !Number.isFinite(new Date(receivedAt).getTime())) {
      throw new Error('R2 email receipt time is missing or invalid');
    }
    const actualHash = createHash('sha256').update(rawMime).digest('hex');
    if (!expectedHash || expectedHash !== actualHash) {
      throw new Error('R2 email content hash does not match its metadata');
    }
    const objectHash = createHash('sha256').update(recipient).update('\0')
      .update(rawMime).digest('hex');
    if (key !== `incoming/${objectHash}.eml`) {
      throw new Error('R2 email object key does not match its contents');
    }
    const parsed = await PostalMime.parse(rawMime, {
      maxNestingDepth: 32, maxHeadersSize: 256 * 1024, maxRfc822NestingDepth: 2,
    });
    const attachments = parsed.attachments
      .filter((file) => file.disposition === 'attachment' || !!file.filename)
      .map((file) => ({
        name: file.filename || 'attachment', mimeType: file.mimeType,
        bytes: file.content instanceof ArrayBuffer
          ? Buffer.from(file.content) : Buffer.from(file.content as Uint8Array),
      }));
    return { externalId: key, rawMime, sender, recipients: [recipient], receivedAt,
      subject: parsed.subject ?? '', bodyText: parsed.text ?? '', attachments };
  })();
}

export async function firmForEmailRecipient(
  recipient: string, defaultFirmId: string | null,
): Promise<string> {
  const token = TOKEN.exec(recipient)?.[1]?.toLowerCase();
  if (token) {
    const route = await ownerPool.query<{ firm_id: string }>(
      'SELECT firm_id FROM email_intake_routes WHERE token = $1', [token]);
    if (route.rows[0]) return route.rows[0].firm_id;
    throw new Error('unknown client reference; kept in R2 for platform review');
  }
  // An arbitrary plus suffix must never put another firm's documents into the
  // pilot CA's unassigned queue. Only the plain address has a default firm.
  if (recipient !== 'inbox@nueralogic.com') {
    throw new Error('unrecognized intake recipient; kept in R2 for platform review');
  }
  if (!defaultFirmId) {
    throw new Error('unmatched email has no default CA firm; kept in R2 for review');
  }
  const firm = await ownerPool.query('SELECT 1 FROM firms WHERE id = $1', [defaultFirmId]);
  if (!firm.rows[0]) throw new Error('configured default CA firm does not exist');
  return defaultFirmId;
}

export interface EmailImportSummary {
  imported: number;
  duplicates: number;
  held: number;
  failures: Array<{ key: string; error: string }>;
}

export async function importArchivedEmails(config: R2EmailConfig): Promise<EmailImportSummary> {
  const s3 = new S3Client({
    region: 'auto', endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey },
  });
  const summary: EmailImportSummary = { imported: 0, duplicates: 0, held: 0, failures: [] };
  let continuationToken: string | undefined;
  try {
    do {
      const page = await s3.send(new ListObjectsV2Command({
        Bucket: config.bucket, Prefix: 'incoming/', MaxKeys: 100,
        ContinuationToken: continuationToken,
      }));
      continuationToken = page.NextContinuationToken;
      for (const object of page.Contents ?? []) {
        const key = object.Key ?? '';
        if (!KEY.test(key)) continue;
        try {
          const item = await s3.send(new GetObjectCommand({
            Bucket: config.bucket, Key: key,
          }));
          if (!item.Body || (item.ContentLength ?? 0) > 8 * 1024 * 1024) {
            throw new Error('email is missing or exceeds the 8 MB intake limit');
          }
          const rawMime = Buffer.from(await item.Body.transformToByteArray());
          const email = await parseArchivedEmail(key, rawMime, item.Metadata ?? {});
          const firmId = await firmForEmailRecipient(
            email.recipients[0]!, config.defaultFirmId);
          const result = await receiveProviderEmail(firmId, email);
          if (result.status === 'failed') {
            summary.held++;
            continue;
          }
          await assessEmailAttachments(firmId, result.id);
          // The database now has the original MIME and attachment entries.
          // If deletion fails, the next poll sees an idempotent duplicate.
          await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
          if (result.duplicate) summary.duplicates++;
          else summary.imported++;
        } catch (error) {
          summary.held++;
          summary.failures.push({ key, error: (error as Error).message });
        }
      }
    } while (continuationToken);
  } finally {
    s3.destroy();
  }
  return summary;
}
