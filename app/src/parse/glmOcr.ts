/**
 * GLM-OCR as a candidate generator: a layout model that returns real tables.
 * Spec: bills-and-expenses.md BE-30
 *
 * Every other reader here works from something the PDF already contains —
 * glyph positions, ruling lines, a text layer. A photograph has none of those,
 * and the OCR fallback that replaces them loses the one thing a table needs:
 * a two-line header survives OCR as two unrelated rows, and no amount of
 * re-bucketing puts it back together.
 *
 * This reads the page as a layout and returns tables as HTML. Measured on the
 * corpus, from a JPEG of an invoice the coordinate reader cannot touch:
 *
 *     S.N. | PART NO. | … | HSN | Qty. | Unit | Price | … | IGST Amount | Amount
 *     1.   | 04211M13149 | … | 87089900 | 246.00 | NOS | 1.36 | … | 93.68 | 428.24
 *
 * — the split header correctly reassembled, every figure right, in four
 * seconds. It also read an invoice number that a vision model dropped a digit
 * from on the same image.
 *
 * ── It decides nothing ─────────────────────────────────────────────────────
 *
 * Like every reader here it produces CANDIDATES. Its tables face the same two
 * gates, and if it and the ruling-line reader both tie with different figures
 * the document is refused rather than one being preferred. A layout model is
 * exactly the kind of reader that can be fluently wrong.
 *
 * ── Two costs a reviewer should know about ─────────────────────────────────
 *
 * The document LEAVES THE BUILDING. That is the same consent question the
 * language model path answers, and it is answered the same way: per firm, in
 * `firm_ai_settings`, defaulting to off. A key being present is capability,
 * never permission.
 *
 * And the bounding boxes are per ELEMENT, not per cell — "this table, this
 * region", not "this figure, this band". So no `columnSources` are claimed
 * from a reading of this kind: a provenance record that points at the wrong
 * place is worse than one that admits it has nothing (PR-3).
 */

import type { CandidateTable } from './candidateTables.ts';

/** One page's dimensions, as the service reports them. */
interface PageInfo { width: number; height: number }

interface LayoutElement {
  label?: string;
  content?: string;
  bbox_2d?: number[];
  width?: number;
  height?: number;
}

interface LayoutResponse {
  layout_details?: Array<LayoutElement[] | LayoutElement>;
  data_info?: { num_pages?: number; pages?: PageInfo[] };
  usage?: { total_tokens?: number };
}

export interface GlmOcrClient {
  read(file: Buffer): Promise<CandidateTable[]>;
}

/**
 * HTML entities the service emits. Decoded rather than left in place because
 * "&amp;" in a description is noise, and "&#x27;" inside a figure would stop
 * it parsing as an amount.
 */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const n = body[1]?.toLowerCase() === 'x'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** A cell's text: inner tags dropped, `<br>` treated as a space. */
function cellText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turns one `<table>` into a rectangular grid.
 *
 * `colspan` is expanded into empty cells so the columns beneath a spanning
 * caption still line up; `rowspan` is ignored, which leaves a hole rather than
 * a wrong value, and a grid with holes simply fails to tie. Short rows are
 * padded so every row has the width of the widest — `gradeTable` reads cells
 * by index, and a ragged row would silently shift a figure into the wrong
 * column.
 */
export function parseHtmlTable(html: string): string[][] {
  const rows: string[][] = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const c of m[1]!.matchAll(/<t([hd])([^>]*)>([\s\S]*?)<\/t\1>/gi)) {
      const span = /colspan\s*=\s*"?(\d+)"?/i.exec(c[2] ?? '');
      cells.push(cellText(c[3] ?? ''));
      const n = span ? Number(span[1]) : 1;
      for (let i = 1; i < n && i < 30; i++) cells.push('');
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return rows;
  const width = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => (r.length === width ? r
    : [...r, ...Array<string>(width - r.length).fill('')]));
}

/** Every table the layout model saw, as candidates for the gates to judge. */
export function tablesFromLayout(body: LayoutResponse): CandidateTable[] {
  const out: CandidateTable[] = [];
  const pages = body.data_info?.pages ?? [];
  (body.layout_details ?? []).forEach((page, i) => {
    const elements = Array.isArray(page) ? page : [page];
    for (const el of elements) {
      if (el?.label !== 'table' || typeof el.content !== 'string') continue;
      const cells = parseHtmlTable(el.content);
      // One row is a caption; one column is a list. Neither is a table.
      if (cells.length < 2 || (cells[0]?.length ?? 0) < 2) continue;
      out.push({
        page: i + 1,
        method: 'glm-ocr',
        cells,
        pageWidth: el.width ?? pages[i]?.width,
        pageHeight: el.height ?? pages[i]?.height,
      });
    }
  });
  return out;
}

const DEFAULT_URL = 'https://api.z.ai/api/paas/v4';

export function glmOcrHttpClient(apiKey: string, baseUrl = DEFAULT_URL): GlmOcrClient {
  return {
    async read(file) {
      const isPdf = file.subarray(0, 5).toString('latin1') === '%PDF-';
      const mime = isPdf ? 'application/pdf' : 'image/jpeg';
      const r = await fetch(`${baseUrl}/layout_parsing`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'glm-ocr',
          file: `data:${mime};base64,${file.toString('base64')}`,
        }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!r.ok) {
        // The body can echo the key back on some gateways, so only the status
        // travels. A balance failure arrives as 429 and reads, unhelpfully,
        // like rate limiting — worth knowing when one turns up in a log.
        throw new Error(
          `HTTP ${r.status} from the layout reader` +
          (r.status === 429 ? ' (rate limit, or the account is out of credit)' : ''));
      }
      return tablesFromLayout(await r.json() as LayoutResponse);
    },
  };
}

/**
 * A client only when a key is set. Capability, not permission — whether a
 * document may actually be sent is `firm_ai_settings`, checked separately by
 * the caller, and defaulting to off.
 */
export function glmOcrClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GlmOcrClient | null {
  const key = env.ZAI_API_KEY;
  if (!key) return null;
  return glmOcrHttpClient(key, env.ZAI_BASE_URL ?? DEFAULT_URL);
}
