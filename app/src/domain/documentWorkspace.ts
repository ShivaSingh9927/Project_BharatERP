/** Durable local originals for the first deployment profile.
 * Callers pass tenant IDs and bytes, never a path supplied by a user or model.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, '../../.data/workspace');

export function workspaceRoot(): string {
  const configured = process.env.DOCUMENT_WORKSPACE_ROOT?.trim();
  if (!configured) return defaultRoot;
  if (!isAbsolute(configured)) throw new Error('DOCUMENT_WORKSPACE_ROOT must be an absolute path');
  return resolve(configured);
}

function originalPath(firmId: string, clientId: string, hash: string): string {
  if (!UUID.test(firmId) || !UUID.test(clientId) || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('invalid document workspace identifier');
  }
  return join(workspaceRoot(), firmId, clientId, 'originals', hash);
}

export function documentUri(firmId: string, clientId: string, hash: string): string {
  originalPath(firmId, clientId, hash); // validates all path components
  return `workspace://${firmId}/${clientId}/originals/${hash}`;
}

export async function storeOriginal(
  firmId: string, clientId: string, bytes: Buffer,
): Promise<{ hash: string; uri: string }> {
  if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) {
    throw new Error('document must be between 1 byte and 5 MB');
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  const target = originalPath(firmId, clientId, hash);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    // Same-content concurrent uploads have identical bytes; replacing that
    // path is safe, and rename ensures readers never see a partial file.
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { hash, uri: documentUri(firmId, clientId, hash) };
}

export async function readOriginal(
  firmId: string, clientId: string, hash: string,
): Promise<Buffer> {
  const path = originalPath(firmId, clientId, hash);
  const info = await stat(path);
  if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error('invalid stored document');
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== hash) {
    throw new Error('stored document failed its integrity check');
  }
  return bytes;
}
