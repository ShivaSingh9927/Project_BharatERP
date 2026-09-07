/**
 * The GST portal's public taxpayer search, through a licensed provider.
 * Spec: bills-and-expenses.md §4.8
 *
 * We do not talk to the GST portal ourselves and will not: GE-18d(i) forbids
 * automating it, and the network is only open to a GST Suvidha Provider, which
 * this project cannot become — the licence carries a net-worth bar it does not
 * meet. So the call goes through Sandbox, who hold the licence.
 *
 * The interface below is deliberately three lines wide. Everything downstream
 * depends on `GstinRecord`, not on Sandbox, so a change of provider is a new
 * file rather than a change to the rules that read it — and every test can
 * supply its own lookup without a network.
 *
 * What this looks up is a PUBLIC business identifier, printed on the invoice
 * and searchable by anyone on the portal's own website. That is a different
 * thing from sending a client's document to a third party, which needs the
 * firm's explicit consent (`firm_ai_settings`), and it is why this has no
 * equivalent gate.
 */

import { ValidationError } from '../domain/types.ts';

/** What the rules need to know. Provider-independent by design. */
export interface GstinRecord {
  gstin: string;
  /** The portal's own word: 'Active', 'Cancelled', 'Suspended', ... */
  status: string;
  /** 'Regular', 'Composition', 'Casual Taxable Person', ... */
  taxpayerType: string | null;
  legalName: string | null;
  tradeName: string | null;
  stateCode: string | null;
  /** ISO dates, converted from the portal's DD/MM/YYYY. */
  registeredOn: string | null;
  cancelledOn: string | null;
  einvoiceRequired: boolean | null;
  /** Everything returned, kept whole (PR-3). */
  raw: unknown;
  /** Who was asked, for the audit trail. */
  source: string;
}

export interface GstinLookup {
  source: string;
  /** Null when the portal has no record of this GSTIN. */
  find(gstin: string): Promise<GstinRecord | null>;
}

const BASE = 'https://api.sandbox.co.in';
const API_VERSION = '1.0';

/** The portal writes dates DD/MM/YYYY. Empty string means "not applicable". */
function isoDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * A Sandbox-backed lookup.
 *
 * The access token is fetched once and reused. It is deliberately not written
 * anywhere: tokens are credentials, and this one lives for the process only.
 */
export function sandboxLookup(apiKey: string, apiSecret: string): GstinLookup {
  let token: string | null = null;

  const authenticate = async (): Promise<string> => {
    const r = await fetch(`${BASE}/authenticate`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey, 'x-api-secret': apiSecret,
        'x-api-version': API_VERSION,
      },
    });
    const body = await r.json() as { access_token?: string };
    if (!r.ok || !body.access_token) {
      throw new ValidationError(
        `the GST lookup service would not authenticate (HTTP ${r.status}). The ` +
        'bill is unaffected; nothing about the supplier could be checked.',
        'BE-12');
    }
    return body.access_token;
  };

  return {
    source: 'sandbox/gst-public-search',

    async find(gstin) {
      token ??= await authenticate();

      const call = async (t: string) => fetch(
        `${BASE}/gst/compliance/public/gstin/search`, {
          method: 'POST',
          headers: {
            Authorization: t, 'x-api-key': apiKey,
            'x-api-version': API_VERSION, 'Content-Type': 'application/json',
          },
          body: JSON.stringify({ gstin }),
        });

      let r = await call(token);
      if (r.status === 401 || r.status === 403) {
        // The token expired mid-run. Once, and then it is a real failure.
        token = await authenticate();
        r = await call(token);
      }

      const body = await r.json() as {
        code?: number; data?: { data?: Record<string, unknown> }; message?: string;
      };

      /*
       * Status FIRST, and this order is the whole point.
       *
       * "No record" is an ANSWER — a GSTIN the portal has never issued is a
       * serious finding about the invoice — while an outage is a gap in what
       * we know. The two arrive looking identical: neither carries data.
       *
       * Checking for missing data first, as this did, meant a rate-limit or a
       * 500 was reported as "the portal has no record of this supplier", which
       * is a blocker making a false accusation about a real business. Blink
       * Commerce resolves perfectly well when asked again.
       */
      if (!r.ok) {
        throw new ValidationError(
          `the GST lookup service returned HTTP ${r.status}` +
          (body.message ? ` — ${body.message}` : '') +
          '. Nothing about the supplier could be checked.', 'BE-12');
      }

      const d = body.data?.data;
      if (d === undefined || Object.keys(d).length === 0) {
        /*
         * A 200 carrying nothing. The provider says "No records found" for a
         * GSTIN that does not exist, so that phrasing is taken at its word and
         * anything else is treated as a fault rather than as an answer.
         */
        if (/no record/i.test(body.message ?? '')) return null;
        throw new ValidationError(
          'the GST lookup service returned an empty result without saying the ' +
          `GSTIN is unknown${body.message ? ` (${body.message})` : ''}. That is ` +
          'not the same as "no such registration", so nothing is concluded ' +
          'about the supplier.', 'BE-12');
      }

      return {
        gstin,
        status: str(d['sts']) ?? 'Unknown',
        taxpayerType: str(d['dty']),
        legalName: str(d['lgnm']),
        tradeName: str(d['tradeNam']),
        stateCode: gstin.slice(0, 2),
        registeredOn: isoDate(d['rgdt']),
        cancelledOn: isoDate(d['cxdt']),
        einvoiceRequired: typeof d['einvoiceStatus'] === 'string'
          ? d['einvoiceStatus'].trim().toLowerCase() === 'yes'
          : null,
        raw: body.data,
        source: 'sandbox/gst-public-search',
      };
    },
  };
}

/** Reads the key pair from the environment, or returns null if unset. */
export function sandboxLookupFromEnv(): GstinLookup | null {
  const key = process.env['SANDBOX_API_KEY'];
  const secret = process.env['SANDBOX_API_SECRET'];
  return key && secret ? sandboxLookup(key, secret) : null;
}
