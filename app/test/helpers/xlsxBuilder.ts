/**
 * Builds real `.xlsx` files for tests.
 *
 * A base64 blob would have been shorter, but nobody can fix an opaque blob when
 * it breaks. This writes an actual zip with actual sheet XML, so a test fixture
 * stays editable and the reader is exercised against the real container format
 * rather than a convenient approximation.
 *
 * Crucially it reproduces the two behaviours that make `.xlsx` reading hard:
 *
 *   - **empty cells are omitted entirely**, so column position must come from
 *     each cell's `r` reference and never from document order
 *   - **empty rows are written self-closing** (`<row r="5"/>`)
 *
 * Test-only. Not a general-purpose writer.
 */

import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xff]!;
  return (c ^ -1) >>> 0;
}

/** Write a zip archive from name/content pairs. */
export function makeZip(files: Array<[string, string]>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of files) {
    const raw = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);                       // deflate
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, cdBuf, eocd]);
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A cell in a fixture grid.
 *
 *   string/number  a value
 *   null           the cell is ABSENT from the file — an unstyled blank
 *   undefined      the cell EXISTS but is empty and styled: `<c r="D3" s="1"/>`
 *
 * The distinction is not pedantry. Excel writes both forms, and the
 * self-closing styled blank is what broke the real SBI statement: a greedy
 * attribute match swallowed the trailing slash and the cell consumed its
 * neighbour, moving a credit into the debit column. Fixtures that only ever
 * omitted blanks could not reproduce it.
 */
export type Cell = string | number | null | undefined;

/**
 * Build a workbook from a grid.
 *
 * `null` means "this cell does not exist in the file" — which is what Excel
 * writes for a blank, and the case the reader has to get right. A row that is
 * entirely null is written as a self-closing `<row/>`.
 */
export function makeXlsx(grid: Cell[][]): Buffer {
  const strings: string[] = [];
  const indexOf = (s: string): number => {
    const i = strings.indexOf(s);
    return i >= 0 ? i : (strings.push(s), strings.length - 1);
  };

  const rowXml: string[] = [];

  for (const [r, row] of grid.entries()) {
    const cells: string[] = [];
    for (const [c, value] of row.entries()) {
      if (value === null) continue;                    // omitted, as Excel does
      const ref = `${colName(c)}${r + 1}`;
      if (value === undefined) {
        // Styled blank, self-closing — exactly what real Excel emits.
        cells.push(`<c r="${ref}" s="1"/>`);
        continue;
      }
      cells.push(typeof value === 'number'
        ? `<c r="${ref}"><v>${value}</v></c>`
        : `<c r="${ref}" t="s"><v>${indexOf(value)}</v></c>`);
    }
    rowXml.push(cells.length === 0
      ? `<row r="${r + 1}"/>`
      : `<row r="${r + 1}">${cells.join('')}</row>`);
  }

  const sst = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ` count="${strings.length}" uniqueCount="${strings.length}">`
    + strings.map((s) => `<si><t>${xmlEscape(s)}</t></si>`).join('')
    + '</sst>';

  const sheet = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${rowXml.join('')}</sheetData></worksheet>`;

  return makeZip([
    ['[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['xl/workbook.xml',
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/sharedStrings.xml', sst],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}

function colName(i: number): string {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
