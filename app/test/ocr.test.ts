/**
 * OCR and markdown-table reading.
 * Spec: bank-and-reconciliation.md §5.1 — the "PDF (scanned)" row
 *
 * The HTTP layer is mocked throughout. Tests must not call a paid third-party
 * service, and the thing worth testing is not whether their API works but what
 * we do with an imperfect answer.
 *
 * The markdown fixture is the ACTUAL output LlamaParse returned for a published
 * sample statement, trimmed to the rows that matter — **including its two
 * misread balances**, because those are the point.
 */

import { describe, it, expect } from 'vitest';
import { extractMarkdownTables, markdownToGrid } from '../src/parse/markdown.ts';
import { ocrDocument, isImage } from '../src/parse/ocr.ts';
import { parseStatementTable } from '../src/parse/statementFile.ts';
import { verifyStatementArithmetic } from '../src/domain/statement.ts';
import { findMoneyColumns } from '../src/parse/columnRoles.ts';

/**
 * Real LlamaParse output. Rows 16 and 17 carry its two OCR errors: the balances
 * should read 2,187.49 and 1,187.49.
 */
const OCR_MARKDOWN = `# Account Statement

**KVB Karur Vysya Bank**

Acc.No. : **0000000000000000**
St.Period : **01/07/2023 to 15/07/2023**

## Account Summary

| Opening Balance | + Total Credit Amount | - Total Debit Amount | = Closing Balance | Count of Cr. & Dr. Transactions |
| --------------- | --------------------- | -------------------- | ----------------- | ------------------------------- |
| 13,312.62       | 78,248.52             | 91,176.21            | 384.93            | CR:67/DR:67                     |

## Statement of A/c for the period 01/07/2023 to 15/07/2023

| Txn Date   | Value Date | Brn Code | Particulars                              | Ref. No | Debit     | Credit    | Balance   |
| ---------- | ---------- | -------- | ---------------------------------------- | ------- | --------- | --------- | --------- |
| 04/07/2023 | 04/07/2023 | 1763     | UPI-DR-355149-EXAMPLE HOTEL              | 906132  | 195.00    |           | 200.49    |
| 04/07/2023 | 04/07/2023 | 1763     | UPI-DR-318535-EXAMPLE                    | 292137  |           | 60.00     | 260.49    |
| 04/07/2023 | 04/07/2023 | 1763     | UPI-DR-355141-EXAMPLE                    | 565210  |           | 213.00    | 473.49    |
| 05/07/2023 | 05/07/2023 | 1763     | UPI-CR-318612-EXAMPLE                    | 311791  |           | 82.00     | 555.49    |
| 05/07/2023 | 05/07/2023 | 1763     | UPI-DR-355280-EXAMPLE AGENCY             | 832232  | 500.00    |           | 55.49     |
| 05/07/2023 | 05/07/2023 | 1763     | UPI-CR-318632-EXAMPLE                    | 161773  |           | 30.00     | 85.49     |
| 06/07/2023 | 06/07/2023 | 1763     | UPI-DR-318707-EXAMPLE                    | 845703  |           | 280.00    | 365.49    |
| 07/07/2023 | 07/07/2023 | 1763     | UPI-DR-318801-EXAMPLE                    | 470743  |           | 105.00    | 160.49    |
| 07/07/2023 | 07/07/2023 | 1763     | UPI-DR-355412-EXAMPLE                    | 903933  | 100.00    |           | 999.49    |
`;

