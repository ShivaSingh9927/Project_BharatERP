/**
 * Markdown tables → a grid of cells.
 * Spec: bank-and-reconciliation.md §5.1
 *
 * This is what a document-parsing service returns for a scanned statement, and
 * it is a considerably easier starting point than fixed-width text: the columns
 * are already delimited, so none of the gutter detection in `fixedWidth.ts` is
 * needed. The hard part moves elsewhere — to whether the DIGITS are right.
 *
 * A statement may contain several tables (an account-summary box, then the
 * transactions), so all of them are returned and the caller decides which is
 * which. Prose between tables is kept as single-cell rows, because the opening
 * balance and the statement period are often stated there rather than in a
 * table.
 */

export interface MarkdownTable {
  /** Header cells, as written. */
  header: string[];
  rows: string[][];
  /** Line index in the source where the table began. */
  startLine: number;
}

/** A `| --- | :--- | ---: |` separator, which is what marks a real table. */
const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const isTableRow = (line: string): boolean => line.trim().startsWith('|');

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) =>
    // Strip the emphasis a parser adds around values it considers salient;
    // `**13,312.62**` must read as a number, not as text.
    c.replace(/\*\*/g, '').replace(/^\s*`|`\s*$/g, '').trim());
}

/** Extract every markdown table in the document. */
export function extractMarkdownTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split('\n');
  const tables: MarkdownTable[] = [];

  for (let i = 0; i < lines.length; i++) {
    // A table is a row followed by a separator. Without that pairing a line
    // beginning with `|` is just text.
    if (!isTableRow(lines[i]!) || i + 1 >= lines.length || !SEPARATOR.test(lines[i + 1]!)) {
      continue;
    }

    const header = splitRow(lines[i]!);
    const rows: string[][] = [];
    let j = i + 2;

    for (; j < lines.length && isTableRow(lines[j]!); j++) {
      if (SEPARATOR.test(lines[j]!)) continue;
      rows.push(splitRow(lines[j]!));
    }

    tables.push({ header, rows, startLine: i });
    i = j - 1;
  }

  return tables;
}

/**
 * Flatten a markdown document into one grid for the statement parser.
 *
 * Tables contribute their header and rows; everything else contributes a
 * single-cell row so that labelled values outside the tables — `St.Period :
 * 01/07/2023 to 15/07/2023`, `Opening Balance 13,312.62` — remain findable.
 *
 * Rows are padded to a common width so column indexes are safe everywhere,
 * exactly as the spreadsheet reader does.
 */
export function markdownToGrid(markdown: string): string[][] {
  const lines = markdown.split('\n');
  const tables = extractMarkdownTables(markdown);
  const tableAt = new Map(tables.map((t) => [t.startLine, t]));

  const grid: string[][] = [];
  let skipUntil = -1;

  for (let i = 0; i < lines.length; i++) {
    if (i < skipUntil) continue;

    const table = tableAt.get(i);
    if (table) {
      grid.push(table.header);
      for (const r of table.rows) grid.push(r);
      grid.push([]);
      // header + separator + rows
      skipUntil = i + 2 + table.rows.length;
      continue;
    }

    const text = lines[i]!.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim();
    grid.push(text.length === 0 ? [] : [text]);
  }

  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  return grid.map((r) => {
    if (r.length === 0) return r;
    const padded = [...r];
    while (padded.length < width) padded.push('');
    return padded;
  });
}
