/**
 * What customers owe, and collecting it — bills-and-expenses.md BE-40.
 *
 * The half of the ledger that was missing. A sales invoice debited Debtors and
 * the trail ended: no ageing, no statement, no way to record a receipt except
 * by matching a bank line — which is backwards for the client whose books
 * these are.
 *
 * The case that matters most here is TDS withheld BY the customer. ₹90,000
 * arriving against a ₹1,00,000 invoice is not a short payment: the ₹10,000 is
 * tax already paid to the government in the client's name and is an asset they
 * claim. Treating it as a shortfall leaves the invoice looking unpaid forever
 * and loses a credit they are owed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, registerGstin, type SeededTenant } from '../src/seed/index.ts';
import { createInvoice } from '../src/domain/invoicing.ts';
import { outstandingInvoices, recordReceipt, writeOffReceivable,
         customerStatement, receiptAccounts } from '../src/domain/receivables.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { trialBalance } from '../src/reports/index.ts';
import { ownerPool, closePools } from '../src/db/pool.ts';

const gstin = (state: string, pan: string) => {
  const f = `${state}${pan}1Z`;
  return f + gstinCheckDigit(f);
};

let t: SeededTenant;
const acct: Record<string, string> = {};
let customer: string;

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  t = await seedTenant({
    firmName: `Recv ${tag}`, clientName: `Client ${tag}`,
    userEmail: `recv-${tag}@example.test`, startYear: 2026,
    pan: 'AAACV9999V', businessType: 'general',
  });
  await registerGstin(t.firmId, t.clientId, gstin('09', 'AAACV9999V'), { primary: true });

  const r = await ownerPool.query<{ id: string; name: string }>(
    `SELECT id, name FROM accounts WHERE client_id = $1 AND NOT is_group
       AND name IN ('Debtors','Bank Accounts','TDS Receivable','Bad Debts','Sales')`,
    [t.clientId]);
  for (const a of r.rows) acct[a.name] = a.id;

  customer = (await ownerPool.query<{ id: string }>(
    `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name, gstin,
                          gst_category, state_code, ledger_account_id, created_by)
     VALUES ($1,$2,'customer','Nair Systems','Nair Systems Pvt Ltd',$3,
             'registered_regular','09',$4,$5) RETURNING id`,
    [t.firmId, t.clientId, gstin('09', 'AABCN1234N'), acct['Debtors'], t.userId])).rows[0]!.id;
});

afterAll(async () => { await closePools(); });

const invoice = (date: string, amount: string, due?: string) => createInvoice(t.firmId, {
  clientId: t.clientId, partyId: customer, postingDate: date,
  ...(due === undefined ? {} : { dueDate: due }),
  lines: [{ description: 'Consulting', hsnSac: '998311', quantity: '1',
            unitPrice: amount, gstRate: '18', incomeAccountId: acct['Sales']! }],
  createdBy: t.userId,
});

const legs = async (voucherId: string) => {
  const r = await ownerPool.query<{ name: string; debit: string; credit: string }>(
    `SELECT a.name, le.debit::text, le.credit::text
       FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
      WHERE le.voucher_id = $1`, [voucherId]);
  return Object.fromEntries(r.rows.map((x) => [x.name, x]));
};

// ---------------------------------------------------------------------------
describe('the ageing', () => {
  let inv: string;

  it('shows an invoice as owed, in the right bucket', async () => {
    const i = await invoice('2026-05-01', '100000', '2026-05-31');
    inv = i.voucherId;
    const open = await outstandingInvoices(t.firmId, t.clientId);
    const row = open.find((x) => x.voucherId === inv)!;
    expect(row.grandTotal).toBe('118000.00');
    expect(row.outstanding).toBe('118000.00');
    expect(row.customerName).toBe('Nair Systems Pvt Ltd');
    // Due 31 May 2026 and today is well past it.
    expect(row.daysOverdue).toBeGreaterThan(90);
    expect(row.bucket).toBe('d90_plus');
  });

  it('falls off the list once it is settled', async () => {
    await recordReceipt(t.firmId, {
      clientId: t.clientId, invoiceVoucherId: inv, amount: '118000',
      receivedIntoAccountId: acct['Bank Accounts']!, receiptDate: '2026-06-10',
      createdBy: t.userId,
    });
    const open = await outstandingInvoices(t.firmId, t.clientId);
    expect(open.some((x) => x.voucherId === inv)).toBe(false);
  });

  it('offers somewhere for the money to land', async () => {
    const accs = await receiptAccounts(t.firmId, t.clientId);
    expect(accs.some((a) => a.name === 'Bank Accounts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('TDS withheld by the customer', () => {
  let inv: string;

  beforeAll(async () => {
    inv = (await invoice('2026-07-01', '100000', '2026-07-31')).voucherId;
  });

  it('settles the invoice in full, and books the tax as an asset', async () => {
    /*
     * 1,18,000 invoiced. The customer deducts 10% TDS on the taxable value —
     * 10,000 — and remits 1,08,000. Nothing is outstanding: they have
     * discharged the whole invoice, partly to us and partly to the government
     * on our behalf.
     */
    const r = await recordReceipt(t.firmId, {
      clientId: t.clientId, invoiceVoucherId: inv, amount: '108000',
      tdsWithheld: '10000',
      receivedIntoAccountId: acct['Bank Accounts']!, receiptDate: '2026-08-05',
      createdBy: t.userId,
    });
    expect(r.received).toBe('108000.00');
    expect(r.tdsWithheld).toBe('10000.00');
    expect(r.settled).toBe('118000.00');
    expect(r.fullySettled).toBe(true);

    const by = await legs(r.voucherId);
    expect(by['Bank Accounts']!.debit).toBe('108000.00');
    // An ASSET, because the client claims it in their return.
    expect(by['TDS Receivable']!.debit).toBe('10000.00');
    expect(by['Debtors']!.credit).toBe('118000.00');
  });

  it('says to check it against Form 16A and 26AS', async () => {
    // A withholding the customer never actually deposited is a credit the
    // client cannot take, and only 26AS shows whether they did.
    const i = await invoice('2026-09-01', '50000');
    const r = await recordReceipt(t.firmId, {
      clientId: t.clientId, invoiceVoucherId: i.voucherId, amount: '54000',
      tdsWithheld: '5000',
      receivedIntoAccountId: acct['Bank Accounts']!, receiptDate: '2026-09-20',
      createdBy: t.userId,
    });
    expect(r.warnings.join(' ')).toMatch(/not a shortfall/);
    expect(r.warnings.join(' ')).toMatch(/Form 16A/);
    expect(r.warnings.join(' ')).toMatch(/26AS/);
  });

  it('reports the withholding on the ageing while anything is still owed', async () => {
    const i = await invoice('2026-10-01', '100000');
    await recordReceipt(t.firmId, {
      clientId: t.clientId, invoiceVoucherId: i.voucherId, amount: '50000',
      tdsWithheld: '10000',
      receivedIntoAccountId: acct['Bank Accounts']!, receiptDate: '2026-10-20',
      createdBy: t.userId,
    });
    const row = (await outstandingInvoices(t.firmId, t.clientId))
      .find((x) => x.voucherId === i.voucherId)!;
    // 1,18,000 less 50,000 cash less 10,000 withheld.
    expect(row.outstanding).toBe('58000.00');
    expect(row.tdsWithheld).toBe('10000.00');
  });

  it('refuses when cash plus withholding exceeds what is owed', async () => {
    /*
     * The guard that stops an ageing quietly going negative. An overpayment is
     * an advance against the next invoice, which is a different document.
     */
    const i = await invoice('2026-11-01', '10000');
    await expect(recordReceipt(t.firmId, {
      clientId: t.clientId, invoiceVoucherId: i.voucherId, amount: '11000',
      tdsWithheld: '1000',
      receivedIntoAccountId: acct['Bank Accounts']!, receiptDate: '2026-11-05',
      createdBy: t.userId,
    })).rejects.toThrow(/more than the 11800\.00 outstanding/);
  });

  it('never infers the withholding from the shortfall', async () => {
    /*
     * A short payment and a withholding look identical in a bank statement and
     * mean opposite things — a debt still owed against an asset already
     * earned. Only the customer's advice settles it, so a plain part-payment
     * stays a part-payment.
     */
    const i = await invoice('2026-12-01', '100000');
    const r = await recordReceipt(t.firmId, {
      clientId: t.clientId, invoiceVoucherId: i.voucherId, amount: '108000',
      receivedIntoAccountId: acct['Bank Accounts']!, receiptDate: '2026-12-10',
      createdBy: t.userId,
    });
    expect(r.tdsWithheld).toBe('0.00');
    expect(r.fullySettled).toBe(false);
    expect(r.outstandingAfter).toBe('10000.00');
    expect(r.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('giving up on a debt', () => {
  let inv: string;

  beforeAll(async () => {
    inv = (await invoice('2027-01-05', '20000')).voucherId;
  });

  it('refuses a write-off with no reason', async () => {
    await expect(writeOffReceivable(t.firmId, {
      clientId: t.clientId, invoiceVoucherId: inv, amount: '23600',
      reason: '  ', writeOffDate: '2027-03-01',
      createdBy: t.userId, approvedBy: t.userId,
    })).rejects.toThrow(/say why this debt is uncollectable/);
  });

  it('books it as an expense, not as a disappearance', async () => {
    // Lesson 4: a customer who will never pay is a real business loss, and
    // distinct from Drawings.
    const r = await writeOffReceivable(t.firmId, {
      clientId: t.clientId, invoiceVoucherId: inv, amount: '23600',
      reason: 'Company struck off; no assets', writeOffDate: '2027-03-01',
      createdBy: t.userId, approvedBy: t.userId,
    });
    const by = await legs(r.voucherId);
    expect(by['Bad Debts']!.debit).toBe('23600.00');
    expect(by['Debtors']!.credit).toBe('23600.00');
    expect((await outstandingInvoices(t.firmId, t.clientId))
      .some((x) => x.voucherId === inv)).toBe(false);
  });

  it('says the GST is gone and is not coming back', async () => {
    /*
     * The trap. The tax became payable at the time of supply and India has no
     * bad-debt relief in GST — so the write-off includes tax already paid on
     * money that never arrived, and issuing a credit note to recover it would
     * be a false statement that the supply was cancelled.
     */
    const i = await invoice('2027-02-01', '10000');
    const r = await writeOffReceivable(t.firmId, {
      clientId: t.clientId, invoiceVoucherId: i.voucherId, amount: '11800',
      reason: 'Untraceable', writeOffDate: '2027-03-05',
      createdBy: t.userId, approvedBy: t.userId,
    });
    expect(r.warnings.join(' ')).toMatch(/1800\.00 — is NOT recoverable/);
    expect(r.warnings.join(' ')).toMatch(/no bad-debt relief/);
    expect(r.warnings.join(' ')).toMatch(/false statement/);
  });
});

// ---------------------------------------------------------------------------
describe('the customer statement', () => {
  it('runs a balance over every entry, not just the invoices', async () => {
    // What gets emailed when somebody disputes what they owe. A statement that
    // omitted a receipt would be worse than none.
    const s = await customerStatement(t.firmId, t.clientId, customer);
    expect(s.customer).toBe('Nair Systems');
    expect(s.lines.length).toBeGreaterThan(6);
    expect(s.lines.some((l) => l.voucherType === 'receipt')).toBe(true);
    expect(s.lines.some((l) => l.voucherType === 'journal')).toBe(true);

    // The closing balance is the sum of every debit less every credit.
    const net = s.lines.reduce(
      (a, l) => a + Number(l.debit) - Number(l.credit), 0);
    expect(Number(s.closing)).toBeCloseTo(net, 2);

    // And it agrees with what the ageing still shows outstanding.
    const open = await outstandingInvoices(t.firmId, t.clientId);
    const owed = open.reduce((a, x) => a + Number(x.outstanding), 0);
    expect(Number(s.closing)).toBeCloseTo(owed, 2);
  });

  it('refuses a customer belonging to someone else', async () => {
    await expect(customerStatement(t.firmId, t.clientId, t.userId))
      .rejects.toThrow(/no such customer/);
  });
});

// ---------------------------------------------------------------------------
describe('the books after all of it', () => {
  it('still balance', async () => {
    const tb = await trialBalance(t.firmId, t.clientId, '2027-03-31');
    expect(Number(tb.totalDebit)).toBeCloseTo(Number(tb.totalCredit), 2);
  });
});