// ---------------------------------------------------------------------------
describe('markdown tables', () => {
  it('finds every table, and only real tables', () => {
    const tables = extractMarkdownTables(OCR_MARKDOWN);
    expect(tables).toHaveLength(2);
    expect(tables[0]!.rows).toHaveLength(1);          // the summary box
    expect(tables[1]!.rows).toHaveLength(9);          // the transactions
    expect(tables[1]!.header[0]).toBe('Txn Date');
  });

  it('strips the emphasis a parser adds, so values read as numbers', () => {
    const g = markdownToGrid('| A |\n| --- |\n| **13,312.62** |\n');
    expect(g[1]![0]).toBe('13,312.62');
  });

  it('keeps prose outside tables as single-cell rows', () => {
    // The statement period and the account number live in prose, not tables,
    // and the parser still has to find them.
    const grid = markdownToGrid(OCR_MARKDOWN);
    expect(grid.some((r) => r[0]?.includes('St.Period'))).toBe(true);
  });

  it('ignores a pipe-prefixed line with no separator beneath it', () => {
    const tables = extractMarkdownTables('| not a table\njust text\n');
    expect(tables).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('reading an OCR\'d statement', () => {
  it('identifies the bank and the columns from the markdown', () => {
    const p = parseStatementTable(markdownToGrid(OCR_MARKDOWN));
    expect(p.bank).toBe('Karur Vysya Bank');
    expect(p.rows).toHaveLength(9);
    expect(p.openingBalance).toBe('13312.62');
    expect(p.closingBalance).toBe('384.93');
  });

  it('the constant Brn Code column is not mistaken for money', () => {
    const t = extractMarkdownTables(OCR_MARKDOWN)[1]!;
    const money = findMoneyColumns(t.rows, t.header.map((_, i) => i));
    expect(money.debit).toBe(5);
    expect(money.credit).toBe(6);
    expect(money.balance).toBe(7);
  });

  it('NAMES the misread cells rather than just failing', () => {
    // This is what OCR is for here. Two digit errors in a page is not good
    // enough to import, and no confidence score says WHICH two — but the
    // row-level arithmetic does, exactly.
    const p = parseStatementTable(markdownToGrid(OCR_MARKDOWN));
    const check = verifyStatementArithmetic(p.openingBalance!, p.closingBalance!, p.rows);

    expect(check.ok).toBe(false);
    const bad = check.badRows.map((b) => b.row);
    expect(bad).toContain(8);
    expect(bad).toContain(9);

    const row9 = check.badRows.find((b) => b.row === 9)!;
    expect(row9.stated).toBe('999.49');
    expect(row9.expected).toBe('60.49');
  });

  it('reports one error as ONE error, not as every row after it', () => {
    // The walk resumes from the balance the STATEMENT states rather than from
    // our own running total. Without that, one misread digit makes every
    // following row disagree and a thirty-row report says nothing.
    const rows = [
      { txnDate: '2026-01-01', narration: 'a', credit: '100', runningBalance: '1100' },
      { txnDate: '2026-01-02', narration: 'b', credit: '100', runningBalance: '9999' },  // misread
      { txnDate: '2026-01-03', narration: 'c', credit: '100', runningBalance: '10099' },
      { txnDate: '2026-01-04', narration: 'd', credit: '100', runningBalance: '10199' },
    ];
    const check = verifyStatementArithmetic('1000', '10199', rows);

    // Exactly one row named, even though the balances after it are all shifted
    // by the same 8,799 — they are self-consistent from the error onwards, so
    // pointing at row 2 is the whole of the useful information.
    expect(check.badRows.map((b) => b.row)).toEqual([2]);
    // And the statement-level total still fails, so nothing gets imported.
    expect(check.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the OCR provider', () => {
  const key = { apiKey: 'test-key-not-real' };
  const noSleep = { sleepImpl: async () => {} };

  /** Minimal stand-in for the upload → poll → fetch-result sequence. */
  function mockService(opts: {
    markdown?: string; statuses?: string[]; uploadStatus?: number;
  } = {}): typeof fetch {
    const statuses = [...(opts.statuses ?? ['PENDING', 'SUCCESS'])];
    return (async (url: string) => {
      const u = String(url);
      if (u.endsWith('/upload')) {
        return {
          ok: (opts.uploadStatus ?? 200) < 400,
          status: opts.uploadStatus ?? 200,
          json: async () => ({ id: 'job-1' }),
        } as Response;
      }
      if (u.endsWith('/result/markdown')) {
        return { ok: true, status: 200,
                 json: async () => ({ markdown: opts.markdown ?? OCR_MARKDOWN }) } as Response;
      }
      return { ok: true, status: 200,
               json: async () => ({ status: statuses.shift() ?? 'SUCCESS' }) } as Response;
    }) as unknown as typeof fetch;
  }

  it('polls until the job finishes, then returns a grid', async () => {
    const r = await ocrDocument(Buffer.from('fake'), {
      ...key, ...noSleep,
      fetchImpl: mockService({ statuses: ['PENDING', 'PENDING', 'SUCCESS'] }),
    });
    expect(r.provider).toBe('llamaparse');
    expect(r.grid.length).toBeGreaterThan(5);
    expect(r.markdown).toContain('Karur Vysya');
  });

  it('refuses to run without a key, and says why it is opt-in', async () => {
    const saved = process.env.LLAMAPARSE_API_KEY;
    delete process.env.LLAMAPARSE_API_KEY;
    try {
      await expect(ocrDocument(Buffer.from('x'), { fetchImpl: mockService() }))
        .rejects.toThrow(/uploads the document to a third-party service/);
    } finally {
      if (saved !== undefined) process.env.LLAMAPARSE_API_KEY = saved;
    }
  });

  it('never puts the key in an error message', async () => {
    const secret = 'llx-supersecret';
    await expect(ocrDocument(Buffer.from('x'), {
      apiKey: secret, ...noSleep, fetchImpl: mockService({ uploadStatus: 401 }),
    })).rejects.toThrow(/rejected the upload \(HTTP 401\)/);

    await ocrDocument(Buffer.from('x'), {
      apiKey: secret, ...noSleep, fetchImpl: mockService(),
    }).then((r) => {
      expect(JSON.stringify(r)).not.toContain(secret);
    });
  });

  it('surfaces a job failure', async () => {
    await expect(ocrDocument(Buffer.from('x'), {
      ...key, ...noSleep, fetchImpl: mockService({ statuses: ['ERROR'] }),
    })).rejects.toThrow(/OCR failed/);
  });

  it('says the image is too low-resolution when nothing came back', async () => {
    await expect(ocrDocument(Buffer.from('x'), {
      ...key, ...noSleep, fetchImpl: mockService({ markdown: '   ' }),
    })).rejects.toThrow(/too low-resolution/);
  });

  it('recognises the image formats worth sending', () => {
    expect(isImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);          // JPEG
    expect(isImage(Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG')]))).toBe(true);
    expect(isImage(Buffer.from('%PDF-1.4'))).toBe(false);
    expect(isImage(Buffer.from('Date,Narration\n'))).toBe(false);
  });
});
