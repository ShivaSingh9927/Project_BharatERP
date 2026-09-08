/**
 * GSTR-3B set-off — Rule 88A. invoicing.md §10.
 *
 * The order credit is applied in decides how much cash goes out, so the rule
 * is tested directly: IGST credit first and across heads, CGST/SGST credit
 * confined to their own head plus IGST, cess its own pool.
 */

import { describe, it, expect } from 'vitest';
import { setOff, type Heads } from '../src/domain/gstr3b.ts';

const H = (igst: string, cgst: string, sgst: string, cess = '0.00'): Heads =>
  ({ igst, cgst, sgst, cess });

describe('applying input credit against output', () => {
  it('pays nothing in cash when credit covers each head exactly', () => {
    const s = setOff(H('100', '50', '50'), H('100', '50', '50'));
    expect(s.cash).toEqual(H('0.00', '0.00', '0.00'));
    expect(s.carryForward).toEqual(H('0.00', '0.00', '0.00'));
  });

  it('spends IGST credit across CGST and SGST before touching their credit', () => {
    /*
     * Output CGST 100 / SGST 100, and 200 of IGST credit, no CGST/SGST credit.
     * Rule 88A: the IGST credit clears both, so nothing is paid in cash.
     */
    const s = setOff(H('0', '100', '100'), H('200', '0', '0'));
    expect(s.cash).toEqual(H('0.00', '0.00', '0.00'));
    expect(s.carryForward.igst).toBe('0.00');
  });

  it('leaves CGST and SGST credit unable to cross to each other', () => {
    /*
     * Output CGST 100, SGST 0; credit CGST 0, SGST 100. SGST credit cannot pay
     * CGST liability, so 100 of CGST is cash and the SGST credit carries.
     */
    const s = setOff(H('0', '100', '0'), H('0', '0', '100'));
    expect(s.cash.cgst).toBe('100.00');
    expect(s.carryForward.sgst).toBe('100.00');
  });

  it('carries forward credit that exceeds the liability', () => {
    const s = setOff(H('50', '0', '0'), H('200', '0', '0'));
    expect(s.cash.igst).toBe('0.00');
    expect(s.carryForward.igst).toBe('150.00');
  });

  it('keeps cess in its own pool', () => {
    const s = setOff(H('0', '0', '0', '90'), H('100', '0', '0', '40'));
    expect(s.cash.cess).toBe('50.00');           // 90 − 40
    expect(s.carryForward.igst).toBe('100.00');  // IGST credit cannot pay cess
  });

  it('uses IGST credit on IGST first, then the surplus on CGST', () => {
    // Output IGST 100 CGST 100; credit IGST 150. 100 clears IGST, 50 to CGST,
    // leaving 50 CGST as cash.
    const s = setOff(H('100', '100', '0'), H('150', '0', '0'));
    expect(s.cash.igst).toBe('0.00');
    expect(s.cash.cgst).toBe('50.00');
    expect(s.carryForward.igst).toBe('0.00');
  });
});
