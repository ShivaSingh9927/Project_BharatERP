/**
 * Local OCR: glyph repair, the character canvas, and the shared layout path.
 * Spec: bank-and-reconciliation.md §5.1; measured in DEFECT-LOG Stage 12
 *
 * No test here starts a Python process. The sidecar is a thin reporter of text
 * positions and its behaviour is PaddleOCR's business; what belongs to us — and
 * what broke repeatedly while this was built — is everything done with those
 * positions afterwards. So the fixtures are boxes.
 *
 * Every coordinate below is synthetic. Real statement content stays out of the
 * repository, and the amounts are chosen so the statement reconciles, which
 * means BR-6 is a real assertion here rather than decoration.
 */

import { describe, it, expect } from 'vitest';
import { repairToken, repairText, summariseRepairs } from '../src/parse/ocrGlyphs.ts';
import { boxesToCanvas, pagesToCanvas, type OcrBox } from '../src/parse/ocrCanvas.ts';
import { sliceCells, fixedWidthToGrid } from '../src/parse/fixedWidth.ts';
import { parseLayoutText } from '../src/parse/layout.ts';
import { verifyStatementArithmetic } from '../src/domain/statement.ts';
import { paddleAvailable } from '../src/parse/paddle.ts';

// ---------------------------------------------------------------------------
// Glyph repair
// ---------------------------------------------------------------------------
describe('OCR glyph repair', () => {
  it('repairs the Dr/Cr marker, preserving case', () => {
    expect(repairToken('10,176.90cz').text).toBe('10,176.90cr');
    expect(repairToken('10,176.90CZ').text).toBe('10,176.90CR');
    expect(repairToken('10,176.90cz').repair?.rule).toBe('dr_cr_marker');
  });

  it('leaves a correct marker completely alone', () => {
    // The P-14 defect was a mis-read direction. A rule that "fixes" markers
    // that were already right is a new way to invert one.
    for (const t of ['2,41,933.51CR', '12,195.90cr', '500.00dr', '500.00DR']) {
      expect(repairToken(t)).toEqual({ text: t, repair: null });
    }
  });

  it('repairs a thousands comma read as a full stop', () => {
    expect(repairToken('22.196.90').text).toBe('22,196.90');
    expect(repairToken('1.14.197.81').text).toBe('1,14,197.81');
  });

  it('does NOT eat dates, which is the obvious way to write this rule wrong', () => {
    for (const t of ['01.06.2022', '31.12.22', '2022.06.01']) {
      expect(repairToken(t).text).toBe(t);
    }
  });

  it('composes a dotted number WITH a suffix', () => {
    // Regression: each rule owned the whole token, so `22.196.90cr` matched
    // neither — the marker rule rejected it (its second letter is already
    // correct) and the number rule rejected it (it does not end in a digit).
    // Nothing fired, parseAmount threw, and one cell killed the whole import.
    expect(repairToken('22.196.90cr').text).toBe('22,196.90cr');
    expect(repairToken('22.196.90cz').text).toBe('22,196.90cr');
  });

  it('corrects the letter O in an IFSC, where the zero is certain', () => {
    expect(repairToken('BARBOMANSAX').text).toBe('BARB0MANSAX');
    // Not an IFSC shape — leave it be.
    expect(repairToken('BARBOMANSA').text).toBe('BARBOMANSA');
    expect(repairToken('SOMEWORD').text).toBe('SOMEWORD');
  });

  it('never changes the length of a line, because positions depend on it', () => {
    const line = '  06-05-2025   UPI/x   22.196.90cz   BARBOMANSAX   15532.29  ';
    const { text, repairs } = repairText(line);
    expect(text.length).toBe(line.length);
    // Two, not three: a dotted number carrying a Dr/Cr suffix is ONE repair —
    // the marker is reported, because that is the half a person must check.
    expect(repairs).toHaveLength(2);
  });

  it('summarises repairs one line per rule', () => {
    const { repairs } = repairText('10,176.90cz 13,196.90cz 22.196.90');
    const lines = summariseRepairs(repairs);
    expect(lines).toHaveLength(2);
    expect(lines.join(' ')).toContain('dr_cr_marker');
    expect(lines.join(' ')).toContain('DIRECTION');
  });
});

