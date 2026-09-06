/**
 * Fixed-width / PDF statement parsing.
 * Spec: bank-and-reconciliation.md §5.1, §5.2
 *
 * The fixtures are the extracted text of two REAL statements, reproduced
 * character-for-character in their column alignment, with every identifier
 * replaced and every amount invented. The alignment IS the test — these
 * defects are all about which character position a value sits at, so a fixture
 * that tidied the spacing would prove nothing.
 *
 * `parsePdfText` is tested rather than `parsePdfStatement`, because the latter
 * shells out to `pdftotext` and the extraction is not what is under test here.
 */

import { describe, it, expect } from 'vitest';
import {
  detectBoundaries, sliceCells, splitPages, fixedWidthToGrid,
  groupRows, joinWrapped, isDatedLine,
} from '../src/parse/fixedWidth.ts';
import { inferColumnRoles } from '../src/parse/columnRoles.ts';
import { parsePdfText } from '../src/parse/pdf.ts';
import { verifyStatementArithmetic } from '../src/domain/statement.ts';

/**
 * HDFC shape. Note what makes it hard:
 *   - an address block whose text sits where the table's gutters are
 *   - blank lines BETWEEN transaction rows
 *   - `Deposit Amt.` header at a different character position from its values
 *   - a narration wrapping MID-TOKEN (`...-Y` then `ESB0PTMUPI-...`)
 *   - the opening balance in a foot summary grid, values beneath their labels
 */
const HDFC_TEXT = `                                                                             Page No .: 1

                                                                             Account Branch      : EXAMPLE BRANCH
   MR   A N OTHER                                                            Address             : EXAMPLE BANK LTD,
   1 EXAMPLE ROAD                                                                                  EXAMPLE PLACE
   EXAMPLE CITY 000000                                                       City                : EXAMPLE CITY
                                                                             Account No          : 00000000000000
                                                                             A/C Open Date       : 05/08/2023

  From : 01/09/2026                          To : 06/09/2026                                       Statement of account
    Date                       Narration                    Chq./Ref.No.        Value Dt        Withdrawal Amt.                 Deposit Amt.              Closing Balance

 02/09/2026     UPI-EXAMPLE PAYEE-PAYTM-70000000@PTYBL-Y     0000624531110990    02/09/2026                 126.80                                              162,509.37

                ESB0PTMUPI-624531110990-TRANSACTIONNOTE

 03/09/2026     IB BILLPAY DR-EXAMPLE-361135XXXX4700         1788411606325904    03/09/2026              12,222.00                                              150,287.37

 03/09/2026     ACH C- EXAMPLE COMPANY-32256648              0000002692476572    03/09/2026                                                     78.00           150,365.37

 04/09/2026     UPI-EXAMPLE PAYEE                            0000661306284113    04/09/2026              25,000.00                                              125,365.37

                PR-EXAMPLE.PAYU.BRK@

 05/09/2026     UPI-XXXXXXX7140-SBIN0000641-624861888406     0000624861888406    05/09/2026                    1.00                                             125,364.37

 05/09/2026     UPI-EXAMPLE PAYEE-PAYTM-70000000@PTYBL-Y     0000661404701814    05/09/2026                                                     55.00           125,419.37


              STATEMENT SUMMARY :-
                                     Opening Balance                                           Dr Count                  Cr Count              Debits                       Credits                   Closing Bal
                                       162,636.17                                                  4                         2                37,349.80                     133.00                    125,419.37

    Please do not share your ATM, Debit/Credit Card number, PIN with anyone.
    This is a computer generated statement and does not require a signature.
`;

/**
 * SBI shape. Its distinguishing feature: extraction preserves NO header row —
 * only the bare word `Balance` — and the transaction TYPE marker sits on its
 * own line ABOVE the dated line.
 */
