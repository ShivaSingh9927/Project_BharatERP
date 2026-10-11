/** Strict, read-only server renderer for the first Nexus response block types. */

export type Source = { kind: string; id: string; label: string };
export type Coverage = { scope: string; completeness: 'complete' | 'partial' | 'unknown'; limitations: string[] };
export type Provenance = { as_of: string; sources: Source[]; coverage: Coverage };
type Base = { id: string; title?: string; provenance?: Provenance };
export type ParagraphBlock = Base & { type: 'paragraph'; text: string };
export type MetricBlock = Base & { type: 'metrics'; items: Array<{ label: string; value: string; unit: string; period?: string; source_refs: string[] }> } & { provenance: Provenance };
export type TableBlock = Base & { type: 'table'; columns: Array<{ key: string; label: string; kind: 'text' | 'money' | 'date' }>; rows: Array<{ id: string; cells: Record<string, string>; source_refs?: string[] }> } & { provenance: Provenance };
export type ChartBlock = Base & { type: 'chart'; kind: 'line' | 'bar'; series: Array<{ name: string; unit: string; points: Array<{ label: string; value: string; source_refs?: string[] }> }>; accessible_summary: string; table_fallback: { columns: Array<{ key: string; label: string; kind: 'text' | 'money' | 'date' }>; rows: Array<{ id: string; cells: Record<string, string>; source_refs?: string[] }> } } & { provenance: Provenance };
export type NexusBlock = ParagraphBlock | MetricBlock | TableBlock | ChartBlock;
export type NexusBlockEnvelope = { schema_version: 1; generated_at: string; blocks: NexusBlock[] };

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const text = (v: unknown, name: string): string => {
  if (!str(v) || v.length > 4000) throw new Error(`Invalid ${name}`);
  return v;
};
const keys = (v: Record<string, unknown>, allowed: string[], required: string[] = allowed): void => {
  if (Object.keys(v).some((k) => !allowed.includes(k)) || required.some((k) => !(k in v))) throw new Error('Unexpected or missing field');
};
const iso = (v: unknown): v is string => str(v) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
// Decimal strings only. Preserve the supplied spelling; never convert money to Number.
const decimal = (v: unknown): v is string => str(v) && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v) && v.length <= 80;
const listOfStrings = (v: unknown, name: string): string[] => {
  if (!Array.isArray(v) || v.length > 200 || !v.every(str)) throw new Error(`Invalid ${name}`);
  return v as string[];
};
function provenance(v: unknown): Provenance {
  if (!obj(v)) throw new Error('Missing provenance');
  keys(v, ['as_of', 'sources', 'coverage']);
  if (!iso(v.as_of) || !Array.isArray(v.sources) || !obj(v.coverage)) throw new Error('Invalid provenance');
  const sources = v.sources.map((s): Source => {
    if (!obj(s)) throw new Error('Invalid source'); keys(s, ['kind', 'id', 'label']);
    return { kind: text(s.kind, 'source kind'), id: text(s.id, 'source id'), label: text(s.label, 'source label') };
  });
  if (sources.length === 0 || sources.length > 30 || new Set(sources.map((s) => s.id)).size !== sources.length) throw new Error('Factual provenance needs unique sources');
  const c = v.coverage;
  keys(c, ['scope', 'completeness', 'limitations']);
  if (!['complete', 'partial', 'unknown'].includes(String(c.completeness))) throw new Error('Invalid completeness');
  const limitations = listOfStrings(c.limitations, 'limitations');
  if (c.completeness !== 'complete' && limitations.length === 0) throw new Error('Incomplete coverage needs a limitation');
  return { as_of: v.as_of, sources, coverage: { scope: text(c.scope, 'scope'), completeness: c.completeness as Coverage['completeness'], limitations } };
}
function tableData(v: unknown): TableBlock['rows'] extends infer _ ? { columns: TableBlock['columns']; rows: TableBlock['rows'] } : never {
  if (!obj(v)) throw new Error('Invalid table'); keys(v, ['columns', 'rows']);
  if (!Array.isArray(v.columns) || v.columns.length < 1 || v.columns.length > 20 || !Array.isArray(v.rows) || v.rows.length > 500) throw new Error('Invalid table size');
  const columns = v.columns.map((c) => {
    if (!obj(c)) throw new Error('Invalid column'); keys(c, ['key', 'label', 'kind']);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(String(c.key)) || !['text', 'money', 'date'].includes(String(c.kind))) throw new Error('Invalid column');
    return { key: c.key as string, label: text(c.label, 'column label'), kind: c.kind as 'text' | 'money' | 'date' };
  });
  if (new Set(columns.map((c) => c.key)).size !== columns.length) throw new Error('Duplicate table column');
  const rows = v.rows.map((r) => {
    if (!obj(r)) throw new Error('Invalid row'); keys(r, ['id', 'cells', 'source_refs'], ['id', 'cells']);
    if (!obj(r.cells) || Object.keys(r.cells).length !== columns.length) throw new Error('Invalid cells');
    const cells: Record<string, string> = {};
    for (const c of columns) {
      if (!(c.key in r.cells)) throw new Error('Missing cell');
      const value = text(r.cells[c.key], 'cell');
      if (c.kind === 'money' && !decimal(value)) throw new Error('Money cell must be an exact decimal string');
      cells[c.key] = value;
    }
    return { id: text(r.id, 'row id'), cells, ...(r.source_refs === undefined ? {} : { source_refs: listOfStrings(r.source_refs, 'source refs') }) };
  });
  return { columns, rows };
}
function validateRefs(refs: string[] | undefined, p: Provenance, required = false): void {
  if (required && (!refs || refs.length === 0)) throw new Error('Factual item needs source references');
  const ids = new Set(p.sources.map((s) => s.id));
  if (refs?.some((ref) => !ids.has(ref))) throw new Error('Source reference is not declared in provenance');
}
export function validateNexusBlocks(input: unknown): NexusBlockEnvelope {
  if (!obj(input)) throw new Error('Invalid response envelope'); keys(input, ['schema_version', 'generated_at', 'blocks']);
  if (input.schema_version !== 1 || !iso(input.generated_at) || !Array.isArray(input.blocks) || input.blocks.length > 100) throw new Error('Invalid response envelope');
  const blocks = input.blocks.map((raw): NexusBlock => {
    if (!obj(raw) || !str(raw.type)) throw new Error('Invalid block');
    const common = ['id', 'type', 'title', 'provenance'];
    const base = { id: text(raw.id, 'block id'), ...(raw.title === undefined ? {} : { title: text(raw.title, 'title') }) };
    if (raw.type === 'paragraph') {
      keys(raw, [...common, 'text'], ['id', 'type', 'text']);
      return { ...base, type: 'paragraph', text: text(raw.text, 'paragraph'), ...(raw.provenance === undefined ? {} : { provenance: provenance(raw.provenance) }) };
    }
    if (raw.type === 'metrics') {
      keys(raw, [...common, 'items'], ['id', 'type', 'provenance', 'items']);
      if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 20) throw new Error('Invalid metrics');
      const prov = provenance(raw.provenance);
      const items = raw.items.map((item) => {
        if (!obj(item)) throw new Error('Invalid metric'); keys(item, ['label', 'value', 'unit', 'period', 'source_refs'], ['label', 'value', 'unit', 'source_refs']);
        if (!decimal(item.value)) throw new Error('Metric must use an exact decimal string');
        const source_refs = listOfStrings(item.source_refs, 'source refs');
        validateRefs(source_refs, prov, true);
        return { label: text(item.label, 'metric label'), value: item.value, unit: text(item.unit, 'unit'), ...(item.period === undefined ? {} : { period: text(item.period, 'period') }), source_refs };
      });
      return { ...base, type: 'metrics', items, provenance: prov };
    }
    if (raw.type === 'table') {
      keys(raw, [...common, 'columns', 'rows'], ['id', 'type', 'provenance', 'columns', 'rows']);
      const prov = provenance(raw.provenance);
      const table = tableData({ columns: raw.columns, rows: raw.rows });
      for (const row of table.rows) validateRefs(row.source_refs, prov);
      return { ...base, type: 'table', ...table, provenance: prov };
    }
    if (raw.type === 'chart') {
      keys(raw, [...common, 'kind', 'series', 'accessible_summary', 'table_fallback'], ['id', 'type', 'provenance', 'kind', 'series', 'accessible_summary', 'table_fallback']);
      if (!['line', 'bar'].includes(String(raw.kind)) || !Array.isArray(raw.series) || !raw.series.length || raw.series.length > 10 || !obj(raw.table_fallback)) throw new Error('Invalid chart');
      const prov = provenance(raw.provenance);
      const series = raw.series.map((s) => {
        if (!obj(s)) throw new Error('Invalid chart series'); keys(s, ['name', 'unit', 'points']);
        if (!Array.isArray(s.points) || s.points.length > 100) throw new Error('Invalid chart points');
        const points = s.points.map((p) => {
          if (!obj(p)) throw new Error('Invalid chart point'); keys(p, ['label', 'value', 'source_refs'], ['label', 'value']);
          if (!decimal(p.value)) throw new Error('Chart values must be exact decimal strings');
          const source_refs = p.source_refs === undefined ? undefined : listOfStrings(p.source_refs, 'source refs');
          validateRefs(source_refs, prov);
          return { label: text(p.label, 'point label'), value: p.value, ...(source_refs === undefined ? {} : { source_refs }) };
        });
        return { name: text(s.name, 'series name'), unit: text(s.unit, 'unit'), points };
      });
      const fallback = tableData(raw.table_fallback);
      const expectedRows = series.flatMap((s) => s.points.map((point) => ({ series: s.name, label: point.label, value: point.value })));
      if (fallback.columns.length !== 3 || fallback.columns[0]?.key !== 'series' || fallback.columns[0]?.kind !== 'text' || fallback.columns[1]?.key !== 'label' || fallback.columns[1]?.kind !== 'text' || fallback.columns[2]?.key !== 'value' || fallback.columns[2]?.kind !== 'text' || fallback.rows.length !== expectedRows.length) throw new Error('Chart fallback must use series, label, and value columns for every point');
      fallback.rows.forEach((row, i) => {
        const expected = expectedRows[i]!;
        if (row.cells.series !== expected.series || row.cells.label !== expected.label || row.cells.value !== expected.value) throw new Error('Chart fallback does not match plotted series');
        validateRefs(row.source_refs, prov);
      });
      return { ...base, type: 'chart', kind: raw.kind as 'line' | 'bar', series, accessible_summary: text(raw.accessible_summary, 'chart summary'), table_fallback: fallback, provenance: prov };
    }
    throw new Error('Unsupported block type');
  });
  const ids = blocks.map((b) => b.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate block id');
  return { schema_version: 1, generated_at: input.generated_at, blocks };
}
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// Links are fixed internal routes and only emitted for UUID bank-line sources.
// The destination performs its own firm/client ownership check on every read.
const sourceLink = (kind: string, id: string, label: string): string =>
  kind === 'bank_transaction' && /^[0-9a-f-]{36}$/i.test(id)
    ? `<a href="/nexus/source/bank-transaction?id=${encodeURIComponent(id)}">${esc(label)}</a>`
    : esc(label);
