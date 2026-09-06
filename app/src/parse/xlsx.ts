/**
 * `.xlsx` → rows of strings.
 * Spec: bank-and-reconciliation.md §5.1 (BR-3)
 *
 * Only what a bank statement needs: the first worksheet, as text, with the grid
 * intact. No formulas, no styles, no charts.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID: **`.xlsx` omits empty cells entirely.**
 * A row with a blank withdrawal column contains no `<c>` element for it at all,
 * so appending cells in document order shifts every later value one column
 * left. On a bank statement that silently moves the balance into the credit
 * column, and the resulting figures are wrong but plausible — the worst kind.
 *
 * Every cell therefore carries an `r` reference (`D19`), and the column is
 * decoded from that letter rather than inferred from position.
 *
 * Dates are the other hazard: Excel stores them as a serial number, so a
 * transaction date can arrive as `46296` rather than `01/09/2026`. Handled by
 * checking the cell's declared type and converting from the 1900 epoch.
 */

import { ZipArchive, looksLikeZip, looksLikeEncryptedOffice } from './zip.ts';
import { ValidationError } from '../domain/types.ts';

/** `D` → 3, `AA` → 26. Zero-based. */
export function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref.toUpperCase())?.[1];
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Excel's serial date → ISO.
 *
 * The epoch is 30 December 1899, not 1 January 1900, because Excel treats 1900
 * as a leap year — a fifty-year-old bug that every reader has to reproduce to
 * stay compatible with the files people actually have.
 */
export function serialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const ms = Math.round(serial * 86_400_000);
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  return d.toISOString().slice(0, 10);
}

/** Decode the five XML entities that appear in shared strings. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');          // last, so &amp;lt; does not become <
}

/** Concatenate the text runs of one shared-string item. */
function sharedStringText(si: string): string {
  const parts = [...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]!);
  // No <t> at all means an empty string entry, which is legitimate.
  return unescapeXml(parts.join(''));
}

function readSharedStrings(zip: ZipArchive): string[] {
  const xml = zip.read('xl/sharedStrings.xml');
  if (!xml) return [];
  return [...xml.toString('utf8').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)]
    .map((m) => sharedStringText(m[1]!));
}

