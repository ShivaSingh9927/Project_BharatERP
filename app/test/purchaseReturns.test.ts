/**
 * Returning goods to a supplier — bills-and-expenses.md BE-38.
 *
 * The asymmetry under test: our debit note reduces what we owe and reverses
 * our own credit immediately, because that is our duty; the SUPPLIER's credit
 * note is what makes the tax side supportable, and it arrives later or not at
 * all. A return that conflated the two would claim support that does not
 * exist.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, registerGstin, type SeededTenant } from '../src/seed/index.ts';
import { seedItcEligibility } from '../src/seed/tdsSections.ts';
import { createBill } from '../src/domain/bills.ts';
import { createPurchaseReturn, recordSupplierCreditNote,
         purchaseReturns } from '../src/domain/purchaseReturns.ts';
import { outstandingBills, recordPayment } from '../src/domain/payables.ts';
import { generateGstr3b } from '../src/domain/gstr3b.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { trialBalance } from '../src/reports/index.ts';
import { ownerPool, closePools } from '../src/db/pool.ts';

const gstin = (state: string, pan: string) => {
  const f = `${state}${pan}1Z`;
  return f + gstinCheckDigit(f);
};

let t: SeededTenant;
const acct: Record<string, string> = {};
let supplier: string;

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  t = await seedTenant({
    firmName: `Ret ${tag}`, clientName: `Client ${tag}`,
    userEmail: `ret-${tag}@example.test`, startYear: 2026,
    pan: 'AAACR4444R', businessType: 'general',
  });
  await seedItcEligibility(t.clientId);
  await registerGstin(t.firmId, t.clientId, gstin('09', 'AAACR4444R'), { primary: true });

  const r = await ownerPool.query<{ id: string; name: string }>(
    `SELECT id, name FROM accounts WHERE client_id = $1 AND NOT is_group
       AND name IN ('Raw Materials','Travel Expenses','Creditors','Bank Accounts',
                    'Input CGST Credit','Input SGST Credit','Input IGST Credit')`,
    [t.clientId]);
  for (const a of r.rows) acct[a.name] = a.id;

  supplier = (await ownerPool.query<{ id: string }>(
    `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name, gstin,
                          gst_category, state_code, ledger_account_id, created_by)
     VALUES ($1,$2,'supplier','Verma Traders','Verma Traders',$3,
             'registered_regular','09',$4,$5) RETURNING id`,
    [t.firmId, t.clientId, gstin('09', 'AABCV5555V'), acct['Creditors'], t.userId])).rows[0]!.id;
});

afterAll(async () => { await closePools(); });

const legs = async (voucherId: string) => {
  const r = await ownerPool.query<{ name: string; debit: string; credit: string }>(
    `SELECT a.name, le.debit::text, le.credit::text
       FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
      WHERE le.voucher_id = $1`, [voucherId]);
  return Object.fromEntries(r.rows.map((x) => [x.name, x]));
};

// ---------------------------------------------------------------------------
describe('a return against a bill', () => {
  let billId: string;

  beforeAll(async () => {
    // Intra-state: 10,000 at 18% is 900 CGST + 900 SGST.
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'VT/100', billDate: '2026-05-10',
      lines: [{ description: 'Steel bar', quantity: '10', unitPrice: '1000',
                gstRate: '18', expenseAccountId: acct['Raw Materials']! }],
      createdBy: t.userId,
    });
    billId = bill.voucherId;
  });

  it('refuses a return with no reason', async () => {
    await expect(createPurchaseReturn(t.firmId, {
      clientId: t.clientId, billVoucherId: billId, noteNumber: 'DN/1',
      noteDate: '2026-05-15', reason: '   ',
      lines: [{ billLineNo: 1, taxableValue: '1000' }], createdBy: t.userId,
    })).rejects.toThrow(/say why the goods went back/);
  });

  it('refuses a return dated before the bill', async () => {
    // Goods cannot go back before they arrived.
    await expect(createPurchaseReturn(t.firmId, {
      clientId: t.clientId, billVoucherId: billId, noteNumber: 'DN/1',
      noteDate: '2026-05-01', reason: 'Damaged',
      lines: [{ billLineNo: 1, taxableValue: '1000' }], createdBy: t.userId,
    })).rejects.toThrow(/before the bill it returns/);
  });

  it('refuses more than was bought', async () => {
    await expect(createPurchaseReturn(t.firmId, {
      clientId: t.clientId, billVoucherId: billId, noteNumber: 'DN/1',
      noteDate: '2026-05-15', reason: 'Damaged',
      lines: [{ billLineNo: 1, taxableValue: '12000' }], createdBy: t.userId,
    })).rejects.toThrow(/reverse credit that was never taken/);
  });

  it('reverses the credit and reduces what is owed', async () => {
    const r = await createPurchaseReturn(t.firmId, {
      clientId: t.clientId, billVoucherId: billId, noteNumber: 'DN/1',
      noteDate: '2026-05-15', reason: 'Two bars bent in transit',
      lines: [{ billLineNo: 1, taxableValue: '2000' }],
      createdBy: t.userId, approvedBy: t.userId,
    });

    expect(r.taxableValue).toBe('2000.00');
    expect(r.totalGst).toBe('360.00');           // 20% of 900 + 900
    expect(r.grandTotal).toBe('2360.00');

    const by = await legs(r.voucherId);
    expect(by['Creditors']!.debit).toBe('2360.00');
    expect(by['Raw Materials']!.credit).toBe('2000.00');
    expect(by['Input CGST Credit']!.credit).toBe('180.00');
    expect(by['Input SGST Credit']!.credit).toBe('180.00');
  });

  it('says the supplier still has to issue the credit note', async () => {
    /*
     * The point of the whole feature. Under s.34 only the supplier can issue a
     * credit note and only theirs reduces their liability — until it appears
     * in GSTR-2B they are still declaring the full invoice, and our reversal
     * has no support in the GST system.
     */
    const list = await purchaseReturns(t.firmId, t.clientId);
    const dn = list.find((x) => x.noteNumber === 'DN/1')!;
    expect(dn.supplierCreditNote).toBeNull();

    const r = await createPurchaseReturn(t.firmId, {
      clientId: t.clientId, billVoucherId: billId, noteNumber: 'DN/1b',
      noteDate: '2026-05-16', reason: 'One more bent bar',
      lines: [{ billLineNo: 1, taxableValue: '1000' }], createdBy: t.userId,
    });
    expect(r.awaitingSupplierCreditNote).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/only Verma Traders can issue a credit note/);
    expect(r.warnings.join(' ')).toMatch(/GSTR-2B/);
  });

  it('shows the bill owing less on the ageing, with no status to maintain', async () => {
    // 11,800 billed, 2,360 + 1,180 returned.
    const open = await outstandingBills(t.firmId, t.clientId);
    const vt = open.find((b) => b.billNumber === 'VT/100')!;
    expect(vt.outstanding).toBe('8260.00');
  });

  it('takes the ITC reversal out of the credit the 3B claims', async () => {
    // The 3B reads the postings, so a reversal lands in the credit figure
    // without a special case — the same property that makes RCM come out.
    const g = await generateGstr3b(t.firmId, t.clientId, '2026-05');
    expect(g.itc.cgst).toBe('630.00');           // 900 less 180 less 90
    expect(g.itc.sgst).toBe('630.00');
  });

  it('records the supplier credit note once, and only once', async () => {
    const list = await purchaseReturns(t.firmId, t.clientId);
    const dn = list.find((x) => x.noteNumber === 'DN/1')!;
    await recordSupplierCreditNote(t.firmId, {
      clientId: t.clientId, returnVoucherId: dn.voucherId,
      number: 'VT/CN/7', date: '2026-05-20',
    });
    const after = await purchaseReturns(t.firmId, t.clientId);
    expect(after.find((x) => x.noteNumber === 'DN/1')!.supplierCreditNote).toBe('VT/CN/7');

    // A second one would mean the supplier credited us twice, which is another
    // return rather than an edit to this one.
    await expect(recordSupplierCreditNote(t.firmId, {
      clientId: t.clientId, returnVoucherId: dn.voucherId,
      number: 'VT/CN/8', date: '2026-05-21',
    })).rejects.toThrow(/already recorded/);
  });
});

