import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { accountNumberHash } from '../src/domain/banking.ts';
import { buildBankActivityResult, getNexusBankTransactionSource } from '../src/domain/nexusBankActivity.ts';
import { withFirm, closePools } from '../src/db/pool.ts';

let tenant: SeededTenant;
let accountId: string;
let statementId: string;
const lineIds: string[] = [];

async function addLine(date: string, index: number, debit: string, credit: string, linkedStatementId: string | null = null): Promise<void> {
  const result = await withFirm(tenant.firmId, (c) => c.query<{ id: string }>(
    `INSERT INTO bank_transactions
       (firm_id, client_id, bank_account_id, statement_id, txn_date, narration, debit, credit, content_hash, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'decentro_webhook') RETURNING id`,
    [tenant.firmId, tenant.clientId, accountId, linkedStatementId, date, `Synthetic line ${index}`, debit, credit, randomUUID()]));
  lineIds.push(result.rows[0]!.id);
}

beforeAll(async () => {
  tenant = await seedTenant({ firmName: `Nexus bank ${randomUUID()}`, clientName: 'Synthetic client', userEmail: `nexus-bank-${randomUUID()}@test.local`, startYear: 2026 });
  accountId = await withFirm(tenant.firmId, async (c) => {
    const result = await c.query<{ id: string }>(
      `INSERT INTO bank_accounts
         (firm_id, client_id, account_id, bank_name, account_number_last4,
          account_number_hash, ifsc, kind, opening_balance, opening_date)
       VALUES ($1,$2,$3,'Synthetic Bank','1234',$4,'SYNB0000001','current','0','2026-04-01')
       RETURNING id`,
      [tenant.firmId, tenant.clientId, tenant.accounts['Bank Accounts'], accountNumberHash(randomUUID())]);
    return result.rows[0]!.id;
  });
  statementId = await withFirm(tenant.firmId, async (c) => {
    const result = await c.query<{ id: string }>(
      `INSERT INTO bank_statements
         (firm_id, client_id, bank_account_id, period_from, period_to, opening_balance,
          closing_balance, row_count, parse_status, parser_version, uploaded_by)
       VALUES ($1,$2,$3,'2026-10-01','2026-10-02','0','123456789012357.99',2,'parsed','test', $4)
       RETURNING id`, [tenant.firmId, tenant.clientId, accountId, tenant.userId]);
    return result.rows[0]!.id;
  });
  await addLine('2026-09-30', 0, '999.99', '0');
  await addLine('2026-10-01', 1, '12.34', '0', statementId);
  await addLine('2026-10-02', 2, '0', '123456789012345.67', statementId);
  for (let i = 3; i < 30; i++) await addLine('2026-10-03', i, '0.01', '0');
  await addLine('2026-10-11', 30, '500.00', '0');
});

afterAll(async () => { await closePools(); });

