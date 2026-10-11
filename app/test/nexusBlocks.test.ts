import { describe, expect, it } from 'vitest';
import { renderNexusBlocks, validateNexusBlocks } from '../src/web/nexusBlocks.ts';

const provenance = { as_of: '2026-10-10T10:15:00+05:30', sources: [{ kind: 'bank_transaction', id: 'row-1', label: 'Statement row' }], coverage: { scope: 'Selected account · October', completeness: 'partial', limitations: ['One row is unresolved'] } };
const envelope = { schema_version: 1, generated_at: '2026-10-10T04:45:00Z', blocks: [
  { id: 'p1', type: 'paragraph', text: '<img src=x onerror=alert(1)>' },
  { id: 'm1', type: 'metrics', provenance, items: [{ label: '<script>', value: '2400.00', unit: 'INR', source_refs: ['row-1'] }] },
  { id: 't1', type: 'table', provenance, columns: [{ key: 'amount', label: 'Amount', kind: 'money' }], rows: [{ id: 'r1', cells: { amount: '2400.00' } }] },
  { id: 'c1', type: 'chart', kind: 'line', provenance, accessible_summary: '<b>Trend</b>', series: [{ name: 'Balance', unit: 'INR', points: [{ label: 'Oct 1', value: '120.00' }, { label: 'Oct 2', value: '2400.00' }] }], table_fallback: { columns: [{ key: 'series', label: 'Series', kind: 'text' }, { key: 'label', label: 'Period', kind: 'text' }, { key: 'value', label: 'Value', kind: 'text' }], rows: [{ id: 'a', cells: { series: 'Balance', label: 'Oct 1', value: '120.00' } }, { id: 'b', cells: { series: 'Balance', label: 'Oct 2', value: '2400.00' } }] } },
] };

describe('Nexus read-only response blocks', () => {
  it('renders allowed blocks with escaped content and visible provenance/coverage', () => {
    const html = renderNexusBlocks(envelope);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('As of 2026-10-10T10:15:00+05:30');
    expect(html).toContain('Coverage: partial');
    expect(html).toContain('One row is unresolved');
    expect(html).toContain('Statement row · bank_transaction · row-1');
    expect(html).toContain('<svg role="img"');
    expect(html).toContain('<table>');
  });

  it('links only declared bank transaction sources to the fixed Nexus evidence route', () => {
    const linked = structuredClone(envelope);
    const transactionId = '123e4567-e89b-42d3-a456-426614174000';
    (linked.blocks[1] as unknown as { provenance: { sources: Array<{ kind: string; id: string; label: string }> }; items: Array<{ source_refs: string[] }> }).provenance.sources = [
      { kind: 'bank_transaction', id: transactionId, label: 'Bank line · 2026-10-01' },
    ];
    (linked.blocks[1] as unknown as { items: Array<{ source_refs: string[] }> }).items[0]!.source_refs = [transactionId];
    (linked.blocks[2] as unknown as { provenance: { sources: Array<{ kind: string; id: string; label: string }> }; rows: Array<{ source_refs: string[] }> }).provenance.sources = [
      { kind: 'bank_transaction', id: transactionId, label: 'Bank line · 2026-10-01' },
    ];
    (linked.blocks[2] as unknown as { rows: Array<{ source_refs: string[] }> }).rows[0]!.source_refs = [transactionId];
    const html = renderNexusBlocks(linked);
    expect(html).toContain(`/nexus/source/bank-transaction?id=${transactionId}`);
    expect(html).toContain('Open bank line');

    const unrelated = structuredClone(linked);
    (unrelated.blocks[1] as unknown as { provenance: { sources: Array<{ kind: string }> } }).provenance.sources[0]!.kind = 'other';
    (unrelated.blocks[2] as unknown as { provenance: { sources: Array<{ kind: string }> } }).provenance.sources[0]!.kind = 'other';
    expect(renderNexusBlocks(unrelated)).not.toContain('/nexus/source/bank-transaction');
  });

  it('rejects malformed money, unsupported types, untrusted action fields, and incomplete provenance', () => {
    const malformedMoney = structuredClone(envelope);
    (malformedMoney.blocks[1] as { items: Array<{ value: string }> }).items[0]!.value = '2,400.00';
    expect(() => validateNexusBlocks(malformedMoney)).toThrow(/exact decimal/);
    const unsupported = structuredClone(envelope);
    (unsupported.blocks[0] as { type: string }).type = 'action';
    expect(() => validateNexusBlocks(unsupported)).toThrow(/Unexpected|Unsupported/);
    const actionUrl = structuredClone(envelope);
    (actionUrl.blocks[0] as Record<string, unknown>).href = 'javascript:alert(1)';
    expect(() => validateNexusBlocks(actionUrl)).toThrow(/Unexpected/);
    const noCoverage = structuredClone(envelope);
    (noCoverage.blocks[1] as { provenance: { coverage: { limitations: string[] } } }).provenance.coverage.limitations = [];
    expect(() => validateNexusBlocks(noCoverage)).toThrow(/limitation/);
  });

  it('requires declared sources for factual blocks and resolves metric, row, and point references', () => {
    const noSources = structuredClone(envelope);
    (noSources.blocks[1] as { provenance: { sources: unknown[] } }).provenance.sources = [];
    expect(() => validateNexusBlocks(noSources)).toThrow(/unique sources/);
    const unmatchedMetric = structuredClone(envelope);
    (unmatchedMetric.blocks[1] as { items: Array<{ source_refs: string[] }> }).items[0]!.source_refs = ['missing'];
    expect(() => validateNexusBlocks(unmatchedMetric)).toThrow(/not declared/);
    const unmatchedRow = structuredClone(envelope);
    (unmatchedRow.blocks[2] as unknown as { rows: Array<{ source_refs: string[] }> }).rows[0]!.source_refs = ['missing'];
    expect(() => validateNexusBlocks(unmatchedRow)).toThrow(/not declared/);
    const unmatchedPoint = structuredClone(envelope);
    (unmatchedPoint.blocks[3] as unknown as { series: Array<{ points: Array<{ source_refs: string[] }> }> }).series[0]!.points[0]!.source_refs = ['missing'];
    expect(() => validateNexusBlocks(unmatchedPoint)).toThrow(/not declared/);
  });

  it('rejects a chart table fallback when its point value differs from the plotted data', () => {
    const mismatch = structuredClone(envelope);
    (mismatch.blocks[3] as { table_fallback: { rows: Array<{ cells: { value: string } }> } }).table_fallback.rows[1]!.cells.value = '2401.00';
    expect(() => validateNexusBlocks(mismatch)).toThrow(/does not match plotted series/);
  });
});
