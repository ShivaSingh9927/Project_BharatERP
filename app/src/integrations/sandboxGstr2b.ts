/**
 * Fetching GSTR-2B live, through Sandbox's authenticated taxpayer session.
 * Spec: bills-and-expenses.md §5.1 · GE-18d(i)
 *
 * The public GSTIN search needed no taxpayer consent — it reads a public
 * identifier. GSTR-2B is different: it is the client's confidential filing
 * data, so the GST Network requires the TAXPAYER to authenticate before it is
 * released. Sandbox holds the GSP licence; we relay an authentication the
 * client performs.
 *
 * ── Why this does not break the rules that forbid automating the portal ────
 *
 * GE-18d(i) forbids automating the GST portal and BR-4 forbids storing a
 * portal password. This flow does neither, by construction:
 *
 *   - it uses the taxpayer's USERNAME and a ONE-TIME PASSWORD, never the
 *     account password. The username is the client's to give; the OTP is sent
 *     by the GST Network to the client's OWN phone and email.
 *   - the client reads that OTP and hands it to us for a single verification.
 *     We never see a credential, only a code the client chose to relay, good
 *     once.
 *   - nothing here is stored. The username passes through, the OTP passes
 *     through, and the session that results is held for the one fetch and
 *     never written down or logged.
 *
 * So Claude never enters a credential and no password is persisted — the
 * taxpayer authorises their own data out of the portal, and we receive the
 * result.
 */

import { ValidationError } from '../domain/types.ts';

const BASE = 'https://api.sandbox.co.in';
const API_VERSION = '1.0';

/**
 * The taxpayer-authentication and 2B fetch, behind an interface so the
 * reconciliation flow can be tested without a network, a licence, or a real
 * taxpayer's phone.
 */
export interface Gstr2bFetcher {
  /**
   * Asks the GST Network to send a one-time password to the taxpayer's own
   * phone and email. Triggers a real message — call it once, when the client
   * is ready to read it.
   */
  requestOtp(gstin: string, username: string): Promise<{ message: string }>;
  /**
   * Verifies the code the taxpayer received, establishing the session the
   * fetch needs. The OTP is used here and nowhere else.
   */
  verifyOtp(gstin: string, username: string, otp: string): Promise<void>;
  /** The raw 2B document for a period, once authenticated. `period` is YYYY-MM. */
  fetch(gstin: string, period: string): Promise<unknown>;
}

async function authenticate(apiKey: string, apiSecret: string): Promise<string> {
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
      `the GST service would not authenticate (HTTP ${r.status}). No 2B was ` +
      'fetched; nothing about the client changed.', 'BE-14');
  }
  return body.access_token;
}

export function sandboxGstr2bFetcher(
  apiKey: string, apiSecret: string,
): Gstr2bFetcher {
  let token: string | null = null;
  const auth = async () => (token ??= await authenticate(apiKey, apiSecret));

  const headers = async (): Promise<Record<string, string>> => ({
    Authorization: await auth(), 'x-api-key': apiKey,
    'x-api-version': API_VERSION, 'Content-Type': 'application/json',
    // The taxpayer endpoints require a source; 'primary' is the portal itself.
    // Omitting it returns "Missing required request parameters: [x-source]",
    // which the published docs do not mention.
    'x-source': 'primary',
  });

  return {
    async requestOtp(gstin, username) {
      const r = await fetch(`${BASE}/gst/compliance/tax-payer/otp`, {
        method: 'POST', headers: await headers(),
        body: JSON.stringify({ gstin, username }),
      });
      const body = await r.json() as { message?: string; data?: { message?: string } };
      if (!r.ok) {
        throw new ValidationError(
          `the GST Network would not send an OTP (HTTP ${r.status})` +
          (body.message ? ` — ${body.message}` : '') +
          '. Check the GSTIN and username are the client\'s portal login.',
          'BE-14');
      }
      return { message: body.data?.message ?? body.message ?? 'OTP sent' };
    },

    async verifyOtp(gstin, username, otp) {
      // The OTP is a query parameter, not a body field — the API answers
      // "Missing required request parameters: [otp]" if it is put in the body.
      const url = `${BASE}/gst/compliance/tax-payer/otp/verify` +
        `?otp=${encodeURIComponent(otp.trim())}`;
      const r = await fetch(url, {
        method: 'POST', headers: await headers(),
        body: JSON.stringify({ gstin, username }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { message?: string };
        throw new ValidationError(
          `the OTP was not accepted (HTTP ${r.status})` +
          (body.message ? ` — ${body.message}` : '') +
          '. It may be mistyped or expired — request a fresh one and retry.',
          'BE-14');
      }
      // The session now lives at Sandbox, keyed to this GSTIN. Nothing to keep.
    },

    async fetch(gstin, period) {
      const [year, month] = period.split('-');
      if (!year || !month) {
        throw new ValidationError(
          `"${period}" is not a return period — expected YYYY-MM.`, 'BE-14');
      }
      const r = await fetch(
        `${BASE}/gst/compliance/tax-payer/gstrs/gstr-2b/${year}/${month}`, {
          method: 'GET',
          headers: { ...(await headers()), GSTIN: gstin },
        });
      const body = await r.json() as Record<string, unknown>;
      if (!r.ok) {
        throw new ValidationError(
          `2B could not be fetched (HTTP ${r.status})` +
          (typeof body['message'] === 'string' ? ` — ${body['message']}` : '') +
          '. The taxpayer session may have expired — re-authenticate with a ' +
          'fresh OTP.', 'BE-14');
      }
      return body;
    },
  };
}

/** Reads the key pair from the environment, or null if unset. */
export function sandboxGstr2bFromEnv(): Gstr2bFetcher | null {
  const key = process.env['SANDBOX_API_KEY'];
  const secret = process.env['SANDBOX_API_SECRET'];
  return key && secret ? sandboxGstr2bFetcher(key, secret) : null;
}
