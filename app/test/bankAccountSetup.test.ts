import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { closePools, withFirm } from '../src/db/pool.ts';
import { accountNumberHash, createBankAccount } from '../src/domain/banking.ts';

let t: SeededTenant;

beforeAll(async () => {
  t = await seedTenant({
    firmName: `Bank setup ${randomUUID().slice(0, 8)}`,
    clientName: 'Bank setup client',
    userEmail: `bank-setup-${randomUUID()}@test.local`,
    startYear: 2026,
  });
});

afterAll(async () => closePools());

describe('bank-account setup', () => {
  it('stores only safe account identifiers and posts the opening balance', async () => {
    const account = await createBankAccount(t.firmId, {
      clientId: t.clientId,
      bankName: 'HDFC Bank',
      accountNumber: '5010 0123 4577 88',
      ifsc: 'hdfc0001234',
      kind: 'current',
      openingBalance: '2500.00',
      openingDate: '2026-04-01',
      createdBy: t.userId,
    });

    expect(account.last4).toBe('7788');
    const saved = await withFirm(t.firmId, async (c) => {
      const bank = await c.query<{
        bank_name: string; account_number_last4: string;
        account_number_hash: string; ifsc: string; opening_balance: string;
      }>('SELECT bank_name, account_number_last4, account_number_hash, ifsc, opening_balance::text FROM bank_accounts WHERE id = $1', [account.id]);
      const entries = await c.query<{ debit: string; credit: string; name: string }>(
        `SELECT le.debit::text, le.credit::text, a.name
         FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
         JOIN vouchers v ON v.id = le.voucher_id
         WHERE v.narration = $1 ORDER BY le.line_no`,
        ['Opening balance — HDFC Bank ••7788']);
      const audit = await c.query<{ after: Record<string, unknown> }>(
        `SELECT after FROM audit_log WHERE entity_type = 'bank_account' AND entity_id = $1`,
        [account.id]);
      return { bank: bank.rows[0]!, entries: entries.rows, audit: audit.rows[0]!.after };
    });

    expect(saved.bank).toEqual({
      bank_name: 'HDFC Bank',
      account_number_last4: '7788',
      account_number_hash: accountNumberHash('50100123457788'),
      ifsc: 'HDFC0001234',
      opening_balance: '2500.00',
    });
    expect(saved.entries).toEqual([
      { debit: '2500.00', credit: '0.00', name: 'Bank Accounts' },
      { debit: '0.00', credit: '2500.00', name: "Owner's Capital" },
    ]);
    expect(JSON.stringify(saved.audit)).not.toContain('50100123457788');
  });

  it('refuses to add the same account twice', async () => {
    await expect(createBankAccount(t.firmId, {
      clientId: t.clientId,
      bankName: 'HDFC Bank',
      accountNumber: '501001234577788',
      kind: 'current',
      openingBalance: '0',
      openingDate: '2026-04-01',
      createdBy: t.userId,
    })).resolves.toBeTruthy();
    await expect(createBankAccount(t.firmId, {
      clientId: t.clientId,
      bankName: 'HDFC Bank',
      accountNumber: '5010 0123 4577 788',
      kind: 'current',
      openingBalance: '0',
      openingDate: '2026-04-01',
      createdBy: t.userId,
    })).rejects.toThrow(/already added/);
  });
});
