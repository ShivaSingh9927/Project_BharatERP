/**
 * Bank & reconciliation acceptance tests — bank-and-reconciliation.md §15.
 *
 * The cases that matter most are the ones where a plausible-looking answer is
 * financially wrong: a statement that parses cleanly but is missing a row, a
 * ₹49,000 receipt that looks like a shortfall and is not, and interest that
 * arrives smaller than it was earned.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { createInvoice } from '../src/domain/invoicing.ts';
import { parseNarration, residueForModel } from '../src/domain/narration.ts';
import {
  verifyStatementArithmetic, transactionHash, importStatement, type StatementRow,
} from '../src/domain/statement.ts';
import {
  scoreCandidate, rank, inferTdsShortfall, openInvoiceCandidates,
  AUTO_MATCH_THRESHOLD, type Candidate,
} from '../src/domain/matching.ts';
import {
  accountNumberHash, settleInvoiceFromBankLine, postBankCharge,
  postInterestCredit, registerCheque, clearCheque, bounceCheque, staleCheques,
} from '../src/domain/banking.ts';
import { bankReconciliationStatement, assertReconciledForClose } from '../src/domain/brs.ts';
import { postVoucher } from '../src/domain/posting.ts';
import { trialBalance } from '../src/reports/index.ts';
import { gstinCheckDigit } from '../src/domain/gstin.ts';
import { ownerPool, withFirm, closePools } from '../src/db/pool.ts';

let t: SeededTenant;
let customer: string;
let bankAccountId: string;

const A = (n: string): string => {
  const id = t.accounts[n];
  if (!id) throw new Error(`missing account ${n}`);
  return id;
};

function makeGstin(state: string, pan: string, entity = '1'): string {
  const first14 = `${state}${pan}${entity}Z`;
  return first14 + gstinCheckDigit(first14);
}

/** Insert a bank line directly — the parser is tested separately. */
async function addLine(row: {
  date: string; narration: string; debit?: string; credit?: string;
  runningBalance?: string; reference?: string; mode?: string;
}): Promise<string> {
  return withFirm(t.firmId, async (c) => {
    const parsed = parseNarration(row.narration);
    const r = await c.query<{ id: string }>(
      `INSERT INTO bank_transactions
         (firm_id, client_id, bank_account_id, txn_date, narration, debit, credit,
          running_balance, reference_number, payment_mode, content_hash, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'statement') RETURNING id`,
      [
        t.firmId, t.clientId, bankAccountId, row.date, row.narration,
        row.debit ?? '0', row.credit ?? '0', row.runningBalance ?? null,
        row.reference ?? parsed.reference, row.mode ?? parsed.mode,
        randomUUID(),
      ]);
    return r.rows[0]!.id;
  });
}

beforeAll(async () => {
  t = await seedTenant({
    firmName: `Bank Firm ${randomUUID().slice(0, 8)}`,
    clientName: 'Bharat Traders',
    userEmail: `bank-${randomUUID()}@test.local`,
    startYear: 2026,
  });

  await ownerPool.query(
    'UPDATE clients SET gstin = $2, state_code = $3 WHERE id = $1',
    [t.clientId, makeGstin('27', 'AAPFB1111L'), '27']);

  customer = await withFirm(t.firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO parties (firm_id, client_id, party_type, name, legal_name,
                            gstin, gst_category, state_code, ledger_account_id, created_by)
       VALUES ($1,$2,'customer','Acme Trading','Acme Trading Pvt Ltd',
               $3,'registered_regular','27',$4,$5) RETURNING id`,
      [t.firmId, t.clientId, makeGstin('27', 'AABCA4444P'), A('Debtors'), t.userId]);
    return r.rows[0]!.id;
  });

  bankAccountId = await withFirm(t.firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO bank_accounts
         (firm_id, client_id, account_id, bank_name, account_number_last4,
          account_number_hash, ifsc, kind, opening_balance, opening_date)
       VALUES ($1,$2,$3,'HDFC Bank','7788',$4,'HDFC0001234','current','0','2026-04-01')
       RETURNING id`,
      [t.firmId, t.clientId, A('Bank Accounts'), accountNumberHash('50100123457788')]);
    return r.rows[0]!.id;
  });
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('BR-2 — account numbers are never stored in full', () => {
  it('the hash is stable and does not reveal the number', async () => {
    const h = accountNumberHash('5010 0123 4577 88');
    expect(h).toBe(accountNumberHash('50100123457788'));
    expect(h).not.toContain('7788');
    expect(h).toHaveLength(64);
  });

  it('the stored row carries only the last four digits', async () => {
    const r = await withFirm(t.firmId, (c) =>
      c.query('SELECT * FROM bank_accounts WHERE id = $1', [bankAccountId]));
    const row = r.rows[0]!;
    expect(row.account_number_last4).toBe('7788');
    expect(JSON.stringify(row)).not.toContain('50100123457788');
  });
});

