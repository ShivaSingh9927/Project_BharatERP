/**
 * GSTIN structure and checksum validation.
 * Spec: invoicing.md §3.2, SI-1 · bills-and-expenses.md BE-4b
 *
 * This is the cheapest and highest-value validation in the product.
 *
 * Our DeepSeek OCR probe misread a vendor GSTIN in one run of two —
 * `27AAPFS4321L1ZK` came back as `27AAFP54321L1ZK`, characters transposed,
 * reported without hedging. Every arithmetic check passed: line items summed
 * to the taxable total, tax equalled taxable × 18%, and the grand total was
 * consistent. All green, identifier silently wrong.
 *
 * Arithmetic validation cannot catch a corrupted identifier. The check digit
 * can, it runs in microseconds, and it costs nothing. Run it on every
 * extracted GSTIN before anything else happens.
 */

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * GSTIN layout (15 characters):
 *   [0:2]   state code          27 = Maharashtra
 *   [2:12]  PAN                 5 letters, 4 digits, 1 letter
 *   [12]    entity number       nth registration for this PAN in this state
 *   [13]    'Z'                 fixed
 *   [14]    check digit
 */
const GSTIN_SHAPE = /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

export interface GstinCheck {
  valid: boolean;
  /** Present when invalid: which test failed and why. */
  reason?: string;
  stateCode?: string;
  pan?: string;
}

/**
 * Computes the check digit for the first 14 characters.
 *
 * Each character's charset index is weighted alternately by 1 and 2, and the
 * quotient and remainder of division by 36 are summed. The check digit is
 * whatever brings the total to a multiple of 36.
 */
export function gstinCheckDigit(first14: string): string {
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHARSET.indexOf(first14[i]!);
    if (value < 0) throw new Error(`invalid character "${first14[i]}" at position ${i}`);
    const weighted = value * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(weighted / 36) + (weighted % 36);
  }
  return CHARSET[(36 - (total % 36)) % 36]!;
}

export function validateGstin(gstin: string | null | undefined): GstinCheck {
  if (!gstin) return { valid: false, reason: 'GSTIN is empty' };

  const g = gstin.trim().toUpperCase();

  if (g.length !== 15) {
    return { valid: false, reason: `expected 15 characters, got ${g.length}` };
  }
  if (!GSTIN_SHAPE.test(g)) {
    return { valid: false, reason: 'does not match the GSTIN character layout' };
  }

  const expected = gstinCheckDigit(g.slice(0, 14));
  if (expected !== g[14]) {
    // The transposition case. Nothing else in the pipeline catches this.
    return {
      valid: false,
      reason: `check digit mismatch — expected "${expected}", got "${g[14]}". ` +
              'Likely a transcription or OCR error.',
    };
  }

  return { valid: true, stateCode: g.slice(0, 2), pan: g.slice(2, 12) };
}

/** State code is the first two digits. Present on every registered party. */
export function stateCodeOf(gstin: string): string {
  return gstin.slice(0, 2);
}

/**
 * The single decision that determines CGST+SGST versus IGST (Lesson 5).
 *
 * Same state as the supplier → the tax splits into two halves collected by
 * the centre and the state. Different state → one IGST charge. Everything
 * downstream in the tax computation follows from this boolean.
 *
 * Spec: invoicing.md §3.2
 */
export function isIntraState(supplierGstin: string, placeOfSupply: string): boolean {
  return stateCodeOf(supplierGstin) === placeOfSupply;
}

/** Indian state and UT codes, used to validate place of supply (SI-4). */
export const STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
  '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh', '97': 'Other Territory', '96': 'Other Country',
};

export function isValidStateCode(code: string): boolean {
  return code in STATE_CODES;
}
