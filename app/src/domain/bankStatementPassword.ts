/** Encrypted storage for passwords used to open bank-issued statements. */

import {
  createCipheriv, createDecipheriv, randomBytes,
} from 'node:crypto';
import {
  existsSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';

const KEY_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.bank-statement-key');

function decodeKey(value: string): Buffer {
  const clean = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(clean)
    ? Buffer.from(clean, 'hex')
    : Buffer.from(clean, 'base64');
  if (key.length !== 32) {
    throw new Error('BANK_STATEMENT_KEY must decode to exactly 32 bytes');
  }
  return key;
}

/**
 * Production should inject BANK_STATEMENT_KEY from its secret manager.
 * A single-machine installation gets a private, git-ignored 0600 key file.
 */
function encryptionKey(): Buffer {
  const configured = process.env['BANK_STATEMENT_KEY'];
  if (configured) return decodeKey(configured);

  if (!existsSync(KEY_FILE)) {
    const generated = randomBytes(32).toString('base64');
    try {
      writeFileSync(KEY_FILE, `${generated}\n`, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      // Another request may have created it between existsSync and write.
      if (!existsSync(KEY_FILE)) throw e;
    }
  }
  return decodeKey(readFileSync(KEY_FILE, 'utf8'));
}

function aad(firmId: string, clientId: string, bankAccountId: string): Buffer {
  return Buffer.from(`${firmId}:${clientId}:${bankAccountId}`, 'utf8');
}

export async function hasSavedStatementPassword(
  firmId: string, clientId: string, bankAccountId: string,
): Promise<boolean> {
  return withFirm(firmId, async (c) => {
    const r = await c.query(
      `SELECT 1 FROM bank_statement_credentials
       WHERE client_id = $1 AND bank_account_id = $2`,
      [clientId, bankAccountId]);
    return r.rowCount === 1;
  });
}

export async function statementPasswordSettings(
  firmId: string, clientId: string, bankAccountId: string,
): Promise<{ saved: boolean; autoOpenEmail: boolean }> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ auto_open_email: boolean }>(
      `SELECT auto_open_email FROM bank_statement_credentials
       WHERE firm_id = $1 AND client_id = $2 AND bank_account_id = $3`,
      [firmId, clientId, bankAccountId]);
    return { saved: r.rowCount === 1, autoOpenEmail: r.rows[0]?.auto_open_email ?? false };
  });
}

