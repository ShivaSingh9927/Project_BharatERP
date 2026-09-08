/**
 * The candidate search — bills-and-expenses.md BE-21.
 *
 * The gate is what makes searching safe, so what is tested here is mostly the
 * refusals: a reading that does not tie, and — the important one — two
 * readings that both tie and therefore cannot both be believed.
 *
 * `gradeCandidates` is pure, so none of this needs the sidecar running.
 */

import { describe, it, expect } from 'vitest';
import { gradeCandidates, type CandidateTable } from '../src/parse/candidateTables.ts';

const HEADER = ['Description', 'Taxable Value', 'IGST', 'Total'];
const good = (method: string, taxable: string, igst: string, total: string): CandidateTable => ({
  page: 1, method, cells: [HEADER, ['Widget', taxable, igst, total]],
});

describe('grading every candidate', () => {
  it('accepts the one reading that ties', () => {
    const v = gradeCandidates([good('lines', '1000.00', '180.00', '1180.00')],
                              [1], 'yes', '');
    expect(v?.table.readable).toBe(true);
    expect(v?.method).toBe('lines');
    expect(v?.table.sums).toMatchObject({ taxable: '1000.00', igst: '180.00', total: '1180.00' });
  });

  it('ignores candidates on other pages', () => {
    expect(gradeCandidates([good('lines', '1000.00', '180.00', '1180.00')],
                           [2], 'yes', '')).toBeNull();
  });

  it('finds the header even when it is not the first row', () => {
    // A ruled invoice is one big outer box, so row 0 of the extracted table is
    // the letterhead and the captions sit further down. Grading only the first
    // rows refused documents whose table had been extracted perfectly.
    const t: CandidateTable = { page: 1, method: 'lines', cells: [
      ['ACME LTD  GSTIN 06AAACA6173F2ZX  TAX INVOICE', '', '', ''],
      ['Invoice No : 42', '', '', ''],
      HEADER,
      ['Widget', '1000.00', '180.00', '1180.00'],
    ] };
    expect(gradeCandidates([t], [1], 'yes', '')?.table.readable).toBe(true);
  });

  it('treats two strategies finding the same grid as one reading', () => {
    const v = gradeCandidates([good('lines', '1000.00', '180.00', '1180.00'),
                               good('default', '1000.00', '180.00', '1180.00')],
                              [1], 'yes', '');
    expect(v?.table.readable).toBe(true);
    expect(v?.survivors).toBe(1);
  });

  it('REFUSES when two readings both tie with different figures', () => {
    // The heart of it. Both are internally consistent, so no arithmetic here
    // can choose, and picking one would be a coin toss with a provenance
    // trail behind it.
    const v = gradeCandidates([good('lines', '1000.00', '180.00', '1180.00'),
                               good('text', '2000.00', '360.00', '2360.00')],
                              [1], 'yes', '');
    expect(v?.table.readable).toBe(false);
    expect(v?.survivors).toBe(2);
    expect(v?.table.reason).toMatch(/cannot all be right/);
  });

  it('reports the closest miss when nothing ties', () => {
    const v = gradeCandidates([good('lines', '1000.00', '180.00', '9999.00')],
                              [1], 'yes', '');
    expect(v?.table.readable).toBe(false);
    expect(v?.survivors).toBe(0);
    expect(v?.table.reason).toBeDefined();
  });

  it('does not prefer a strategy over the arithmetic', () => {
    // `lines` is usually the better reader, but it does not win by being
    // named: here it fails to tie and the text reading is taken.
    const v = gradeCandidates([good('lines', '1000.00', '180.00', '9999.00'),
                               good('text', '1000.00', '180.00', '1180.00')],
                              [1], 'yes', '');
    expect(v?.table.readable).toBe(true);
    expect(v?.method).toBe('text');
  });
});
