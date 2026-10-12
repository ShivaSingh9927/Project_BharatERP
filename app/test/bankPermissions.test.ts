import { describe, expect, it } from 'vitest';
import { bankClassificationCapability, hasBankCapability } from '../src/domain/bankPermissions.ts';

describe('bank role capabilities', () => {
  it('lets owners and CA partners confirm accounting effects', () => {
    for (const role of ['owner', 'ca_partner']) {
      expect(hasBankCapability(role, 'confirm')).toBe(true);
      expect(hasBankCapability(role, 'manage_settings')).toBe(true);
    }
  });

  it('lets CA staff prepare or import review work without posting or changing firm settings', () => {
    expect(hasBankCapability('ca_staff', 'read')).toBe(true);
    expect(hasBankCapability('ca_staff', 'import')).toBe(true);
    expect(hasBankCapability('ca_staff', 'review')).toBe(true);
    expect(hasBankCapability('ca_staff', 'confirm')).toBe(false);
    expect(hasBankCapability('ca_staff', 'manage_settings')).toBe(false);
  });

  it('keeps auditors read-only and unknown roles denied', () => {
    expect(hasBankCapability('auditor', 'read')).toBe(true);
    for (const capability of ['import', 'review', 'confirm', 'manage_settings'] as const) {
      expect(hasBankCapability('auditor', capability)).toBe(false);
      expect(hasBankCapability('support', capability)).toBe(false);
    }
  });

  it('requires confirmation for posting classifications and fails closed on unknown values', () => {
    expect(bankClassificationCapability('unsure')).toBe('review');
    expect(bankClassificationCapability('customer_receipt_pending')).toBe('review');
    expect(bankClassificationCapability('business_expense')).toBe('confirm');
    expect(bankClassificationCapability('transfer')).toBe('confirm');
    expect(bankClassificationCapability('unknown')).toBe('confirm');
  });
});
