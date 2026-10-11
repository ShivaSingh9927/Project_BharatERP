import { describe, expect, it } from 'vitest';
import { validateBankActivityRange } from '../src/domain/nexusBankActivity.ts';

describe('Nexus bank activity date range', () => {
  it('accepts an inclusive calendar-date range', () => {
    expect(() => validateBankActivityRange('2026-10-01', '2026-10-10')).not.toThrow();
  });

  it('rejects malformed, impossible, and reversed dates before a case is created', () => {
    expect(() => validateBankActivityRange('2026-10-1', '2026-10-10')).toThrow(/invalid start date/);
    expect(() => validateBankActivityRange('2026-02-30', '2026-03-01')).toThrow(/invalid start date/);
    expect(() => validateBankActivityRange('2026-10-10', '2026-10-01')).toThrow(/must not be after/);
  });
});
