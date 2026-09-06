/**
 * Delimited-text reader for bank statement exports.
 * Spec: bank-and-reconciliation.md §5.1 (BR-3 — CSV/Excel before PDF)
 *
 * Hand-written rather than pulled from a package, because bank exports break
 * the rules in specific, knowable ways and a strict RFC 4180 parser rejects
 * files a CA will absolutely try to upload:
 *
 *   - preamble rows before the header ("Statement of account", account number,
 *     address, blank lines)
 *   - trailer rows after the data (totals, "*** End of statement ***")
 *   - inconsistent column counts between rows
 *   - a UTF-8 BOM, because the file came out of Excel on Windows
 *   - tabs or semicolons instead of commas
 *
 * Being permissive here is safe precisely because BR-6 checks the arithmetic
 * afterwards. A parser that guesses wrong gets caught by the balance check;
 * a parser that refuses the file helps nobody.
 */

export interface DelimitedTable {
  rows: string[][];
  delimiter: string;
}

/** Strip the BOM and normalise line endings, including old Mac CR-only. */
function normalise(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * Guess the delimiter by which candidate yields the most consistent column
 * count across the file, not by which appears most often.
 *
 * Frequency alone is a trap: narration fields are full of commas ("ACME
 * TRADING PVT LTD, MUMBAI"), so a tab-separated file can easily contain more
 * commas than tabs. Consistency is the signal that actually identifies
 * structure.
 */
export function detectDelimiter(text: string): string {
  const lines = normalise(text).split('\n').filter((l) => l.trim().length > 0).slice(0, 40);
  if (lines.length === 0) return ',';

  let best = ',';
  let bestScore = -1;

  for (const d of [',', '\t', ';', '|']) {
    const counts = lines.map((l) => splitLine(l, d).length).filter((n) => n > 1);
    if (counts.length === 0) continue;

    // Modal column count, and how many lines agree with it.
    const freq = new Map<number, number>();
    for (const n of counts) freq.set(n, (freq.get(n) ?? 0) + 1);
    const [modal, agree] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]!;

    // Reward agreement and column count; a delimiter splitting into 7 agreeing
    // columns beats one splitting into 2.
    const score = agree * 10 + modal;
    if (score > bestScore) { bestScore = score; best = d; }
  }

  return best;
}

/** One line into fields, honouring double-quote escaping. */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(field); field = '';
    } else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Parse delimited text into rows.
 *
 * Newlines inside quoted fields are honoured — a multi-line narration inside
 * quotes is one field, not two rows. Getting this wrong silently shifts every
 * subsequent row by one, which BR-6 would catch but only after wasting the
 * user's time.
 */
export function parseDelimited(text: string, delimiter?: string): DelimitedTable {
  const src = normalise(text);
  const d = delimiter ?? detectDelimiter(src);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const endField = (): void => { row.push(field.trim()); field = ''; };
  const endRow = (): void => {
    endField();
    if (!isBlankRow(row)) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;

    if (inQuotes) {
      if (ch !== '"') { field += ch; continue; }
      // A doubled quote inside a quoted field is a literal quote.
      if (src[i + 1] === '"') { field += '"'; i++; continue; }
      inQuotes = false;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === d) {
      endField();
    } else if (ch === '\n') {
      endRow();
    } else {
      field += ch;
    }
  }

  // Whatever is buffered at EOF is a final row, quoted or not.
  if (field.length > 0 || row.length > 0) endRow();

  return { rows, delimiter: d };
}

/** A row carrying no content at all — blank separators are everywhere. */
export function isBlankRow(row: string[]): boolean {
  return row.every((c) => c.trim().length === 0);
}
