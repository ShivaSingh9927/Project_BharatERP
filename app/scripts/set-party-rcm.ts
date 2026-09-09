/**
 * Set a supplier's standing reverse-charge rate.
 *
 *   npx tsx scripts/set-party-rcm.ts <firm-id> <client-id> <user-id> \
 *     "<supplier name>" <rate> <igst_5_3|cgst_9_3> "<what they supply>" [from-date]
 *
 * The command-line counterpart of the block on the blocked-bill card. It
 * exists because this is the one figure on a reverse-charge bill that no
 * arithmetic can check — the supplier charges no tax, so there is nothing to
 * check it against — and it therefore has to be a decision somebody made and
 * signed, not a flag on an ingest run.
 *
 * `--rcm-rate` on `ingest-bills.ts` is still there and still applies to one
 * run of one folder. This writes to the party master, so it applies to every
 * future bill from that supplier and says who decided it.
 */

import { setPartyRcmRate, partyRcmRate } from '../src/domain/partyRcm.ts';
import { withFirm, closePools } from '../src/db/pool.ts';

const [firmId, clientId, userId, name, rate, provision, supply, from] =
  process.argv.slice(2);

if (!firmId || !clientId || !userId || !name || !rate || !provision || !supply) {
  console.error(
    'usage: npx tsx scripts/set-party-rcm.ts <firm-id> <client-id> <user-id> ' +
    '"<supplier name>" <rate> <igst_5_3|cgst_9_3> "<supply>" [from-date]');
  process.exit(1);
}

// Matched by name, and refused if the name is ambiguous. A rate written
// against the wrong supplier would price every bill they send.
const party = await withFirm(firmId, async (c) => {
  const r = await c.query<{ id: string; name: string; category: string }>(
    `SELECT id, name, gst_category::text AS category FROM parties
      WHERE client_id = $1 AND party_type = 'supplier' AND is_active
        AND lower(name) LIKE '%' || lower($2) || '%'`,
    [clientId, name]);
  if (r.rows.length === 0) throw new Error(`no supplier matching "${name}"`);
  if (r.rows.length > 1) {
    throw new Error(
      `"${name}" matches ${r.rows.length} suppliers: ` +
      r.rows.map((x) => x.name).join(', '));
  }
  return r.rows[0]!;
});

// Default: from the beginning. An advocate has always been an advocate, and a
// foreign vendor's supply has always been an import — a date is only worth
// giving when the rate itself changed on one.
const effectiveFrom = from ?? '2000-01-01';
await setPartyRcmRate(firmId, {
  clientId, partyId: party.id, rate, provision: provision as 'igst_5_3',
  supply, effectiveFrom, setBy: userId,
});

const back = await partyRcmRate(firmId, clientId, party.id, effectiveFrom);
console.log(`${party.name} (${party.category}): ` +
  (typeof back === 'string' ? back : `${back.rate}% — ${back.supply}, from ${back.effectiveFrom}`));

await closePools();
