/** Map a reviewed Tally XML preview onto the existing chart and post it. */

import { createHash, randomUUID } from 'node:crypto';
import { withFirm } from '../db/pool.ts';
import { postVoucher } from './posting.ts';
import { ValidationError } from './types.ts';
import type { TallyPreview, TallyVoucher } from '../parse/tallyXml.ts';
import { validateGstin } from './gstin.ts';

export interface TallyAccountChoice {
  id: string;
  name: string;
  rootType: string;
  accountType: string;
}

export interface TallyLedgerMapping {
  sourceName: string;
  usedIn: number;
  suggestedAccountId: string | null;
  partyType: 'customer' | 'supplier' | null;
}

const normal = (value: string): string => value.toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\b(a\/c|account)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const ALIASES: Record<string, string> = {
  'sundry debtors': 'debtors',
  'sundry creditors': 'creditors',
  'sales accounts': 'sales',
  'purchase accounts': 'purchases',
  'output cgst': 'output cgst payable',
  'output sgst': 'output sgst payable',
  'output igst': 'output igst payable',
  'rounding off': 'round off',
};

export function suggestTallyMappings(
  preview: TallyPreview, accounts: TallyAccountChoice[],
): TallyLedgerMapping[] {
  const usage = new Map<string, number>();
  const masters = new Map(preview.ledgers.map((ledger) => [ledger.name, ledger]));
  for (const voucher of preview.vouchers) {
    for (const entry of voucher.entries) {
      usage.set(entry.ledgerName, (usage.get(entry.ledgerName) ?? 0) + 1);
    }
  }
  const byName = new Map<string, TallyAccountChoice[]>();
  for (const account of accounts) {
    const key = normal(account.name);
    byName.set(key, [...(byName.get(key) ?? []), account]);
  }

  return [...usage.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sourceName, usedIn]) => {
    const source = normal(sourceName);
    const master = masters.get(sourceName);
    const partyTarget = master?.partyType === 'customer' ? 'debtors'
      : master?.partyType === 'supplier' ? 'creditors' : null;
    const candidates = byName.get(partyTarget ?? source)
      ?? byName.get(ALIASES[source] ?? '') ?? [];
    return {
      sourceName, usedIn,
      suggestedAccountId: candidates.length === 1 ? candidates[0]!.id : null,
      partyType: master?.partyType ?? null,
    };
  });
}

export async function tallyMappingDesk(
  firmId: string, clientId: string, preview: TallyPreview,
): Promise<{ accounts: TallyAccountChoice[]; mappings: TallyLedgerMapping[] }> {
  const accounts = await withFirm(firmId, async (c) => {
    const r = await c.query<{ id: string; name: string; root_type: string; account_type: string }>(
      `SELECT id, name, root_type::text, account_type::text
         FROM accounts
        WHERE client_id = $1 AND NOT is_group AND NOT is_disabled
        ORDER BY root_type, code NULLS LAST, name`, [clientId]);
    return r.rows.map((x) => ({
      id: x.id, name: x.name, rootType: x.root_type, accountType: x.account_type,
    }));
  });
  return { accounts, mappings: suggestTallyMappings(preview, accounts) };
}

function fingerprint(voucher: TallyVoucher): string {
  if (voucher.guid) return `tally:${voucher.guid}`;
  const stable = JSON.stringify({
    type: voucher.sourceType, number: voucher.number, date: voucher.date,
    narration: voucher.narration,
    entries: voucher.entries.map((x) => [x.ledgerName, x.signedAmount]),
  });
  return `tally:sha256:${createHash('sha256').update(stable).digest('hex')}`;
}

export interface ConfirmedTallyImport {
  batchId: string;
  imported: number;
  skippedDuplicates: number;
}