describe('Nexus bank activity result', () => {
  it('resolves a bank line for read-only evidence only inside the active client', async () => {
    const source = await getNexusBankTransactionSource(tenant.firmId, tenant.clientId, lineIds[1]!);
    expect(source).toMatchObject({
      id: lineIds[1], txn_date: '2026-10-01', narration: 'Synthetic line 1',
      debit: '12.34', credit: '0.00', bank_name: 'Synthetic Bank',
      account_number_last4: '1234', statement_from: '2026-10-01', statement_to: '2026-10-02',
    });
    await expect(getNexusBankTransactionSource(tenant.firmId, randomUUID(), lineIds[1]!)).resolves.toBeNull();
    await expect(getNexusBankTransactionSource(tenant.firmId, tenant.clientId, 'not-a-uuid')).resolves.toBeNull();
  });

  it('validates account client ownership before reading activity', async () => {
    await expect(buildBankActivityResult({
      firmId: tenant.firmId, clientId: randomUUID(), bankAccountId: accountId,
      fromDate: '2026-10-01', toDate: '2026-10-10',
    })).rejects.toThrow(/bank account not found/);
  });

  it('filters inclusive dates and preserves exact numeric totals', async () => {
    const result = await buildBankActivityResult({
      firmId: tenant.firmId, clientId: tenant.clientId, bankAccountId: accountId,
      fromDate: '2026-10-01', toDate: '2026-10-02',
    });
    const metrics = result.blocks.find((block) => block.id === 'bank-activity-totals');
    expect(metrics?.type).toBe('metrics');
    if (metrics?.type !== 'metrics') throw new Error('expected metrics block');
    expect(metrics.items.map(({ value }) => value)).toEqual(['2', '12.34', '123456789012345.67']);
    const table = result.blocks.find((block) => block.id === 'bank-activity-lines');
    if (table?.type !== 'table') throw new Error('expected table block');
    expect(table.rows.map((row) => row.id)).toEqual(lineIds.slice(1, 3));
    expect(table.rows[0]!.cells.debit).toBe('12.34');
    expect(table.rows[0]!.source_refs).toEqual([lineIds[1]]);
    expect(metrics.items[1]!.source_refs).toContain(statementId);
    const chart = result.blocks.find((block) => block.id === 'bank-activity-daily-chart');
    if (chart?.type !== 'chart') throw new Error('expected daily chart for two transaction dates');
    expect(chart.series[0]!.points.map((point) => point.value)).toEqual(['12.34', '0.00']);
    expect(chart.table_fallback.rows[0]!.cells.value).toBe('12.34');
  });

  it('bounds displayed lines and marks partial coverage while totals cover every line', async () => {
    const result = await buildBankActivityResult({
      firmId: tenant.firmId, clientId: tenant.clientId, bankAccountId: accountId,
      fromDate: '2026-10-01', toDate: '2026-10-10',
    });
    const metrics = result.blocks.find((block) => block.id === 'bank-activity-totals');
    if (metrics?.type !== 'metrics') throw new Error('expected metrics block');
    expect(metrics.items[0]!.value).toBe('29');
    expect(metrics.items[1]!.value).toBe('12.61');
    const table = result.blocks.find((block) => block.id === 'bank-activity-lines');
    if (table?.type !== 'table') throw new Error('expected table block');
    expect(table.rows).toHaveLength(25);
    expect(table.provenance.coverage.completeness).toBe('partial');
    expect(table.provenance.coverage.limitations[0]).toContain('Showing 25 of 29');
    expect(table.provenance.coverage.limitations.some((item) => item.includes('Aggregate provenance lists'))).toBe(true);
    const chart = result.blocks.find((block) => block.id === 'bank-activity-daily-chart');
    if (chart?.type !== 'chart') throw new Error('expected daily chart for multi-day activity');
    expect(chart.table_fallback.rows).toHaveLength(6);
  });

  it('explains chart omission for one date and sources unlinked webhook totals by transaction', async () => {
    const result = await buildBankActivityResult({
      firmId: tenant.firmId, clientId: tenant.clientId, bankAccountId: accountId,
      fromDate: '2026-10-03', toDate: '2026-10-03',
    });
    const summary = result.blocks.find((block) => block.id === 'bank-activity-summary');
    expect(summary?.type).toBe('paragraph');
    if (summary?.type !== 'paragraph') throw new Error('expected summary block');
    expect(summary.text).toContain('daily chart is omitted');
    expect(summary.provenance?.coverage.limitations.some((item) => item.includes('fewer than two transaction dates'))).toBe(true);
    const metrics = result.blocks.find((block) => block.id === 'bank-activity-totals');
    if (metrics?.type !== 'metrics') throw new Error('expected metrics block');
    expect(metrics.items[1]!.source_refs.every((id) => id !== statementId)).toBe(true);
    const sourceKinds = new Map(summary.provenance?.sources.map((source) => [source.id, source.kind]));
    expect(metrics.items[1]!.source_refs.every((id) => sourceKinds.get(id) === 'bank_transaction')).toBe(true);
  });
});
