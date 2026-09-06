/**
 * Period close — gl-engine.md §7.4, BR-23. DEFECT-LOG G-4.
 *
 * BR-23 was implemented and tested, and nothing ever called it, because there
 * was no close path to call it from: `accounting_periods.is_closed` existed,
 * the database refused to post into a closed period, and no function in the
 * codebase could set the flag. A control with no moment at which to fire.
 *
 * The test that matters is the first one — an untied bank account must BLOCK,
 * not warn. A warning at close time is read by someone whose goal at that
 * moment is to close.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { postVoucher } from '../src/domain/posting.ts';
import { closePeriod, reopenPeriod, periodCloseCheck } from '../src/domain/periodClose.ts';
import { accountNumberHash } from '../src/domain/banking.ts';
import { ownerPool, withFirm, closePools } from '../src/db/pool.ts';

let t: SeededTenant;
let bankAccountId: string;

const A = (n: string): string => t.accounts[n]!;

beforeAll(async () => {
  t = await seedTenant({
    firmName: `Close Firm ${randomUUID().slice(0, 8)}`,
    clientName: 'Close Test Ltd',
    userEmail: `close-${randomUUID()}@test.local`,
    startYear: 2026,
  });

  bankAccountId = await withFirm(t.firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO bank_accounts (firm_id, client_id, account_id, bank_name,
                                  account_number_last4, account_number_hash,
                                  opening_date)
       VALUES ($1,$2,$3,'HDFC Bank','1234',$4,'2026-04-01') RETURNING id`,
      [t.firmId, t.clientId, A('Bank Accounts'), accountNumberHash('000000001234')]);
    return r.rows[0]!.id;
  });
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('period close (G-4, BR-23)', () => {
  it('closes a clean month', async () => {
    const r = await closePeriod(t.firmId, {
      clientId: t.clientId, label: '2026-04', closedBy: t.userId,
    });
    expect(r.label).toBe('2026-04');
    expect(r.overridden).toEqual([]);
  });

  it('the database then refuses to post into it', async () => {
    // The close has teeth because `resolve_open_fiscal_year` enforces it in
    // SQL — a caller that forgets to check cannot get around it.
    await expect(postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'journal', postingDate: '2026-04-15',
      createdBy: t.userId,
      lines: [{ accountId: A('Cash'), debit: '100' },
              { accountId: A('Sales'), credit: '100' }],
    })).rejects.toThrow(/closed/i);
  });

  it('refuses to close twice', async () => {
    await expect(closePeriod(t.firmId, {
      clientId: t.clientId, label: '2026-04', closedBy: t.userId,
    })).rejects.toThrow(/already closed/);
  });

  it('BLOCKS a close when a bank account does not reconcile', async () => {
    // The whole point of BR-23.
    //
    // The discrepancy used here is a real and common migration error: an
    // account is created with the balance the bank shows, and the opening
    // journal that would put it in the books is never posted. The BRS then
    // cannot tie, because there is nothing on the book side to tie TO.
    //
    // Note what does NOT break a BRS: an imported statement line with no
    // matching voucher. That is an ordinary reconciling item — "bank credit not
    // in books" — and the statement ties with it included. BR-22 is about a
    // residual that no reconciling item explains, which is the only kind of
    // difference worth blocking a close for.
    await withFirm(t.firmId, (c) => c.query(
      `INSERT INTO bank_accounts (firm_id, client_id, account_id, bank_name,
                                  account_number_last4, account_number_hash,
                                  opening_balance, opening_date)
       VALUES ($1,$2,$3,'ICICI Bank','9999',$4,'5000.00','2026-05-01')`,
      [t.firmId, t.clientId, A('Bank Accounts'), accountNumberHash('000000009999')]));

    const check = await periodCloseCheck(t.firmId, t.clientId, '2026-05');
    expect(check.ok).toBe(false);
    expect(check.blockers.join(' ')).toMatch(/ICICI Bank/);

    await expect(closePeriod(t.firmId, {
      clientId: t.clientId, label: '2026-05', closedBy: t.userId,
    })).rejects.toThrow(/cannot be closed/);
  });

  it('allows an override, and records what was overridden', async () => {
    // Refusing absolutely would mean the close happens by an UPDATE against
    // the database instead — the same act, with no record of who decided it.
    const r = await closePeriod(t.firmId, {
      clientId: t.clientId, label: '2026-05', closedBy: t.userId,
      overrideReason: 'client will not supply the May statement; GSTR-3B due',
    });
    expect(r.overridden.length).toBeGreaterThan(0);

    const audit = await ownerPool.query<{ after: { override_reason: string } }>(
      `SELECT after FROM audit_log
       WHERE entity_type = 'accounting_period' AND action = 'close'
         AND entity_id = $1`, [r.periodId]);
    expect(audit.rows[0]!.after.override_reason).toMatch(/GSTR-3B due/);
  });

  it('reopens only with a reason, and audits it', async () => {
    // A close with no way back is a trap: one premature close and the month can
    // only be corrected by a later-dated adjustment — the exact harm closing
    // was meant to prevent.
    await expect(reopenPeriod(t.firmId, {
      clientId: t.clientId, label: '2026-04', reopenedBy: t.userId, reason: '  ',
    })).rejects.toThrow(/requires a reason/);

    await reopenPeriod(t.firmId, {
      clientId: t.clientId, label: '2026-04', reopenedBy: t.userId,
      reason: 'April purchase bill arrived late',
    });

    // Posting works again.
    const v = await postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'journal', postingDate: '2026-04-15',
      createdBy: t.userId,
      lines: [{ accountId: A('Cash'), debit: '100' },
              { accountId: A('Sales'), credit: '100' }],
    });
    expect(v.id).toBeTruthy();

    const audit = await ownerPool.query(
      `SELECT 1 FROM audit_log
       WHERE entity_type = 'accounting_period' AND action = 'reopen'`);
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it('refuses to reopen a period that is not closed', async () => {
    await expect(reopenPeriod(t.firmId, {
      clientId: t.clientId, label: '2026-07', reopenedBy: t.userId, reason: 'x',
    })).rejects.toThrow(/not closed/);
  });

  it('rejects an unknown period label', async () => {
    await expect(periodCloseCheck(t.firmId, t.clientId, '2099-01'))
      .rejects.toThrow(/no accounting period/);
  });
});