export async function importTallyPreview(
  firmId: string,
  clientId: string,
  userId: string,
  preview: TallyPreview,
  mappings: Record<string, string>,
): Promise<ConfirmedTallyImport> {
  if (preview.vouchers.length === 0) {
    throw new ValidationError('this export contains no vouchers', 'TM-2');
  }
  const invalid = preview.vouchers.find((v) => !v.balanced || !v.type || !v.date);
  if (invalid) {
    throw new ValidationError(
      `voucher ${invalid.number ?? '(unnumbered)'} is unbalanced, unsupported, or has an invalid date`,
      'TM-2',
    );
  }

  const sourceNames = [...new Set(preview.vouchers.flatMap((v) =>
    v.entries.map((e) => e.ledgerName)))];
  for (const source of sourceNames) {
    if (!mappings[source]) {
      throw new ValidationError(`map the Tally ledger "${source}" before importing`, 'TM-3');
    }
  }

  const mappedIds = [...new Set(sourceNames.map((name) => mappings[name]!))];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (mappedIds.some((id) => !uuid.test(id))) {
    throw new ValidationError('a mapped ledger has an invalid account ID', 'TM-3');
  }
  const allowed = await withFirm(firmId, async (c) => {
    const r = await c.query<{ id: string; account_type: string }>(
      `SELECT id, account_type::text FROM accounts
        WHERE client_id = $1 AND id = ANY($2::uuid[])
          AND NOT is_group AND NOT is_disabled`, [clientId, mappedIds]);
    return new Map(r.rows.map((x) => [x.id, x.account_type]));
  });
  if (mappedIds.some((id) => !allowed.has(id))) {
    throw new ValidationError('a mapped ledger is not an active account for this client', 'TM-3');
  }

  const partyMasters = preview.ledgers.filter((ledger) =>
    ledger.partyType !== null && sourceNames.includes(ledger.name));
  for (const ledger of partyMasters) {
    const required = ledger.partyType === 'customer' ? 'receivable' : 'payable';
    if (allowed.get(mappings[ledger.name]!) !== required) {
      throw new ValidationError(
        `${ledger.name} is a ${ledger.partyType}; map it to a ${required} account`, 'TM-3');
    }
    if (ledger.gstin) {
      const check = validateGstin(ledger.gstin);
      if (!check.valid) {
        throw new ValidationError(`party ${ledger.name} has an invalid GSTIN — ${check.reason}`, 'TM-4');
      }
    }
  }

  // Preflight every date before the first write. A historical export often
  // spans years that have not been configured yet; discovering that halfway
  // through would create a needlessly partial import.
  await withFirm(firmId, async (c) => {
    for (const date of new Set(preview.vouchers.map((v) => v.date!))) {
      await c.query('SELECT resolve_open_fiscal_year($1, $2)', [clientId, date]);
    }
  });

  const partyIds = new Map<string, { id: string; type: 'customer' | 'supplier' }>();
  for (const ledger of partyMasters) {
    const party = await withFirm(firmId, async (c) => {
      const existing = await c.query<{
        id: string; party_type: 'customer' | 'supplier' | 'employee';
        ledger_account_id: string;
      }>(ledger.gstin
        ? `SELECT id, party_type::text, ledger_account_id FROM parties
            WHERE client_id = $1 AND gstin = $2`
        : `SELECT id, party_type::text, ledger_account_id FROM parties
            WHERE client_id = $1 AND party_type = $2 AND lower(name) = lower($3)`,
      ledger.gstin
        ? [clientId, ledger.gstin]
        : [clientId, ledger.partyType, ledger.name]);

      if ((existing.rowCount ?? 0) > 0) {
        const found = existing.rows[0]!;
        if (found.party_type !== ledger.partyType) {
          throw new ValidationError(
            `${ledger.name} already exists as a ${found.party_type}; dual-role parties need review`, 'TM-4');
        }
        if (found.ledger_account_id !== mappings[ledger.name]) {
          throw new ValidationError(
            `${ledger.name} is already linked to a different control account`, 'TM-4');
        }
        return { id: found.id, type: ledger.partyType! };
      }

      const category = ledger.gstin
        ? /compos/i.test(ledger.gstRegistrationType ?? '')
          ? 'registered_composition' : 'registered_regular'
        : 'unregistered';
      const created = await c.query<{ id: string }>(
        `INSERT INTO parties
           (firm_id, client_id, party_type, name, legal_name, gstin, pan,
            gst_category, state_code, billing_address, ledger_account_id,
            is_active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12)
         RETURNING id`,
        [firmId, clientId, ledger.partyType, ledger.name,
         ledger.mailingName ?? ledger.name, ledger.gstin,
         ledger.gstin?.slice(2, 12) ?? null, category,
         ledger.gstin?.slice(0, 2) ?? null,
         ledger.address ? JSON.stringify({ line1: ledger.address }) : null,
         mappings[ledger.name], userId]);
      const id = created.rows[0]!.id;
      await c.query(
        `INSERT INTO audit_log
           (firm_id, client_id, entity_type, entity_id, action, after,
            actor_user_id, actor_type)
         VALUES ($1,$2,$3,$4,'create',$5,$6,'human')`,
        [firmId, clientId, ledger.partyType, id,
         JSON.stringify({ source: 'tally_import', name: ledger.name, gstin: ledger.gstin }),
         userId]);
      return { id, type: ledger.partyType! };
    });
    partyIds.set(ledger.name, party);
  }

  const batchId = randomUUID();
  let imported = 0, skippedDuplicates = 0;
  for (const [index, voucher] of preview.vouchers.entries()) {
    const externalId = fingerprint(voucher);
    const exists = await withFirm(firmId, async (c) => {
      const r = await c.query(
        `SELECT 1 FROM vouchers
          WHERE client_id = $1 AND created_via = 'tally_import' AND external_id = $2`,
        [clientId, externalId]);
      return (r.rowCount ?? 0) > 0;
    });
    if (exists) { skippedDuplicates++; continue; }

    await postVoucher(firmId, {
      clientId,
      voucherType: voucher.type!,
      postingDate: voucher.date!,
      voucherNumber: `TLY/${voucher.number || String(index + 1)}`,
      narration: voucher.narration ?? `Imported from Tally (${voucher.sourceType})`,
      lines: voucher.entries.map((entry) => ({
        accountId: mappings[entry.ledgerName]!,
        debit: entry.debit,
        credit: entry.credit,
        partyType: partyIds.get(entry.ledgerName)?.type,
        partyId: partyIds.get(entry.ledgerName)?.id,
      })),
      createdBy: userId,
      createdVia: 'tally_import',
      actorType: 'human',
      batchId,
      externalId,
    });
    imported++;
  }

  return { batchId, imported, skippedDuplicates };
}
