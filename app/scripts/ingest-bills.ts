/**
 * Ingest a folder of purchase-bill PDFs end to end.
 *
 * This is the real entry point today. There is no bill-upload screen yet, and
 * writing one would not change any of the decisions below — so the pipeline is
 * driven from here rather than pretending a UI exists.
 *
 *   npx tsx scripts/ingest-bills.ts <firm-id> <client-id> <expense-account-id> <dir> [--post]
 *
 * Without `--post` it only reports what it WOULD do. That is the default on
 * purpose: this writes to an append-only ledger, and a dry run is the last
 * cheap moment to notice a wrong expense account.
 *
 * Environment:
 *   DEEPSEEK_API    a key enables the model paths — subject to the firm's own
 *                   `firm_ai_settings`, which is checked separately
 *   DEEPSEEK_MODEL  defaults to deepseek-chat
 *   APPROVED_BY     required with --post: AT-13 refuses an AI-proposed voucher
 *                   with no named approver, and the database enforces it
 *
 * The bill date is read off each document. A document whose date cannot be
 * settled is blocked, not dated with today.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { proposeBills, postProposal, llmSettings } from '../src/domain/billProposal.ts';
import { llmClientFromEnv } from '../src/parse/llmTable.ts';
import { closePools } from '../src/db/pool.ts';

const [firmId, clientId, expenseAccountId, dir] = process.argv.slice(2);
const post = process.argv.includes('--post');
const approvedBy = process.env.APPROVED_BY;

if (!firmId || !clientId || !expenseAccountId || !dir) {
  console.error(
    'usage: npx tsx scripts/ingest-bills.ts <firm-id> <client-id> ' +
    '<expense-account-id> <dir> [--post]');
  process.exit(1);
}
if (post && !approvedBy) {
  console.error('--post needs APPROVED_BY=<user-id>: an AI-proposed voucher ' +
                'must name the human who authorised it (AT-13).');
  process.exit(1);
}

const llm = llmClientFromEnv() ?? undefined;
const settings = await llmSettings(firmId);

console.log(`model available : ${llm ? `${llm.provider}/${llm.model}` : 'no key set'}`);
console.log(`firm allows it  : extraction=${settings.extraction} cross-check=${settings.crossCheck}`);
console.log(`mode            : ${post ? 'POSTING' : 'dry run'}\n`);

if (llm && !settings.extraction) {
  console.log('note: a key is set but this firm has not switched the model on, ' +
              'so no document will leave the building.\n');
}

let posted = 0, ready = 0, blocked = 0;
const tally = { coordinates: 0, llm: 0 };
const checks = { off: 0, agreed: 0, disagreed: 0, unavailable: 0 };

for (const file of readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort()) {
  console.log(`### ${file}`);
  let proposals;
  try {
    proposals = await proposeBills(firmId, {
      clientId, file: readFileSync(join(dir, file)),
      createdBy: approvedBy ?? '00000000-0000-0000-0000-000000000000',
      expenseAccountId, llm,
    });
  } catch (e) {
    console.log(`  could not read the file: ${(e as Error).message}\n`);
    continue;
  }

  for (const p of proposals) {
    tally[p.readBy]++;
    checks[p.crossChecked]++;
    const label = `[${p.index}] ${p.documentNumber ?? '(no number)'}`;
    const via = p.readBy === 'llm'
      ? ` via ${p.llmProvenance?.model}` : '';
    const check = p.crossChecked === 'off' ? '' : ` cross-check:${p.crossChecked}`;

    if (p.blockers.length > 0) {
      blocked++;
      console.log(`  ${label} BLOCKED${check}`);
      for (const b of p.blockers) console.log(`      - ${b}`);
      continue;
    }

    ready++;
    const s = p.table.sums;
    console.log(`  ${label} ready${via}${check}  ${p.billDate}  taxable=${s.taxable} ` +
                `gst=${[s.cgst, s.sgst, s.igst].filter(Boolean).join('+') || '0'} ` +
                `total=${s.total}`);
    for (const wn of p.warnings) console.log(`      ! ${wn}`);

    if (post) {
      try {
        const bill = await postProposal(firmId, p, { approvedBy: approvedBy! });
        posted++;
        console.log(`      posted ${bill.voucherId} — ITC ${bill.itcEligibility}, ` +
                    `claimable ${bill.itcClaimableValue}`);
      } catch (e) {
        console.log(`      REFUSED BY createBill: ${(e as Error).message}`);
      }
    }
  }
  console.log();
}

console.log('=== summary ===');
console.log(`ready ${ready}, blocked ${blocked}${post ? `, posted ${posted}` : ''}`);
console.log(`read by coordinates ${tally.coordinates}, by model ${tally.llm}`);
if (settings.crossCheck) {
  console.log(`cross-check: agreed ${checks.agreed}, disagreed ${checks.disagreed}, ` +
              `unavailable ${checks.unavailable}`);
  if (checks.disagreed > 0) {
    console.log('\nA disagreement means two readers that each add up got different ' +
                'figures. No arithmetic can settle it — read those documents.');
  }
}
await closePools();
