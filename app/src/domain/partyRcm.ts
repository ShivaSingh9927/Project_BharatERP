/**
 * The reverse-charge rate a supplier's supplies attract.
 * Spec: bills-and-expenses.md BE-35
 *
 * Under reverse charge the recipient owes the GST and the supplier charges
 * none. So the rate is absent from the document by construction — there is no
 * amount to read, no percentage printed, and nothing an arithmetic check can
 * confirm it against. Every other figure in this pipeline is proved against
 * the paper; this one cannot be, ever.
 *
 * That makes it a decision rather than a reading, and decisions belong to a
 * named human at a recorded moment. It used to arrive as `--rcm-rate=18` on a
 * command line: right for one bill, wrong for the folder, and gone the instant
 * the shell history rolled over.
 *
 * Held against the SUPPLIER instead, it is decided once. An advocate's every
 * bill is taxed in the client's hands at 18% under s.9(3); a foreign hosting
 * vendor's every bill is an import of service under s.5(3) of the IGST Act.
 * The party master is also the only place that can hold it: nothing else knows
 * whether "no GSTIN" means Frankfurt or the carpenter down the road.
 */

import { withFirm } from '../db/pool.ts';
import { STATUTORY_RATES } from './tax.ts';
import { ValidationError } from './types.ts';

/**
 * The two live routes by which a recipient owes the tax.
 *
 * s.9(4) — reverse charge merely because the supplier is unregistered — is
 * deliberately not here. It has been suspended since 13 October 2017, so a row
 * claiming it would assert a liability that does not exist, and the CHECK
 * constraint refuses it in the database as well.
 */
export type RcmProvision = 'igst_5_3' | 'cgst_9_3';

/** How each provision reads to a human, for the sentence on the bill. */
export const PROVISION_TEXT: Record<RcmProvision, string> = {
  igst_5_3: 'section 5(3) of the IGST Act — import of service',
  cgst_9_3: 'section 9(3) of the CGST Act — a notified service',
};

export interface PartyRcmRate {
  rate: string;
  provision: RcmProvision;
  /** What this supplier supplies, in the notification's own words. */
  supply: string;
  notification: string | null;
  effectiveFrom: string;
  /** The user who decided it, so the rate on a posted bill has an author. */
  setBy: string | null;
  setByName: string | null;
  setOn: string;
}

/**
 * The rate on file for this supplier ON THE BILL'S DATE.
 *
 * As of the date, never "current" — for the reason migration 008 gives. The
 * 2025-09-22 rationalisation collapsed two slabs; a bill from August was
 * charged at August's rate, and a lookup that ignored the date would reprice
 * it the moment somebody edited the master.
 *
 * 'ambiguous' when two open ranges cover the date. `setPartyRcmRate` closes
 * the previous row so that should not arise, but if it has, the rate for this
 * bill is genuinely undecided and picking one would be inventing it.
 */
export async function partyRcmRate(
  firmId: string, clientId: string, partyId: string, asOf: string,
): Promise<PartyRcmRate | 'none' | 'ambiguous'> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{
      gst_rate: string; provision: RcmProvision; supply: string;
      source_notification: string | null; effective_from: string;
      set_by: string | null; set_by_name: string | null; created_at: string;
    }>(
      `SELECT r.gst_rate::text, r.provision, r.supply, r.source_notification,
              r.effective_from::text, r.set_by, u.display_name AS set_by_name,
              r.created_at::text
         FROM party_rcm_rates r
         LEFT JOIN users u ON u.id = r.set_by
        WHERE r.client_id = $1 AND r.party_id = $2
          AND r.effective_from <= $3::date
          AND (r.effective_to IS NULL OR r.effective_to >= $3::date)`,
      [clientId, partyId, asOf]);

    if (r.rows.length === 0) return 'none';
    if (r.rows.length > 1) return 'ambiguous';
    const x = r.rows[0]!;
    return {
      // Trimmed of the numeric's trailing zeros: the column stores 18.00 and
      // every rate comparison downstream is against the string '18'.
      rate: String(Number(x.gst_rate)),
      provision: x.provision, supply: x.supply,
      notification: x.source_notification,
      effectiveFrom: x.effective_from,
      setBy: x.set_by, setByName: x.set_by_name, setOn: x.created_at,
    };
  });
}

export interface SetPartyRcmRate {
  clientId: string;
  partyId: string;
  /** One of the scheduled rates, as a plain string: '18', '5', '0'. */
  rate: string;
  provision: RcmProvision;
  supply: string;
  notification?: string;
  /** From when it applies. Bills before this date are unaffected. */
  effectiveFrom: string;
  setBy: string;
}

