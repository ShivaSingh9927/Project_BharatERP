/**
 * What the GST portal says about a supplier — bills-and-expenses.md §4.8.
 *
 * A valid check digit proves a GSTIN was typed correctly and nothing more. The
 * questions that decide whether input credit survives an assessment — is the
 * registration still live, may this supplier charge GST at all — cannot be
 * answered from the document, and every fixture here is a real shape returned
 * by the portal.
 */

import { describe, it, expect } from 'vitest';
import { checkRegistration } from '../src/domain/gstinRegistry.ts';
import type { GstinRecord } from '../src/integrations/sandboxGst.ts';

const record = (over: Partial<GstinRecord> = {}): GstinRecord => ({
  gstin: '09AAKCC1645G1ZN',
  status: 'Active',
  taxpayerType: 'Regular',
  legalName: 'COMMODUM GROCERIES PRIVATE LIMITED',
  tradeName: 'COMMODUM GROCERIES PRIVATE LIMITED',
  stateCode: '09',
  registeredOn: '2022-08-17',
  cancelledOn: null,
  einvoiceRequired: false,
  raw: {},
  source: 'test',
  ...over,
});

const bill = { date: '2026-08-17', chargesTax: true, hasIrn: false };
const messages = (...a: Parameters<typeof checkRegistration>) =>
  checkRegistration(...a).map((f) => `${f.severity}: ${f.message}`).join(' | ');

describe('an active, regular supplier', () => {
  it('produces no findings at all', () => {
    expect(checkRegistration(record(), bill)).toEqual([]);
  });
});

describe('a registration the portal has never issued', () => {
  it('blocks, and says the number is not a typo', () => {
    /*
     * The check digit already passed, so this is not a misread — there is
     * simply no registration to claim credit against.
     */
    const f = checkRegistration(null, bill);
    expect(f[0]!.severity).toBe('blocker');
    expect(f[0]!.message).toMatch(/no record of this supplier GSTIN/);
    expect(f[0]!.message).toMatch(/check digit is correct/);
  });
});

describe('a cancelled registration', () => {
  it('blocks a bill dated after the cancellation', () => {
    const f = checkRegistration(
      record({ status: 'Cancelled', cancelledOn: '2026-01-31' }), bill);
    expect(f[0]!.severity).toBe('blocker');
    expect(f[0]!.message).toMatch(/cancelled \(from 2026-01-31\)/);
  });

  it('only warns about a bill raised while they were still registered', () => {
    /*
     * The invoice date decides. A supplier who was registered when they billed
     * us issued a perfectly good invoice; it is the NEXT one that is a problem.
     */
    const f = checkRegistration(
      record({ status: 'Cancelled', cancelledOn: '2026-12-31' }), bill);
    expect(f[0]!.severity).toBe('warning');
    expect(f[0]!.message).toMatch(/after this invoice/);
  });
});

describe('a composition dealer', () => {
  it('blocks an invoice that charges GST', () => {
    /*
     * s.10(4): a composition dealer pays a flat rate out of its own turnover
     * and may not collect tax from a customer. GST on its invoice is both
     * irregular and uncreditable — and nothing on the paper says so.
     */
    const m = messages(record({ taxpayerType: 'Composition' }), bill);
    expect(m).toMatch(/blocker: .*composition scheme/);
    expect(m).toMatch(/s\.10\(4\)/);
  });

  it('says nothing when the invoice correctly charges none', () => {
    expect(checkRegistration(
      record({ taxpayerType: 'Composition' }, ), { ...bill, chargesTax: false }))
      .toEqual([]);
  });
});

describe('an invoice older than the registration', () => {
  it('blocks — a GSTIN cannot appear before it existed', () => {
    const m = messages(record({ registeredOn: '2026-09-01' }), bill);
    expect(m).toMatch(/blocker: .*before the supplier was registered/);
  });
});

describe('a supplier who must issue e-invoices', () => {
  it('warns when the document carries no IRN', () => {
    const m = messages(record({ einvoiceRequired: true }), bill);
    expect(m).toMatch(/warning: .*required to issue e-invoices/);
  });

  it('says nothing when the document carries one', () => {
    expect(checkRegistration(
      record({ einvoiceRequired: true }), { ...bill, hasIrn: true })).toEqual([]);
  });

  it('is a warning, not a blocker', () => {
    /*
     * Rule 48(5) does make a non-compliant invoice invalid, but the threshold
     * turns on the supplier's turnover and on the supply being B2B — neither
     * of which is on the paper. Blocking would refuse most of a real purchase
     * ledger on a rule that may not apply to it.
     */
    const f = checkRegistration(record({ einvoiceRequired: true }), bill);
    expect(f.every((x) => x.severity === 'warning')).toBe(true);
  });
});

describe('when nobody could be asked', () => {
  it('concludes nothing, rather than concluding the supplier is fine', () => {
    /*
     * The distinction this whole module rests on: "no record" is a finding
     * about the supplier, "unavailable" is a gap in what we know, and they
     * must never collapse into each other.
     */
    expect(checkRegistration('unavailable', bill)).toEqual([]);
  });
});
