/**
 * Repairing the three glyph confusions PaddleOCR actually makes.
 * Spec: bank-and-reconciliation.md §5.1; measured in DEFECT-LOG Stage 12
 *
 * Measured across seven sample statements, PaddleOCR misread **no digits at
 * all**. Every error was a letter or a piece of punctuation:
 *
 *     BARBOMANSAX  for BARB0MANSAX   letter O for digit 0, in an IFSC
 *     10,176.90cz  for 10,176.90cr   the Dr/Cr DIRECTION marker
 *     22.196.90    for 22,196.90     comma read as a full stop
 *
 * Two of those three are dangerous rather than merely wrong. A broken Dr/Cr
 * marker is the P-14 sign-inversion class exactly — the defect that read
 * `2,41,933.51CR` as a negative and inverted every HDFC credit. And a mangled
 * IFSC defeats the P-17 guard that stops an IFSC being mistaken for a UTR,
 * because that guard works by recognising the IFSC's shape: fail to recognise
 * it and the branch code silently becomes the payment reference for every
 * transaction from that bank.
 *
 * Three rules govern everything here:
 *
 *   1. **Every repair is length-preserving.** The caller renders these tokens
 *      onto a character canvas at pixel-derived positions, so a repair that
 *      changed a token's length would move a column. `repairToken` asserts it.
 *   2. **Every repair is reported**, never silent. A repair is a guess about
 *      pixels, and a guess that reaches the ledger unannounced is worse than
 *      the error it fixed. Provenance is not optional here.
 *   3. **Narrow beats clever.** Each pattern was written against an observed
 *      failure and deliberately refuses anything it has not seen. The cost of
 *      being too narrow is an unrepaired cell that BR-6 then catches; the cost
 *      of being too broad is corrupting a value that was already correct.
 */

/** One applied substitution, for the import warnings. */
export interface GlyphRepair {
  before: string;
  after: string;
  rule: 'dr_cr_marker' | 'thousand_separator' | 'ifsc_zero';
  why: string;
}

// ---------------------------------------------------------------------------
// 1. The Dr/Cr direction marker
// ---------------------------------------------------------------------------
/**
 * A trailing direction marker whose second letter came back wrong.
 *
 * `r` is confused with the tall thin glyphs — observed as `cz`, and `i`, `l`,
 * `t`, `f` are the same shape class. The first letter is NOT repaired: `c`
 * and `d` are distinct enough that guessing between them would be inventing
 * the direction of the money, which is precisely the thing that must never be
 * invented.
 *
 * Anchored to a numeric body so it cannot touch ordinary words.
 */
const DR_CR_MARKER = /^([\d,.]*\d)([cd])([rziltf])(\.?)$/i;

// ---------------------------------------------------------------------------
// 2. A thousand separator read as a full stop
// ---------------------------------------------------------------------------
/**
 * `22.196.90` for `22,196.90`.
 *
 * Deliberately tight, because the obvious version of this rule eats dates.
 * Requires all three of:
 *   - two or more dots,
 *   - a final group of exactly two digits (the paise),
 *   - at least one interior group of exactly three digits (a thousands group).
 *
 * So `22.196.90` matches (196 is a thousands group, 90 is paise), while
 * `01.06.2022` does not (four-digit final group) and `31.12.22` does not
 * (no three-digit interior group). Indian grouping — `1.14.197.81` — matches
 * on the `197`.
 */
const DOTTED_NUMBER = /^\d{1,3}(?:\.\d{2,3})+\.\d{2}$/;

function repairDottedNumber(token: string): string | null {
  if (!DOTTED_NUMBER.test(token)) return null;

  const groups = token.split('.');
  const interior = groups.slice(1, -1);
  if (!interior.some((g) => g.length === 3)) return null;

  // Every dot but the last is a separator; the last is the decimal point.
  return groups.slice(0, -1).join(',') + '.' + groups[groups.length - 1];
}

// ---------------------------------------------------------------------------
// 3. The letter O inside an IFSC
// ---------------------------------------------------------------------------
/**
 * An IFSC is four letters, then a character that is **always** the digit zero,
 * then six alphanumerics. When OCR returns `O` in that fifth position the code
 * is unambiguously wrong, so this is a correction rather than a guess — the
 * only rule here that is certain.
 */
const IFSC_WITH_LETTER_O = /^([A-Z]{4})O([A-Z0-9]{6})$/;