// ---------------------------------------------------------------------------
describe('BR-6 — the statement must reconcile against itself (T-1)', () => {
  const rows: StatementRow[] = [
    { txnDate: '2026-05-02', narration: 'NEFT-HDFCN001-ACME', credit: '50000', runningBalance: '150000' },
    { txnDate: '2026-05-05', narration: 'CHQ PAID - 123456', debit: '20000', runningBalance: '130000' },
    { txnDate: '2026-05-09', narration: 'SMS CHARGES 05/2026', debit: '118', runningBalance: '129882' },
  ];

  it('passes when the arithmetic holds', () => {
    const r = verifyStatementArithmetic('100000', '129882', rows);
    expect(r.ok).toBe(true);
    expect(r.totalCredits).toBe('50000.00');
    expect(r.totalDebits).toBe('20118.00');
    expect(r.computedClosing).toBe('129882.00');
  });

  it('fails when a row is dropped, and names the row', () => {
    // The middle line goes missing — exactly what a page break does to a parser.
    const missing = [rows[0]!, rows[2]!];
    const r = verifyStatementArithmetic('100000', '129882', missing);
    expect(r.ok).toBe(false);
    // Negative: dropping a DEBIT makes the computed closing too high.
    expect(r.difference).toBe('-20000.00');
    // The running balance disagrees from the first line after the gap.
    expect(r.firstBadRow).toBe(2);
    expect(r.detail).toContain('row(s) 2');
    // Only ONE row is reported, not every row after it: the walk resumes from
    // what the statement states, so a single error stays a single error.
    expect(r.badRows).toHaveLength(1);
  });

  it('fails when a digit is misread', () => {
    const misread = rows.map((r, i) => i === 0 ? { ...r, credit: '5000' } : r);
    const r = verifyStatementArithmetic('100000', '129882', misread);
    expect(r.ok).toBe(false);
    expect(r.difference).toBe('45000.00');
    expect(r.firstBadRow).toBe(1);
  });

  it('the import is rejected outright rather than partially applied', async () => {
    await expect(importStatement(t.firmId, {
      clientId: t.clientId, bankAccountId,
      periodFrom: '2026-05-01', periodTo: '2026-05-31',
      openingBalance: '100000', closingBalance: '999999',
      rows, uploadedBy: t.userId,
    })).rejects.toThrow(/BR-6/);

    const n = await withFirm(t.firmId, (c) =>
      c.query('SELECT COUNT(*)::int AS n FROM bank_statements WHERE bank_account_id = $1',
        [bankAccountId]));
    expect(n.rows[0]!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('BR-7 / BR-8 — duplicate and gap detection (T-2, T-3)', () => {
  const jan: StatementRow[] = [
    { txnDate: '2026-06-03', narration: 'UPI/123456789012/From/ramesh@okhdfcbank/UPI', credit: '11800' },
    { txnDate: '2026-06-18', narration: 'SMS CHARGES 06/2026', debit: '118' },
  ];

  it('imports cleanly the first time', async () => {
    const r = await importStatement(t.firmId, {
      clientId: t.clientId, bankAccountId,
      periodFrom: '2026-06-01', periodTo: '2026-06-30',
      openingBalance: '0', closingBalance: '11682',
      rows: jan, uploadedBy: t.userId,
    });
    expect(r.imported).toBe(2);
    expect(r.duplicates).toBe(0);
    expect(r.arithmetic.ok).toBe(true);
  });

  it('an overlapping re-import adds only the new rows and reports the overlap', async () => {
    const junJul = [
      ...jan,
      { txnDate: '2026-07-04', narration: 'NEFT-HDFCN99-SHREE ENTERPRISES', debit: '5000' },
    ];
    const r = await importStatement(t.firmId, {
      clientId: t.clientId, bankAccountId,
      periodFrom: '2026-06-01', periodTo: '2026-07-31',
      openingBalance: '0', closingBalance: '6682',
      rows: junJul, uploadedBy: t.userId,
    });
    expect(r.imported).toBe(1);
    expect(r.duplicates).toBe(2);
    expect(r.warnings.join(' ')).toMatch(/BR-7: 2 of 3 rows already existed/);
  });

  it('a gap since the last statement is warned about, not swallowed', async () => {
    const r = await importStatement(t.firmId, {
      clientId: t.clientId, bankAccountId,
      periodFrom: '2026-08-05', periodTo: '2026-08-31',
      openingBalance: '6682', closingBalance: '6682',
      rows: [{ txnDate: '2026-08-10', narration: 'ATM WDL 445566 MUMBAI', debit: '2000' },
             { txnDate: '2026-08-11', narration: 'BY CASH - BRANCH 0234', credit: '2000' }],
      uploadedBy: t.userId,
    });
    expect(r.warnings.join(' ')).toMatch(/BR-8: 4 day\(s\) missing/);
  });

  it('the content hash ignores whitespace noise but not amounts', () => {
    const a = { txnDate: '2026-06-03', narration: 'NEFT  ACME', credit: '100' };
    const b = { txnDate: '2026-06-03', narration: 'NEFT ACME', credit: '100' };
    const c = { txnDate: '2026-06-03', narration: 'NEFT ACME', credit: '100.01' };
    expect(transactionHash(bankAccountId, a)).toBe(transactionHash(bankAccountId, b));
    expect(transactionHash(bankAccountId, b)).not.toBe(transactionHash(bankAccountId, c));
  });
});

// ---------------------------------------------------------------------------
describe('BR-9 / BR-10 — narration parsing by rule (T-4)', () => {
  const cases: Array<[string, string | null, string | null]> = [
    ['UPI/123456789012/Payment from/ramesh@okhdfcbank/UPI', 'upi', '123456789012'],
    ['NEFT-CITIN52024061012345-ACME TRADING PVT LTD-UTR123456789', 'neft', 'CITIN52024061012345'],
    ['IMPS/P2A/412345678901/RAMESH KUMAR/HDFC', 'imps', '412345678901'],
    ['RTGS-HDFCR52024061098765-SHREE ENTERPRISES', 'rtgs', 'HDFCR52024061098765'],
    ['CHQ PAID - 123456', 'cheque', '123456'],
    ['NACH DR-INDUSIND-ABC FINANCE-MANDATE123', 'nach', null],
    ['ACH C- SALARY CREDIT XYZ TECHNOLOGIES', 'nach', null],
    ['BY CASH - BRANCH 0234', 'cash', null],
    ['INT.PD:01-04-2026 TO 30-06-2026', 'interest', null],
    ['SMS CHARGES 07/2026 + GST', 'charge', null],
  ];

  for (const [narration, mode, reference] of cases) {
    it(`parses ${mode}: ${narration.slice(0, 34)}`, () => {
      const p = parseNarration(narration);
      expect(p.matchedByRule).toBe(true);
      expect(p.mode).toBe(mode);
      if (reference) expect(p.reference).toBe(reference);
    });
  }

  it('extracts the counterparty where the format carries one', () => {
    expect(parseNarration('RTGS-HDFCR52024061098765-SHREE ENTERPRISES').counterparty)
      .toBe('SHREE ENTERPRISES');
    expect(parseNarration('IMPS/P2A/412345678901/RAMESH KUMAR/HDFC').counterparty)
      .toBe('RAMESH KUMAR');
  });

  it('leaves only genuinely unstructured lines for the model', () => {
    const residue = residueForModel([
      ...cases.map(([n]) => n),
      'MISC ADJUSTMENT ENTRY REF 9981',
    ]);
    expect(residue).toEqual(['MISC ADJUSTMENT ENTRY REF 9981']);
  });

  // Shapes taken from two REAL HDFC statements, with names, handles and
  // account numbers replaced by dummies. Continuation lines are joined with NO
  // separator, because HDFC wraps mid-token: `...PTYBL-Y` + `ESB0PTMUPI-...`
  // is the single token `YESB0PTMUPI`, and joining with a space would corrupt
  // the reference the matcher depends on.
  describe('real HDFC narrations', () => {
    it('does NOT mistake an IFSC for the UTR', () => {
      // The reference is 624861888406; SBIN0000641 is the counterparty bank's
      // IFSC and matches the UTR shape. Because a UTR is preferred over a
      // positional match, the IFSC used to overwrite the real reference —
      // corrupting the strongest matching signal in the product, and doing it
      // identically for every transaction from that bank.
      const p = parseNarration('UPI-XXXXXXX7140-SBIN0000641-624861888406-EXAMPLE NAME');
      expect(p.mode).toBe('upi');
      expect(p.reference).toBe('624861888406');
      expect(p.reference).not.toBe('SBIN0000641');
    });

    it('reads the UPI reference through a mid-token line wrap', () => {
      const p = parseNarration(
        'UPI-EXAMPLE NAME-PAYTM-70000000@PTYBL-YESB0PTMUPI-624531110990-TRANSACTIONNOTE');
      expect(p.reference).toBe('624531110990');
    });

    it('recognises a credit-card bill paid from the bank account', () => {
      // §18.5: this line must settle Credit Card Payable, never an expense —
      // the card spend is already on the card statement. Previously no rule
      // fired at all, so it would have gone to the model for classification.
      const p = parseNarration('IB BILLPAY DR-HDFC93-361135XXXX4700');
      expect(p.matchedByRule).toBe(true);
      expect(p.mode).toBe('card');
      expect(p.reference).toBe('361135XXXX4700');
    });

    it('separates the mandate reference from the party on a direct debit', () => {
      const p = parseNarration('ACH C- EXAMPLE COMPANY-32256648');
      expect(p.mode).toBe('nach');
      expect(p.counterparty).toBe('EXAMPLE COMPANY');
      expect(p.reference).toBe('32256648');
    });
  });

  it('still recovers a bare UTR when no rule fires', () => {
    const p = parseNarration('SETTLEMENT HDFCR52026090412345 BATCH');
    expect(p.matchedByRule).toBe(false);
    expect(p.reference).toBe('HDFCR52026090412345');
  });
});

// ---------------------------------------------------------------------------
describe('BR-15 — scoring and ambiguity (T-5, T-6)', () => {
  const base: Candidate = {
    voucherId: randomUUID(), voucherNumber: 'SAL/00001', documentNumber: 'SAL/00001',
    partyId: 'p1', partyName: 'Acme Trading', documentDate: '2026-05-01',
    taxableValue: '10000', grandTotal: '11800', outstanding: '11800', reference: null,
  };

  it('an exact reference dominates every other signal (T-5)', () => {
    const withRef = { ...base, reference: 'HDFCR52026050112345' };
    const s = scoreCandidate(
      { amount: '11800', txnDate: '2026-05-02', reference: 'hdfcr52026050112345', partyId: 'p1' },
      withRef);
    expect(s.score).toBe(100);          // 50 + 30 + 15 + 5
    expect(s.signals[0]).toMatch(/reference/);

    const proposal = rank(
      { amount: '11800', txnDate: '2026-05-02', reference: 'HDFCR52026050112345', partyId: 'p1' },
      [withRef, { ...base, voucherId: randomUUID(), documentNumber: 'SAL/00002' }]);
    expect(proposal.layer).toBe('exact_reference');
    expect(proposal.autoMatchable).toBe(true);
    expect(proposal.ambiguous).toBe(false);
  });

  it('two identical invoices from the same customer are never auto-resolved (T-6)', () => {
    const a = base;
    const b = { ...base, voucherId: randomUUID(), documentNumber: 'SAL/00002',
                documentDate: '2026-05-02' };
    const proposal = rank(
      { amount: '11800', txnDate: '2026-05-03', reference: null, partyId: 'p1' }, [a, b]);

    expect(proposal.best!.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
    expect(proposal.ambiguous).toBe(true);
    expect(proposal.autoMatchable).toBe(false);
    expect(proposal.reason).toMatch(/BR-15/);
    // PR-11: the runner-up must be offered, not discarded.
    expect(proposal.runnersUp).toHaveLength(1);
  });

  it('a single unambiguous candidate auto-matches without a reference', () => {
    // The calibration that matters: most Indian statement lines carry no UTR,
    // so exact amount + party + date must be enough on its own.
    const proposal = rank(
      { amount: '11800', txnDate: '2026-05-02', reference: null, partyId: 'p1' }, [base]);
    expect(proposal.best!.score).toBe(50);
    expect(proposal.autoMatchable).toBe(true);
  });

  it('a merely plausible candidate stays below the bar', () => {
    // Amount only within tolerance, right party, right week — 35, not enough.
    const proposal = rank(
      { amount: '11700', txnDate: '2026-05-02', reference: null, partyId: 'p1' }, [base]);
    expect(proposal.best!.score).toBe(35);
    expect(proposal.autoMatchable).toBe(false);
  });

  it('no plausible candidate is reported as such rather than guessed at', () => {
    const proposal = rank(
      { amount: '99999', txnDate: '2026-05-03', reference: null, partyId: null }, []);
    expect(proposal.best).toBeNull();
    expect(proposal.autoMatchable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('BR-16 — customer-deducted TDS is not a shortfall (T-7)', () => {
  it('recognises 10% professional-fee TDS on the taxable value', () => {
    // ₹50,000 taxable + 18% GST = ₹59,000 invoice. TDS is deducted on the
    // taxable value, not the gross, so ₹5,000 is withheld and ₹54,000 arrives.
    const r = inferTdsShortfall({
      invoiceGrandTotal: '59000', invoiceTaxableValue: '50000', amountReceived: '54000',
    });
    expect(r.isLikelyTds).toBe(true);
    expect(r.impliedRate).toBe('10');
    expect(r.shortfall).toBe('5000.00');
    expect(r.explanation).toMatch(/fully settled/);
  });

  it('recognises 2% contractor TDS', () => {
    const r = inferTdsShortfall({
      invoiceGrandTotal: '50000', invoiceTaxableValue: '50000', amountReceived: '49000',
    });
    expect(r.isLikelyTds).toBe(true);
    expect(r.impliedRate).toBe('2');
  });

  it('a genuine part-payment is NOT mistaken for TDS', () => {
    const r = inferTdsShortfall({
      invoiceGrandTotal: '15000', invoiceTaxableValue: '15000', amountReceived: '10000',
    });
    expect(r.isLikelyTds).toBe(false);
    expect(r.shortfall).toBe('5000.00');
    expect(r.explanation).toMatch(/genuine partial payment/);
  });

  it('settles the invoice in full and books the TDS as an asset', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: customer, postingDate: '2026-09-01',
      lines: [{ description: 'Consultancy', hsnSac: '998311', quantity: '1', unitPrice: '50000', gstRate: '18', incomeAccountId: A('Sales') }],
      createdBy: t.userId,
    });
    expect(inv.grandTotal).toBe('59000.00');

    const line = await addLine({
      date: '2026-09-10', narration: 'NEFT-HDFCN20260910-ACME TRADING PVT LTD',
      credit: '54000',
    });

    const r = await settleInvoiceFromBankLine(t.firmId, {
      clientId: t.clientId, bankTransactionId: line, invoiceVoucherId: inv.voucherId,
      treatShortfallAsTds: true, createdBy: t.userId,
    });

    expect(r.cashReceived).toBe('54000.00');
    expect(r.tdsRecognised).toBe('5000.00');
    expect(r.invoiceSettled).toBe('59000.00');
    expect(r.fullySettled).toBe(true);

    // The receivable is gone — not left as a permanently uncollectable ₹5,000.
    const out = await withFirm(t.firmId, (c) => c.query<{ o: string }>(
      `SELECT (si.grand_total - COALESCE((SELECT SUM(le.credit - le.debit)
                FROM ledger_entries le WHERE le.settles_voucher_id = si.voucher_id), 0))::text AS o
       FROM sales_invoices si WHERE si.voucher_id = $1`, [inv.voucherId]));
    expect(out.rows[0]!.o).toBe('0.00');

    // And the credit is claimable rather than lost.
    const tb = await trialBalance(t.firmId, t.clientId, '2026-09-30');
    const tds = tb.rows.find((x) => x.name === 'TDS Receivable');
    expect(tds?.debit).toBe('5000.00');
  });

  it('refuses to book a shortfall as TDS when the arithmetic does not support it', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: customer, postingDate: '2026-09-02',
      lines: [{ description: 'Goods', hsnSac: '1006', quantity: '1', unitPrice: '15000', gstRate: '0', incomeAccountId: A('Sales') }],
      createdBy: t.userId,
    });
    const line = await addLine({
      date: '2026-09-12', narration: 'NEFT-HDFCN20260912-ACME TRADING PVT LTD', credit: '10000',
    });

    await expect(settleInvoiceFromBankLine(t.firmId, {
      clientId: t.clientId, bankTransactionId: line, invoiceVoucherId: inv.voucherId,
      treatShortfallAsTds: true, createdBy: t.userId,
    })).rejects.toThrow(/BR-16/);
  });

  it('a partial payment leaves the balance correctly outstanding (T-8)', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: customer, postingDate: '2026-09-03',
      lines: [{ description: 'Goods', hsnSac: '1006', quantity: '1', unitPrice: '15000', gstRate: '0', incomeAccountId: A('Sales') }],
      createdBy: t.userId,
    });
    const line = await addLine({
      date: '2026-09-13', narration: 'NEFT-HDFCN20260913-ACME TRADING PVT LTD', credit: '10000',
    });

    const r = await settleInvoiceFromBankLine(t.firmId, {
      clientId: t.clientId, bankTransactionId: line, invoiceVoucherId: inv.voucherId,
      createdBy: t.userId,
    });
    expect(r.fullySettled).toBe(false);
    expect(r.note).toMatch(/5000\.00 remains outstanding/);
  });

  it('BV-4 — over-allocation is rejected (T-17)', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: customer, postingDate: '2026-09-04',
      lines: [{ description: 'Goods', hsnSac: '1006', quantity: '1', unitPrice: '15000', gstRate: '0', incomeAccountId: A('Sales') }],
      createdBy: t.userId,
    });
    const line = await addLine({
      date: '2026-09-14', narration: 'NEFT-HDFCN20260914-ACME', credit: '20000',
    });

    await expect(settleInvoiceFromBankLine(t.firmId, {
      clientId: t.clientId, bankTransactionId: line, invoiceVoucherId: inv.voucherId,
      createdBy: t.userId,
    })).rejects.toThrow(/BV-4/);
  });
});