const SBI_TEXT = `                                               STATEMENT OF ACCOUNT

             Account Name                    : MR A N OTHER
             Account Number                  : 00000000000
         Clear Balance                       : 1,05,000.00CR
                                           Statement From       : 01-09-2026 to 06-09-2026

                                                                                                                  Balance

                             WDL TFR
01/09/2026      01/09/2026   UPI/DR/000000000001/EXAMPLE/YESB          -           5,000.00        -               95,000.00
                             /handle@upi/Collect
                             0000000000000 AT 00000
                             EXAMPLE MAIN BRANCH
                             DEP TFR
02/09/2026      02/09/2026   UPI/CR/000000000002/EXAMPLE/PUNB          -              -        20,000.00           115,000.00
                             /handle@upi/Payment
                             0000000000000 AT 00000
                             EXAMPLE MAIN BRANCH
                             WDL TFR
03/09/2026      03/09/2026   UPI/DR/000000000003/EXAMPLE/UTIB          -          10,000.00        -               105,000.00
                             /handle@upi/Collect

                                              Statement Summary : 01-09-2026 To 06-09-2026

Brought Forward (       ) Dr Count Cr Count                   Total Debits ( )           Total Credits ( )                 Closing Balance ( )

  1,00,000.00CR                  2               1                 15,000.00                    20,000.00                       1,05,000.00CR

    This is a computer generated statement and does not require a signature.
`;

