/**
 * What the GST portal says about a supplier, and what follows from it.
 * Spec: bills-and-expenses.md §4.8 · CGST s.16(2), s.10(4), Rule 48(4)
 *
 * A valid check digit proves a GSTIN was typed correctly. It says nothing
 * about whether the registration behind it still exists, or whether that
 * supplier is even permitted to charge the tax printed on the invoice. Those
 * are the questions that decide whether input credit survives an assessment,
 * and neither can be answered from the document.
 *
 * ── The findings, and why each is worth a call ────────────────────────────
 *
 *   no record          the number passes its own checksum and the portal has
 *                      never issued it. Nothing to claim against.
 *   cancelled          credit is not available on an invoice dated after the
 *                      cancellation. The invoice looks perfect; only the
 *                      portal knows.
 *   composition        a composition dealer may not collect GST at all
 *                      (s.10(4)). GST charged by one is not creditable, and a
 *                      bill that charges it is wrong on its face.
 *   before registration an invoice predating the registration cannot carry a
 *                      valid GSTIN on it.
 *   e-invoice required the supplier must issue an e-invoice (Rule 48(4)); a
 *                      B2B invoice from them with no IRN is not a valid
 *                      document and credit on it can be denied.
 *   name mismatch      reported, never blocking. Trade names differ from
 *                      legal names for perfectly good reasons.
 *
 * ── Cached, and honestly dated ────────────────────────────────────────────
 *
 * The lookup is a paid call and the answer is a fact about a business rather
 * than about this bill, so it is stored and reused. `fetched_at` travels with
 * it: a cancellation that happened after we looked is a cancellation we cannot
 * know about, and the record says when it was true rather than implying it is
 * true now.
 */

import { ownerPool } from '../db/pool.ts';
import type { GstinLookup, GstinRecord } from '../integrations/sandboxGst.ts';

/** How long a cached registration is treated as current. */
export const REGISTRY_MAX_AGE_DAYS = 30;

export interface RegistryFinding {
  /** 'blocker' stops the bill; 'warning' is for the reviewer. */
  severity: 'blocker' | 'warning';
  message: string;
}

/**
 * Reads a GSTIN's registration, from cache when it is fresh enough.
 *
 * Returns `null` when the portal has no record, and `'unavailable'` when
 * nobody could be asked — no lookup configured, or the call failed. Those are
 * different answers and the caller must not conflate them: one is a finding
 * about the supplier, the other is a gap in our own knowledge.
 */
export async function readRegistration(
  gstin: string, lookup: GstinLookup | undefined,
): Promise<GstinRecord | null | 'unavailable'> {
  const found = await ownerPool.query<CachedRow>(
    `SELECT gstin, status, taxpayer_type, legal_name, trade_name, state_code,
            to_char(registered_on, 'YYYY-MM-DD') AS registered_on,
            to_char(cancelled_on, 'YYYY-MM-DD') AS cancelled_on,
            einvoice_required, raw,
            (fetched_at < now() - ($2 || ' days')::interval) AS stale
       FROM gstin_registry WHERE gstin = $1`,
    [gstin, String(REGISTRY_MAX_AGE_DAYS)]);
  const cached = found.rows[0] ?? null;

  if (cached && !cached.stale) return fromRow(cached);

  if (lookup === undefined) {
    // Stale beats nothing: an answer from last month, clearly dated, is more
    // use to a reviewer than silence.
    return cached ? fromRow(cached) : 'unavailable';
  }

  let fresh: GstinRecord | null;
  try {
    fresh = await lookup.find(gstin);
  } catch {
    return cached ? fromRow(cached) : 'unavailable';
  }

  if (fresh === null) return null;
  await store(fresh);
  return fresh;
}

/**
 * Reads back what was stored, from the COLUMNS rather than by re-parsing the
 * provider's payload.
 *
 * Re-deriving from `raw` meant the cache and the live call could disagree
 * about the same record — and did: a stored row whose payload was shaped
 * slightly differently came back with a status of "Unknown", which reads as
 * "not active" and blocked the bill. The typed columns are the record; `raw`
 * is kept for questions nobody has asked yet.
 */
interface CachedRow {
  gstin: string;
  status: string;
  taxpayer_type: string | null;
  legal_name: string | null;
  trade_name: string | null;
  state_code: string | null;
  registered_on: string | null;
  cancelled_on: string | null;
  einvoice_required: boolean | null;
  raw: unknown;
  stale: boolean;
}

function fromRow(r: CachedRow): GstinRecord {
  return {
    gstin: r.gstin,
    status: r.status,
    taxpayerType: r.taxpayer_type,
    legalName: r.legal_name,
    tradeName: r.trade_name,
    stateCode: r.state_code,
    registeredOn: r.registered_on,
    cancelledOn: r.cancelled_on,
    einvoiceRequired: r.einvoice_required,
    raw: r.raw,
    source: 'cache',
  };
}

