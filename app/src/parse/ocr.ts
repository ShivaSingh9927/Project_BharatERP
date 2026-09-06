/**
 * OCR for scanned statements and photographs.
 * Spec: bank-and-reconciliation.md §5.1 — the "PDF (scanned)" row
 *
 * ⚠️ THIS SENDS THE DOCUMENT TO A THIRD PARTY. It is therefore **opt-in twice**:
 * a key must be configured AND the caller must pass `ocr: true`. It is never
 * reached when a PDF has a text layer, and never used as a silent fallback.
 *
 * The reason for that strictness is not fussiness. A bank statement carries the
 * account number, the address and every counterparty a client pays. Uploading
 * one to a hosted service is a decision for the CA firm as data fiduciary under
 * the DPDP Act, and it has to be theirs to make, per client, knowingly.
 *
 * ── What OCR is actually for here ──────────────────────────────────────────
 *
 * Measured against a published sample statement at roughly 90 DPI, LlamaParse
 * returned a clean markdown table and read 27 of 29 balances correctly: **two
 * digit errors in one page**. Every debit and credit was right.
 *
 * Two wrong figures in thirty rows is not good enough to import, and no
 * confidence score would have told us which two. But the row-level balance
 * check does, exactly:
 *
 *     row 16: 2082.49 + 105.00 → expected 2187.49, stated 1877.49
 *     row 17: 1877.49 − 1000.00 → expected  877.49, stated 1887.49
 *
 * Three consecutive failures bracketing two bad cells — because each balance is
 * checked against the row before and the row after. So the useful output of OCR
 * is not "here is your statement", it is **"here are the two cells to fix"**.
 * That turns retyping a page into correcting two numbers, and it is only
 * possible because the statement carries its own arithmetic.
 *
 * This is the same principle as BR-6, applied per row instead of per document.
 */

import { readFileSync } from 'node:fs';
import { ValidationError } from '../domain/types.ts';
import { markdownToGrid } from './markdown.ts';

const LLAMA_BASE = 'https://api.cloud.llamaindex.ai/api/v1/parsing';

/** How long to wait for a job before giving up. Statements are small. */
const POLL_INTERVAL_MS = 3_000;
const MAX_WAIT_MS = 180_000;

export type OcrProvider = 'llamaparse';

export interface OcrOptions {
  provider?: OcrProvider;
  /** Overrides the environment. Never logged, never stored. */
  apiKey?: string;
  /** Passed to the service; a statement is a table, so tables are what we want. */
  fileName?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface OcrResult {
  provider: OcrProvider;
  markdown: string;
  /** The markdown flattened into the same grid shape every other reader produces. */
  grid: string[][];
  /** Wall-clock, useful when judging whether this is viable at scale. */
  elapsedMs: number;
}

function resolveKey(opts: OcrOptions): string {
  const key = opts.apiKey
    ?? process.env.LLAMAPARSE_API_KEY
    ?? process.env.LLAMA_CLOUD_API_KEY;

  if (!key) {
    throw new ValidationError(
      'OCR is not configured. Set LLAMAPARSE_API_KEY to enable it — and note ' +
      'that it uploads the document to a third-party service, which is a ' +
      'data-protection decision for the firm, not a default.', 'BR-3');
  }
  return key;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send a document for OCR and return its markdown.
 *
 * Deliberately returns markdown rather than a parsed statement: the layout
 * intelligence already exists and is shared, so OCR's only job is to turn
 * pixels into a grid.
 */
export async function ocrDocument(
  bytes: Buffer, opts: OcrOptions = {},
): Promise<OcrResult> {
  const provider = opts.provider ?? 'llamaparse';
  if (provider !== 'llamaparse') {
    throw new ValidationError(`unknown OCR provider "${provider}"`, 'BR-3');
  }

  const key = resolveKey(opts);
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const started = Date.now();

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), opts.fileName ?? 'statement');

  const upload = await doFetch(`${LLAMA_BASE}/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    body: form,
  });

  if (!upload.ok) {
    // The key must never reach a log or an error message.
    throw new ValidationError(
      `the OCR service rejected the upload (HTTP ${upload.status})`, 'BR-3');
  }

  const { id } = (await upload.json()) as { id?: string };
  if (!id) throw new ValidationError('the OCR service returned no job id', 'BR-3');

  // --- poll ---------------------------------------------------------------
  let status = 'PENDING';
  while (Date.now() - started < MAX_WAIT_MS) {
    const r = await doFetch(`${LLAMA_BASE}/job/${id}`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    });
    const body = (await r.json()) as { status?: string; error_message?: string };
    status = body.status ?? 'UNKNOWN';

    if (status === 'SUCCESS') break;
    if (status === 'ERROR' || status === 'FAILED') {
      throw new ValidationError(
        `OCR failed — ${body.error_message ?? 'no reason given'}`, 'BR-3');
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (status !== 'SUCCESS') {
    throw new ValidationError(
      `OCR did not finish within ${MAX_WAIT_MS / 1000}s`, 'BR-3');
  }

  const result = await doFetch(`${LLAMA_BASE}/job/${id}/result/markdown`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
  });
  const { markdown } = (await result.json()) as { markdown?: string };

  if (!markdown || markdown.trim().length === 0) {
    throw new ValidationError(
      'OCR returned no text. The image is probably too low-resolution to read; ' +
      'a scan of 300 DPI or better is needed.', 'BR-3');
  }

  return {
    provider, markdown,
    grid: markdownToGrid(markdown),
    elapsedMs: Date.now() - started,
  };
}

/** Convenience for scripts and probes. */
export async function ocrFile(path: string, opts: OcrOptions = {}): Promise<OcrResult> {
  return ocrDocument(readFileSync(path), { fileName: path.split('/').pop(), ...opts });
}

/** True for the image types worth sending to OCR. */
export function isImage(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const b = buffer;
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG';
  const tiff = (b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d);
  return jpeg || png || tiff;
}