/** Which worksheet part is the first sheet in the workbook's own order. */
function firstSheetPath(zip: ZipArchive): string {
  const wb = zip.read('xl/workbook.xml');
  const rels = zip.read('xl/_rels/workbook.xml.rels');

  if (wb && rels) {
    const rid = /<sheet[^>]*r:id="([^"]+)"/.exec(wb.toString('utf8'))?.[1];
    if (rid) {
      const target = new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`)
        .exec(rels.toString('utf8'))?.[1];
      if (target) {
        const clean = target.replace(/^\/?xl\//, '').replace(/^\//, '');
        if (zip.has(`xl/${clean}`)) return `xl/${clean}`;
      }
    }
  }

  // Fall back to the conventional name, then to whatever worksheet exists.
  if (zip.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';
  const any = zip.names().find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
  if (!any) throw new ValidationError('the workbook contains no worksheet', 'BR-3');
  return any;
}

/**
 * Read the first worksheet as a rectangular grid of strings.
 *
 * Blank cells become empty strings rather than being dropped, so downstream
 * column mapping sees the same shape a human sees in Excel.
 */
export function readXlsxSheet(buffer: Buffer): string[][] {
  if (looksLikeEncryptedOffice(buffer)) {
    throw new ValidationError(
      'this spreadsheet is password-protected — supply the password to open it. ' +
      "SBI's net-banking export is encrypted like this by default.", 'BR-4');
  }
  if (!looksLikeZip(buffer)) {
    throw new ValidationError(
      'this file is not a spreadsheet — an .xlsx is a zip archive, and this is ' +
      'neither that nor an encrypted Office file', 'BR-3');
  }

  const zip = new ZipArchive(buffer);
  const shared = readSharedStrings(zip);
  const xml = zip.text(firstSheetPath(zip));

  const grid: string[][] = [];

  // Both forms of the tag. Excel writes `<row r="5"/>` for an empty row, and
  // matching only the paired form was actively harmful rather than merely
  // incomplete: `[^>]*` happily consumed the trailing slash, so the parser
  // treated `<row r="5"/>` as an OPENING tag and swallowed the next real row as
  // its body — silently shifting the summary block up by one and losing a
  // transaction. A skipped empty row would have been harmless; misreading it
  // corrupted the rows around it.
  for (const rowMatch of xml.matchAll(
    /<row(?:\s([^>]*?))?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const attrs = rowMatch[1] ?? '';
    const body = rowMatch[2] ?? '';

    // Honour the row's own index, so blank rows between blocks are preserved —
    // a statement's summary block is separated from its transactions by them.
    const rowNo = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? grid.length + 1);
    const cells: string[] = [];

    // The attribute group MUST be non-greedy, for the same reason as the row
    // tag above — and this one was found by BR-6 on a real file after the row
    // version had already been fixed.
    //
    // Real Excel writes a blank-but-STYLED cell as `<c r="D23" s="122"/>`. With
    // a greedy `[^>]*` the attributes swallow the trailing slash, the cell is
    // treated as an opening tag, and it consumes the NEXT cell as its body. On
    // the real SBI statement that moved a ₹50,000 credit into the debit column
    // and read its shared-string index as the literal amount `50`.
    //
    // The synthetic fixtures never caught it because they wrote blanks as
    // omitted cells, which is what Excel does for an unstyled blank — so the
    // tests encoded half of reality. BR-6 caught what they could not.
    for (const cellMatch of body.matchAll(/<c(?:\s([^>]*?))?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cellAttrs = cellMatch[1] ?? '';
      const inner = cellMatch[2] ?? '';

      const ref = /\br="([A-Z]+\d+)"/.exec(cellAttrs)?.[1];
      const col = ref ? columnIndex(ref) : cells.length;
      const type = /\bt="([^"]+)"/.exec(cellAttrs)?.[1] ?? 'n';

      let value = '';
      if (type === 's') {
        // Shared string: <v> holds an index into sharedStrings.
        const i = Number(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '-1');
        value = shared[i] ?? '';
      } else if (type === 'inlineStr') {
        value = sharedStringText(inner);
      } else if (type === 'str') {
        value = unescapeXml(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      } else {
        const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
        value = unescapeXml(raw);
      }

      // Place by decoded column, filling any gap the file left out.
      while (cells.length < col) cells.push('');
      cells[col] = value.trim();
    }

    while (grid.length < rowNo - 1) grid.push([]);
    grid[rowNo - 1] = cells;
  }

  // Normalise to a rectangle so column indexes are safe to read everywhere.
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  return grid.map((r) => {
    const row = r ?? [];
    while (row.length < width) row.push('');
    return row;
  });
}

/**
 * Decrypt a password-protected Office file, if a decryptor is available.
 *
 * Loaded dynamically and deliberately optional: ECMA-376 agile encryption is
 * AES plus a SHA-512 key-derivation chain, and hand-rolling crypto to save a
 * dependency is a bad trade. If the package is absent the caller gets a clear
 * instruction rather than a stack trace.
 */
export async function decryptOfficeFile(
  buffer: Buffer, password: string,
): Promise<Buffer> {
  interface OfficeCrypto {
    OfficeFile: new (b: Buffer) => {
      loadKey(o: { password: string }): void; decrypt(): ArrayBufferLike;
    };
  }

  let mod: OfficeCrypto;
  try {
    // The specifier is a variable on purpose: it keeps the package a genuinely
    // OPTIONAL dependency, so `npm install` and `tsc` both succeed without it.
    // Deliberate, because ECMA-376 agile encryption is AES over a SHA-512
    // key-derivation chain and the available package is version 0.1.0 — young,
    // for code that would run on every client's bank statement. Making it
    // opt-in leaves that supply-chain call to whoever deploys this, and the
    // unencrypted spreadsheet path needs no dependency at all.
    const specifier = 'office-crypto';
    mod = (await import(specifier)) as OfficeCrypto;
  } catch {
    throw new ValidationError(
      'this file is password-protected and the decryption support is not ' +
      'installed. Run `npm install office-crypto`, or open the file in Excel ' +
      'and save it without a password.', 'BR-4');
  }

  try {
    const f = new mod.OfficeFile(buffer);
    f.loadKey({ password });
    return Buffer.from(f.decrypt());
  } catch (e) {
    throw new ValidationError(
      `could not open the file with that password — ${
        e instanceof Error ? e.message : String(e)}`, 'BR-4');
  }
}
