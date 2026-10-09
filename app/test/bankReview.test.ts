import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { accountNumberHash, bankReviewOptions, reviewBankTransaction } from '../src/domain/banking.ts';
import { suggestFundingFromConfirmedSource } from '../src/domain/matching.ts';
import { closePools, withFirm } from '../src/db/pool.ts';

let t: SeededTenant;
let bankAccountId: string;

beforeAll(async () => {
  t = await seedTenant({
    firmName: `Review Firm ${randomUUID().slice(0, 8)}`,
    clientName: 'Review Traders', userEmail: `review-${randomUUID()}@test.local`, startYear: 2026,
  });
  bankAccountId = await withFirm(t.firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO bank_accounts
         (firm_id, client_id, account_id, bank_name, account_number_last4,
          account_number_hash, kind, opening_balance, opening_date)
       VALUES ($1,$2,$3,'HDFC Bank','7788',$4,'current','0','2026-04-01') RETURNING id`,
      [t.firmId, t.clientId, t.accounts['Bank Accounts'], accountNumberHash('50100123457788')]);
    return r.rows[0]!.id;
  });
});

afterAll(async () => { await closePools(); });

async function bankLine(narration: string, debit = '0', credit = '0'): Promise<string> {
  return withFirm(t.firmId, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO bank_transactions
         (firm_id, client_id, bank_account_id, txn_date, narration, debit, credit,
          content_hash, source)
       VALUES ($1,$2,$3,'2026-08-10',$4,$5,$6,$7,'statement') RETURNING id`,
      [t.firmId, t.clientId, bankAccountId, narration, debit, credit, randomUUID()]);
    return r.rows[0]!.id;
  });
}

describe('bank transaction review', () => {
  it('posts a receipt-missing expense gross and records zero GST credit', async () => {
    const id = await bankLine('GOOGLE ADS PAYMENT', '2500');
    const options = await bankReviewOptions(t.firmId, t.clientId, bankAccountId);
    const marketing = options.expenseAccounts.find((a) => a.name === 'Marketing')!;
    const r = await reviewBankTransaction(t.firmId, {
      clientId: t.clientId, bankTransactionId: id, classification: 'business_expense',
      accountId: marketing.id, note: 'campaign spend; receipt requested', reviewedBy: t.userId,
    });
    expect(r.posted).toBe(true);

    const stored = await withFirm(t.firmId, (c) => c.query<{
      classification: string; receipt_status: string; evidence: { gst_itc_claimed: string };
    }>(`SELECT review.classification, review.receipt_status, match.evidence
        FROM bank_transaction_reviews review
        JOIN reconciliation_matches match ON match.bank_transaction_id = review.bank_transaction_id
       WHERE review.bank_transaction_id = $1`, [id]));
    expect(stored.rows[0]).toMatchObject({
      classification: 'business_expense', receipt_status: 'missing',
      evidence: { gst_itc_claimed: '0.00' },
    });
  });

  it('keeps a personal payment out of the P&L', async () => {
    const id = await bankLine('PERSONAL SHOPPING', '900');
    const r = await reviewBankTransaction(t.firmId, {
      clientId: t.clientId, bankTransactionId: id, classification: 'personal', reviewedBy: t.userId,
    });
    expect(r.posted).toBe(true);
    const ledger = await withFirm(t.firmId, (c) => c.query<{ name: string }>(
      `SELECT a.name FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
       WHERE le.voucher_id = $1 AND le.debit > 0`, [r.voucherId]));
    expect(['Drawings', 'Personal Expenses Recoverable']).toContain(ledger.rows[0]!.name);
  });

  it('leaves an unsure payment unmatched and does not post it', async () => {
    const id = await bankLine('UPI UNKNOWN MERCHANT', '700');
    const r = await reviewBankTransaction(t.firmId, {
      clientId: t.clientId, bankTransactionId: id, classification: 'unsure',
      note: 'ask founder', reviewedBy: t.userId,
    });
    expect(r).toMatchObject({ posted: false, voucherId: null });
    const review = await withFirm(t.firmId, (c) => c.query<{ classification: string; posted_voucher_id: string | null }>(
      'SELECT classification, posted_voucher_id FROM bank_transaction_reviews WHERE bank_transaction_id = $1', [id]));
    expect(review.rows[0]).toEqual({ classification: 'unsure', posted_voucher_id: null });
  });

  it('records a share application answer without posting or reconciling the receipt', async () => {
    const id = await bankLine('NEFT FROM SHIVA SINGH', '0', '50000');
    const r = await reviewBankTransaction(t.firmId, {
      clientId: t.clientId, bankTransactionId: id,
      classification: 'share_application_pending', sourceName: 'Shiva Singh',
      note: 'Application received; allotment documents pending', reviewedBy: t.userId,
    });
    expect(r).toMatchObject({ posted: false, voucherId: null });
    const stored = await withFirm(t.firmId, (c) => c.query<{
      classification: string; source_name: string; posted_voucher_id: string | null;
      status: string; match_count: number;
    }>(`SELECT review.classification, review.source_name, review.posted_voucher_id,
              txn.status, (SELECT count(*)::int FROM reconciliation_matches m
                           WHERE m.bank_transaction_id = review.bank_transaction_id) AS match_count
        FROM bank_transaction_reviews review
        JOIN bank_transactions_reconciled txn ON txn.id = review.bank_transaction_id
        WHERE review.bank_transaction_id = $1`, [id]));
    expect(stored.rows[0]).toMatchObject({
      classification: 'share_application_pending', source_name: 'Shiva Singh',
      posted_voucher_id: null, status: 'unmatched', match_count: 0,
    });
  });

  it('rejects share application classification for an outgoing payment', async () => {
    const id = await bankLine('NEFT TO SHIVA SINGH', '50000');
    await expect(reviewBankTransaction(t.firmId, {
      clientId: t.clientId, bankTransactionId: id,
      classification: 'share_application_pending', sourceName: 'Shiva Singh',
      reviewedBy: t.userId,
    })).rejects.toThrow('requires an incoming receipt');
  });
});

describe('funding suggestion', () => {
  it('suggests only a consistently confirmed exact payer, with confirmation still required', () => {
    const prior = [{ sourceName: 'Shiva Singh', classification: 'share_application_pending' }];
    expect(suggestFundingFromConfirmedSource('SHIVA SINGH', prior)).toEqual({
      classification: 'share_application_pending', sourceName: 'Shiva Singh',
      basis: 'prior_confirmation',
      reason: 'A prior receipt from this same extracted payer name was reviewed this way.',
    });
    expect(suggestFundingFromConfirmedSource('Shiva Kumar Singh', prior)).toBeNull();
    expect(suggestFundingFromConfirmedSource('Shiva Singh', [
      ...prior, { sourceName: 'Shiva Singh', classification: 'related_party_loan_pending' },
    ])).toBeNull();
  });
});
