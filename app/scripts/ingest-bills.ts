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
import { sandboxLookupFromEnv } from '../src/integrations/sandboxGst.ts';
import { doclingClientFromEnv } from '../src/parse/doclingTable.ts';
import { parserClientFromEnv } from '../src/parse/candidateTables.ts';
import { glmOcrClientFromEnv } from '../src/parse/glmOcr.ts';
import { closePools } from '../src/db/pool.ts';
import { paise, money } from '../src/domain/tax.ts';

const [firmId, clientId, expenseAccountId, dir] = process.argv.slice(2);
const post = process.argv.includes('--post');

/*
 * Treat documents with no GSTIN as imports of service, taxed at this rate.
 *
 * Deliberately a flag rather than a default. Supplying it is the filer saying
 * these suppliers are outside India and the tax is owed here — a decision with
 * money attached, which no amount of reading the paper can make.
 *
 *   --rcm-rate=18 --fx=USD:88.20,EUR:96.50
 *
 * The rate is better set on the SUPPLIER — `scripts/set-party-rcm.ts`, or the
 * block on the blocked bill's card — which records who decided it and applies
 * it to every future bill from them. This flag remains for a folder whose
 * suppliers have no rate on file yet, and it never applies to a domestic
 * unregistered supplier: s.9(3) is a standing decision about a party, not a
 * property of an ingest run.
 */
const flag = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const rcmRate = flag('rcm-rate');
const confirmAll = process.argv.includes('--confirm');
const fx = new Map((flag('fx') ?? '').split(',').filter(Boolean)
  .map((p) => p.split(':') as [string, string]));
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
const gstinLookup = sandboxLookupFromEnv() ?? undefined;
const docling = (await doclingClientFromEnv()) ?? undefined;
const parser = (await parserClientFromEnv()) ?? undefined;
const glmOcr = glmOcrClientFromEnv() ?? undefined;
const settings = await llmSettings(firmId);

console.log(`model available : ${llm ? `${llm.provider}/${llm.model}` : 'no key set'}`);
console.log(`firm allows it  : extraction=${settings.extraction} cross-check=${settings.crossCheck}`);
console.log(`GSTIN lookup    : ${gstinLookup ? gstinLookup.source : 'no key set'}`);
console.log(`Docling reader  : ${docling ? 'up' : 'not running'}`);
console.log(`Structure reader: ${parser ? 'up' : 'not running'}`);
console.log(`Layout model    : ${glmOcr ? 'key set' : 'no key set'}`);
console.log(`mode            : ${post ? 'POSTING' : 'dry run'}\n`);

if (llm && !settings.extraction) {
  console.log('note: a key is set but this firm has not switched the model on, ' +
              'so no document will leave the building.\n');
}

let posted = 0, ready = 0, blocked = 0, needsAnswer = 0;
const tally = { coordinates: 0, candidates: 0, summary: 0, charges: 0, docling: 0, llm: 0 };
const checks = { off: 0, not_needed: 0, agreed: 0, disagreed: 0, unavailable: 0 };

