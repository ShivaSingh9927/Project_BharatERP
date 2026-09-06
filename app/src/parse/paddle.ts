/**
 * PaddleOCR, run locally.
 * Spec: bank-and-reconciliation.md §5.1; measured in DEFECT-LOG Stage 12
 *
 * This is the default OCR path, and the reason is not only that it measured
 * better. On the one image where both engines were scored against the
 * statement's own arithmetic, LlamaParse reconciled 25 of 28 rows and PaddleOCR
 * reconciled 28 of 28. But the decisive property is where the document goes:
 *
 *     PaddleOCR runs on this machine. Nothing leaves it.
 *
 * That removes, in one step, a DPDP Act cross-border transfer, the contract
 * needed to make it lawful, the liability the CA firm carries when a processor
 * leaks, an open question about whether ICAI's confidentiality rules permit
 * cloud processing of client records at all, and a per-page bill. A hosted
 * service had to be justified against all five; a local one does not.
 *
 * ── What it is still not ──────────────────────────────────────────────────
 *
 * Not an import path. Across seven sample statements PaddleOCR misread no
 * digits, but it did misread the Dr/Cr direction marker, an IFSC's zero and a
 * thousands comma — see `ocrGlyphs.ts` — and 96% of rows reconciling is not
 * the same as a statement being safe to post. The output of OCR is a
 * *candidate* that BR-6 then judges, and its value is naming the few cells a
 * person must correct.
 *
 * ── Why a Python subprocess ───────────────────────────────────────────────
 *
 * PaddleOCR is Python-only; there is no usable Node binding. The sidecar in
 * `scripts/paddle_ocr.py` therefore reports positioned text boxes and nothing
 * else — every decision about columns, direction and arithmetic stays in
 * TypeScript where it is tested. The cost is a process boundary and a JSON
 * document; the benefit is that the OCR engine cannot quietly acquire opinions
 * about accounting.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError } from '../domain/types.ts';
import { boxesToCanvas, pagesToCanvas, type OcrBox, type CanvasResult } from './ocrCanvas.ts';

/** Magic-byte sniff, only so a temporary file gets a sensible name. */
function extensionOf(bytes: Buffer): string {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
    if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) {
      return 'tif';
    }
  }
  return 'png';
}

/**
 * Which interpreter to use.
 *
 * `python3` will not normally have PaddleOCR on it — it is a large dependency
 * and belongs in a virtual environment — so this is expected to be set to that
 * environment's interpreter, e.g. `/opt/bharaterp/ocr/bin/python`.
 */
const PYTHON = process.env.PADDLE_PYTHON ?? 'python3';

/** 47–93 s per page was measured on CPU; a long statement needs headroom. */
const TIMEOUT_MS = 10 * 60 * 1000;

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'paddle_ocr.py');

interface SidecarSuccess {
  ok: true;
  provider: 'paddleocr';
  version: { paddle: string; paddleocr: string };
  width: number | null;
  height: number | null;
  elapsed_ms: number;
  mean_confidence: number;
  boxes: OcrBox[];
}

interface SidecarFailure {
  ok: false;
  error: string;
  code: string;
}

interface SidecarSelftest {
  ok: true;
  paddle: string;
  paddleocr: string;
  python: string;
}

export interface PaddleResult {
  provider: 'paddleocr';
  boxes: OcrBox[];
  canvas: CanvasResult;
  meanConfidence: number;
  elapsedMs: number;
  version: string;
  warnings: string[];
}

type SidecarReply = SidecarSuccess | SidecarSelftest | SidecarFailure;

function runSidecar(args: string[]): SidecarReply {
  const r = spawnSync(PYTHON, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new ValidationError(
      `OCR needs a Python interpreter with PaddleOCR installed, and "${PYTHON}" ` +
      'was not found. Set PADDLE_PYTHON to the interpreter of the environment ' +
      'it is installed in.', 'BR-3');
  }

  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    throw new ValidationError(
      `OCR did not finish within ${TIMEOUT_MS / 60_000} minutes. PaddleOCR ` +
      'takes roughly a minute per page on CPU, so a long statement should be ' +
      'run as a background job rather than during an upload.', 'BR-3');
  }

  const stdout = (r.stdout ?? '').trim();

  // The last line, because model loading writes progress to stdout on a first
  // run. The sidecar emits exactly one JSON document and it is emitted last.
  const lastLine = stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();

  if (!lastLine) {
    const stderr = (r.stderr ?? '').toString().trim();
    throw new ValidationError(
      'the OCR sidecar produced no result' +
      (stderr ? ` — ${stderr.split('\n').slice(-3).join(' ')}` : ''), 'BR-3');
  }

  try {
    return JSON.parse(lastLine) as SidecarReply;
  } catch {
    throw new ValidationError(
      'the OCR sidecar returned output that could not be read as JSON', 'BR-3');
  }
}