export async function saveStatementPassword(
  firmId: string,
  input: { clientId: string; bankAccountId: string; password: string; updatedBy: string;
    autoOpenEmail?: boolean },
): Promise<void> {
  if (input.password.length === 0 || input.password.length > 256) {
    throw new ValidationError('statement password must be between 1 and 256 characters', 'BR-4');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(aad(firmId, input.clientId, input.bankAccountId));
  const ciphertext = Buffer.concat([
    cipher.update(input.password, 'utf8'), cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  await withFirm(firmId, async (c) => {
    const account = await c.query(
      `SELECT 1 FROM bank_accounts b JOIN users u ON u.firm_id = b.firm_id
       WHERE b.id = $1 AND b.client_id = $2 AND b.firm_id = $3
         AND u.id = $4 AND u.role IN ('ca_partner', 'ca_staff')
         AND (u.client_id IS NULL OR u.client_id = b.client_id)`,
      [input.bankAccountId, input.clientId, firmId, input.updatedBy]);
    if (account.rowCount !== 1) {
      throw new ValidationError('bank account not found for this client', 'BR-2');
    }
    await c.query(
      `INSERT INTO bank_statement_credentials
         (firm_id, client_id, bank_account_id, ciphertext, nonce, auth_tag, updated_by,
          auto_open_email, auto_open_consented_at, auto_open_consented_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::uuid,$8::boolean,
         CASE WHEN $8::boolean THEN now() ELSE NULL::timestamptz END,
         CASE WHEN $8::boolean THEN $7::uuid ELSE NULL::uuid END)
       ON CONFLICT (bank_account_id) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         nonce = EXCLUDED.nonce,
         auth_tag = EXCLUDED.auth_tag,
         updated_by = EXCLUDED.updated_by,
         auto_open_email = EXCLUDED.auto_open_email,
         auto_open_consented_at = EXCLUDED.auto_open_consented_at,
         auto_open_consented_by = EXCLUDED.auto_open_consented_by,
         updated_at = now()`,
      [firmId, input.clientId, input.bankAccountId, ciphertext, iv, tag,
        input.updatedBy, input.autoOpenEmail === true]);
  });
}

/** One-time, revocable permission to open new email attachments in the background. */
export async function setStatementAutoOpenConsent(
  firmId: string, clientId: string, bankAccountId: string,
  actorId: string, enabled: boolean,
): Promise<void> {
  await withFirm(firmId, async (c) => {
    const result = await c.query(
      `UPDATE bank_statement_credentials p SET
         auto_open_email = $5,
         auto_open_consented_at = CASE WHEN $5 THEN now() ELSE NULL END,
         auto_open_consented_by = CASE WHEN $5 THEN $4::uuid ELSE NULL END,
         updated_by = $4, updated_at = now()
       FROM bank_accounts b, users u
       WHERE p.bank_account_id = $3 AND p.client_id = $2 AND p.firm_id = $1
         AND b.id = p.bank_account_id AND b.client_id = $2 AND b.firm_id = $1
         AND u.id = $4 AND u.firm_id = $1
         AND u.role IN ('ca_partner', 'ca_staff')
         AND (u.client_id IS NULL OR u.client_id = $2)`,
      [firmId, clientId, bankAccountId, actorId, enabled]);
    if (result.rowCount !== 1) throw new ValidationError(
      'saved password or authorized bank account not found', 'BR-4');
  });
}

export async function forgetStatementPassword(
  firmId: string, clientId: string, bankAccountId: string, actorId: string,
): Promise<void> {
  await withFirm(firmId, async (c) => {
    const result = await c.query(
      `DELETE FROM bank_statement_credentials p USING bank_accounts b, users u
       WHERE p.bank_account_id = $3 AND p.client_id = $2 AND p.firm_id = $1
         AND b.id = p.bank_account_id AND b.client_id = $2 AND b.firm_id = $1
         AND u.id = $4 AND u.firm_id = $1
         AND u.role IN ('ca_partner', 'ca_staff')
         AND (u.client_id IS NULL OR u.client_id = $2)`,
      [firmId, clientId, bankAccountId, actorId]);
    if (result.rowCount !== 1) throw new ValidationError(
      'saved password or authorized bank account not found', 'BR-4');
  });
}

/** The importer receives IDs only; plaintext passwords never leave this module. */
export async function autoOpenBankAccountIds(
  firmId: string, clientId: string,
): Promise<string[]> {
  return withFirm(firmId, async (c) => {
    const result = await c.query<{ bank_account_id: string }>(
      `SELECT p.bank_account_id FROM bank_statement_credentials p
       JOIN bank_accounts b ON b.id = p.bank_account_id
       WHERE p.firm_id = $1 AND p.client_id = $2 AND p.auto_open_email
         AND b.firm_id = $1 AND b.client_id = $2
       ORDER BY p.updated_at DESC LIMIT 10`, [firmId, clientId]);
    return result.rows.map((row) => row.bank_account_id);
  });
}

export async function savedStatementPassword(
  firmId: string, clientId: string, bankAccountId: string,
): Promise<string | null> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer }>(
      `SELECT ciphertext, nonce, auth_tag FROM bank_statement_credentials
       WHERE client_id = $1 AND bank_account_id = $2`,
      [clientId, bankAccountId]);
    const row = r.rows[0];
    if (!row) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), row.nonce);
      decipher.setAAD(aad(firmId, clientId, bankAccountId));
      decipher.setAuthTag(row.auth_tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new ValidationError(
        'the saved statement password cannot be decrypted with this installation key; enter it again',
        'BR-4');
    }
  });
}
