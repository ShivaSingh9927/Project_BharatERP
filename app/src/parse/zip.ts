/**
 * Minimal ZIP reader — enough to open an `.xlsx`.
 * Spec: bank-and-reconciliation.md §5.1
 *
 * Hand-written rather than pulled from a package, for one reason that matters
 * in a financial product: this code opens **files uploaded by users**, so every
 * dependency here is attack surface. An `.xlsx` needs exactly two entries read
 * out of a zip, and Node already ships the only hard part (`zlib`).
 *
 * The caps below are the point of the exercise. A zip stores the uncompressed
 * size in its own header, so a malicious file can claim four gigabytes in a
 * few kilobytes — a "zip bomb". Inflating without a limit turns a 12 KB upload
 * into an out-of-memory crash, so the limits are enforced against the DECLARED
 * size before any inflation happens, and again on the result.
 */

import { inflateRawSync } from 'node:zlib';

/** Per-entry and whole-archive ceilings. A real statement is well under these. */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export class ZipError extends Error {}

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** Find the End of Central Directory record, which is at the tail. */
function findEocd(buf: Buffer): number {
  // The record is 22 bytes plus an optional comment of up to 64 KB.
  const from = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError('not a zip file — no end-of-central-directory record');
}

/**
 * List the archive's entries from its central directory.
 *
 * The central directory is used rather than scanning local headers, because a
 * local header may declare zero sizes and defer them to a trailing data
 * descriptor — which makes sequential scanning silently wrong.
 */
function readCentralDirectory(buf: Buffer): Map<string, CentralEntry> {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const entries = new Map<string, CentralEntry>();
  let declaredTotal = 0;

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new ZipError(`corrupt central directory at entry ${i + 1}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    // Checked BEFORE inflating anything — that is what makes it a defence.
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new ZipError(
        `entry "${name}" declares ${uncompressedSize} bytes, above the ` +
        `${MAX_ENTRY_BYTES}-byte limit`);
    }
    declaredTotal += uncompressedSize;
    if (declaredTotal > MAX_TOTAL_BYTES) {
      throw new ZipError('archive declares more uncompressed data than the limit allows');
    }

    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

export class ZipArchive {
  private readonly entries: Map<string, CentralEntry>;

  constructor(private readonly buf: Buffer) {
    this.entries = readCentralDirectory(buf);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Read one entry, or null when it is absent. */
  read(name: string): Buffer | null {
    const e = this.entries.get(name);
    if (!e) return null;

    const lp = e.localOffset;
    if (this.buf.readUInt32LE(lp) !== SIG_LOCAL) {
      throw new ZipError(`entry "${name}" has no local header`);
    }
    const nameLen = this.buf.readUInt16LE(lp + 26);
    const extraLen = this.buf.readUInt16LE(lp + 28);
    const start = lp + 30 + nameLen + extraLen;
    const data = this.buf.subarray(start, start + e.compressedSize);

    if (e.method === 0) return Buffer.from(data);          // stored
    if (e.method !== 8) {
      throw new ZipError(`entry "${name}" uses unsupported compression method ${e.method}`);
    }

    // maxOutputLength is the second half of the bomb defence: even if the
    // header lied about the uncompressed size, inflation stops at the cap.
    const out = inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
    return Buffer.from(out);
  }

  /** Read an entry as UTF-8 text, throwing when it is missing. */
  text(name: string): string {
    const b = this.read(name);
    if (b === null) throw new ZipError(`entry "${name}" not found in the archive`);
    return b.toString('utf8');
  }
}

/** True when the buffer starts with a local-file-header signature. */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length > 4 && buf.readUInt32LE(0) === SIG_LOCAL;
}

/**
 * True for an OLE compound file — which is what an ENCRYPTED `.xlsx` is.
 *
 * SBI's net-banking export is exactly this: the file is named `.xlsx` but is a
 * `CDFV2 Encrypted` container holding the real spreadsheet. Opening it as a zip
 * fails with "not a zip file", which is a confusing thing to tell someone whose
 * file is merely password-protected.
 */
export function looksLikeEncryptedOffice(buf: Buffer): boolean {
  const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  return buf.length > 8 && buf.subarray(0, 8).equals(OLE_MAGIC);
}