/**
 * Is a working PaddleOCR available?
 *
 * Used to give a straight answer before an import is attempted, rather than
 * failing halfway through one.
 */
export function paddleAvailable(): { ok: boolean; detail: string } {
  try {
    const r = runSidecar(['--selftest']);
    if (!r.ok) return { ok: false, detail: r.error };
    const v = r as SidecarSelftest;
    return { ok: true, detail: `paddlepaddle ${v.paddle}, paddleocr ${v.paddleocr}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * OCR one page image and render it as fixed-width text.
 *
 * The image is written to a private temporary file because the sidecar takes a
 * path, and it is removed in a `finally` — a statement image must not outlive
 * the call that read it, exactly as with the decrypted spreadsheet and the
 * password-protected PDF.
 */
export function paddleOcrImage(bytes: Buffer, fileName = 'page'): PaddleResult {
  const dir = mkdtempSync(join(tmpdir(), 'bharaterp-ocr-'));
  // The name is sanitised because it reaches a subprocess argument. The
  // extension is cosmetic — both PIL and OpenCV identify the format from the
  // file's magic bytes, not its name — but a wrong one is confusing in a log.
  const safe = fileName.replace(/[^\w.-]/g, '_') || 'page';
  const file = join(dir, safe.includes('.') ? safe : `${safe}.${extensionOf(bytes)}`);

  try {
    writeFileSync(file, bytes, { mode: 0o600 });

    const r = runSidecar([file]);
    if (!r.ok) {
      const failure = r as SidecarFailure;
      if (failure.code === 'not_installed' || failure.code === 'not_usable') {
        throw new ValidationError(
          `OCR is not available: ${failure.error}. Install it with ` +
          '`uv pip install paddlepaddle paddleocr` in a virtual environment ' +
          'and point PADDLE_PYTHON at that interpreter.', 'BR-3');
      }
      throw new ValidationError(failure.error, 'BR-3');
    }

    const success = r as SidecarSuccess;
    const canvas = boxesToCanvas(success.boxes);

    const warnings: string[] = [...canvas.warnings];

    // Confidence is the engine's opinion of its own reading, so it is reported
    // but never relied on. BR-6 is arithmetic about every figure; a confidence
    // score is a guess about one. It earns its place only as a hint about scan
    // quality, which is actionable — a better scan is something a person can
    // actually go and produce.
    if (success.mean_confidence < 0.95) {
      warnings.push(
        `OCR mean confidence was ${(success.mean_confidence * 100).toFixed(1)}%, ` +
        'which is low for a bank statement and usually means the scan is below ' +
        '300 DPI, skewed, or shadowed. A better scan is cheaper than checking ' +
        'every figure by hand.');
    }

    return {
      provider: 'paddleocr',
      boxes: success.boxes,
      canvas,
      meanConfidence: success.mean_confidence,
      elapsedMs: success.elapsed_ms,
      version: `paddleocr ${success.version.paddleocr}/paddle ${success.version.paddle}`,
      warnings,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Scanned PDFs
// ---------------------------------------------------------------------------

/**
 * Rendering resolution for a scanned PDF page.
 *
 * 300 DPI is the floor at which bank-statement digits read reliably, and it is
 * also what the error message tells a user to scan at, so rendering below it
 * would make this the cause of the very failure it reports. Higher costs
 * roughly linearly in OCR time for no measured accuracy gain.
 */
const RASTER_DPI = 300;

/**
 * Render a PDF's pages to PNG with `pdftoppm` (poppler-utils, already required
 * by the text path).
 *
 * This exists because the case that reaches OCR is almost never a bare JPEG —
 * it is a **scanned PDF**, which is what a client actually emails when they
 * photograph or scan a paper statement. Without rasterisation this whole
 * feature would only serve the rarer input.
 *
 * Getting every page matters more here than anywhere else: BR-6 sums the whole
 * document, so a statement OCR'd one page at a time can never pass it. That is
 * defect G-19, and rendering all pages at once is what closes it.
 */
export function rasterizePdf(buffer: Buffer, password?: string): Buffer[] {
  const dir = mkdtempSync(join(tmpdir(), 'bharaterp-raster-'));
  const input = join(dir, 'in.pdf');

  try {
    writeFileSync(input, buffer, { mode: 0o600 });

    const args = ['-png', '-r', String(RASTER_DPI)];
    // ⚠️ Same exposure as `extractPdfText`: `pdftoppm` has no stdin channel for
    // a password, so it appears in the process list for the life of the call.
    // Written to no file, kept in no variable (BR-4) — but real, and recorded
    // as G-18.
    if (password) args.push('-upw', password);
    args.push(input, join(dir, 'page'));

    const r = spawnSync('pdftoppm', args, { encoding: 'utf8', timeout: 10 * 60 * 1000 });

    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ValidationError(
        'reading a scanned PDF needs the `pdftoppm` command to turn its pages ' +
        'into images. Install poppler-utils (`apt install poppler-utils`).',
        'BR-3');
    }

    if (r.status !== 0) {
      const stderr = (r.stderr ?? '').toString();
      if (/password/i.test(stderr)) {
        throw new ValidationError(
          password
            ? 'that password did not open the PDF'
            : 'this PDF is password-protected — supply the password.', 'BR-4');
      }
      throw new ValidationError(
        `the PDF could not be rendered — ${stderr.trim() || `exit code ${r.status}`}`,
        'BR-3');
    }

    // Sorted numerically: `page-10.png` must not sort before `page-2.png`, or
    // the transactions arrive out of order and every running balance disagrees.
    const pages = readdirSync(dir)
      .filter((f) => f.startsWith('page') && f.endsWith('.png'))
      .map((f) => ({ f, n: Number(/(\d+)\.png$/.exec(f)?.[1] ?? '0') }))
      .sort((a, b) => a.n - b.n)
      .map(({ f }) => readFileSync(join(dir, f)));

    if (pages.length === 0) {
      throw new ValidationError('no pages were rendered from this PDF', 'BR-3');
    }

    return pages;
  } finally {
    // Rendered images of a client's statement must not outlive the call.
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface PaddleDocument extends PaddleResult {
  pageCount: number;
}

/**
 * OCR a whole document — a single image, or every page of a scanned PDF.
 *
 * Pages are joined with a form feed so `splitPages` measures each one's columns
 * separately, which real statements need: page 1 and page 2 of one HDFC
 * statement genuinely place their columns differently.
 */
export function paddleOcrDocument(
  bytes: Buffer,
  opts: { password?: string; fileName?: string } = {},
): PaddleDocument {
  const isPdfInput = bytes.length > 5
    && bytes.subarray(0, 5).toString('latin1') === '%PDF-';

  if (!isPdfInput) {
    const single = paddleOcrImage(bytes, opts.fileName);
    return { ...single, pageCount: 1 };
  }

  const images = rasterizePdf(bytes, opts.password);
  const results = images.map((img, i) => paddleOcrImage(img, `page-${i + 1}`));

  const canvas = pagesToCanvas(results.map((r) => r.boxes));
  const confidences = results.map((r) => r.meanConfidence);

  return {
    provider: 'paddleocr',
    boxes: results.flatMap((r) => r.boxes),
    canvas,
    meanConfidence: confidences.reduce((a, b) => a + b, 0) / Math.max(1, confidences.length),
    elapsedMs: results.reduce((n, r) => n + r.elapsedMs, 0),
    version: results[0]?.version ?? 'paddleocr',
    warnings: [
      ...canvas.warnings,
      // Deduplicated: a five-page scan should not repeat the same low-confidence
      // advice five times.
      ...new Set(results.flatMap((r) => r.warnings)),
    ],
    pageCount: images.length,
  };
}