// ---------------------------------------------------------------------------
describe('reversing a line whose credit was blocked', () => {
  it('takes the GST back out of the EXPENSE, not out of input credit', async () => {
    /*
     * s.17(5) blocks credit on employee travel, so the GST was capitalised
     * into the expense on the way in. Reversing it against Input CGST would
     * credit an account that never received it — and understate the expense
     * by the tax, which changes reported profit.
     */
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'VT/200', billDate: '2026-06-01',
      lines: [{ description: 'Staff flights', unitPrice: '10000', gstRate: '18',
                expenseAccountId: acct['Travel Expenses']! }],
      createdBy: t.userId,
    });

    const r = await createPurchaseReturn(t.firmId, {
      clientId: t.clientId, billVoucherId: bill.voucherId, noteNumber: 'DN/2',
      noteDate: '2026-06-05', reason: 'Trip cancelled',
      lines: [{ billLineNo: 1, taxableValue: '10000' }], createdBy: t.userId,
    });

    const by = await legs(r.voucherId);
    expect(by['Creditors']!.debit).toBe('11800.00');
    // The whole 11,800 comes out of the expense head.
    expect(by['Travel Expenses']!.credit).toBe('11800.00');
    expect(by['Input CGST Credit']).toBeUndefined();
    expect(r.lines[0]!.itc).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
describe('returning a line in pieces', () => {
  it('leaves no paisa behind when the last piece goes back', async () => {
    /*
     * 100.03 at 18% is 9.00 + 9.00. Returned in three parts, each part's
     * prorated share rounds to slightly less than a third, and prorating the
     * last one too would strand a paisa of input credit on a line that no
     * longer exists. The final return takes whatever is left instead.
     */
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'VT/300', billDate: '2026-07-01',
      lines: [{ description: 'Odd lot', unitPrice: '100.03', gstRate: '18',
                expenseAccountId: acct['Raw Materials']! }],
      createdBy: t.userId,
    });
    const posted = await legs(bill.voucherId);
    const cgstIn = Number(posted['Input CGST Credit']!.debit);

    let reversed = 0;
    for (const [i, part] of ['33.34', '33.34', '33.35'].entries()) {
      const r = await createPurchaseReturn(t.firmId, {
        clientId: t.clientId, billVoucherId: bill.voucherId,
        noteNumber: `DN/3-${i}`, noteDate: '2026-07-05',
        reason: 'Rejected on inspection', lines: [{ billLineNo: 1, taxableValue: part }],
        createdBy: t.userId,
      });
      const by = await legs(r.voucherId);
      reversed += Number(by['Input CGST Credit']?.credit ?? '0');
    }
    // Exactly what went in came back out.
    expect(reversed).toBeCloseTo(cgstIn, 2);

    // And the line is now fully returned, so nothing more can go back.
    await expect(createPurchaseReturn(t.firmId, {
      clientId: t.clientId, billVoucherId: bill.voucherId, noteNumber: 'DN/3-x',
      noteDate: '2026-07-06', reason: 'One more', 
      lines: [{ billLineNo: 1, taxableValue: '0.01' }], createdBy: t.userId,
    })).rejects.toThrow(/0\.00 is left/);
  });
});