/**
 * Records the rate against a supplier, on a named user's decision.
 *
 * The previous open range is CLOSED rather than overwritten. A rate that
 * priced a posted bill is that bill's evidence: overwriting it would leave
 * last quarter's return citing a rate that no row could produce, which is
 * exactly the drill-back PR-7 exists to guarantee.
 */
export async function setPartyRcmRate(
  firmId: string, input: SetPartyRcmRate,
): Promise<void> {
  if (!STATUTORY_RATES.includes(input.rate as never)) {
    throw new ValidationError(
      `"${input.rate}" is not a GST rate. A supply taxed under reverse charge ` +
      'is taxed at the rate it would attract in the ordinary way — one of ' +
      `${STATUTORY_RATES.join('%, ')}%.`, 'BE-35');
  }
  if (input.supply.trim() === '') {
    throw new ValidationError(
      'say what this supplier supplies. The rate is the one figure on a ' +
      'reverse-charge bill that no arithmetic can check, so the reason for it ' +
      'is the only evidence there will ever be.', 'BE-35');
  }

  await withFirm(firmId, async (c) => {
    /*
     * The party's own record decides whether a rate here means anything.
     *
     * A rate against a registered supplier would be read as reverse charge on
     * an invoice that charges tax in the ordinary way, and the recipient would
     * pay twice. Refused here rather than ignored later, because a row sitting
     * in the master looking effective is worse than no row at all.
     */
    const p = await c.query<{ name: string; category: string }>(
      `SELECT name, gst_category::text AS category FROM parties
        WHERE id = $1 AND client_id = $2 AND party_type = 'supplier'`,
      [input.partyId, input.clientId]);
    const party = p.rows[0];
    if (party === undefined) {
      throw new ValidationError('no such supplier for this client', 'BE-35');
    }
    if (party.category !== 'overseas' && party.category !== 'unregistered') {
      throw new ValidationError(
        `${party.name} is on file as ${party.category}, so their invoices ` +
        'charge GST in the ordinary way and the credit is claimed from the ' +
        'document. A reverse-charge rate here would tax the same supply twice.',
        'BE-35');
    }
    if (input.provision === 'igst_5_3' && party.category !== 'overseas') {
      throw new ValidationError(
        `${party.name} is on file as an Indian supplier, so their supply is ` +
        'not an import of service. If the tax is owed here it is under ' +
        's.9(3) — legal services, goods transport, sponsorship and the rest — ' +
        'and the row has to say so.', 'BE-35');
    }

    /*
     * Close the range this one supersedes — the open row that started earlier.
     * Closed rather than overwritten: a rate that priced a posted bill is that
     * bill's evidence, and replacing it would leave last quarter's return
     * citing a rate no row could produce.
     */
    await c.query(
      `UPDATE party_rcm_rates
          SET effective_to = ($3::date - 1)
        WHERE client_id = $1 AND party_id = $2 AND effective_to IS NULL
          AND effective_from < $3::date`,
      [input.clientId, input.partyId, input.effectiveFrom]);

    await c.query(
      `INSERT INTO party_rcm_rates
         (firm_id, client_id, party_id, gst_rate, provision, supply,
          source_notification, effective_from, set_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (party_id, effective_from) DO UPDATE
         SET gst_rate = EXCLUDED.gst_rate, provision = EXCLUDED.provision,
             supply = EXCLUDED.supply,
             source_notification = EXCLUDED.source_notification,
             effective_to = NULL, set_by = EXCLUDED.set_by`,
      [firmId, input.clientId, input.partyId, input.rate, input.provision,
       input.supply.trim(), input.notification ?? null,
       input.effectiveFrom, input.setBy]);

    /*
     * And close the new row where the NEXT one begins.
     *
     * Only reached when a rate is BACKDATED — filling in a period after a
     * later rate is already on file, which is what happens when somebody
     * realises in August that a supplier has been an advocate all along.
     * Without this the new open range and the later open range both cover
     * today, and `partyRcmRate` would rightly call the rate undecided and
     * block every bill from that supplier.
     */
    await c.query(
      `UPDATE party_rcm_rates
          SET effective_to = n.next_start - 1
         FROM (SELECT min(effective_from) AS next_start
                 FROM party_rcm_rates
                WHERE client_id = $1 AND party_id = $2
                  AND effective_from > $3::date) n
        WHERE party_rcm_rates.client_id = $1
          AND party_rcm_rates.party_id = $2
          AND party_rcm_rates.effective_from = $3::date
          AND n.next_start IS NOT NULL`,
      [input.clientId, input.partyId, input.effectiveFrom]);
  });
}
