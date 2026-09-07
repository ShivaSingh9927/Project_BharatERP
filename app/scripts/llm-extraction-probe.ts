/**
 * Measures a model against the documents we already know the answer to.
 *
 * Run this OUTSIDE the sandbox — the development sandbox has no route to
 * api.deepseek.com (EHOSTUNREACH), so the model path has never been exercised
 * against a real API.
 *
 *   DEEPSEEK_API=sk-... npx tsx scripts/llm-extraction-probe.ts ~/Downloads/myinvoice
 *
 * ── What it measures, and why in this order ────────────────────────────────
 *
 * The tempting probe is "does it read the 13 documents we cannot". That is the
 * less useful half. The half that decides whether to trust it is the AGREEMENT
 * check: on the 11 documents the coordinate path already read — each one
 * arithmetically tied and spot-checked against the paper — does the model
 * return the same figures?
 *
 * A disagreement there is worth more than any number of new readings, because
 * on those documents we know which answer is right. A model that differs on a
 * verified reading should not be trusted on an unverified one.
 *
 * Every document is sent to a third party. Run it on your own invoices.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractPdfWords } from '../src/parse/pdfWords.ts';
import { extractPdfText } from '../src/parse/pdf.ts';
import { splitDocuments } from '../src/parse/documentSplit.ts';
import { readInvoiceTableFromWords } from '../src/parse/invoiceTable.ts';
import { readInvoiceTableFromLlm, deepseekClient } from '../src/parse/llmTable.ts';

const dir = process.argv[2];
const key = process.env.DEEPSEEK_API;
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';

if (!dir || !key) {
  console.error('usage: DEEPSEEK_API=sk-... npx tsx scripts/llm-extraction-probe.ts <dir-of-pdfs>');
  process.exit(1);
}

const client = deepseekClient(key, model);
const fig = (t: { sums: Record<string, string | undefined> }) =>
  ['taxable', 'cgst', 'sgst', 'igst', 'total']
    .map((k) => `${k}=${t.sums[k] ?? '-'}`).join(' ');

let agree = 0, disagree = 0, newlyRead = 0, stillUnread = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort()) {
  const buf = readFileSync(join(dir, file));
  let pages, segments;
  try {
    pages = extractPdfWords(buf);
    segments = splitDocuments(extractPdfText(buf));
  } catch (e) {
    console.log(`### ${file}\n  extraction failed: ${(e as Error).message}`);
    continue;
  }

  console.log(`\n### ${file}`);
  for (const seg of segments) {
    const coords = readInvoiceTableFromWords(
      pages.filter((p) => seg.pages.includes(p.number)));
    const llm = await readInvoiceTableFromLlm(seg.text, client);

    if (coords.readable) {
      // The check that matters: does it match an answer we already trust?
      if (!llm.table.readable) {
        console.log(`  [${seg.index}] UNCONFIRMED  coords: ${fig(coords)}`);
        console.log(`               model refused: ${llm.table.reason}`);
        disagree++;
      } else if (fig(coords) === fig(llm.table)) {
        console.log(`  [${seg.index}] AGREE        ${fig(coords)}`);
        agree++;
      } else {
        console.log(`  [${seg.index}] DISAGREE`);
        console.log(`               coords: ${fig(coords)}`);
        console.log(`               model : ${fig(llm.table)}`);
        disagree++;
      }
    } else if (llm.table.readable) {
      console.log(`  [${seg.index}] NEW          ${fig(llm.table)}`);
      console.log(`               coords had refused: ${coords.reason?.slice(0, 90)}`);
      newlyRead++;
    } else {
      console.log(`  [${seg.index}] both refused`);
      stillUnread++;
    }
  }
}

console.log(`\n=== ${model} ===`);
console.log(`agrees with a verified reading : ${agree}`);
console.log(`differs from one              : ${disagree}   <- read these before trusting anything`);
console.log(`newly readable                : ${newlyRead}`);
console.log(`still unread                  : ${stillUnread}`);
if (disagree > 0) {
  console.log('\nA model that differs on a document we can already verify should ' +
              'not be trusted on one we cannot. Check each DISAGREE against the paper.');
}
