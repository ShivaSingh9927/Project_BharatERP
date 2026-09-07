/**
 * Word positions, straight from the PDF.
 *
 * Spec: bills-and-expenses.md §4.3
 *
 * `pdftotext -layout` reconstructs a page as characters on a fixed-width grid,
 * and the gutter machinery in `fixedWidth.ts` recovers columns from the
 * whitespace that repeats down it. That works on bank statements and on two of
 * the four marketplace invoice layouts.
 *
 * It fails on Amazon, and the reason is worth being precise about: Amazon's
 * numeric columns end up ONE space apart in the reconstruction, below the two
 * characters a gutter needs, so they collapse into a single cell. The
 * information was not missing from the PDF — `-layout` threw it away while
 * rounding real coordinates onto a character grid, and the histogram was trying
 * to recover something already gone.
 *
 * `-bbox-layout` reports every word with its exact bounding box. On the same
 * Amazon page each column's words land within about 1.4pt of their header:
 *
 *     header (stacked over two lines)      data row        totals row
 *     x=320.4  Unit / Price                x=320.4         —
 *     x=380.4  Net / Amount                x=380.4         —
 *     x=423.1  Tax / Rate                  x=424.4         —
 *     x=444.9  Tax / Type                  x=444.9         —
 *     x=468.1  Tax / Amount                x=469.5         x=468.7
 *     x=504.4  Total / Amount              x=505.8         x=504.4
 *
 * ── Why the `<line>` elements cannot be used as rows ───────────────────────
 *
 * Poppler already groups words into `<line>`s, but a line lives inside a
 * `<block>`, and a table's columns are usually separate blocks. One visual row
 * is therefore spread across several lines in several blocks. Rows have to be
 * clustered by vertical overlap instead — and they must be clustered, not
 * matched on equality: in the row above, "IGST" sits at y=434.5 while its
 * neighbours sit at y=431.3, because a different font baseline shifts it.
 *
 * This module does the extraction and the row clustering. It assigns no
 * meaning to anything — no columns, no roles, no amounts.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationError } from '../domain/types.ts';

export interface Word {
  text: string;
  xMin: number; xMax: number;
  yMin: number; yMax: number;
}

export interface WordRow {
  /** Words in left-to-right order. */
  words: Word[];
  yMin: number;
  yMax: number;
}

export interface WordPage {
  /** 1-based, matching `DocumentSegment.pages`. */
  number: number;
  width: number;
  height: number;
  rows: WordRow[];
}

/**
 * Two words share a row when one's vertical midpoint falls inside the other's
 * box.
 *
 * Midpoint-inside rather than a fraction of overlap, because font sizes differ
 * within a row — a small superscript beside a normal-sized figure overlaps by
 * very little of the larger box but sits squarely inside it.
 */
function sameRow(a: Word, b: Word): boolean {
  const midA = (a.yMin + a.yMax) / 2;
  const midB = (b.yMin + b.yMax) / 2;
  return (midA >= b.yMin && midA <= b.yMax) || (midB >= a.yMin && midB <= a.yMax);
}

/** XML entities poppler emits inside word text. */
function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');   // last, so &amp;lt; does not become <
}

const PAGE_RE = /<page\s+width="([\d.]+)"\s+height="([\d.]+)"\s*>([\s\S]*?)<\/page>/g;
const WORD_RE =
  /<word\s+xMin="([\d.-]+)"\s+yMin="([\d.-]+)"\s+xMax="([\d.-]+)"\s+yMax="([\d.-]+)"\s*>([\s\S]*?)<\/word>/g;

/** Groups a page's words into visual rows, top to bottom, each left to right. */
export function wordsToRows(words: Word[]): WordRow[] {
  const sorted = [...words].sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin);
  const rows: WordRow[] = [];

  for (const w of sorted) {
    // Only the last row can still be open: input is sorted by yMin, so once a
    // row is left behind nothing later can belong to it.
    const open = rows[rows.length - 1];
    if (open && open.words.some((o) => sameRow(o, w))) {
      open.words.push(w);
      open.yMin = Math.min(open.yMin, w.yMin);
      open.yMax = Math.max(open.yMax, w.yMax);
    } else {
      rows.push({ words: [w], yMin: w.yMin, yMax: w.yMax });
    }
  }

  for (const r of rows) r.words.sort((a, b) => a.xMin - b.xMin);
  return rows;
}

/** Parses the XHTML `pdftotext -bbox-layout` writes. */
export function parseBboxLayout(html: string): WordPage[] {
  const pages: WordPage[] = [];
  for (const pm of html.matchAll(PAGE_RE)) {
    const words: Word[] = [];
    for (const wm of pm[3]!.matchAll(WORD_RE)) {
      const text = unescapeXml(wm[5]!);
      if (text.trim() === '') continue;
      words.push({
        xMin: Number(wm[1]), yMin: Number(wm[2]),
        xMax: Number(wm[3]), yMax: Number(wm[4]),
        text,
      });
    }
    pages.push({
      number: pages.length + 1,
      width: Number(pm[1]), height: Number(pm[2]),
      rows: wordsToRows(words),
    });
  }
  return pages;
}

/**
 * Runs `pdftotext -bbox-layout` and returns one entry per page.
 *
 * The buffer goes to a temp file rather than to stdin because poppler needs to
 * seek. G-18 is still open and this is now its THIRD call site: a password
 * passed here appears in the process list for the lifetime of the call, and
 * `pdftotext`, `pdftoppm` and this all share the problem. It is not fixed by
 * being written down again, but it is not made worse either.
 */
export function extractPdfWords(buffer: Buffer, password?: string): WordPage[] {
  const dir = mkdtempSync(join(tmpdir(), 'bharaterp-words-'));
  const src = join(dir, 'in.pdf');
  const out = join(dir, 'out.html');
  try {
    writeFileSync(src, buffer);
    const args = ['-bbox-layout'];
    if (password) args.push('-upw', password);
    args.push(src, out);

    const r = spawnSync('pdftotext', args, { encoding: 'utf8', timeout: 60_000 });
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ValidationError(
        'Reading invoice columns needs the `pdftotext` command, which is not ' +
        'installed. Install poppler-utils.', 'PB-6');
    }
    if (r.status !== 0) {
      throw new ValidationError(
        `pdftotext could not read this PDF: ${(r.stderr || '').trim() || 'no detail given'}`,
        'PB-6');
    }
    return parseBboxLayout(readFileSync(out, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