// Photographs too: an SMB sends an invoice as a picture more often than as a
// PDF, and the pipeline reads one by OCR through the structure sidecar.
const READABLE = /\.(?:pdf|jpe?g|png|webp|tiff?|bmp)$/i;
for (const file of readdirSync(dir).filter((f) => READABLE.test(f)).sort()) {
  console.log(`### ${file}`);
  let proposals;
  try {
    proposals = await proposeBills(firmId, {
      clientId, file: readFileSync(join(dir, file)),
      createdBy: approvedBy ?? '00000000-0000-0000-0000-000000000000',
      expenseAccountId, llm, gstinLookup, docling, parser, glmOcr,
      sourceUri: `file://${join(dir, file)}`,
      ...(rcmRate === undefined ? {} : { reverseCharge: { rate: rcmRate } }),
    });

    /*
     * A second pass once the currency is known.
     *
     * The exchange rate needed depends on what the document is written in, and
     * that is only known after reading it — so the first pass reports the
     * currency and this one supplies the rate for it. Cheap: everything is
     * already parsed, and only documents actually blocked for want of a rate
     * come back through.
     */
    if (fx.size > 0) {
      const needs = proposals.some((p) =>
        p.blockers.some((b) => /no exchange rate was given/.test(b)));
      if (needs) {
        const cur = [...fx.keys()].find((c) =>
          proposals.some((p) => p.blockers.some((b) => b.includes(`in ${c} `))));
        if (cur !== undefined) {
          /*
           * The rate can now come from the party master, so an exchange rate
           * is supplied on its own — passed as manual entry, which is what a
           * reviewer typing it on the form does. The `--rcm-rate` route is
           * kept for a run where no master rate is on file yet.
           */
          proposals = await proposeBills(firmId, {
            clientId, file: readFileSync(join(dir, file)),
            createdBy: approvedBy ?? '00000000-0000-0000-0000-000000000000',
            expenseAccountId, llm, gstinLookup, docling, parser, glmOcr,
            sourceUri: `file://${join(dir, file)}`,
            ...(rcmRate === undefined
              ? { manual: { fxRate: fx.get(cur)! } }
              : { reverseCharge: { rate: rcmRate, exchangeRate: fx.get(cur)! } }),
          });
        }
      }
    }
  } catch (e) {
    console.log(`  could not read the file: ${(e as Error).message}\n`);
    continue;
  }

  for (const p of proposals) {
    tally[p.readBy]++;
    checks[p.crossChecked]++;
    const label = `[${p.index}] ${p.documentNumber ?? '(no number)'}`;
    const via = p.readBy === 'llm' ? ` via ${p.llmProvenance?.model}`
      : p.readBy === 'docling' ? ' via Docling' : '';
    const check = p.crossChecked === 'off' ? '' : ` cross-check:${p.crossChecked}`;

    if (p.blockers.length > 0) {
      blocked++;
      console.log(`  ${label} BLOCKED${check}`);
      for (const b of p.blockers) console.log(`      - ${b}`);
      // A blocked document's warnings still matter: they are usually what the
      // reviewer needs in order to clear the blocker by hand.
      for (const wn of p.warnings) console.log(`      ! ${wn}`);
      continue;
    }

    /*
     * Read, but with something for a human to settle. Kept separate from
     * `ready` in the counts, because a run that says "20 ready" when three of
     * them are waiting on an answer is telling the user the wrong thing.
     */
    if (p.confirmations.length > 0 && !confirmAll) {
      needsAnswer++;
      console.log(`  ${label} NEEDS YOUR CONFIRMATION${check}  ${p.billDate}`);
      for (const c of p.confirmations) console.log(`      ? ${c.question}`);
      for (const wn of p.warnings) console.log(`      ! ${wn}`);
      console.log('      (re-run with --confirm to accept the readings above)');
      continue;
    }

    ready++;
    const s = p.table.sums;
    /*
     * A reverse-charge bill is reported from its POSTED lines, not its table.
     *
     * The table holds the figures as printed, which on a foreign invoice are
     * dollars or euros — so this line read "taxable=6.00" for a bill posting
     * at 529.20, and the tax read zero because the supplier charged none. Both
     * true of the paper and misleading about the entry, which is the worst
     * combination for a dry run somebody approves from.
     */
    if (p.input?.isReverseCharge) {
      const value = p.input.lines.reduce((a, l) => a + paise(l.unitPrice), 0n);
      console.log(`  ${label} ready${via}${check}  ${p.billDate}  ` +
                  `taxable=${money(value)} (INR) ` +
                  `gst=reverse charge, computed at posting  ` +
                  `printed=${s.total}`);
    } else {
    console.log(`  ${label} ready${via}${check}  ${p.billDate}  taxable=${s.taxable} ` +
                `gst=${[s.cgst, s.sgst, s.igst].filter(Boolean).join('+') || '0'} ` +
                `total=${s.total}`);
    }
    for (const wn of p.warnings) console.log(`      ! ${wn}`);

    if (post) {
      try {
        const bill = await postProposal(firmId, p, {
          approvedBy: approvedBy!, sourceUri: `file://${join(dir, file)}`,
          // --confirm accepts every reading offered. Acceptable for a bulk
          // run over a folder; a real reviewer answers one bill at a time.
          confirm: Object.fromEntries(p.confirmations.map((c) => [c.field, c.chose])),
        });
        posted++;
        console.log(`      posted ${bill.voucherId} — ITC ${bill.itcEligibility}, ` +
                    `claimable ${bill.itcClaimableValue}`);
        // `createBill` has its own warnings — the supplier's tax being taken
        // over ours is one of them, and it was invisible until now.
        for (const wn of bill.warnings) console.log(`      ! ${wn}`);
      } catch (e) {
        console.log(`      REFUSED BY createBill: ${(e as Error).message}`);
      }
    }
  }
  console.log();
}

console.log('=== summary ===');
console.log(`ready ${ready}, needing an answer ${needsAnswer}, ` +
            `blocked ${blocked}${post ? `, posted ${posted}` : ''}`);
console.log(`read by coordinates ${tally.coordinates}, ` +
            `by candidate search ${tally.candidates}, by stated totals ${tally.summary}, ` +
            `by charge block ${tally.charges}, ` +
            `by Docling ${tally.docling}, ` +
            `by model ${tally.llm}`);
if (settings.crossCheck) {
  console.log(`cross-check: agreed ${checks.agreed}, disagreed ${checks.disagreed}, ` +
              `unavailable ${checks.unavailable}`);
  if (checks.disagreed > 0) {
    console.log('\nA disagreement means two readers that each add up got different ' +
                'figures. No arithmetic can settle it — read those documents.');
  }
}
await closePools();