// ---------------------------------------------------------------------------
describe('§9 — statement-only transactions', () => {
  it('a bank charge claims the GST rather than absorbing it', async () => {
    const line = await addLine({
      date: '2026-09-20', narration: 'SMS CHARGES 09/2026 + GST', debit: '118',
    });
    const r = await postBankCharge(t.firmId, {
      clientId: t.clientId, bankTransactionId: line,
      amount: '118', gstAmount: '18', createdBy: t.userId,
    });
    expect(r.chargeNet).toBe('100.00');
    expect(r.itcClaimed).toBe('18.00');

    const tb = await trialBalance(t.firmId, t.clientId, '2026-09-30');
    expect(tb.rows.find((x) => x.name === 'Input CGST Credit')?.debit)
      .toBe('9.00');
  });

  it('BR-17 — interest is recorded gross, with the bank\'s TDS as an asset (T-10)', async () => {
    const line = await addLine({
      date: '2026-09-25', narration: 'INT.PD:01-07-2026 TO 30-09-2026', credit: '9000',
    });
    const r = await postInterestCredit(t.firmId, {
      clientId: t.clientId, bankTransactionId: line,
      grossInterest: '10000', createdBy: t.userId,
    });
    expect(r.gross).toBe('10000.00');
    expect(r.tds).toBe('1000.00');
    expect(r.net).toBe('9000.00');

    const tb = await trialBalance(t.firmId, t.clientId, '2026-09-30');
    // Income is the gross earned, not the amount that happened to land.
    expect(tb.rows.find((x) => x.name === 'Interest Income')?.credit)
      .toBe('10000.00');
  });

  it('rejects a gross figure that contradicts what the bank actually credited', async () => {
    const line = await addLine({
      date: '2026-09-26', narration: 'INT.PD:01-07-2026 TO 30-09-2026', credit: '9000',
    });
    await expect(postInterestCredit(t.firmId, {
      clientId: t.clientId, bankTransactionId: line,
      grossInterest: '10000', tdsWithheld: '500', createdBy: t.userId,
    })).rejects.toThrow(/BR-17/);
  });
});