// ---------------------------------------------------------------------------
describe('returning after the bill was paid', () => {
  it('says the supplier now owes the client', async () => {
    const bill = await createBill(t.firmId, {
      clientId: t.clientId, partyId: supplier,
      billNumber: 'VT/400', billDate: '2026-08-01',
      lines: [{ description: 'Steel bar', unitPrice: '5000', gstRate: '18',
                expenseAccountId: acct['Raw Materials']! }],
      createdBy: t.userId,
    });
    await recordPayment(t.firmId, {
      clientId: t.clientId, billVoucherId: bill.voucherId, amount: '5900',
      paidFromAccountId: acct['Bank Accounts']!, paymentDate: '2026-08-10',
      createdBy: t.userId,
    });

    const r = await createPurchaseReturn(t.firmId, {
      clientId: t.clientId, billVoucherId: bill.voucherId, noteNumber: 'DN/4',
      noteDate: '2026-08-15', reason: 'Rate corrected after payment',
      lines: [{ billLineNo: 1, taxableValue: '1000' }], createdBy: t.userId,
    });
    // A debit balance on a supplier is legitimate and is not what an ageing
    // is built to show, so it is said rather than left to be noticed.
    expect(r.warnings.join(' ')).toMatch(/owing the client 1180\.00/);
  });
});

// ---------------------------------------------------------------------------
describe('the books after all of it', () => {
  it('still balances', async () => {
    const tb = await trialBalance(t.firmId, t.clientId, '2027-03-31');
    expect(Number(tb.totalDebit)).toBeCloseTo(Number(tb.totalCredit), 2);
  });
});