// ---------------------------------------------------------------------------
describe('gutter detection', () => {
  it('finds column starts from consistently blank positions', () => {
    const lines = [
      'AAA    BBB      CCC',
      'A      BB       C',
      'AA     B        CC',
    ];
    expect(detectBoundaries(lines)).toEqual([0, 7, 16]);
  });

  it('tolerates one line reaching into a gutter', () => {
    // Requiring unanimity is too brittle: a single long narration would erase
    // the boundary and merge every column to its right.
    const lines = [
      'AAA    BBB      CCC',
      'AAAAAAAAA       CCC',      // spills into the first gutter
      'AA     B        CC',
      'AA     B        CC',
      'AA     B        CC',
      'AA     B        CC',
      'AA     B        CC',
      'AA     B        CC',
      'AA     B        CC',
      'AA     B        CC',
    ];
    expect(detectBoundaries(lines)).toContain(16);
  });

  it('slices a line at the boundaries and trims', () => {
    expect(sliceCells('AAA    BBB      CCC', [0, 7, 16]))
      .toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('splits pages on the form feed pdftotext emits', () => {
    expect(splitPages('a\n\fb\n')).toHaveLength(2);
  });

  it('recognises a dated line', () => {
    expect(isDatedLine(' 02/09/2026   X')).toBe(true);
    expect(isDatedLine('   WDL TFR')).toBe(false);
    expect(isDatedLine('Total')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('region segmentation', () => {
  it('does not let the address block merge the table columns', () => {
    // Measuring the whole page merged Date and Narration into one
    // 85-character column, because the address text sits in the table's gutter.
    const doc = fixedWidthToGrid(HDFC_TEXT);
    const header = doc.rows.find((r) => r[0] === 'Date');
    expect(header).toBeDefined();
    expect(header!.length).toBeGreaterThanOrEqual(7);
  });

  it('keeps the header with its data despite blank lines between rows', () => {
    // Splitting on blank lines put the header in its own region, so a column
    // empty on every transaction vanished and the balance shifted left.
    const doc = fixedWidthToGrid(HDFC_TEXT);
    const dated = doc.rows.filter((r) => isDatedLine(r[0] ?? ''));
    expect(dated.length).toBe(6);
    // Every transaction row keeps a populated balance in its last column.
    for (const row of dated) {
      expect(row[row.length - 1]).not.toBe('');
    }
  });

  it('drops page furniture but records it', () => {
    const doc = fixedWidthToGrid(HDFC_TEXT);
    expect(doc.pages[0]!.dropped.some((l) => /Page No/.test(l))).toBe(true);
    expect(doc.pages[0]!.dropped.some((l) => /computer generated/.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('row grouping', () => {
  it('attaches continuation lines to the row above', () => {
    const rows = [['01/01/2026', 'first'], ['', 'more'], ['02/01/2026', 'second']];
    const grouped = groupRows(rows, (c) => isDatedLine(c[0] ?? ''));
    expect(grouped).toHaveLength(2);
    expect(grouped[0]!.continuations).toEqual([['', 'more']]);
  });

  it('attaches a forward marker to the row BELOW it', () => {
    // SBI prints `WDL TFR` above the dated line it belongs to.
    const rows = [
      ['01/01/2026', 'first'],
      ['', 'WDL TFR'],
      ['02/01/2026', 'second'],
    ];
    const grouped = groupRows(rows, (c) => isDatedLine(c[0] ?? ''), ['WDL TFR']);
    expect(grouped[0]!.continuations).toEqual([]);
    expect(grouped[1]!.continuations).toEqual([['', 'WDL TFR']]);
  });

  it('joins wrapped fragments with NO separator', () => {
    // HDFC splits `YESB0PTMUPI` across lines. A space would corrupt the
    // reference the matcher relies on most (BR-10).
    expect(joinWrapped(['...PTYBL-Y', 'ESB0PTMUPI-624531110990']))
      .toBe('...PTYBL-YESB0PTMUPI-624531110990');
  });
});

// ---------------------------------------------------------------------------
describe('column inference', () => {
  it('does not mistake a reference number for an amount column', () => {
    // `0000624531110990` parses as a number. Only the two-decimal test
    // distinguishes money from a reference, and without it the reference
    // column became a candidate for the debit column.
    const rows = [
      ['01/09/2026', 'narration', '0000624531110990', '01/09/2026', '126.80', '', '162,509.37'],
      ['02/09/2026', 'narration', '0000624531130468', '02/09/2026', '30.00', '', '162,479.37'],
      ['03/09/2026', 'narration', '0000002692476572', '03/09/2026', '', '78.00', '162,557.37'],
    ];
    const r = inferColumnRoles(rows);
    expect(r.columns.reference).toBe(2);
    expect(r.columns.debit).toBe(4);
    expect(r.columns.credit).toBe(5);
    expect(r.columns.balance).toBe(6);
  });

  it('handles a CREDIT-then-debit column order, proved by the balance', () => {
    const rows = [
      ['01/09/2026', 'x', '', '', '10,000.00'],
      ['02/09/2026', 'x', '500.00', '', '10,500.00'],   // balance ROSE
      ['03/09/2026', 'x', '', '200.00', '10,300.00'],   // balance FELL
      ['04/09/2026', 'x', '100.00', '', '10,400.00'],   // ROSE again
    ];
    const r = inferColumnRoles(rows);
    expect(r.directionEvidence.method).toBe('balance_arithmetic');
    // Column 3 coincides with falling balances, so it is the debit column;
    // column 2 with rising, so it is the credit — the reverse of the usual
    // left-to-right order, and the arithmetic settles it with no special case.
    expect(r.columns.debit).toBe(3);
    expect(r.columns.credit).toBe(2);
    expect(r.directionEvidence.disagreed).toBe(0);
  });

  it('reads money columns that carry NO decimals', () => {
    // Federal Bank writes `456072`, not `4,56,072.00`. A formatting test that
    // required paise found no money columns at all on it: no balance, no
    // debit, no credit. Arithmetic does not care how the number is written.
    const rows = [
      ['02-APR-2026', 'RTG/EXAMPLE', 'C', '', '457698', '1844596'],
      ['03-APR-2026', 'CHRG/CARD AMC', 'D', '885', '', '1843711'],
      ['03-APR-2026', 'RTG/EXAMPLE', 'D', '1700000', '', '143711'],
      ['03-APR-2026', 'Charges for RTGS', 'D', '53', '', '143658'],
      ['03-APR-2026', 'RTG/EXAMPLE', 'C', '', '684719', '828377'],
    ];
    const r = inferColumnRoles(rows);
    expect(r.directionEvidence.method).toBe('balance_arithmetic');
    expect(r.columns.debit).toBe(3);
    expect(r.columns.credit).toBe(4);
    expect(r.columns.balance).toBe(5);
    expect(r.directionEvidence.disagreed).toBe(0);
  });

  it('ignores numeric columns that are not money', () => {
    // A serial number and a constant branch code are both perfectly good
    // numbers. Neither reproduces the movement of a balance, so neither needs
    // a rule of its own to be excluded.
    const rows = [
      ['1', '04/07/2023', '1763', 'UPI-EXAMPLE', '906132', '195.00', '', '200.49'],
      ['2', '04/07/2023', '1763', 'UPI-EXAMPLE', '292357', '', '60.00', '260.49'],
      ['3', '04/07/2023', '1763', 'UPI-EXAMPLE', '565210', '', '213.00', '473.49'],
      ['4', '05/07/2023', '1763', 'UPI-EXAMPLE', '311791', '', '82.00', '555.49'],
    ];
    const r = inferColumnRoles(rows);
    expect(r.columns.debit).toBe(5);
    expect(r.columns.credit).toBe(6);
    expect(r.columns.balance).toBe(7);
    expect(r.directionEvidence.disagreed).toBe(0);
  });

  it('says plainly when nothing reproduced the balance', () => {
    const rows = [
      ['01/09/2026', 'x', '100.00', '', ''],
      ['02/09/2026', 'x', '', '200.00', ''],
    ];
    const r = inferColumnRoles(rows);
    expect(r.notes.join(' ')).toMatch(/no column reproduced the running balance/);
    expect(r.notes.join(' ')).toMatch(/unverified/);
  });
});

// ---------------------------------------------------------------------------
describe('a real HDFC PDF layout', () => {
  it('identifies the bank from the page text', () => {
    const p = parsePdfText(HDFC_TEXT);
    expect(p.columnSource).toBe('inferred');
    expect(p.pageCount).toBe(1);
  });

  it('reads every transaction, and splits debits from credits correctly', () => {
    // The summary states 4 debits and 2 credits. Header-based mapping produced
    // 6 debits and 0 credits, because `Deposit Amt.` sits at a different
    // character position from its values.
    const p = parsePdfText(HDFC_TEXT);
    expect(p.rows).toHaveLength(6);
    expect(p.rows.filter((r) => r.debit !== '0.00')).toHaveLength(4);
    expect(p.rows.filter((r) => r.credit !== '0.00')).toHaveLength(2);
  });

  it('mines the opening balance from the foot summary grid', () => {
    const p = parsePdfText(HDFC_TEXT);
    expect(p.openingBalance).toBe('162636.17');
    expect(p.closingBalance).toBe('125419.37');
  });

  it('passes BR-6, which is the only real proof the columns were right', () => {
    const p = parsePdfText(HDFC_TEXT);
    const check = verifyStatementArithmetic(p.openingBalance!, p.closingBalance!, p.rows);
    expect(check.ok).toBe(true);
    expect(check.totalDebits).toBe('37349.80');
    expect(check.totalCredits).toBe('133.00');
  });

  it('joins a mid-token narration wrap so the reference survives', () => {
    const p = parsePdfText(HDFC_TEXT);
    const wrapped = p.rows.find((r) => r.narration.includes('PTYBL'))!;
    expect(wrapped.narration).toContain('YESB0PTMUPI');
    expect(wrapped.narration).not.toContain('Y ESB0PTMUPI');
  });

  it('reads the period from the From/To line', () => {
    const p = parsePdfText(HDFC_TEXT);
    expect(p.periodFrom).toBe('2026-09-01');
    expect(p.periodTo).toBe('2026-09-06');
  });
});

// ---------------------------------------------------------------------------
describe('a real SBI PDF layout, with no header row at all', () => {
  it('parses despite no header surviving extraction', () => {
    const p = parsePdfText(SBI_TEXT);
    expect(p.rows).toHaveLength(3);
    expect(p.columnSource).toBe('inferred');
  });

  it('splits debits and credits, agreeing with the stated Dr/Cr counts', () => {
    const p = parsePdfText(SBI_TEXT);
    expect(p.rows.filter((r) => r.debit !== '0.00')).toHaveLength(2);
    expect(p.rows.filter((r) => r.credit !== '0.00')).toHaveLength(1);
  });

  it('reads Brought Forward as a POSITIVE CR balance', () => {
    const p = parsePdfText(SBI_TEXT);
    expect(p.openingBalance).toBe('100000.00');
    expect(p.closingBalance).toBe('105000.00');
  });

  it('passes BR-6', () => {
    const p = parsePdfText(SBI_TEXT);
    const check = verifyStatementArithmetic(p.openingBalance!, p.closingBalance!, p.rows);
    expect(check.ok).toBe(true);
  });

  it('attaches the type marker to the transaction below it', () => {
    const p = parsePdfText(SBI_TEXT);
    const credit = p.rows.find((r) => r.credit !== '0.00')!;
    expect(credit.narration).toContain('DEP TFR');
    const firstDebit = p.rows.find((r) => r.debit !== '0.00')!;
    expect(firstDebit.narration).toContain('WDL TFR');
  });

  it('warns that the columns were inferred, not read from a header', () => {
    const p = parsePdfText(SBI_TEXT);
    expect(p.warnings.join(' ')).toMatch(/columns in this PDF were inferred/);
    expect(p.warnings.join(' ')).toMatch(/reproducing the running balance/);
  });
});

// ---------------------------------------------------------------------------
describe('refusals', () => {
  it('reports text with no table', () => {
    expect(() => parsePdfText('Just a sentence.\nAnd another.\n'))
      .toThrow(/no transaction rows|no tabular content/);
  });
});
