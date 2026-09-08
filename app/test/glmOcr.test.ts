/**
 * The layout model as a candidate generator — bills-and-expenses.md BE-30.
 *
 * Only the pure halves are tested: turning the service's HTML into a grid, and
 * picking the tables out of its layout. The network call is a thin wrapper
 * around those, and the interesting failures — a ragged row, a spanning
 * caption, an entity inside a figure — are all in the parsing.
 */

import { describe, it, expect } from 'vitest';
import { parseHtmlTable, tablesFromLayout } from '../src/parse/glmOcr.ts';

const TABLE = `<table class="table table-bordered"><thead><tr>
  <th>S.N.</th><th>PART DESCRIPTION</th><th>Qty.</th><th>IGST Amount</th><th>Amount (\`)</th>
</tr></thead><tbody><tr>
  <td>1.</td><td>PIN BLOCK &amp; T/M CASE</td><td>246.00</td><td>93.68</td><td>428.24</td>
</tr></tbody></table>`;

describe('turning the service HTML into a grid', () => {
  it('reads the header and the row', () => {
    const g = parseHtmlTable(TABLE);
    expect(g[0]).toEqual(['S.N.', 'PART DESCRIPTION', 'Qty.', 'IGST Amount', 'Amount (`)']);
    expect(g[1]).toEqual(['1.', 'PIN BLOCK & T/M CASE', '246.00', '93.68', '428.24']);
  });

  it('decodes entities, because one inside a figure stops it parsing', () => {
    const g = parseHtmlTable('<table><tr><td>100 B&#x27;DLES</td><td>&amp;</td></tr></table>');
    expect(g[0]).toEqual(["100 B'DLES", '&']);
  });

  it('treats <br> as a space rather than glueing two values together', () => {
    // A real cell: "996511<br>CGST 0.0 %<br>SGST 0.0 %".
    const g = parseHtmlTable('<table><tr><td>996511<br>CGST 0.0 %</td></tr><tr><td>x</td></tr></table>');
    expect(g[0]?.[0]).toBe('996511 CGST 0.0 %');
  });

  it('expands a spanning caption so the columns beneath still line up', () => {
    const g = parseHtmlTable(
      '<table><tr><th colspan="2">Tax</th><th>Total</th></tr>'
      + '<tr><td>9.00</td><td>9.00</td><td>18.00</td></tr></table>');
    expect(g[0]).toEqual(['Tax', '', 'Total']);
    expect(g[1]).toEqual(['9.00', '9.00', '18.00']);
  });

  it('pads a short row rather than letting a figure shift column', () => {
    /*
     * `gradeTable` reads cells by index. A ragged row would slide a tax amount
     * into the total's place and the arithmetic would then be checked against
     * the wrong figure — which can still tie.
     */
    const g = parseHtmlTable(
      '<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td></tr></table>');
    expect(g[1]).toEqual(['1', '', '']);
  });
});

describe('picking tables out of the layout', () => {
  const body = {
    data_info: { num_pages: 1, pages: [{ width: 2200, height: 1700 }] },
    layout_details: [[
      { label: 'text', content: 'TAX INVOICE', bbox_2d: [1, 2, 3, 4] },
      { label: 'table', content: TABLE, bbox_2d: [48, 243, 2057, 1595],
        width: 2200, height: 1700 },
      { label: 'image', content: 'https://example.test/x.png' },
    ]],
  };

  it('keeps the tables and nothing else', () => {
    const out = tablesFromLayout(body);
    expect(out).toHaveLength(1);
    expect(out[0]?.method).toBe('glm-ocr');
    expect(out[0]?.page).toBe(1);
    expect(out[0]?.pageWidth).toBe(2200);
  });

  it('claims no per-cell boxes, because it is not given any', () => {
    /*
     * The service reports one box per ELEMENT — "this table, this region" —
     * not one per cell. A provenance record pointing at the wrong place is
     * worse than one that admits it has nothing, so no column bands are
     * invented from a reading of this kind.
     */
    expect(tablesFromLayout(body)[0]?.boxes).toBeUndefined();
  });

  it('drops a one-row table, which is a caption', () => {
    expect(tablesFromLayout({
      layout_details: [[{ label: 'table', content: '<table><tr><td>Total</td><td>9</td></tr></table>' }]],
    })).toHaveLength(0);
  });

  it('survives a page returned as a bare object rather than a list', () => {
    const out = tablesFromLayout({ layout_details: [{ label: 'table', content: TABLE }] });
    expect(out).toHaveLength(1);
  });
});
