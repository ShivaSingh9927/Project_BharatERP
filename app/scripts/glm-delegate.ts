#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeGlmTask, loadImageFile, loadTextFile, parseGlmKeyFile, type GlmTaskMode } from '../src/integrations/glmTaskWorker.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultKeyFile = '/home/shiva/Documents/api_keys/zen_ai_api.txt';

function usage(exitCode = 2): never {
  console.error(`Usage: npm run agent:glm -- [--model text|vision] [--file repo/path] [--image repo/path] --task "task description"

Models:
  text   GLM-4.7-Flash
  vision GLM-4.6V-Flash (images supported)

The worker only receives the task and files explicitly selected with --file or --image.
It has no repository tools and cannot apply a patch. Review its output before use.
`);
  process.exit(exitCode);
}

async function main(argv: string[]) {
  let model: GlmTaskMode = 'text';
  let keyFile = process.env.ZAI_API_KEY_FILE ?? defaultKeyFile;
  const textPaths: string[] = [];
  const imagePaths: string[] = [];
  let task = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--model') {
      const value = argv[++i];
      if (value !== 'text' && value !== 'vision') usage();
      model = value;
    } else if (arg === '--file') {
      const value = argv[++i]; if (!value) usage(); textPaths.push(value);
    } else if (arg === '--image') {
      const value = argv[++i]; if (!value) usage(); imagePaths.push(value);
    } else if (arg === '--key-file') {
      const value = argv[++i]; if (!value) usage(); keyFile = value;
    } else if (arg === '--task') {
      task = argv[++i] ?? '';
    } else usage();
  }
  if (!task.trim() || (imagePaths.length && model !== 'vision')) usage();

  // Key bytes are read only into memory and are never printed or included in errors.
  const apiKey = process.env.ZAI_API_KEY?.trim() || parseGlmKeyFile(await readFile(keyFile, 'utf8'));
  const files = await Promise.all(textPaths.map((name) => loadTextFile(repoRoot, name)));
  const images = await Promise.all(imagePaths.map((name) => loadImageFile(repoRoot, name)));
  console.error(`Sending task${files.length + images.length ? ' and selected files' : ''} to Z.ai (${model === 'text' ? 'GLM-4.7-Flash' : 'GLM-4.6V-Flash'}).`);
  console.error('Do not include credentials, protected statement content, or client data unless the firm has approved this external AI use.');
  const result = await completeGlmTask({ model, task, files, images, apiKey });
  process.stdout.write(`${result}\n`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`GLM delegate failed: ${message}`);
  process.exitCode = 1;
});
