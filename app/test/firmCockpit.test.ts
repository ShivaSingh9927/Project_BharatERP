/**
 * The firm cockpit — bills-and-expenses.md §9.
 *
 * The filing calendar and the ranking are pure, and they decide what a CA sees
 * first on a Monday morning, so they are tested directly.
 */

import { describe, it, expect } from 'vitest';
import { returnDueDates, daysUntil } from '../src/domain/firmCockpit.ts';

describe('the filing calendar', () => {
  it('puts GSTR-1 on the 11th and 3B on the 20th of the following month', () => {
    expect(returnDueDates('2026-08')).toEqual({
      gstr1: '2026-09-11', gstr3b: '2026-09-20' });
  });
  it('rolls December into the next year', () => {
    expect(returnDueDates('2026-12')).toEqual({
      gstr1: '2027-01-11', gstr3b: '2027-01-20' });
  });
});

describe('counting days to a deadline', () => {
  it('is positive before, zero on the day, negative after', () => {
    expect(daysUntil('2026-09-08', '2026-09-20')).toBe(12);
    expect(daysUntil('2026-09-20', '2026-09-20')).toBe(0);
    expect(daysUntil('2026-09-25', '2026-09-20')).toBe(-5);
  });
  it('counts across a month boundary', () => {
    expect(daysUntil('2026-08-30', '2026-09-11')).toBe(12);
  });
});
