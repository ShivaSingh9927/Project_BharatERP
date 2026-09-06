/**
 * `.xlsx` reading — bank-and-reconciliation.md §5.1 (BR-3).
 *
 * The grid in these tests reproduces the layout of a real SBI net-banking
 * spreadsheet export: a label preamble, a header row, transactions with blank
 * amount cells, a blank separator row, and a foot summary grid whose values
 * sit beneath their labels. All identifiers are dummies and all amounts are
 * invented.
 */

import { describe, it, expect } from 'vitest';
import { makeXlsx, makeZip, type Cell } from './helpers/xlsxBuilder.ts';
import { readXlsxSheet, columnIndex, serialToIsoDate } from '../src/parse/xlsx.ts';
import { ZipArchive, looksLikeZip, looksLikeEncryptedOffice } from '../src/parse/zip.ts';
import { parseStatementBytes } from '../src/parse/statementFile.ts';
import { verifyStatementArithmetic } from '../src/domain/statement.ts';

/** `null` = the cell is absent from the file, exactly as Excel writes a blank. */
const SBI_GRID: Cell[][] = [
  ['Statement From  :  01-09-2026  to  06-09-2026', null, null, null, null, null],
  ['Date', 'Details', 'Ref No/Cheque No', 'Debit', 'Credit', 'Balance'],
  ['01/09/2026', 'WDL TFR   UPI/DR/000000000001/EXAMPLE/handle@upi/Co\nllect', null, 5000, null, 95000],
  ['02/09/2026', 'DEP TFR   UPI/CR/000000000002/EXAMPLE/handle@upi/Paym\nent', null, null, 10000, 105000],
  [],                                                    // self-closing <row/>
  ['Statement Summary : 01-09-2026  To  06-09-2026', null, null, null, null, null],
  ['Brought Forward (₹)', 'Dr Count', 'Cr Count', 'Total Debits (₹)',
   'Total Credits (₹)', 'Closing Balance (₹)'],
  ['1,00,000.00CR', 1, 1, '5,000.00', '10,000.00', '1,05,000.00CR'],
];

// ---------------------------------------------------------------------------
describe('column references', () => {
  it('decodes single and double letters', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('D19')).toBe(3);
    expect(columnIndex('Z1')).toBe(25);
    expect(columnIndex('AA1')).toBe(26);
    expect(columnIndex('AB7')).toBe(27);
  });
});

