/**
 * End-to-end reconciliation: statement file → queue → postings → BRS.
 *
 * The unit tests prove each piece. This proves they compose — which is a
 * different claim, and the one that broke twice while the pieces were all
 * passing (a score floor that hid real matches, and a proposal offered against
 * an unrelated invoice on date proximity alone).
 *
 * The month is the demo dataset: an exact UTR match, an ambiguous pair, a
 * receipt net of TDS, a part payment, bank charges with GST, and interest
 * credited net of the bank's TDS.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { seedTdsSections, seedItcEligibility } from '../src/seed/tdsSections.ts';
import { createInvoice } from '../src/domain/invoicing.ts';
import { importStatementFile } from '../src/domain/statement.ts';
import { reconciliationQueue, MIN_PROPOSAL_SCORE } from '../src/domain/matching.ts';
import {
  accountNumberHash, settleInvoiceFromBankLine, postBankCharge, postInterestCredit,
} from '../src/domain/banking.ts';
import { bankReconciliationStatement } from '../src/domain/brs.ts';
import { trialBalance } from '../src/reports/index.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { ownerPool, withFirm, closePools } from '../src/db/pool.ts';

let t: SeededTenant;
let bankAccountId: string;
const inv: Record<string, string> = {};

const A = (n: string): string => {
  const id = t.accounts[n];
  if (!id) throw new Error(`missing account ${n}`);
  return id;
};

const gstin = (state: string, pan: string): string => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckDigit(first14);
};

/**
 * The statement, built with a correct running balance so BR-6 passes.
 * Amounts tie to the invoices raised below.
 */
const STATEMENT = `Statement of account
Account Number:,50100123457788
Period:,01/04/26 to 30/04/26
Opening Balance:,"1,00,000.00"

Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
10/04/26,"NEFT-HDFCR52026041012345-BHARAT STEEL INDUSTRIES-UTR HDFCR52026041012345",,10/04/26,,"47,200.00","1,47,200.00"
14/04/26,"UPI/402612345678/Payment from/acme@okhdfcbank/UPI",,14/04/26,,"11,800.00","1,59,000.00"
18/04/26,"NEFT-CITIN52026041812345-NOVA CONSULTING LLP",,18/04/26,,"54,000.00","2,13,000.00"
21/04/26,"RTGS-HDFCR52026042199999-BHARAT STEEL INDUSTRIES",,21/04/26,,"10,000.00","2,23,000.00"
25/04/26,"SMS CHARGES 04/2026 + GST",,25/04/26,118.00,,"2,22,882.00"
28/04/26,"INT.PD:01-01-2026 TO 31-03-2026",,28/04/26,,"9,000.00","2,31,882.00"

Closing Balance:,"2,31,882.00"
*** End of statement ***
`;