const meta = (p: Provenance): string => `<aside class="nexus-provenance"><span>As of ${esc(p.as_of)}</span><span>Coverage: ${esc(p.coverage.completeness)} · ${esc(p.coverage.scope)}</span>${p.coverage.limitations.length ? `<ul>${p.coverage.limitations.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}<ul>${p.sources.map((s) => `<li>${sourceLink(s.kind, s.id, s.label)} · ${esc(s.kind)} · ${esc(s.id)}</li>`).join('')}</ul></aside>`;
function renderTable(columns: TableBlock['columns'], rows: TableBlock['rows'], caption: string, p: Provenance): string {
  const sourceKinds = new Map(p.sources.map((source) => [source.id, source.kind]));
  const linkable = (id: string) => sourceKinds.get(id) === 'bank_transaction' && /^[0-9a-f-]{36}$/i.test(id);
  const withSources = rows.some((row) => row.source_refs?.some(linkable));
  return `<table><caption>${esc(caption)}</caption><thead><tr>${columns.map((c) => `<th scope="col">${esc(c.label)}</th>`).join('')}${withSources ? '<th scope="col">Source</th>' : ''}</tr></thead><tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td>${esc(r.cells[c.key]!)}</td>`).join('')}${withSources ? `<td>${(r.source_refs ?? []).filter(linkable).map((id) => `<a href="/nexus/source/bank-transaction?id=${encodeURIComponent(id)}">Open bank line</a>`).join(' · ')}</td>` : ''}</tr>`).join('')}</tbody></table>`;
}
function chartSvg(block: ChartBlock): string {
  const all = block.series.flatMap((s) => s.points.map((p) => p.value));
  const scale = Math.max(0, ...all.map((v) => v.split('.')[1]?.length ?? 0));
  const values = block.series.map((s) => s.points.map((p) => { const [w, f = ''] = p.value.split('.'); return BigInt(`${w}${f.padEnd(scale, '0')}`); }));
  const abs = values.flat().map((v) => v < 0n ? -v : v); const max = abs.reduce((a, b) => a > b ? a : b, 1n);
  const x = (i: number, n: number) => n < 2 ? 300 : 30 + Math.round(i * 540 / (n - 1));
  const y = (v: bigint) => 65 - Number((v * 55n) / max);
  if (block.kind === 'bar') return `<svg role="img" aria-label="${esc(block.accessible_summary)}" viewBox="0 0 600 130">${values.flatMap((vs, si) => vs.map((v, i) => { const yy = y(v); return `<rect x="${x(i, vs.length) - 8 + si * 4}" y="${Math.min(65, yy)}" width="12" height="${Math.max(1, Math.abs(65 - yy))}" fill="currentColor"><title>${esc(block.series[si]!.points[i]!.label)}: ${esc(block.series[si]!.points[i]!.value)} ${esc(block.series[si]!.unit)}</title></rect>`; })).join('')}</svg>`;
  return `<svg role="img" aria-label="${esc(block.accessible_summary)}" viewBox="0 0 600 130">${values.map((vs, si) => `<polyline fill="none" stroke="currentColor" stroke-width="2" points="${vs.map((v, i) => `${x(i, vs.length)},${y(v)}`).join(' ')}"><title>${esc(block.series[si]!.name)}</title></polyline>`).join('')}</svg>`;
}
export function renderNexusBlocks(input: unknown): string {
  const envelope = validateNexusBlocks(input);
  return envelope.blocks.map((b) => {
    const heading = b.title ? `<h3>${esc(b.title)}</h3>` : '';
    if (b.type === 'paragraph') return `<section class="nexus-block" data-block-id="${esc(b.id)}">${heading}<p>${esc(b.text)}</p>${b.provenance ? meta(b.provenance) : ''}</section>`;
    if (b.type === 'metrics') return `<section class="nexus-block" data-block-id="${esc(b.id)}">${heading}<dl>${b.items.map((m) => `<div><dt>${esc(m.label)}</dt><dd>${esc(m.value)} ${esc(m.unit)}${m.period ? ` · ${esc(m.period)}` : ''}</dd></div>`).join('')}</dl>${meta(b.provenance)}</section>`;
    if (b.type === 'table') return `<section class="nexus-block" data-block-id="${esc(b.id)}">${heading}${renderTable(b.columns, b.rows, b.title ?? 'Data', b.provenance)}${meta(b.provenance)}</section>`;
    return `<section class="nexus-block" data-block-id="${esc(b.id)}">${heading}<figure>${chartSvg(b)}<figcaption>${esc(b.accessible_summary)}</figcaption></figure><details open><summary>Chart data table</summary>${renderTable(b.table_fallback.columns, b.table_fallback.rows, b.title ?? 'Chart data', b.provenance)}</details>${meta(b.provenance)}</section>`;
  }).join('\n');
}