describe('Excel serial dates', () => {
  it('is correct for every date a bank statement can contain', () => {
    // Excel's serial numbering has an unfixable inconsistency: it treats 1900
    // as a leap year, so serial 60 is the non-existent 29 February 1900. No
    // single epoch can be right on both sides of that day.
    //
    // The 1899-12-30 epoch is therefore the standard choice: exact for serial
    // 61 onwards — every date from 1 March 1900 — and off by one only before
    // it. A bank statement cannot predate 1900, so the trade-off costs nothing.
    expect(serialToIsoDate(61)).toBe('1900-03-01');
    expect(serialToIsoDate(46266)).toBe('2026-09-01');
    expect(serialToIsoDate(46267)).toBe('2026-09-02');
  });

  it('rejects values outside a plausible range', () => {
    expect(serialToIsoDate(0)).toBeNull();
    expect(serialToIsoDate(-5)).toBeNull();
    expect(serialToIsoDate(9e9)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('reading the sheet', () => {
  it('places values by cell reference, not by document order', () => {
    // THE defect this reader exists to avoid. Row 3 omits the reference and
    // credit cells; appending in document order would slide the balance into
    // the credit column and produce figures that are wrong but plausible.
    const grid = readXlsxSheet(makeXlsx(SBI_GRID));
    expect(grid[2]).toEqual([
      '01/09/2026',
      'WDL TFR   UPI/DR/000000000001/EXAMPLE/handle@upi/Co\nllect',
      '', '5000', '', '95000',
    ]);
    expect(grid[3]).toEqual([
      '02/09/2026',
      'DEP TFR   UPI/CR/000000000002/EXAMPLE/handle@upi/Paym\nent',
      '', '', '10000', '105000',
    ]);
  });

  it('does not let a styled blank cell swallow its neighbour', () => {
    // The real SBI defect, reduced. `undefined` writes `<c r="D1" s="1"/>` —
    // a blank cell that EXISTS. A greedy attribute match treats it as an
    // opening tag, consumes the next cell as its body, and reads that cell's
    // shared-string INDEX as a value: on the real statement a ₹50,000 credit
    // became a ₹50 debit, in the wrong column.
    const grid = readXlsxSheet(makeXlsx([
      ['Date', 'Details', 'Ref', 'Debit', 'Credit', 'Balance'],
      ['02/09/2026', 'a credit', undefined, undefined, '50,000.00', '284873.51'],
    ]));
    expect(grid[1]).toEqual(
      ['02/09/2026', 'a credit', '', '', '50,000.00', '284873.51']);
  });

  it('handles both kinds of blank in the same row', () => {
    const grid = readXlsxSheet(makeXlsx([
      ['a', null, undefined, 'd'],          // omitted AND styled-blank
    ]));
    expect(grid[0]).toEqual(['a', '', '', 'd']);
  });

  it('preserves a self-closing empty row in position', () => {
    // Matching only <row>…</row> was worse than skipping empty rows: the
    // regex consumed the trailing slash, treated `<row r="5"/>` as an opening
    // tag, and swallowed the next real row as its body — shifting the summary
    // block up and losing a transaction.
    const grid = readXlsxSheet(makeXlsx(SBI_GRID));
    expect(grid).toHaveLength(8);
    expect(grid[4]!.every((c) => c === '')).toBe(true);
    expect(grid[5]![0]).toMatch(/^Statement Summary/);
    expect(grid[6]![0]).toBe('Brought Forward (₹)');
  });

  it('returns a rectangular grid so column indexes are always safe', () => {
    const grid = readXlsxSheet(makeXlsx(SBI_GRID));
    const widths = new Set(grid.map((r) => r.length));
    expect(widths.size).toBe(1);
  });

  it('keeps newlines inside a single cell', () => {
    const grid = readXlsxSheet(makeXlsx(SBI_GRID));
    expect(grid[2]![1]).toContain('\n');
  });

  it('decodes XML entities without double-decoding', () => {
    // The third value is the LITERAL text '&amp;lt;'. Reading it back
    // unchanged is the whole test: decoding '&amp;' before the other entities
    // would turn it into '&lt;' and then into '<', silently rewriting a
    // narration. Hence '&amp;' is decoded last.
    const values = ['A & B', '<tag>', '&amp;lt;', "it's", '"quoted"'];
    const grid = readXlsxSheet(makeXlsx([values]));
    expect(grid[0]).toEqual(values);
  });
});

// ---------------------------------------------------------------------------
describe('end to end from bytes', () => {
  it('detects the format, maps the columns, and passes BR-6', async () => {
    const p = await parseStatementBytes(makeXlsx(SBI_GRID));

    expect(p.format).toBe('xlsx');
    expect(p.columns).toMatchObject({
      txnDate: 0, narration: 1, reference: 2, debit: 3, credit: 4, balance: 5,
    });
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]).toMatchObject({ debit: '5000.00', credit: '0.00' });
    expect(p.rows[1]).toMatchObject({ debit: '0.00', credit: '10000.00' });

    // Mined from the foot summary: label row, value beneath, CR meaning
    // positive. Three separate fixes, all exercised here.
    expect(p.openingBalance).toBe('100000.00');
    expect(p.closingBalance).toBe('105000.00');
    expect(p.periodFrom).toBe('2026-09-01');
    expect(p.periodTo).toBe('2026-09-06');

    const check = verifyStatementArithmetic(p.openingBalance!, p.closingBalance!, p.rows);
    expect(check.ok).toBe(true);
  });

  it('falls through to delimited text for a CSV', async () => {
    const csv = Buffer.from(
      'Date,Narration,Withdrawal,Deposit,Balance\n01/04/2026,X,,100.00,100.00\n');
    const p = await parseStatementBytes(csv);
    expect(p.format).toBe('delimited');
    expect(p.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('refusals and safety', () => {
  it('tells the user a file is password-protected rather than "not a zip"', async () => {
    // SBI's export is named .xlsx but is an encrypted OLE container. Reporting
    // a zip error to someone whose file merely has a password is useless.
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(600),
    ]);
    expect(looksLikeEncryptedOffice(ole)).toBe(true);
    await expect(parseStatementBytes(ole)).rejects.toThrow(/password-protected/);
  });

  it('names the format hazard: extension cannot be trusted', () => {
    const real = makeXlsx([['a']]);
    expect(looksLikeZip(real)).toBe(true);
    expect(looksLikeEncryptedOffice(real)).toBe(false);
  });

  it('rejects a file that is neither a zip nor an encrypted container', () => {
    expect(() => readXlsxSheet(Buffer.from('just some text')))
      .toThrow(/not a spreadsheet/);
  });

  it('rejects a zip claiming an implausible uncompressed size', () => {
    // Zip-bomb defence. The declared size is checked BEFORE inflating, so a
    // small file cannot claim gigabytes and exhaust memory.
    const buf = makeZip([['xl/worksheets/sheet1.xml', 'x'.repeat(64)]]);
    // Overwrite the central-directory uncompressed size with 1 GB.
    const eocd = buf.length - 22;
    const cdOffset = buf.readUInt32LE(eocd + 16);
    buf.writeUInt32LE(1024 * 1024 * 1024, cdOffset + 24);
    expect(() => new ZipArchive(buf)).toThrow(/above the .*-byte limit/);
  });

  it('rejects a truncated archive rather than guessing', () => {
    const buf = makeXlsx([['a']]).subarray(0, 40);
    expect(() => new ZipArchive(buf)).toThrow(/no end-of-central-directory/);
  });

  it('reports a workbook with no worksheet', () => {
    const buf = makeZip([['[Content_Types].xml', '<Types/>']]);
    expect(() => readXlsxSheet(buf)).toThrow(/no worksheet/);
  });
});
