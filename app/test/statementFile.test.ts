/**
 * Statement file parsing tests — bank-and-reconciliation.md §5.1, §5.2.
 *
 * The fixtures deliberately include the mess a real export carries: preamble
 * rows, a trailer, blank separators, lakh-grouped amounts, quoted narrations
 * with embedded commas, and a subtotal line that must not become a
 * transaction.
 *
 * ⚠️ Column headings are taken from documented layouts, not real files
 * (CA-REVIEW-REQUEST.md B1). These tests prove the machinery, not the accuracy
 * of any one bank's template.
 */

import { describe, it, expect } from 'vitest';
import { parseDelimited, detectDelimiter } from '../src/parse/csv.ts';
import { parseDate, parseAmount } from '../src/parse/values.ts';
import { parseStatementFile } from '../src/parse/statementFile.ts';
import { verifyStatementArithmetic } from '../src/domain/statement.ts';

// ---------------------------------------------------------------------------
describe('delimited reading', () => {
  it('honours quoted fields containing the delimiter', () => {
    const { rows } = parseDelimited('a,b\n"ACME TRADING, MUMBAI",100\n');
    expect(rows[1]).toEqual(['ACME TRADING, MUMBAI', '100']);
  });

  it('honours newlines inside quoted fields', () => {
    // Getting this wrong shifts every following row by one.
    const { rows } = parseDelimited('a,b\n"line one\nline two",100\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]![0]).toBe('line one\nline two');
  });

  it('handles escaped double quotes', () => {
    const { rows } = parseDelimited('a\n"say ""hello"" now"\n');
    expect(rows[1]![0]).toBe('say "hello" now');
  });

  it('strips a UTF-8 BOM from the first heading', () => {
    const { rows } = parseDelimited('﻿Date,Narration\n01/04/2026,X\n');
    expect(rows[0]![0]).toBe('Date');
  });

  it('detects a tab delimiter even when commas are more numerous', () => {
    // The narration column is full of commas; the tabs are what give structure.
    const text = 'Date\tNarration\tAmount\n'
      + '01/04/2026\tACME, MUMBAI, INDIA\t100\n'
      + '02/04/2026\tBETA, PUNE, INDIA\t200\n';
    expect(detectDelimiter(text)).toBe('\t');
  });

  it('drops blank separator rows', () => {
    const { rows } = parseDelimited('a,b\n\n,\n1,2\n');
    expect(rows).toEqual([['a', 'b'], ['1', '2']]);
  });
});

// ---------------------------------------------------------------------------
describe('date coercion', () => {
  it('reads Indian day-first formats', () => {
    expect(parseDate('01/02/2026', 'dd/MM/yyyy')).toBe('2026-02-01');
    expect(parseDate('01/02/26', 'dd/MM/yy')).toBe('2026-02-01');
    expect(parseDate('15-08-2026', 'dd-MM-yyyy')).toBe('2026-08-15');
    expect(parseDate('2026-08-15', 'yyyy-MM-dd')).toBe('2026-08-15');
  });

  it('reads month names regardless of the declared format', () => {
    expect(parseDate('15 Aug 2026', 'dd MMM yyyy')).toBe('2026-08-15');
    expect(parseDate('15-Sep-2026', 'dd-MMM-yyyy')).toBe('2026-09-15');
  });

  it('the same string parses differently under Indian and US formats', () => {
    // Exactly why the format is declared per bank and never inferred: guessing
    // wrong moves a transaction into the wrong month.
    expect(parseDate('01/02/2026', 'dd/MM/yyyy')).toBe('2026-02-01');
    expect(parseDate('01/02/2026', 'MM/dd/yyyy')).toBe('2026-01-02');
  });

  it('rejects a date that does not exist rather than rolling it over', () => {
    // 31 February must not silently become 3 March.
    expect(parseDate('31/02/2026', 'dd/MM/yyyy')).toBeNull();
  });

  it('returns null for label and blank cells', () => {
    expect(parseDate('', 'dd/MM/yyyy')).toBeNull();
    expect(parseDate('Total', 'dd/MM/yyyy')).toBeNull();
    expect(parseDate('-', 'dd/MM/yyyy')).toBeNull();
  });

  it('ignores a trailing time component', () => {
    expect(parseDate('01/04/2026 14:32:07', 'dd/MM/yyyy')).toBe('2026-04-01');
  });
});

// ---------------------------------------------------------------------------
describe('amount coercion', () => {
  it('reads lakh and crore digit grouping', () => {
    // Number('1,23,456.78') is NaN.
    expect(parseAmount('1,23,456.78').value).toBe('123456.78');
    expect(parseAmount('1,00,00,000.00').value).toBe('10000000.00');
  });

  it('reads accounting negatives and signs', () => {
    expect(parseAmount('(500.00)')).toMatchObject({ value: '500.00', negative: true });
    expect(parseAmount('-500.00')).toMatchObject({ value: '500.00', negative: true });
    expect(parseAmount('500.00')).toMatchObject({ value: '500.00', negative: false });
  });

  it('reads a Dr/Cr marker with the Indian meaning, not the reverse', () => {
    // From a real SBI statement: no space before the suffix, and CR means the
    // customer HAS the money. Flagging Cr as negative — which this originally
    // did, with a test asserting it — turned a ₹2,41,933.51 opening balance
    // into −₹2,41,933.51 and made BR-6 report a nonsense discrepancy.
    expect(parseAmount('2,41,933.51CR'))
      .toMatchObject({ value: '241933.51', negative: false, suffix: 'cr' });
    // A Dr balance is an overdrawn account.
    expect(parseAmount('500.00 Dr'))
      .toMatchObject({ value: '500.00', negative: true, suffix: 'dr' });
    // No marker at all — an ordinary amount column.
    expect(parseAmount('5,000.00'))
      .toMatchObject({ value: '5000.00', negative: false, suffix: null });
  });

  it('recognises every way a bank writes "nothing here"', () => {
    for (const blank of ['', ' ', '-', 'NIL', 'nil']) {
      expect(parseAmount(blank).blank).toBe(true);
    }
  });

  it('strips the rupee symbol', () => {
    expect(parseAmount('₹ 1,500.50').value).toBe('1500.50');
  });

  it('throws on text rather than returning NaN', () => {
    // NaN flowing into the BR-6 balance check fails far from its cause.
    expect(() => parseAmount('Opening Balance')).toThrow(/not a recognisable amount/);
  });
});

// ---------------------------------------------------------------------------
const HDFC_FILE = `Statement of account
Account Number:,50100123457788
Account Branch:,ANDHERI EAST MUMBAI
Period:,01/04/26 to 30/04/26
Opening Balance:,"1,00,000.00"

Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
02/04/26,NEFT-CITIN52026040212345-ACME TRADING PVT LTD-UTR123456789,,02/04/26,,"50,000.00","1,50,000.00"
05/04/26,CHQ PAID - 123456,123456,05/04/26,"20,000.00",,"1,30,000.00"
09/04/26,SMS CHARGES 04/2026 + GST,,09/04/26,118.00,,"1,29,882.00"

Closing Balance:,"1,29,882.00"
*** End of statement ***
`;

describe('a realistic HDFC-shaped export (BR-5)', () => {
  it('identifies the bank from the file contents', () => {
    const p = parseStatementFile(HDFC_FILE);
    expect(p.bank).toBe('HDFC Bank');
  });

  it('finds the header row below the preamble', () => {
    const p = parseStatementFile(HDFC_FILE);
    // Blank rows are dropped, so the header is the 5th surviving row (index 4).
    expect(p.rows).toHaveLength(3);
    expect(p.columns.narration).toBe(1);
    expect(p.columns.balance).toBe(6);
  });

  it('does not treat the preamble or trailer as transactions', () => {
    const p = parseStatementFile(HDFC_FILE);
    expect(p.rows.map((r) => r.txnDate))
      .toEqual(['2026-04-02', '2026-04-05', '2026-04-09']);
    // Skipped rows are recorded, not silently dropped.
    expect(p.skippedRows.length).toBeGreaterThan(0);
    expect(p.skippedRows.some((s) => s.text.includes('End of statement'))).toBe(true);
  });

  it('splits withdrawal and deposit into the right sides', () => {
    const p = parseStatementFile(HDFC_FILE);
    expect(p.rows[0]).toMatchObject({ credit: '50000.00', debit: '0.00' });
    expect(p.rows[1]).toMatchObject({ debit: '20000.00', credit: '0.00' });
  });

  it('mines the stated opening and closing balances and the period', () => {
    const p = parseStatementFile(HDFC_FILE);
    expect(p.openingBalance).toBe('100000.00');
    expect(p.closingBalance).toBe('129882.00');
    expect(p.periodFrom).toBe('2026-04-01');
    expect(p.periodTo).toBe('2026-04-30');
  });

  it('and the parsed result passes BR-6 end to end', () => {
    const p = parseStatementFile(HDFC_FILE);
    const check = verifyStatementArithmetic(p.openingBalance!, p.closingBalance!, p.rows);
    expect(check.ok).toBe(true);
    expect(check.firstBadRow).toBeNull();
  });

  it('a dropped row is caught by the balance check, not by the parser', () => {
    // The parser cannot know a page is missing. BR-6 can.
    const truncated = HDFC_FILE.replace(/^05\/04\/26.*\n/m, '');
    const p = parseStatementFile(truncated);
    expect(p.rows).toHaveLength(2);
    const check = verifyStatementArithmetic(p.openingBalance!, p.closingBalance!, p.rows);
    expect(check.ok).toBe(false);
    expect(check.difference).toBe('-20000.00');
  });
});

// ---------------------------------------------------------------------------
describe('other layouts', () => {
  it('reads a single signed amount column', () => {
    const file = `Date,Description,Amount,Balance
01/04/2026,OPENING,0.00,10000.00
02/04/2026,NEFT FROM ACME,5000.00,15000.00
03/04/2026,SMS CHARGES,-118.00,14882.00
`;
    const p = parseStatementFile(file);
    expect(p.template.amountConvention).toBe('single_signed');
    expect(p.rows.find((r) => r.narration === 'SMS CHARGES'))
      .toMatchObject({ debit: '118.00', credit: '0.00' });
    expect(p.rows.find((r) => r.narration === 'NEFT FROM ACME'))
      .toMatchObject({ credit: '5000.00', debit: '0.00' });
    // The zero-amount opening line is not a transaction.
    expect(p.rows.some((r) => r.narration === 'OPENING')).toBe(false);
  });

  it('reads an amount column plus a Dr/Cr flag (Kotak shape)', () => {
    const file = `Kotak Mahindra Bank - Statement
Transaction Date,Description,Chq / Ref No,Amount,Dr / Cr,Balance
01-04-2026,NEFT FROM ACME,REF1,"5,000.00",CR,"15,000.00"
02-04-2026,ATM WDL 4455,,"2,000.00",DR,"13,000.00"
`;
    const p = parseStatementFile(file);
    expect(p.bank).toBe('Kotak Mahindra Bank');
    expect(p.rows[0]).toMatchObject({ credit: '5000.00', debit: '0.00' });
    expect(p.rows[1]).toMatchObject({ debit: '2000.00', credit: '0.00' });
  });

  it('an explicit bank choice overrides detection (BR-5)', () => {
    // The file says ICICI, but the user knows better.
    const file = `ICICI Bank - Statement of Account
Transaction Date,Value Date,Transaction Remarks,Withdrawal Amount (INR ),Deposit Amount (INR ),Balance (INR )
15/08/2026,15/08/2026,NEFT FROM ACME,,5000.00,5000.00
`;
    expect(parseStatementFile(file).bank).toBe('ICICI Bank');
    // The user overrides; the SBI template also fits these column names, and
    // its 'dd MMM yyyy' format is what would then be applied.
    const forced = parseStatementFile(file, { bank: 'Generic (separate debit/credit columns)' });
    expect(forced.bank).toBe('Generic (separate debit/credit columns)');
    expect(forced.rows[0]!.txnDate).toBe('2026-08-15');
  });

  it('warns when the bank could not be identified', () => {
    const file = `Txn Date,Particulars,Withdrawal,Deposit,Balance
01/04/2026,SOMETHING,,100.00,100.00
`;
    const p = parseStatementFile(file);
    expect(p.warnings.join(' ')).toMatch(/BR-5.*could not be identified/);
  });

  it('a signed-amount file is not hijacked by a template needing a Dr/Cr flag', () => {
    // Regression: the Kotak template (priority 90, amount_plus_type) matched a
    // plain Date/Description/Amount/Balance file on its other columns, then
    // skipped every row for having no Dr/Cr marker — a parse that produced
    // nothing while reporting a confident bank name.
    const file = `Date,Description,Amount,Balance
02/04/2026,NEFT FROM ACME,5000.00,15000.00
`;
    const p = parseStatementFile(file);
    expect(p.template.amountConvention).toBe('single_signed');
    expect(p.rows).toHaveLength(1);
  });

  it('says so when a recognised bank\'s template does not fit its own file', () => {
    // The file names HDFC, but the columns are not HDFC's — which is what a
    // format change looks like from here.
    const file = `HDFC Bank Statement
Txn Date,Particulars,Debit,Credit,Balance
01/04/2026,SOMETHING,,100.00,100.00
`;
    const p = parseStatementFile(file);
    expect(p.bank).not.toBe('HDFC Bank');
    expect(p.warnings.join(' ')).toMatch(/appears to be from HDFC Bank.*did not match/);
    expect(p.warnings.join(' ')).toMatch(/may have changed its export format/);
  });

  it('derives the opening balance when the file states none', () => {
    const file = `Date,Narration,Withdrawal,Deposit,Balance
02/04/2026,NEFT FROM ACME,,"5,000.00","15,000.00"
`;
    const p = parseStatementFile(file);
    expect(p.openingBalance).toBe('10000.00');
    expect(p.warnings.join(' ')).toMatch(/derived from the first row/);
  });

  it('says plainly when BR-6 cannot be checked at all', () => {
    const file = `Date,Narration,Withdrawal,Deposit
02/04/2026,NEFT FROM ACME,,5000.00
`;
    const p = parseStatementFile(file);
    expect(p.openingBalance).toBeNull();
    expect(p.warnings.join(' ')).toMatch(/BR-6 cannot run/);
  });
});

// ---------------------------------------------------------------------------
/**
 * Modelled on a REAL HDFC savings-account statement (net-banking PDF export),
 * with every personal detail replaced by a dummy. Only the layout is real.
 *
 * Two things here that no invented fixture had:
 *
 *   - the opening balance lives in a STATEMENT SUMMARY block at the FOOT of the
 *     statement, not in the preamble
 *   - in that block, the labels are on one row and the values on the next, so
 *     the value must be read from beneath its own heading
 *
 * Both broke the parser. On the real file `openingBalance` came back null and
 * BR-6 could not run at all.
 */
const HDFC_REAL_SHAPE = `Page No .: 1
Account Branch,:,EXAMPLE BRANCH
Address,:,HDFC BANK LTD.
City,:,EXAMPLE CITY 000000
Phone no.,:,18002600/18001600
OD Limit,:,0.00
Currency,:,INR
Cust ID,:,000000000
Account No,:,00000000000000,OTHER
A/C Open Date,:,20/07/2026
RTGS/NEFT IFSC:,HDFC0000000,MICR : 000000000
Account Type,:,SAVINGS A/C - SB MAX(193)
From : 01/07/2026,To : 22/07/2026,Statement of account

Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
21/07/26,"CHQ DEP - CTS CLG1 - EXAMPLE: A N OTHER
NAME :STATE BANK OF INDIA",0000000000204314,21/07/26,,"25,000.00","25,000.00"

STATEMENT SUMMARY :-
Opening Balance,Dr Count,Cr Count,Debits,Credits,Closing Bal
0.00,0,1,0.00,"25,000.00","25,000.00"

Generated On:,22-Jul-2026 19:50
This is a computer generated statement and does not require signature.
`;

describe('a real HDFC statement layout', () => {
  it('identifies the bank and its columns', () => {
    const p = parseStatementFile(HDFC_REAL_SHAPE);
    expect(p.bank).toBe('HDFC Bank');
    expect(p.template.dateFormat).toBe('dd/MM/yy');
    expect(p.rows).toHaveLength(1);
  });

  it('reads the transaction, including a narration wrapped over two lines', () => {
    const p = parseStatementFile(HDFC_REAL_SHAPE);
    expect(p.rows[0]).toMatchObject({
      txnDate: '2026-07-21', credit: '25000.00', debit: '0.00',
      runningBalance: '25000.00',
    });
    expect(p.rows[0]!.narration).toContain('CHQ DEP - CTS CLG1');
    expect(p.rows[0]!.narration).toContain('STATE BANK OF INDIA');
  });

  it('finds the opening balance in the summary block at the FOOT of the file', () => {
    const p = parseStatementFile(HDFC_REAL_SHAPE);
    expect(p.openingBalance).toBe('0.00');
    expect(p.closingBalance).toBe('25000.00');
    // Not derived from the running balance — genuinely mined from the summary.
    expect(p.warnings.join(' ')).not.toMatch(/derived from the first row/);
  });

  it('reads the period from the From/To line, not from the transaction dates', () => {
    const p = parseStatementFile(HDFC_REAL_SHAPE);
    expect(p.periodFrom).toBe('2026-07-01');
    expect(p.periodTo).toBe('2026-07-22');
  });

  it('so BR-6 can actually run, which is the whole point', () => {
    const p = parseStatementFile(HDFC_REAL_SHAPE);
    const check = verifyStatementArithmetic(p.openingBalance!, p.closingBalance!, p.rows);
    expect(check.ok).toBe(true);
  });

  it('does not mistake the summary or the page header for transactions', () => {
    const p = parseStatementFile(HDFC_REAL_SHAPE);
    expect(p.rows).toHaveLength(1);
    expect(p.skippedRows.some((s) => s.text.includes('STATEMENT SUMMARY'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('refusals', () => {
  it('refuses a file with no header row', () => {
    expect(() => parseStatementFile('Some summary text\nNothing tabular here\n'))
      .toThrow(/could not find a header row/);
  });

  it('refuses a header with no data beneath it', () => {
    const file = `Date,Narration,Withdrawal,Deposit,Balance
Total,,100.00,200.00,
`;
    expect(() => parseStatementFile(file)).toThrow(/no data rows parsed/);
  });

  it('refuses an empty file', () => {
    expect(() => parseStatementFile('')).toThrow(/no rows/);
  });
});
