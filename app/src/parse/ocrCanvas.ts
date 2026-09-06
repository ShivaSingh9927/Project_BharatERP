/**
 * Positioned OCR boxes → fixed-width text.
 * Spec: bank-and-reconciliation.md §5.1
 *
 * The point of this file is to write NO layout logic. `fixedWidth.ts` already
 * knows how to find columns with no header, how to segment a page into
 * preamble / table / trailer, how to pin down a column that every transaction
 * leaves blank, and how to join a narration that wrapped mid-token — and all of
 * it was learned from real HDFC and SBI files and is covered by tests. OCR
 * gives us the same problem those functions already solve, expressed in pixels
 * instead of characters. So the whole job here is a change of units.
 *
 * That decision is not just economy. The throwaway Python probe that first
 * measured PaddleOCR reimplemented row and column clustering, and *all four* of
 * its apparent OCR failures were its own: it merged `Withdrawals` and `Deposits`
 * because they are mutually exclusive, it rejected `1,14,197.8 1` because the
 * source PDF prints a broken space, and it scored a MICR code as a balance.
 * `fixedWidth.ts` and `columnRoles.ts` handle all three. Reimplementing was the
 * mistake; this file exists so it is not repeated in production.
 *
 * ── Why tokens are placed by their LEFT edge ──────────────────────────────
 *
 * A character canvas has one glyph width, and a real page does not. The safe
 * direction to be wrong is *narrow*: `charWidth` is deliberately underestimated,
 * so a token rendered at `x0 / charWidth` occupies fewer characters than its
 * true pixel footprint and therefore always lies inside the left portion of the
 * space it really occupies.
 *
 * The consequence is worth stating precisely, because it is the correctness
 * argument for this whole approach:
 *
 *     a token can never intrude into the column to its right,
 *     and every gutter can only get wider than it truly is.
 *
 * Merging two columns is the expensive failure — it is how money moves between
 * the debit and credit columns, which is defect D-2 — so being wrong in the
 * direction that cannot merge them is worth a lot.
 *
 * ⚠️ But "narrower is safer" has a floor, and the first version of this file
 * claimed otherwise. Spreading widens the gaps *inside* a cell as well as
 * between cells, so past a point the gap between a value date and its
 * description exceeds `WIDE_GAP` and one logical column splits into two,
 * shifting every column role after it. Measured: narrowing below `SQUEEZE`
 * took a Karur Vysya statement from 29 rows to 13. The direction is safe;
 * the magnitude still has to be chosen and left alone.
 *
 * Right-aligned money columns therefore come out ragged on the left. Nothing
 * downstream cares: `sliceCells` takes everything between two boundaries, and
 * `columnRoles.ts` identifies money by reproducing the running balance, not by
 * where the digits sit.
 */

import { repairText, type GlyphRepair } from './ocrGlyphs.ts';

/** One text box as reported by the OCR sidecar, in image pixels. */
export interface OcrBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  text: string;
  score: number;
}

export interface CanvasResult {
  /** Fixed-width text, ready for `fixedWidthToGrid`. */
  text: string;
  /** Pixels per character actually used. */
  charWidth: number;
  lineCount: number;
  /**
   * Boxes that had to be nudged right because the previous token on their line
   * already reached that far. A handful is normal; many means `charWidth` was
   * overestimated and the columns are at risk.
   */
  collisions: number;
  repairs: GlyphRepair[];
  warnings: string[];
}

/**
 * How much to shrink the estimated glyph width.
 *
 * 0.5 doubles every gap measured in characters while leaving token lengths
 * alone, which is what buys the "gutters can only widen" guarantee above.
 * `fixedWidth.ts` needs 3 blank characters to call a gap a column separator
 * (`WIDE_GAP`) and 2 to call it a gutter (`MIN_GUTTER`), and on a 736-pixel
 * statement render a real inter-column gap is often only 12–15 pixels — under
 * two characters at true glyph width. Without this factor the columns of a
 * perfectly-read page would merge.
 */
const SQUEEZE = 0.5;

/** Boxes shorter than this are too noisy to measure a glyph width from. */
const MIN_CHARS_TO_MEASURE = 4;

/** A vertical gap wider than this many line-heights starts a new block. */
const BLOCK_GAP = 1.75;

const median = (xs: number[]): number =>
  xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

/**
 * Estimate pixels per character.
 *
 * The 25th percentile rather than the median: a page mixes a large bank name,
 * bold headers and small print, and the narrow end of that range is the body
 * text that forms the table. Taking a low percentile — then shrinking it
 * further — keeps the estimate on the safe side of wrong.
 */
function estimateCharWidth(boxes: OcrBox[]): number {
  const widths = boxes
    .filter((b) => b.text.length >= MIN_CHARS_TO_MEASURE)
    .map((b) => (b.x1 - b.x0) / b.text.length)
    .filter((w) => w > 0.5);

  const measured = widths.length > 0
    ? percentile(widths, 0.25)
    // Nothing long enough to measure. 7px is a typical body glyph on a
    // 700–800px statement render; the squeeze below keeps a bad guess safe.
    : 7;

  return Math.max(0.5, measured * SQUEEZE);
}

/** Group boxes into visual lines by vertical proximity. */
function clusterLines(boxes: OcrBox[]): OcrBox[][] {
  if (boxes.length === 0) return [];

  const lineHeight = median(boxes.map((b) => b.y1 - b.y0)) || 12;
  const byY = [...boxes].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);

  const lines: OcrBox[][] = [];
  let current: OcrBox[] = [byY[0]!];
  const centre = (b: OcrBox): number => (b.y0 + b.y1) / 2;

  for (const box of byY.slice(1)) {
    // Compared against the line's own last box rather than its first, so a row
    // that drifts slightly across the page — every scan does — stays one row.
    if (Math.abs(centre(box) - centre(current[current.length - 1]!)) <= lineHeight * 0.6) {
      current.push(box);
    } else {
      lines.push(current);
      current = [box];
    }
  }
  lines.push(current);

  return lines.map((l) => [...l].sort((a, b) => a.x0 - b.x0));
}