// ---------------------------------------------------------------------------
describe('§10 — cheques and the float', () => {
  let chequeId: string;
  let paymentVoucherId: string;

  it('BR-19 — the ledger is dated at issue, not at clearance (T-12)', async () => {
    const p = await postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'payment', postingDate: '2026-09-05',
      narration: 'Cheque 445566 to Shree Enterprises', createdBy: t.userId,
      lines: [
        { accountId: A('Bank Charges'), debit: '62000' },
        { accountId: A('Bank Accounts'), credit: '62000' },
      ],
    });
    paymentVoucherId = p.id;

    const { chequeId: id } = await registerCheque(t.firmId, {
      clientId: t.clientId, bankAccountId, voucherId: p.id,
      chequeNumber: '445566', chequeDate: '2026-09-05',
      direction: 'issued', amount: '62000',
    });
    chequeId = id;

    // Books have paid it on the 5th; the bank has not seen it.
    const brs = await bankReconciliationStatement(t.firmId, bankAccountId, '2026-09-15');
    const item = brs.lines.find((l) => l.label.startsWith('Cheques issued'));
    expect(item?.amount).toBe('62000.00');
    expect(item?.effect).toBe('add');
  });

  it('clearance is a matching event, and the float is measured', async () => {
    const line = await addLine({
      date: '2026-09-20', narration: 'CHQ PAID - 445566', debit: '62000',
    });
    const r = await clearCheque(t.firmId, {
      clientId: t.clientId, chequeId, bankTransactionId: line,
      clearedDate: '2026-09-20', clearedBy: t.userId,
    });
    expect(r.floatDays).toBe(15);

    // Once cleared it is no longer a reconciling item.
    const brs = await bankReconciliationStatement(t.firmId, bankAccountId, '2026-09-25');
    expect(brs.lines.find((l) => l.label.startsWith('Cheques issued'))).toBeUndefined();
  });

  it('BR-20 — a bounced received cheque reverses, charges, and raises S.138 (T-13)', async () => {
    const p = await postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'receipt', postingDate: '2026-10-01',
      narration: 'Cheque 778899 received from Acme', createdBy: t.userId,
      lines: [
        { accountId: A('Bank Accounts'), debit: '25000' },
        { accountId: A('Debtors'), credit: '25000', partyType: 'customer', partyId: customer },
      ],
    });

    const { chequeId: rc } = await registerCheque(t.firmId, {
      clientId: t.clientId, bankAccountId, voucherId: p.id, partyId: customer,
      chequeNumber: '778899', chequeDate: '2026-10-01',
      direction: 'received', amount: '25000',
    });

    const r = await bounceCheque(t.firmId, {
      clientId: t.clientId, chequeId: rc, bounceDate: '2026-10-06',
      reason: 'Funds insufficient', returnCharge: '590', actedBy: t.userId,
    });

    expect(r.section138Flag).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/Section 138/);
    expect(r.chargeVoucherId).not.toBeNull();

    // The receivable is reinstated by the reversal, not left cleared.
    const bal = await withFirm(t.firmId, (c) => c.query<{ b: string }>(
      `SELECT COALESCE(SUM(debit - credit), 0)::text AS b FROM ledger_entries
       WHERE account_id = $1 AND party_id = $2`, [A('Debtors'), customer]));
    expect(Number(bal.rows[0]!.b)).toBeGreaterThan(0);
  });

  it('BR-21 — a cheque uncleared past three months is flagged stale (T-14)', async () => {
    const p = await postVoucher(t.firmId, {
      clientId: t.clientId, voucherType: 'payment', postingDate: '2026-06-01',
      narration: 'Cheque 990011', createdBy: t.userId,
      lines: [
        { accountId: A('Bank Charges'), debit: '1500' },
        { accountId: A('Bank Accounts'), credit: '1500' },
      ],
    });
    await registerCheque(t.firmId, {
      clientId: t.clientId, bankAccountId, voucherId: p.id,
      chequeNumber: '990011', chequeDate: '2026-06-01',
      direction: 'issued', amount: '1500',
    });

    const stale = await staleCheques(t.firmId, t.clientId, '2026-10-10');
    expect(stale.map((s) => s.chequeNumber)).toContain('990011');
    expect(stale.find((s) => s.chequeNumber === '990011')!.ageDays).toBeGreaterThan(90);
  });
});

