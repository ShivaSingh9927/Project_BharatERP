/**
 * GL engine acceptance tests.
 *
 * These are the test cases from gl-engine.md §11 and audit-trail.md §8,
 * executable. Each test names the spec rule it proves.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { postVoucher, reverseVoucher } from '../src/domain/posting.ts';
import { ValidationError } from '../src/domain/types.ts';
import { trialBalance, balanceSheet, profitAndLoss } from '../src/reports/index.ts';
import { appPool, ownerPool, withFirm, closePools } from '../src/db/pool.ts';

let t: SeededTenant;
const A = (name: string): string => {
  const id = t.accounts[name];
  if (!id) throw new Error(`account "${name}" not in seeded chart`);
  return id;
};

beforeAll(async () => {
  t = await seedTenant({
    firmName: `Test Firm ${randomUUID().slice(0, 8)}`,
    clientName: 'Test Client',
    userEmail: `ca-${randomUUID()}@test.local`,
    startYear: 2026,
  });
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('validation (gl-engine.md §6)', () => {
  it('T-1 rejects an unbalanced voucher and writes nothing (V-1)', async () => {
    const before = await withFirm(t.firmId, (c) =>
      c.query('SELECT count(*)::int n FROM vouchers WHERE client_id = $1', [t.clientId]));

    await expect(postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'journal', postingDate: '2026-09-01',
      createdBy: t.userId,
      lines: [
        { accountId: A('Office Rent'), debit: '11800.00' },
        { accountId: A('Cash'), credit: '10900.00' },
      ],
    })).rejects.toThrow(ValidationError);

    const after = await withFirm(t.firmId, (c) =>
      c.query('SELECT count(*)::int n FROM vouchers WHERE client_id = $1', [t.clientId]));
    expect(after.rows[0].n).toBe(before.rows[0].n);   // nothing written
  });

  it('T-2 rejects a line carrying both a debit and a credit (V-3)', async () => {
    await expect(postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'journal', postingDate: '2026-09-01',
      createdBy: t.userId,
      lines: [
        { accountId: A('Office Rent'), debit: '100.00', credit: '100.00' },
        { accountId: A('Cash'), credit: '100.00' },
      ],
    })).rejects.toThrow(/V-3/);
  });

  it('T-3 rejects posting to a group account (V-4)', async () => {
    await expect(postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'journal', postingDate: '2026-09-01',
      createdBy: t.userId,
      lines: [
        { accountId: A('Current Assets'), debit: '100.00' },   // a group node
        { accountId: A('Cash'), credit: '100.00' },
      ],
    })).rejects.toThrow(/V-4/);
  });

  it('T-4 rejects a receivable line with no party (V-5)', async () => {
    await expect(postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'sales', postingDate: '2026-09-01',
      createdBy: t.userId,
      lines: [
        { accountId: A('Debtors'), debit: '100.00' },          // party omitted
        { accountId: A('Sales'), credit: '100.00' },
      ],
    })).rejects.toThrow(/V-5/);
  });

  it('T-8 rejects a posting date outside any open fiscal year (V-6)', async () => {
    await expect(postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'journal', postingDate: '2019-01-01',
      createdBy: t.userId,
      lines: [
        { accountId: A('Office Rent'), debit: '100.00' },
        { accountId: A('Cash'), credit: '100.00' },
      ],
    })).rejects.toThrow(/V-6/);
  });

  it('T-16 rejects an AI-originated voucher with no human approver (V-12, AT-13)', async () => {
    await expect(postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'purchase', postingDate: '2026-09-01',
      createdBy: t.userId, createdVia: 'ai_proposal',   // approvedBy omitted
      lines: [
        { accountId: A('Purchases'), debit: '100.00' },
        { accountId: A('Creditors'), credit: '100.00', partyType: 'supplier', partyId: randomUUID() },
      ],
    })).rejects.toThrow(/V-12/);
  });

  it('accepts an AI-originated voucher when a CA approved it', async () => {
    const v = await postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'purchase', postingDate: '2026-09-01',
      createdBy: t.userId, createdVia: 'ai_proposal',
      approvedBy: t.userId, aiModel: 'deepseek-v4-flash',
      lines: [
        { accountId: A('Purchases'), debit: '100.00' },
        { accountId: A('Creditors'), credit: '100.00', partyType: 'supplier', partyId: randomUUID() },
      ],
    });
    expect(v.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('GST posting templates (gl-engine.md §5.5, Lesson 5)', () => {
  it('T-5 intra-state sale splits into CGST + SGST', async () => {
    const customer = randomUUID();
    const v = await postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'sales', postingDate: '2026-09-02',
      narration: 'Intra-state sale, 18%', createdBy: t.userId,
      lines: [
        { accountId: A('Debtors'), debit: '11800.00', partyType: 'customer', partyId: customer },
        { accountId: A('Sales'), credit: '10000.00' },
        { accountId: A('Output CGST Payable'), credit: '900.00' },
        { accountId: A('Output SGST Payable'), credit: '900.00' },
      ],
    });
    expect(v.lineCount).toBe(4);
  });

  it('T-6 inter-state sale uses a single IGST line', async () => {
    const customer = randomUUID();
    const v = await postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'sales', postingDate: '2026-09-02',
      narration: 'Inter-state sale, 18%', createdBy: t.userId,
      lines: [
        { accountId: A('Debtors'), debit: '11800.00', partyType: 'customer', partyId: customer },
        { accountId: A('Sales'), credit: '10000.00' },
        { accountId: A('Output IGST Payable'), credit: '1800.00' },
      ],
    });
    expect(v.lineCount).toBe(3);
  });

  it('posts a vendor payment with TDS withheld (Lesson 6)', async () => {
    const supplier = randomUUID();
    await postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'purchase', postingDate: '2026-09-03',
      createdBy: t.userId,
      lines: [
        { accountId: A('Professional Fees'), debit: '50000.00' },
        { accountId: A('Creditors'), credit: '50000.00', partyType: 'supplier', partyId: supplier },
      ],
    });
    const v = await postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'payment', postingDate: '2026-09-04',
      narration: 'Consultant payment, 10% TDS u/s 194J-equivalent', createdBy: t.userId,
      lines: [
        { accountId: A('Creditors'), debit: '50000.00', partyType: 'supplier', partyId: supplier },
        { accountId: A('TDS Payable'), credit: '5000.00' },
        { accountId: A('Bank Accounts'), credit: '45000.00' },
      ],
    });
    expect(v.lineCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('reversal (GL-6, AT-3/AT-4)', () => {
  it('T-11 reversal leaves the original intact and nets the ledger to zero', async () => {
    const orig = await postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'journal', postingDate: '2026-09-05',
      narration: 'Mistaken entry', createdBy: t.userId,
      lines: [
        { accountId: A('Marketing'), debit: '7500.00' },
        { accountId: A('Bank Accounts'), credit: '7500.00' },
      ],
    });

    const rev = await reverseVoucher(t.firmId, orig.id, {
      reason: 'wrong account', reversedBy: t.userId,
    });

    const r = await withFirm(t.firmId, (c) => c.query(
      `SELECT
         (SELECT count(*)::int FROM vouchers WHERE id = $1)                       AS original_present,
         (SELECT is_reversed FROM vouchers_with_reversal WHERE id = $1)           AS is_reversed,
         (SELECT COALESCE(SUM(debit - credit),0)::text
            FROM ledger_entries WHERE voucher_id IN ($1, $2))                     AS net`,
      [orig.id, rev.id]));

    expect(r.rows[0].original_present).toBe(1);      // original never deleted
    expect(r.rows[0].is_reversed).toBe(true);        // derived, not stored
    expect(Number(r.rows[0].net)).toBe(0);           // net effect zero
  });

  it('refuses to reverse the same voucher twice', async () => {
    const v = await postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'journal', postingDate: '2026-09-05',
      createdBy: t.userId,
      lines: [
        { accountId: A('Travel Expenses'), debit: '1000.00' },
        { accountId: A('Cash'), credit: '1000.00' },
      ],
    });
    await reverseVoucher(t.firmId, v.id, { reason: 'first', reversedBy: t.userId });
    await expect(reverseVoucher(t.firmId, v.id, { reason: 'second', reversedBy: t.userId }))
      .rejects.toThrow(/already reversed/);
  });
});

// ---------------------------------------------------------------------------
describe('append-only enforcement (audit-trail.md AT-2)', () => {
  it('AT T-1 the app role cannot UPDATE a posted ledger entry', async () => {
    await expect(
      appPool.query('UPDATE ledger_entries SET debit = 1 WHERE true'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('AT T-2 the app role cannot DELETE a posted ledger entry', async () => {
    await expect(
      appPool.query('DELETE FROM ledger_entries WHERE true'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('AT T-2b the app role cannot UPDATE or DELETE a voucher', async () => {
    await expect(appPool.query('UPDATE vouchers SET narration = $1', ['x']))
      .rejects.toThrow(/permission denied/i);
    await expect(appPool.query('DELETE FROM vouchers WHERE true'))
      .rejects.toThrow(/permission denied/i);
  });

  it('AT T-3 the app role cannot modify the audit log', async () => {
    await expect(appPool.query('UPDATE audit_log SET action = $1', ['create']))
      .rejects.toThrow(/permission denied/i);
    await expect(appPool.query('DELETE FROM audit_log WHERE true'))
      .rejects.toThrow(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
describe('audit hash chain (audit-trail.md §4.5)', () => {
  it('verifies intact for a firm with activity', async () => {
    const r = await ownerPool.query('SELECT * FROM verify_audit_chain($1)', [t.firmId]);
    expect(r.rows[0].ok).toBe(true);
    expect(Number(r.rows[0].checked)).toBeGreaterThan(0);
  });

  it('AT T-12 detects tampering done with direct database access', async () => {
    // The owner role can bypass permissions — this simulates someone with
    // direct DB credentials editing history. The chain must still expose it.
    const row = await ownerPool.query(
      'SELECT id FROM audit_log WHERE firm_id = $1 ORDER BY id LIMIT 1', [t.firmId]);
    const id = row.rows[0].id;
    const original = await ownerPool.query('SELECT after FROM audit_log WHERE id = $1', [id]);

    await ownerPool.query(
      `UPDATE audit_log SET after = jsonb_set(COALESCE(after,'{}'::jsonb),
        '{tampered}', 'true') WHERE id = $1`, [id]);

    const bad = await ownerPool.query('SELECT * FROM verify_audit_chain($1)', [t.firmId]);
    expect(bad.rows[0].ok).toBe(false);
    expect(Number(bad.rows[0].broken_at)).toBe(Number(id));

    // restore so later assertions in this file still see an intact chain
    await ownerPool.query('UPDATE audit_log SET after = $2 WHERE id = $1',
      [id, original.rows[0].after]);
    const good = await ownerPool.query('SELECT * FROM verify_audit_chain($1)', [t.firmId]);
    expect(good.rows[0].ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('multi-tenancy (gl-engine.md §9)', () => {
  it('T-17 one firm cannot see another firm\'s ledger', async () => {
    const other = await seedTenant({
      firmName: `Other Firm ${randomUUID().slice(0, 8)}`,
      clientName: 'Other Client',
      userEmail: `other-${randomUUID()}@test.local`,
      startYear: 2026,
    });

    // Query firm B's client while the session is scoped to firm A.
    const leaked = await withFirm(t.firmId, (c) => c.query(
      'SELECT count(*)::int n FROM ledger_entries WHERE client_id = $1', [other.clientId]));
    expect(leaked.rows[0].n).toBe(0);

    const visible = await withFirm(t.firmId, (c) => c.query(
      'SELECT count(*)::int n FROM clients')); // RLS scopes this automatically
    expect(visible.rows[0].n).toBe(1);
  });
});