/**
 * Render one page of OCR boxes as fixed-width text.
 *
 * Glyph repair happens here, per token, before anything is positioned — every
 * repair is length-preserving (asserted in `ocrGlyphs.ts`) precisely so that it
 * cannot move a column.
 */
export function boxesToCanvas(boxes: OcrBox[]): CanvasResult {
  const usable = boxes.filter((b) => b.text.trim().length > 0);

  if (usable.length === 0) {
    return {
      text: '', charWidth: 0, lineCount: 0, collisions: 0, repairs: [],
      warnings: ['OCR returned no text boxes for this page'],
    };
  }

  const lines = clusterLines(usable);

  /*
   * ONE character width, chosen by `SQUEEZE`, and no search for a better one.
   *
   * Searching was tried and reverted, which is worth recording because the
   * argument for it was persuasive and wrong in both directions.
   *
   * A dense ICICI statement — three stacked tables at roughly 90 DPI — has
   * transaction text well below the 25th-percentile glyph width, so its tokens
   * needed more characters than their pixel span allowed and ran together:
   *
   *     Tds:7.70.001,14,267.81Int:77
   *
   * Three values in one token. The obvious response is to spread the canvas
   * until nothing collides. Two attempts at that each regressed a statement
   * that had been passing:
   *
   *   1. Starting the search at the unsqueezed estimate and stopping at the
   *      first attempt with zero collisions took Bank of Baroda from 15 rows
   *      and a passing balance check to 6 rows and a failing one. **Zero
   *      collisions is not evidence of a good canvas** — a canvas compressed
   *      enough to merge two columns has no collisions either, because merged
   *      columns are one column and one column cannot overlap itself.
   *   2. Narrowing further than `SQUEEZE` took Karur Vysya from 29 rows to 13
   *      and lost its opening balance. This falsifies the header comment's
   *      claim that spreading is harmless: spreading widens the gaps
   *      *within* a cell too, so once the gap between a value date and its
   *      description passes `WIDE_GAP`, one logical column becomes two and
   *      every column role after it shifts.
   *
   * So there is a safe direction but not an unboundedly safe one, and the
   * collision count is a symptom rather than an objective. ICICI never improved
   * under either search; trading two working statements for nothing is not a
   * fix. The fusion is reported instead, and BR-6 refuses the import.
   */
  const charWidth = estimateCharWidth(usable);
  const best = renderLines(lines, charWidth);

  const warnings: string[] = [];
  if (best.collisions > usable.length * 0.05) {
    warnings.push(
      `${best.collisions} of ${usable.length} text boxes overlapped when placed ` +
      'on the character canvas, so two values may have run together and a ' +
      'column may be wrong. This is what a scan below 300 DPI looks like — the ' +
      'balance report is the thing to read, and a better scan is cheaper than ' +
      'checking every figure by hand.');
  }

  return { ...best, warnings };
}

/** Render clustered lines at a given character width. */
function renderLines(lines: OcrBox[][], charWidth: number): CanvasResult {
  const flat = lines.flat();
  const lineHeight = median(flat.map((b) => b.y1 - b.y0)) || 12;

  const repairs: GlyphRepair[] = [];
  const rendered: string[] = [];
  let collisions = 0;
  let previousBottom: number | null = null;

  for (const line of lines) {
    const top = Math.min(...line.map((b) => b.y0));
    if (previousBottom !== null && top - previousBottom > lineHeight * BLOCK_GAP) {
      // A real block break — the gap between the address block and the table,
      // or between the table and the summary. `pageToGrid` measures those
      // regions separately, and it needs to be able to see the seam.
      rendered.push('');
    }

    let out = '';
    for (const box of line) {
      const { text, repairs: applied } = repairText(box.text);
      repairs.push(...applied);

      const wanted = Math.round(box.x0 / charWidth);
      // One space minimum between tokens, so two boxes never fuse into one
      // word — a fused `20,000.00876,770.82` is unrecoverable.
      const at = Math.max(wanted, out.length === 0 ? 0 : out.length + 1);
      if (at > wanted) collisions++;

      out = out.padEnd(at, ' ') + text;
    }

    rendered.push(out.trimEnd());
    previousBottom = Math.max(...line.map((b) => b.y1));
  }

  return {
    text: rendered.join('\n'),
    charWidth,
    lineCount: rendered.length,
    collisions,
    repairs,
    // The caller decides what to warn about: it can see whether a narrower
    // attempt fixed this one, and a warning from a discarded attempt would be
    // reported against a canvas nobody used.
    warnings: [],
  };
}

/**
 * Render several pages, separated by form feeds.
 *
 * `splitPages` splits on `\f` because that is what `pdftotext` emits, so a
 * multi-image scan reaches the same per-page measurement as a multi-page PDF —
 * which matters, since column positions genuinely differ between pages of one
 * statement.
 */
export function pagesToCanvas(pages: OcrBox[][]): CanvasResult {
  const results = pages.map(boxesToCanvas);

  return {
    text: results.map((r) => r.text).join('\n\f\n'),
    charWidth: results.length > 0 ? results[0]!.charWidth : 0,
    lineCount: results.reduce((n, r) => n + r.lineCount, 0),
    collisions: results.reduce((n, r) => n + r.collisions, 0),
    repairs: results.flatMap((r) => r.repairs),
    warnings: results.flatMap((r) => r.warnings),
  };
}