// ---------------------------------------------------------------------------
describe('BV-5 / BV-6 / BV-7 — the database refuses invalid matches', () => {
  it('a match to another client\'s voucher is rejected (T-16)', async () => {
    const other = await seedTenant({
      firmName: `Other Firm ${randomUUID().slice(0, 8)}`,
      clientName: 'Other Traders',
      userEmail: `other-${randomUUID()}@test.local`,
      startYear: 2026,
    });
    const foreign = await postVoucher(other.firmId, {
      clientId: other.clientId, voucherType: 'journal', postingDate: '2026-09-01',
      narration: 'unrelated', createdBy: other.userId,
      lines: [
        { accountId: other.accounts['Bank Accounts']!, debit: '100' },
        { accountId: other.accounts['Bank Charges']!, credit: '100' },
      ],
    });

    const line = await addLine({
      date: '2026-09-28', narration: 'NEFT-HDFCN20260928-UNKNOWN', credit: '100',
    });

    await expect(withFirm(t.firmId, (c) => c.query(
      `INSERT INTO reconciliation_matches
         (firm_id, client_id, bank_transaction_id, voucher_id, amount, match_type, proposed_by)
       VALUES ($1,$2,$3,$4,'100','manual','user')`,
      [t.firmId, t.clientId, line, foreign.id]))).rejects.toThrow(/BV-6/);
  });

  it('allocating more than the bank line carries is rejected', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: customer, postingDate: '2026-09-05',
      lines: [{ description: 'Goods', hsnSac: '1006', quantity: '1', unitPrice: '5000', gstRate: '0', incomeAccountId: A('Sales') }],
      createdBy: t.userId,
    });
    const line = await addLine({
      date: '2026-09-29', narration: 'NEFT-HDFCN20260929-ACME', credit: '1000',
    });

    await expect(withFirm(t.firmId, (c) => c.query(
      `INSERT INTO reconciliation_matches
         (firm_id, client_id, bank_transaction_id, voucher_id, amount, match_type, proposed_by)
       VALUES ($1,$2,$3,$4,'5000','manual','user')`,
      [t.firmId, t.clientId, line, inv.voucherId]))).rejects.toThrow(/BV-5/);
  });

  it('an AI-proposed match cannot exist without a human approver (BV-11, AT-13)', async () => {
    const inv = await createInvoice(t.firmId, {
      clientId: t.clientId, partyId: customer, postingDate: '2026-09-06',
      lines: [{ description: 'Goods', hsnSac: '1006', quantity: '1', unitPrice: '2000', gstRate: '0', incomeAccountId: A('Sales') }],
      createdBy: t.userId,
    });
    const line = await addLine({
      date: '2026-09-30', narration: 'NEFT-HDFCN20260930-ACME', credit: '2000',
    });

    await expect(withFirm(t.firmId, (c) => c.query(
      `INSERT INTO reconciliation_matches
         (firm_id, client_id, bank_transaction_id, voucher_id, amount, match_type, proposed_by)
       VALUES ($1,$2,$3,$4,'2000','ai_proposed','ai')`,
      [t.firmId, t.clientId, line, inv.voucherId])))
      .rejects.toThrow(/match_ai_needs_approver_ck/);
  });
});

