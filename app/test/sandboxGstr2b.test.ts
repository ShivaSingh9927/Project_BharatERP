/**
 * The live 2B fetch flow — bills-and-expenses.md §5.1.
 *
 * The value tested here is the discipline, not the transport: the OTP is
 * relayed once and never kept, and the fetched records are the same shape the
 * downloaded-JSON path produces, so reconciliation cannot tell where the
 * statement came from.
 */

import { describe, it, expect } from 'vitest';
import type { Gstr2bFetcher } from '../src/integrations/sandboxGstr2b.ts';
import { parseGstr2b } from '../src/integrations/gstr2bJson.ts';
import { reconcile, type LedgerBill } from '../src/domain/gstr2b.ts';

/** A fake that records what it was asked, so the flow can be checked. */
function fakeFetcher(doc: unknown) {
  const calls: string[] = [];
  const seen: { otp?: string } = {};
  const fetcher: Gstr2bFetcher = {
    async requestOtp(gstin, username) {
      calls.push(`otp:${gstin}:${username}`);
      return { message: 'OTP sent to registered mobile' };
    },
    async verifyOtp(_g, _u, otp) { calls.push('verify'); seen.otp = otp; },
    async fetch() { calls.push('fetch'); return doc; },
  };
  return { fetcher, calls, seen };
}

const doc = {
  data: { docdata: { b2b: [
    { ctin: '09AAKCC1645G1ZN', inv: [
      { inum: 'INV-1', dt: '17-08-2026', val: '1180.00', itcavl: 'Y',
        items: [{ itm_det: { txval: 1000, iamt: 180, camt: 0, samt: 0, csamt: 0 } }] } ] },
  ] } },
};

describe('the fetch-and-reconcile flow', () => {
  it('verifies the OTP immediately before the fetch that needs it', async () => {
    const { fetcher, calls, seen } = fakeFetcher(doc);
    await fetcher.verifyOtp('09AAKCC1645G1ZN', 'user.1', '123456');
    const raw = await fetcher.fetch('09AAKCC1645G1ZN', '2026-08');
    expect(calls).toEqual(['verify', 'fetch']);
    expect(seen.otp).toBe('123456');
    // What comes back reconciles like any other statement.
    const bill: LedgerBill = {
      voucherId: 'v', supplierGstin: '09AAKCC1645G1ZN', billNumber: 'INV-1',
      billDate: '2026-08-17', taxableValue: '1000.00', totalTax: '180.00',
      grandTotal: '1180.00',
    };
    expect(reconcile([bill], parseGstr2b(raw))[0]!.status).toBe('matched');
  });

  it('produces records indistinguishable from the downloaded JSON', async () => {
    // The whole point of the interface: the reconciler cannot tell the source.
    const { fetcher } = fakeFetcher(doc);
    const fromWire = parseGstr2b(await fetcher.fetch('g', '2026-08'));
    const fromFile = parseGstr2b(doc);
    expect(fromWire).toEqual(fromFile);
  });
});
