import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { documentUri, readOriginal, storeOriginal } from '../src/domain/documentWorkspace.ts';

const firm = randomUUID();
const client = randomUUID();
let root: string;
let previous: string | undefined;

beforeAll(async () => {
  previous = process.env.DOCUMENT_WORKSPACE_ROOT;
  root = await mkdtemp(join(tmpdir(), 'bharaterp-documents-'));
  process.env.DOCUMENT_WORKSPACE_ROOT = root;
});

afterAll(async () => {
  if (previous === undefined) delete process.env.DOCUMENT_WORKSPACE_ROOT;
  else process.env.DOCUMENT_WORKSPACE_ROOT = previous;
  await rm(root, { recursive: true, force: true });
});

describe('client document workspace', () => {
  it('stores identical bytes at one stable address and reads them by tenant', async () => {
    const bytes = Buffer.from('invoice number INV-1');
    const first = await storeOriginal(firm, client, bytes);
    const second = await storeOriginal(firm, client, bytes);
    expect(second).toEqual(first);
    expect(first.uri).toBe(documentUri(firm, client, first.hash));
    expect(await readOriginal(firm, client, first.hash)).toEqual(bytes);
    await expect(readOriginal(firm, randomUUID(), first.hash)).rejects.toThrow();
  });

  it('rejects path-like tenant IDs and detects altered originals', async () => {
    const saved = await storeOriginal(firm, client, Buffer.from('bank statement'));
    await expect(readOriginal('../outside', client, saved.hash)).rejects.toThrow(
      'invalid document workspace identifier');
    await writeFile(join(root, firm, client, 'originals', saved.hash), 'changed');
    await expect(readOriginal(firm, client, saved.hash)).rejects.toThrow(
      'integrity check');
  });
});