async function store(r: GstinRecord): Promise<void> {
  await ownerPool.query(
    `INSERT INTO gstin_registry
       (gstin, status, taxpayer_type, legal_name, trade_name, state_code,
        registered_on, cancelled_on, einvoice_required, raw, source, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (gstin) DO UPDATE SET
       status = EXCLUDED.status, taxpayer_type = EXCLUDED.taxpayer_type,
       legal_name = EXCLUDED.legal_name, trade_name = EXCLUDED.trade_name,
       registered_on = EXCLUDED.registered_on,
       cancelled_on = EXCLUDED.cancelled_on,
       einvoice_required = EXCLUDED.einvoice_required,
       raw = EXCLUDED.raw, source = EXCLUDED.source, fetched_at = now()`,
    [r.gstin, r.status, r.taxpayerType, r.legalName, r.tradeName, r.stateCode,
     r.registeredOn, r.cancelledOn, r.einvoiceRequired,
     JSON.stringify(r.raw), r.source]);
}

/**
 * What the registration means for THIS bill.
 *
 * Everything here needs the invoice date, because every one of these questions
 * is about a moment: a registration cancelled last March says nothing about a
 * bill from the January before it.
 */
export function checkRegistration(
  record: GstinRecord | null | 'unavailable',
  bill: { date: string | null; chargesTax: boolean; hasIrn: boolean },
): RegistryFinding[] {
  if (record === 'unavailable') return [];

  if (record === null) {
    return [{
      severity: 'blocker',
      message: 'the GST portal has no record of this supplier GSTIN. The ' +
        'number is well formed — its check digit is correct — so this is not a ' +
        'typing error, and there is no registration to claim credit against.',
    }];
  }

  const out: RegistryFinding[] = [];
  const on = bill.date;

  /*
   * Cancelled, and cancelled BEFORE this invoice. A supplier who was
   * registered when they billed us is fine; the invoice date decides.
   */
  if (/cancel/i.test(record.status)) {
    if (on !== null && record.cancelledOn !== null && on < record.cancelledOn) {
      out.push({
        severity: 'warning',
        message: `this supplier's registration was cancelled on ` +
          `${record.cancelledOn}, after this invoice of ${on}. The invoice is ` +
          'valid, but nothing further from them will be.',
      });
    } else {
      out.push({
        severity: 'blocker',
        message: `this supplier's GST registration is cancelled` +
          (record.cancelledOn !== null ? ` (from ${record.cancelledOn})` : '') +
          `${on !== null ? `, and this invoice is dated ${on}` : ''}. Input ` +
          'credit is not available on it.',
      });
    }
  } else if (!/active/i.test(record.status)) {
    out.push({
      severity: 'blocker',
      message: `the GST portal reports this supplier's registration as ` +
        `"${record.status}", not active. Credit on it needs a decision from ` +
        'the CA before it is claimed.',
    });
  }

  /*
   * A composition dealer collects no tax from its customers — it pays a flat
   * rate out of its own turnover (s.10(4)) — so GST printed on its invoice is
   * both wrong and uncreditable.
   */
  if (record.taxpayerType !== null
      && /composition/i.test(record.taxpayerType) && bill.chargesTax) {
    out.push({
      severity: 'blocker',
      message: 'this supplier is registered under the composition scheme, ' +
        'which does not permit collecting GST from a customer (s.10(4)) — yet ' +
        'this invoice charges it. The tax is not creditable and the invoice ' +
        'itself is irregular.',
    });
  }

  if (on !== null && record.registeredOn !== null && on < record.registeredOn) {
    out.push({
      severity: 'blocker',
      message: `this invoice is dated ${on}, before the supplier was ` +
        `registered on ${record.registeredOn}. A GSTIN cannot appear on an ` +
        'invoice raised before it existed.',
    });
  }

  /*
   * A warning rather than a blocker, deliberately. Rule 48(5) does say a
   * non-compliant invoice is not a valid document, but the threshold turns on
   * the SUPPLIER's turnover and on whether the supply is B2B — neither of
   * which is on the paper — and blocking every such bill would refuse most of
   * a real purchase ledger on a rule that may not apply to it.
   */
  if (record.einvoiceRequired === true && !bill.hasIrn) {
    out.push({
      severity: 'warning',
      message: 'the portal says this supplier is required to issue e-invoices, ' +
        'and no IRN appears on this document. If the supply is B2B, an invoice ' +
        'without one is not a valid document and the credit can be denied — ' +
        'worth asking them for the e-invoice copy.',
    });
  }

  return out;
}
