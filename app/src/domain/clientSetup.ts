import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';
import { validateGstin } from './gstin.ts';

export interface ClientSetupProgress {
  name: string;
  pan: string | null;
  gstin: string | null;
  bankAccounts: number;
  teamMembers: number;
}

export async function clientSetupProgress(
  firmId: string, clientId: string,
): Promise<ClientSetupProgress> {
  return withFirm(firmId, async (c) => {
    const [client, registration, banks, team] = await Promise.all([
      c.query<{ name: string; pan: string | null }>(
        'SELECT name, pan FROM clients WHERE id = $1 AND firm_id = $2', [clientId, firmId]),
      c.query<{ gstin: string }>(
        `SELECT gstin FROM client_registrations
          WHERE client_id = $1 AND cancelled_on IS NULL ORDER BY is_primary DESC LIMIT 1`, [clientId]),
      c.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM bank_accounts WHERE client_id = $1', [clientId]),
      c.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM users WHERE firm_id = $1', [firmId]),
    ]);
    const row = client.rows[0];
    if (!row) throw new ValidationError('client was not found', 'ON-1');
    return {
      name: row.name, pan: row.pan, gstin: registration.rows[0]?.gstin ?? null,
      bankAccounts: Number(banks.rows[0]?.count ?? 0),
      teamMembers: Number(team.rows[0]?.count ?? 0),
    };
  });
}

export async function saveClientSetup(
  firmId: string, clientId: string,
  input: { name: string; pan: string; gstin?: string },
): Promise<void> {
  const name = input.name.trim();
  const pan = input.pan.trim().toUpperCase();
  const gstin = input.gstin?.trim().toUpperCase() || null;
  if (name.length < 2) throw new ValidationError('enter the company name', 'ON-1');
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) throw new ValidationError('PAN must be 10 characters', 'ON-1');
  if (gstin) {
    const check = validateGstin(gstin);
    if (!check.valid) throw new ValidationError(check.reason ?? 'GSTIN is not valid', 'ON-1');
    if (gstin.slice(2, 12) !== pan) throw new ValidationError('GSTIN PAN does not match the company PAN', 'ON-1');
  }
  await withFirm(firmId, async (c) => {
    const updated = await c.query(
      'UPDATE clients SET name = $1, pan = $2 WHERE id = $3 AND firm_id = $4',
      [name, pan, clientId, firmId]);
    if (updated.rowCount !== 1) throw new ValidationError('client was not found', 'ON-1');
    if (gstin) {
      await c.query(
        `INSERT INTO client_registrations (firm_id, client_id, gstin, state_code, is_primary)
         VALUES ($1,$2,$3,$4, NOT EXISTS (
           SELECT 1 FROM client_registrations WHERE client_id = $2 AND is_primary))
         ON CONFLICT (client_id, gstin) DO NOTHING`,
        [firmId, clientId, gstin, gstin.slice(0, 2)]);
    }
  });
}