// ---------------------------------------------------------------------------
describe('BR-1 — statement lines are immutable', () => {
  it('the app role cannot rewrite what the bank reported', async () => {
    const line = await addLine({
      date: '2026-10-15', narration: 'NEFT-HDFCN20261015-SOMEONE', credit: '4321',
    });
    await expect(withFirm(t.firmId, (c) => c.query(
      'UPDATE bank_transactions SET credit = $2 WHERE id = $1', [line, '9999'])))
      .rejects.toThrow(/permission denied/i);
    await expect(withFirm(t.firmId, (c) => c.query(
      'DELETE FROM bank_transactions WHERE id = $1', [line])))
      .rejects.toThrow(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
describe('BR-22 / BR-23 — the BRS must tie (T-18, T-19)', () => {
  let isolatedBank: string;

  beforeAll(async () => {
    isolatedBank = await withFirm(t.firmId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO bank_accounts
           (firm_id, client_id, account_id, bank_name, account_number_last4,
            account_number_hash, kind, opening_balance, opening_date)
         VALUES ($1,$2,$3,'ICICI Bank','4321',$4,'current','0','2026-04-01')
         RETURNING id`,
        [t.firmId, t.clientId, A('Cash'), accountNumberHash('000401234321')]);
      return r.rows[0]!.id;
    });
  });

  it('an unexplained residual is surfaced, never rounded away', async () => {
    // The books say nothing happened on this account; the bank says ₹120 left.
    await withFirm(t.firmId, (c) => c.query(
      `INSERT INTO bank_statements
         (firm_id, client_id, bank_account_id, period_from, period_to,
          opening_balance, closing_balance, row_count, parse_status,
          parser_version, uploaded_by)
       VALUES ($1,$2,$3,'2026-04-01','2026-04-30','0','-120',0,'parsed','test',$4)`,
      [t.firmId, t.clientId, isolatedBank, t.userId]));

    const brs = await bankReconciliationStatement(t.firmId, isolatedBank, '2026-04-30');
    expect(brs.ties).toBe(false);
    expect(brs.difference).toBe('-120.00');
    expect(brs.exception).toMatch(/BR-22/);
    expect(brs.exception).toMatch(/do not adjust the figure/);
  });

  it('an unreconciled account blocks period close', async () => {
    const r = await assertReconciledForClose(t.firmId, t.clientId, '2026-04-30');
    expect(r.ok).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/ICICI Bank ••4321/);
  });
});
