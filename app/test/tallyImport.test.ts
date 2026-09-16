import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseTallyXml } from '../src/parse/tallyXml.ts';
import { importTallyPreview } from '../src/domain/tallyImport.ts';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { closePools, ownerPool } from '../src/db/pool.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';

let t: SeededTenant;

const GSTIN14 = '27AABCA4444P1Z';
const CUSTOMER_GSTIN = GSTIN14 + gstinCheckDigit(GSTIN14);
const xml = `<ENVELOPE><BODY><DATA>
  <TALLYMESSAGE><LEDGER NAME="Acme Trading"><PARENT>Sundry Debtors</PARENT>
    <MAILINGNAME>Acme Trading Private Limited</MAILINGNAME>
    <ADDRESS.LIST><ADDRESS>Fort</ADDRESS><ADDRESS>Mumbai</ADDRESS></ADDRESS.LIST>
    <PARTYGSTIN>${CUSTOMER_GSTIN}</PARTYGSTIN>
  </LEDGER></TALLYMESSAGE><TALLYMESSAGE>
  <VOUCHER VCHTYPE="Journal">
    <DATE>20260405</DATE><GUID>tally-guid-journal-1</GUID>
    <VOUCHERNUMBER>J-1</VOUCHERNUMBER><NARRATION>Opening correction</NARRATION>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme Trading</LEDGERNAME><AMOUNT>-100</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>100</AMOUNT></ALLLEDGERENTRIES.LIST>
  </VOUCHER>
</TALLYMESSAGE></DATA></BODY></ENVELOPE>`;

beforeAll(async () => {
  t = await seedTenant({
    firmName: `Tally ${randomUUID().slice(0, 8)}`,
    clientName: 'Tally Client', userEmail: `tally-${randomUUID()}@test.local`,
    startYear: 2026,
  });
});

afterAll(async () => { await closePools(); });

describe('confirmed Tally import', () => {
  it('posts through the GL with source identity and skips the same voucher on resume', async () => {
    const preview = parseTallyXml(xml);
    const mappings = { 'Acme Trading': t.accounts.Debtors!, Sales: t.accounts.Sales! };

    const first = await importTallyPreview(t.firmId, t.clientId, t.userId, preview, mappings);
    expect(first).toMatchObject({ imported: 1, skippedDuplicates: 0 });

    const row = await ownerPool.query<{
      voucher_number: string; created_via: string; external_id: string; lines: string;
    }>(
      `SELECT v.voucher_number, v.created_via::text, v.external_id,
              COUNT(le.id)::text AS lines
         FROM vouchers v JOIN ledger_entries le ON le.voucher_id = v.id
        WHERE v.client_id = $1 AND v.external_id = 'tally:tally-guid-journal-1'
        GROUP BY v.id`, [t.clientId]);
    expect(row.rows[0]).toEqual({
      voucher_number: 'TLY/J-1', created_via: 'tally_import',
      external_id: 'tally:tally-guid-journal-1', lines: '2',
    });

    const party = await ownerPool.query<{ id: string; name: string; legal_name: string; gstin: string }>(
      `SELECT id, name, legal_name, gstin FROM parties
        WHERE client_id = $1 AND party_type = 'customer' AND gstin = $2`,
      [t.clientId, CUSTOMER_GSTIN]);
    expect(party.rows[0]).toMatchObject({
      name: 'Acme Trading', legal_name: 'Acme Trading Private Limited', gstin: CUSTOMER_GSTIN,
    });
    const dimension = await ownerPool.query<{ party_id: string }>(
      `SELECT le.party_id FROM ledger_entries le JOIN vouchers v ON v.id = le.voucher_id
        WHERE v.client_id = $1 AND v.external_id = 'tally:tally-guid-journal-1'
          AND le.account_id = $2`, [t.clientId, t.accounts.Debtors]);
    expect(dimension.rows[0]!.party_id).toBe(party.rows[0]!.id);

    const resumed = await importTallyPreview(t.firmId, t.clientId, t.userId, preview, mappings);
    expect(resumed).toMatchObject({ imported: 0, skippedDuplicates: 1 });
  });

  it('refuses an incomplete mapping before posting', async () => {
    await expect(importTallyPreview(
      t.firmId, t.clientId, t.userId, parseTallyXml(xml), { 'Acme Trading': t.accounts.Debtors! },
    )).rejects.toThrow(/map the Tally ledger "Sales"/);
  });
});