beforeAll(async () => {
  await seedTdsSections();

  t = await seedTenant({
    firmName: `Flow Firm ${randomUUID().slice(0, 8)}`,
    clientName: 'Shree Ram Trading',
    userEmail: `flow-${randomUUID()}@test.local`,
    startYear: 2026,
  });

  await ownerPool.query(
    'UPDATE clients SET gstin = $2, state_code = $3 WHERE id = $1',
    [t.clientId, gstin('27', 'AAPFS1234K'), '27']);
  await seedItcEligibility(t.clientId);

  bankAccountId = await withFirm(t.firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO bank_accounts
         (firm_id, client_id, account_id, bank_name, account_number_last4,
          account_number_hash, kind, opening_balance, opening_date)
       VALUES ($1,$2,$3,'HDFC Bank','7788',$4,'current','100000.00','2026-04-01')
       RETURNING id`,
      [t.firmId, t.clientId, A('Bank Accounts'), accountNumberHash('50100123457788')]);
    return r.rows[0]!.id;
  });

  // The opening bank balance must exist in the LEDGER too, or the BRS starts
  // ₹1,00,000 out and every later difference is masked by it.
  await withFirm(t.firmId, async (c) => {
    const v = await c.query<{ id: string }>(
      `INSERT INTO vouchers (firm_id, client_id, voucher_type, voucher_number,
                             posting_date, fiscal_year_id, narration, created_by)
       VALUES ($1,$2,'opening','OPN/00001','2026-04-01',$3,'Opening',$4) RETURNING id`,
      [t.firmId, t.clientId, t.fiscalYearId, t.userId]);
    for (const [i, [account, debit, credit]] of ([
      [A('Bank Accounts'), '100000.00', '0'],
      [A("Owner's Capital"), '0', '100000.00'],
    ] as const).entries()) {
      await c.query(
        `INSERT INTO ledger_entries (firm_id, client_id, voucher_id, line_no,
           posting_date, fiscal_year_id, account_id, debit, credit, is_opening)
         VALUES ($1,$2,$3,$4,'2026-04-01',$5,$6,$7,$8,true)`,
        [t.firmId, t.clientId, v.rows[0]!.id, i + 1, t.fiscalYearId, account, debit, credit]);
    }
  });

  const party = async (name: string, legal: string, pan: string): Promise<string> =>
    withFirm(t.firmId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name, gstin,
                              gst_category, state_code, ledger_account_id, created_by)
         VALUES ($1,$2,'customer',$3,$4,$5,'registered_regular','27',$6,$7) RETURNING id`,
        [t.firmId, t.clientId, name, legal, gstin('27', pan), A('Debtors'), t.userId]);
      return r.rows[0]!.id;
    });

  const acme = await party('Acme Trading', 'Acme Trading Pvt Ltd', 'AABCA4444P');
  const bharat = await party('Bharat Steel', 'Bharat Steel Industries', 'AABCB5555Q');
  const nova = await party('Nova Consulting', 'Nova Consulting LLP', 'AABCN6666R');

  const raise = async (
    key: string, partyId: string, date: string, price: string, rate: string, ref?: string,
  ): Promise<void> => {
    const r = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId, postingDate: date,
      lines: [{ description: key, hsnSac: '7318', quantity: '1', unitPrice: price,
                gstRate: rate, incomeAccountId: A('Sales') }],
      createdBy: t.userId,
    });
    inv[key] = r.voucherId;
    if (ref) {
      await withFirm(t.firmId, (c) => c.query(
        'UPDATE sales_invoices SET expected_reference = $2 WHERE voucher_id = $1',
        [r.voucherId, ref]));
    }
  };

  await raise('utr', bharat, '2026-04-03', '40000', '18', 'HDFCR52026041012345');
  await raise('twinA', acme, '2026-04-05', '10000', '18');
  await raise('twinB', acme, '2026-04-06', '10000', '18');
  await raise('tds', nova, '2026-04-08', '50000', '18');
  await raise('partial', bharat, '2026-04-12', '25000', '0');
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('the whole month, in order', () => {
  it('imports the file and passes its own arithmetic check', async () => {
    const out = await importStatementFile(t.firmId, {
      clientId: t.clientId, bankAccountId, fileText: STATEMENT, uploadedBy: t.userId,
    });
    expect(out.error).toBeNull();
    expect(out.parse.bank).toBe('HDFC Bank');
    expect(out.result!.imported).toBe(6);
    expect(out.result!.arithmetic.ok).toBe(true);
    expect(out.result!.arithmetic.computedClosing).toBe('231882.00');
  });

  it('ranks the queue by confidence, with the UTR match on top', async () => {
    const { items, totals } = await reconciliationQueue(t.firmId, bankAccountId);

    expect(items).toHaveLength(6);
    expect(items[0]!.proposal.best!.score).toBe(97);
    expect(items[0]!.proposal.autoMatchable).toBe(true);
    expect(items[0]!.proposal.best!.voucherId).toBe(inv.utr);
    expect(totals.autoMatchable).toBe(1);

    // Descending — the point of the screen (§14.1).
    const scores = items.map((i) => i.proposal.best?.score ?? -1);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('surfaces the identical pair as ambiguous and refuses to choose', async () => {
    const { items } = await reconciliationQueue(t.firmId, bankAccountId);
    const upi = items.find((i) => i.narration.startsWith('UPI/'))!;
    expect(upi.proposal.ambiguous).toBe(true);
    expect(upi.proposal.autoMatchable).toBe(false);
    expect(upi.proposal.reason).toMatch(/BR-15/);
    expect(upi.proposal.runnersUp[0]!.score).toBe(upi.proposal.best!.score);
  });

  it('offers no candidate for lines an invoice cannot explain, and says what they are', async () => {
    const { items } = await reconciliationQueue(t.firmId, bankAccountId);

    const charge = items.find((i) => i.narration.startsWith('SMS CHARGES'))!;
    expect(charge.proposal.best).toBeNull();
    expect(charge.suggestedClassification).toBe('bank_charge');

    const interest = items.find((i) => i.narration.startsWith('INT.PD'))!;
    expect(interest.proposal.best).toBeNull();
    expect(interest.suggestedClassification).toBe('interest');
  });

  it('still proposes a part payment from a known customer', async () => {
    // The regression that set MIN_PROPOSAL_SCORE too high: the amount cannot
    // match on a partial payment, so party plus date is all the evidence there
    // is — and it is enough to be worth showing.
    const { items } = await reconciliationQueue(t.firmId, bankAccountId);
    const rtgs = items.find((i) => i.narration.startsWith('RTGS-'))!;
    expect(rtgs.proposal.best).not.toBeNull();
    expect(rtgs.proposal.best!.score).toBeGreaterThanOrEqual(MIN_PROPOSAL_SCORE);
    expect(rtgs.proposal.autoMatchable).toBe(false);
    expect(rtgs.proposal.best!.partyName).toBe('Bharat Steel');
  });

  it('settles the UTR match, the TDS receipt, and the part payment', async () => {
    const { items } = await reconciliationQueue(t.firmId, bankAccountId);
    const line = (prefix: string) => items.find((i) => i.narration.startsWith(prefix))!;

    const exact = await settleInvoiceFromBankLine(t.firmId, {
      clientId: t.clientId, bankTransactionId: line('NEFT-HDFCR').bankTransactionId,
      invoiceVoucherId: inv.utr!, matchType: 'scored', createdBy: t.userId,
    });
    expect(exact.fullySettled).toBe(true);

    // ₹54,000 against a ₹59,000 invoice — 10% of the ₹50,000 taxable value.
    const withTds = await settleInvoiceFromBankLine(t.firmId, {
      clientId: t.clientId, bankTransactionId: line('NEFT-CITIN').bankTransactionId,
      invoiceVoucherId: inv.tds!, treatShortfallAsTds: true, createdBy: t.userId,
    });
    expect(withTds.tdsRecognised).toBe('5000.00');
    expect(withTds.invoiceSettled).toBe('59000.00');
    expect(withTds.fullySettled).toBe(true);

    const part = await settleInvoiceFromBankLine(t.firmId, {
      clientId: t.clientId, bankTransactionId: line('RTGS-').bankTransactionId,
      invoiceVoucherId: inv.partial!, createdBy: t.userId,
    });
    expect(part.fullySettled).toBe(false);
    expect(part.note).toMatch(/15000\.00 remains outstanding/);
  });

  it('posts the charge and the interest, gross', async () => {
    const { items } = await reconciliationQueue(t.firmId, bankAccountId);
    const line = (prefix: string) => items.find((i) => i.narration.startsWith(prefix))!;

    const charge = await postBankCharge(t.firmId, {
      clientId: t.clientId, bankTransactionId: line('SMS CHARGES').bankTransactionId,
      amount: '118', gstAmount: '18', createdBy: t.userId,
    });
    expect(charge.chargeNet).toBe('100.00');
    expect(charge.itcClaimed).toBe('18.00');

    const interest = await postInterestCredit(t.firmId, {
      clientId: t.clientId, bankTransactionId: line('INT.PD').bankTransactionId,
      grossInterest: '10000', createdBy: t.userId,
    });
    expect(interest.gross).toBe('10000.00');
    expect(interest.tds).toBe('1000.00');
  });

  it('leaves only the genuinely ambiguous line unresolved', async () => {
    const { items, totals } = await reconciliationQueue(t.firmId, bankAccountId);
    expect(items).toHaveLength(1);
    expect(items[0]!.narration).toMatch(/^UPI\//);
    expect(totals.ambiguous).toBe(1);
  });

  it('and the books say what they should', async () => {
    const tb = await trialBalance(t.firmId, t.clientId, '2026-04-30');
    const row = (name: string) => tb.rows.find((r) => r.name === name);

    // ₹5,000 from the customer + ₹1,000 from the bank on interest.
    expect(row('TDS Receivable')?.debit).toBe('6000.00');
    // Gross interest earned, not the ₹9,000 that landed.
    expect(row('Interest Income')?.credit).toBe('10000.00');
    // The GST on the bank charge is claimed, not absorbed into the expense.
    expect(row('Bank Charges')?.debit).toBe('100.00');
    expect(row('Input CGST Credit')?.debit).toBe('9.00');
    expect(tb.balanced).toBe(true);
  });

  it('the BRS ties, with the unmatched UPI receipt as the only reconciling item', async () => {
    const brs = await bankReconciliationStatement(t.firmId, bankAccountId, '2026-04-30');

    const unrecorded = brs.lines.find((l) => l.label.startsWith('Amounts credited'));
    expect(unrecorded?.amount).toBe('11800.00');
    expect(unrecorded?.effect).toBe('add');

    expect(brs.actualBankBalance).toBe('231882.00');
    expect(brs.ties).toBe(true);
    expect(brs.exception).toBeNull();
  });
});
