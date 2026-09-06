/**
 * PDF bank statements.
 * Spec: bank-and-reconciliation.md §5.1 (BR-4), §5.2 (BR-5)
 *
 * Two decisions worth stating, because both were made against alternatives.
 *
 * **Text extraction is delegated to `pdftotext -layout`** (poppler-utils).
 * Implementing PDF text extraction means implementing font descriptors,
 * encodings and CMaps — a large, subtle body of work whose failure mode is
 * silently wrong characters. `pdftotext` is standard, packaged everywhere, and
 * already produced usable output from both real statements we have.
 *
 * **Extraction stays local.** A hosted parsing service would do this too, and
 * might reconstruct tables better. But a bank statement carries the account
 * number, the address and every counterparty the client pays, so sending them
 * to a third party is a data-protection decision for the CA firm as data
 * fiduciary — not a library choice to be made on their behalf. Local-first
 * keeps that decision theirs; a hosted fallback can be added as an explicit
 * opt-in for files this defeats.
 *
 * Everything downstream is shared with the spreadsheet and CSV paths, and BR-6
 * verifies the result whichever route produced it. That matters more here than
 * anywhere else: fixed-width parsing has the most ways to go subtly wrong, and
 * the arithmetic check is what makes a wrong parse a refusal rather than a
 * corrupt import.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationError } from '../domain/types.ts';
import type { ColumnMap } from './statementFile.ts';
import type { DateFormat } from './values.ts';
import { parseLayoutText, type ParsedLayoutStatement } from './layout.ts';

export function isPdf(buffer: Buffer): boolean {
  return buffer.length > 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Extract a PDF's text layer, preserving the visual layout.
 *
 * ⚠️ The password is passed as a command-line argument, which is visible in the
 * process list to the same user for the lifetime of the call. `pdftotext` has
 * no stdin channel for it. It is written to no file and kept in no variable
 * beyond this function (BR-4), but the exposure is real and is the reason a
 * caller should never run this as a shared service account.
 */
export function extractPdfText(buffer: Buffer, password?: string): string {
  if (!isPdf(buffer)) {
    throw new ValidationError('this file is not a PDF', 'BR-3');
  }

  const dir = mkdtempSync(join(tmpdir(), 'bharaterp-pdf-'));
  const file = join(dir, 'in.pdf');

  try {
    writeFileSync(file, buffer, { mode: 0o600 });

    const args = ['-layout', '-enc', 'UTF-8'];
    if (password) args.push('-upw', password);
    args.push(file, '-');

    const r = spawnSync('pdftotext', args, {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });

    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ValidationError(
        'PDF support needs the `pdftotext` command, which is not installed. ' +
        'Install poppler-utils (`apt install poppler-utils`), or upload the ' +
        "bank's spreadsheet export instead — it is more reliable anyway.", 'BR-3');
    }

    const stderr = (r.stderr ?? '').toString();

    if (r.status !== 0) {
      if (/incorrect password|password/i.test(stderr)) {
        throw new ValidationError(
          password
            ? 'that password did not open the PDF'
            : 'this PDF is password-protected — supply the password. Indian ' +
              'banks encrypt emailed statements by default, often with a ' +
              'PAN-and-date-of-birth pattern.',
          'BR-4');
      }
      throw new ValidationError(
        `the PDF could not be read — ${stderr.trim() || `exit code ${r.status}`}`,
        'BR-3');
    }

    const text = r.stdout ?? '';
    if (text.trim().length === 0) {
      // A scanned statement has no text layer at all. Saying so is far more
      // useful than reporting an empty parse, and it points at the fix.
      throw new ValidationError(
        'this PDF contains no text — it is almost certainly a scan or a photo. ' +
        'Reading it needs OCR, which must be enabled deliberately per import. ' +
        'Prefer asking for the statement to be downloaded from net banking: ' +
        'OCR reads pixels, so no figure it produces is one the bank published.',
        'BR-3');
    }

    return text;
  } finally {
    // The decrypted copy must not outlive the call.
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ParsedPdfStatement extends ParsedLayoutStatement {
  format: 'pdf';
}

/**
 * Parse a PDF statement's extracted text.
 *
 * The fixed-width work is shared with the OCR path — see `layout.ts`. Both
 * produce columns held apart by runs of spaces, and that problem cost six
 * defects on real HDFC and SBI files, so there is exactly one implementation
 * of it.
 */
export function parsePdfText(
  text: string,
  opts: { bank?: string; dateFormat?: DateFormat } = {},
): ParsedPdfStatement {
  return { ...parseLayoutText(text, { ...opts, source: 'pdf' }), format: 'pdf' };
}

/** Convenience: bytes → parsed statement. */
export function parsePdfStatement(
  buffer: Buffer,
  opts: { bank?: string; dateFormat?: DateFormat; password?: string } = {},
): ParsedPdfStatement {
  return parsePdfText(extractPdfText(buffer, opts.password), opts);
}

export type { ColumnMap };