// ---------------------------------------------------------------------------
// Slicing
// ---------------------------------------------------------------------------
describe('sliceCells does not cut a value in half', () => {
  it('gives a straddling right-aligned number to its own column', () => {
    //                     0         1         2         3
    //                     0123456789012345678901234567890
    const narrow = '01-05  NARRATION            220.90    15311.39';
    const wide   = '06-05  NARRATION          30000.00    15532.29';
    // A boundary derived from the narrow rows falls inside `30000.00`.
    const boundaries = [0, 7, 28, 38];

    expect(sliceCells(narrow, boundaries)[2]).toBe('220.90');
    // Without snapping this was ['…30000', '.00'] — the row lost its amount,
    // was dropped as unparseable, and the statement came out ₹30,000 short.
    expect(sliceCells(wide, boundaries)[2]).toBe('30000.00');
  });

  it('leaves a left-aligned overflow where it was', () => {
    // A narration spilling a little past the boundary keeps its majority on
    // the left, so it must not jump into the next column.
    const line = 'A  SOMEVERYLONGNARRATION  9.00';
    const cells = sliceCells(line, [0, 3, 24]);
    expect(cells[1]!.startsWith('SOMEVERYLONGNARRATION')).toBe(true);
  });

  it('never produces a negative-width slice', () => {
    const line = 'AAAAAAAAAA';
    expect(() => sliceCells(line, [2, 3, 4, 5])).not.toThrow();
    expect(sliceCells(line, [2, 3, 4, 5]).join('')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------

/** Build a box, sizing it as if each glyph were 7 pixels wide. */
const box = (x0: number, y: number, text: string, score = 0.99): OcrBox => ({
  x0, x1: x0 + text.length * 7, y0: y, y1: y + 14, text, score,
});

/**
 * A synthetic three-transaction statement.
 *
 *   opening 10,000.00 + 2,500.00 − 400.00 + 1,000.00 = 13,100.00
 */
const STATEMENT: OcrBox[] = [
  box(60, 20, 'EXAMPLE BANK LIMITED'),
  box(60, 40, 'Account Number : 00000000000000'),

  box(60, 100, 'Date'),
  box(200, 100, 'Particulars'),
  box(600, 100, 'Debit'),
  box(700, 100, 'Credit'),
  box(820, 100, 'Balance'),

  box(60, 130, '01-04-2026'), box(200, 130, 'Opening Balance'),
  /*                       */ box(820, 130, '10,000.00'),

  box(60, 150, '02-04-2026'), box(200, 150, 'UPI/000000000001/EXAMPLE'),
  box(714, 150, '2,500.00'), box(827, 150, '12,500.00'),

  box(60, 170, '03-04-2026'), box(200, 170, 'UPI/000000000002/EXAMPLE'),
  box(621, 170, '400.00'), box(834, 170, '12,100.00'),

  box(60, 190, '04-04-2026'), box(200, 190, 'NEFT/000000000003/EXAMPLE'),
  box(714, 190, '1,000.00'), box(827, 190, '13,100.00'),
];

describe('rendering OCR boxes as fixed-width text', () => {
  it('keeps every column apart', () => {
    const c = boxesToCanvas(STATEMENT);
    const lines = c.text.split('\n').filter((l) => l.trim().length > 0);

    const row = lines.find((l) => l.includes('12,500.00'))!;
    expect(row).toMatch(/02-04-2026\s+UPI\/000000000001\/EXAMPLE\s+2,500\.00\s+12,500\.00/);
  });

  it('places a token no further right than its true pixel span', () => {
    // The correctness argument for the whole approach: an underestimated
    // character width means a token always lies within the left portion of the
    // space it really occupies, so it can never intrude on the column to its
    // right and gutters can only widen.
    const c = boxesToCanvas(STATEMENT);
    for (const line of c.text.split('\n')) {
      const at = line.indexOf('12,500.00');
      if (at >= 0) expect(at * c.charWidth).toBeLessThanOrEqual(827);
    }
  });

  it('separates blocks with a blank line so regions can be measured apart', () => {
    const c = boxesToCanvas(STATEMENT);
    expect(c.text).toMatch(/\n\s*\n/);
  });

  it('groups boxes that drift vertically into one row', () => {
    const drifting: OcrBox[] = [
      box(60, 200, '05-04-2026'),
      { ...box(300, 203, 'DRIFTED'), y0: 203, y1: 217 },
      { ...box(700, 206, '9.00'), y0: 206, y1: 220 },
    ];
    const c = boxesToCanvas(drifting);
    expect(c.text.split('\n').filter((l) => l.trim()).length).toBe(1);
  });

  it('reports pages separated by a form feed', () => {
    const c = pagesToCanvas([STATEMENT, STATEMENT]);
    expect(c.text).toContain('\f');
    expect(fixedWidthToGrid(c.text).pages.length).toBe(2);
  });

  it('repairs glyphs while rendering, and reports them', () => {
    const c = boxesToCanvas([...STATEMENT, box(60, 40, 'BARBOMANSAX')]);
    expect(c.text).toContain('BARB0MANSAX');
    expect(c.repairs.map((r) => r.rule)).toContain('ifsc_zero');
  });

  it('returns something usable for an empty page rather than throwing', () => {
    const c = boxesToCanvas([]);
    expect(c.text).toBe('');
    expect(c.warnings[0]).toMatch(/no text boxes/);
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------
describe('an OCR\'d statement reaches BR-6', () => {
  it('parses through the SAME path the PDF reader uses, and reconciles', () => {
    const canvas = boxesToCanvas(STATEMENT);
    const p = parseLayoutText(canvas.text, { source: 'ocr' });

    expect(p.format).toBe('ocr');
    expect(p.columnSource).toBe('inferred');
    expect(p.rows).toHaveLength(3);
    expect(p.openingBalance).toBe('10000.00');

    const check = verifyStatementArithmetic(p.openingBalance!, p.closingBalance!, p.rows);
    expect(check.ok).toBe(true);
    expect(check.badRows).toEqual([]);
  });

  it('identifies debit and credit by arithmetic, not by position', () => {
    const p = parseLayoutText(boxesToCanvas(STATEMENT).text, { source: 'ocr' });
    expect(p.rows[0]!.credit).toBe('2500.00');
    expect(p.rows[1]!.debit).toBe('400.00');
    expect(p.rows[2]!.credit).toBe('1000.00');
  });

  it('names the misread cell when a digit is wrong', () => {
    // The whole point of OCR here. One balance is corrupted; the arithmetic has
    // to say WHICH row rather than only that the statement does not add up.
    const corrupted = STATEMENT.map((b) =>
      b.text === '12,100.00' ? { ...b, text: '12,700.00' } : b);

    const p = parseLayoutText(boxesToCanvas(corrupted).text, { source: 'ocr' });
    const check = verifyStatementArithmetic(p.openingBalance!, p.closingBalance!, p.rows);

    expect(check.ok).toBe(false);
    expect(check.badRows.map((b) => b.row)).toContain(2);
    expect(check.badRows.find((b) => b.row === 2)!.expected).toBe('12100.00');
  });

  it('says the columns were inferred, and why', () => {
    const p = parseLayoutText(boxesToCanvas(STATEMENT).text, { source: 'ocr' });
    expect(p.warnings.join(' ')).toMatch(/scanned statement/);
    expect(p.warnings.join(' ')).toMatch(/inferred from the data/);
  });
});

// ---------------------------------------------------------------------------
describe('availability', () => {
  it('answers rather than throwing when the interpreter is missing', () => {
    const saved = process.env.PADDLE_PYTHON;
    process.env.PADDLE_PYTHON = '/nonexistent/python-that-is-not-here';
    try {
      // Reported as unavailable with a reason; a missing optional dependency
      // must never surface as a crash.
      const r = paddleAvailable();
      expect(typeof r.ok).toBe('boolean');
      expect(r.detail.length).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env.PADDLE_PYTHON;
      else process.env.PADDLE_PYTHON = saved;
    }
  });
});