// ---------------------------------------------------------------------------

/**
 * Repair one whitespace-delimited token.
 *
 * Returns the token unchanged and no repair when nothing applies, which is the
 * overwhelmingly common case.
 */
export function repairToken(token: string): { text: string; repair: GlyphRepair | null } {
  // A Dr/Cr marker is split off FIRST rather than matched as a whole token,
  // because the two numeric rules compose in real data and did not when each
  // owned the entire token: `22.196.90cr` carries a dotted thousands separator
  // *and* a suffix, so the marker rule rejected it (its second letter is
  // already correct) and the number rule rejected it (it does not end in a
  // digit). Nothing fired, `parseAmount` threw, and the whole import died on
  // one cell. Splitting the token means each rule sees only its own part.
  const marker = DR_CR_MARKER.exec(token);
  const body = marker ? marker[1]! : token;

  const dotted = repairDottedNumber(body);
  const fixedBody = dotted ?? body;

  if (marker) {
    const [, , letter, second, dot] = marker;
    // Follow the case of the glyph being replaced, so `90CZ` becomes `90CR`
    // and `90cz` becomes `90cr` rather than either being case-normalised.
    const r = second! === second!.toUpperCase() ? 'R' : 'r';
    const markerFixed = second!.toLowerCase() !== 'r';
    const after = `${fixedBody}${letter}${r}${dot}`;

    if (after === token) return { text: token, repair: null };

    // When both parts needed work the marker is reported, because it is the
    // one that decides the direction of the money and therefore the one a
    // person must actually check.
    return {
      text: after,
      repair: markerFixed
        ? {
            before: token, after, rule: 'dr_cr_marker',
            why:
              `a trailing "${letter}${second}" was read as the Dr/Cr marker ` +
              `"${letter}r". This decides the DIRECTION of the money, so ` +
              'verify this row against the statement before accepting it.',
          }
        : {
            before: token, after, rule: 'thousand_separator',
            why: 'a thousands comma was read as a full stop',
          },
    };
  }

  if (dotted !== null) {
    return {
      text: dotted,
      repair: {
        before: token, after: dotted, rule: 'thousand_separator',
        why: 'a thousands comma was read as a full stop',
      },
    };
  }

  const ifsc = IFSC_WITH_LETTER_O.exec(token);
  if (ifsc) {
    const after = `${ifsc[1]}0${ifsc[2]}`;
    return {
      text: after,
      repair: {
        before: token, after, rule: 'ifsc_zero',
        why:
          'the fifth character of an IFSC is always the digit 0, so the ' +
          'letter O read there is certainly wrong',
      },
    };
  }

  return { text: token, repair: null };
}

/**
 * Repair every token in a piece of OCR'd text.
 *
 * Whitespace is preserved exactly, and the result is asserted to be the same
 * length as the input — the caller's character positions depend on it.
 */
export function repairText(text: string): { text: string; repairs: GlyphRepair[] } {
  const repairs: GlyphRepair[] = [];

  const out = text.replace(/\S+/g, (token) => {
    const { text: fixed, repair } = repairToken(token);
    if (repair) repairs.push(repair);
    return fixed;
  });

  if (out.length !== text.length) {
    // Unreachable by construction: every rule above substitutes one character
    // for one character. Asserted rather than trusted, because if it ever
    // stops being true the symptom is a column of money shifting sideways,
    // which is both silent and expensive.
    throw new Error(
      `glyph repair changed the length of "${text}" — repairs must be ` +
      'length-preserving because the canvas positions text by character index');
  }

  return { text: out, repairs };
}

/** Collapse repairs into one line per rule for the import warnings. */
export function summariseRepairs(repairs: GlyphRepair[]): string[] {
  const byRule = new Map<GlyphRepair['rule'], GlyphRepair[]>();
  for (const r of repairs) {
    byRule.set(r.rule, [...(byRule.get(r.rule) ?? []), r]);
  }

  return [...byRule.entries()].map(([rule, rs]) => {
    const examples = rs.slice(0, 3).map((r) => `"${r.before}" → "${r.after}"`).join(', ');
    const more = rs.length > 3 ? `, and ${rs.length - 3} more` : '';
    return `OCR glyph repair (${rule}): ${rs.length} token(s) corrected — ` +
      `${examples}${more}. ${rs[0]!.why}`;
  });
}
