import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeGlmTask, loadImageFile, loadTextFile, parseGlmKeyFile } from '../src/integrations/glmTaskWorker.ts';

describe('GLM delegated tasks', () => {
  it('parses supported key-file formats without logging the credential', () => {
    expect(parseGlmKeyFile('test-secret')).toBe('test-secret');
    expect(parseGlmKeyFile('export ZAI_API_KEY="test-secret"')).toBe('test-secret');
    expect(parseGlmKeyFile('# comment\nZAI_API_KEY=test-secret')).toBe('test-secret');
    expect(() => parseGlmKeyFile('first\nsecond')).toThrow(/one key/);
  });

  it('sends only selected context using the selected model and safe system rules', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.z.ai/api/paas/v4/chat/completions');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-secret');
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: 'Reviewed.\n```diff\n--- a/file.ts\n+++ b/file.ts\n```' } }] });
    }) as typeof fetch;
    const answer = await completeGlmTask({ model: 'text', task: 'Fix the typo.', files: [{ name: 'file.ts', text: 'const x = 1;' }], apiKey: 'test-secret', fetcher });
    expect(answer).toContain('Reviewed.');
    expect(requestBody?.model).toBe('glm-4.7-flash');
    const messages = requestBody?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain('untrusted evidence');
    expect(messages[0]?.content).toContain('never claim the diff has been applied');
    expect(messages[1]?.content).toContain('const x = 1;');
  });

  it('uses the vision model only for explicitly supplied images', async () => {
    let requestBody: Record<string, unknown> | undefined;
    await completeGlmTask({ model: 'vision', task: 'Describe the screenshot.', images: [{ name: 'screen.png', mimeType: 'image/png', base64: 'aW1hZ2U=' }], apiKey: 'test-secret',
      fetcher: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: 'A screenshot.' } }] });
      }) as typeof fetch,
    });
    expect(requestBody?.model).toBe('glm-4.6v-flash');
    const messages = requestBody?.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[1]?.content[1]?.image_url).toEqual({ url: 'data:image/png;base64,aW1hZ2U=' });
  });

  it('does not leak provider response bodies in errors', async () => {
    await expect(completeGlmTask({ model: 'text', task: 'Small task', apiKey: 'test-secret',
      fetcher: vi.fn(async () => new Response('sensitive provider body', { status: 401 })) as typeof fetch,
    })).rejects.toThrow('HTTP 401');
    await expect(completeGlmTask({ model: 'text', task: 'Small task', apiKey: 'test-secret',
      fetcher: vi.fn(async () => Response.json({ error: { code: '1315', message: 'private provider detail' } }, { status: 429 })) as typeof fetch,
    })).rejects.toThrow(/HTTP 429 \(Z.ai code 1315: this API key is restricted to Coding Plan scenarios/);
    await expect(completeGlmTask({ model: 'text', task: 'Small task', apiKey: 'test-secret',
      fetcher: vi.fn(async () => Response.json({ error: { code: '1305', message: 'prompt contents reflected here' } }, { status: 429 })) as typeof fetch,
    })).rejects.toThrow(/service is temporarily overloaded/);
    await expect(completeGlmTask({ model: 'text', task: 'Small task', images: [{ name: 'x', mimeType: 'image/png', base64: 'eA==' }], apiKey: 'test-secret', fetcher: fetch })).rejects.toThrow(/require the vision/);
  });
});

describe('selected delegate files', () => {
  let root = '';
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; });

  it('loads only repo-relative files and rejects paths outside the root', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'glm-worker-'));
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'example.ts'), 'export const safe = true;');
    await expect(loadTextFile(root, 'src/example.ts')).resolves.toMatchObject({ text: 'export const safe = true;' });
    await expect(loadTextFile(root, '../outside.txt')).rejects.toThrow(/repo-relative|inside the repository/);
    await expect(loadTextFile(root, path.resolve(root, 'src/example.ts'))).rejects.toThrow(/repo-relative/);
  });

  it('loads supported image files with their MIME type', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'glm-worker-image-'));
    await writeFile(path.join(root, 'sample.png'), Buffer.from('png'));
    await expect(loadImageFile(root, 'sample.png')).resolves.toMatchObject({ mimeType: 'image/png', base64: 'cG5n' });
  });
});
