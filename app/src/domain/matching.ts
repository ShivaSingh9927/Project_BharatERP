/**
 * The matching engine.
 * Spec: bank-and-reconciliation.md §8
 *
 * Layered and cheapest-first (BR-14). Most lines should be resolved by a known
 * link or an exact reference and never reach the model at all. A line that
 * reaches layer 4 has cost real money to classify, so the layers below it are
 * where the engineering effort belongs.
 */

import type { PoolClient } from 'pg';
import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';
import { paise, money } from './tax.ts';

export type MatchLayer = 'known_link' | 'exact_reference' | 'scored' | 'rule' | 'ai';

export interface Candidate {
  voucherId: string;
  voucherNumber: string;
  documentNumber: string;
  partyId: string | null;
  partyName: string | null;
  documentDate: string;
  /** Value excluding GST — what TDS is actually computed on (§8.3, BR-16). */
  taxableValue: string;
  grandTotal: string;
  outstanding: string;
  reference: string | null;
}

export interface ScoredCandidate extends Candidate {
  score: number;
  signals: string[];
}

export interface MatchProposal {
  layer: MatchLayer;
  best: ScoredCandidate | null;
  runnersUp: ScoredCandidate[];
  /** BR-15: true when the CA must choose. Never resolved by the system. */
  ambiguous: boolean;
  autoMatchable: boolean;
  reason: string;
}

/**
 * Weights from §8.2 — deliberately not flat.
 *
 * A UTR match and a date-proximity match are not comparable pieces of
 * evidence. Summing binary signals equally, as the reference implementation
 * does, lets three weak coincidences outvote one conclusive identifier.
 */
export const WEIGHTS = {
  referenceExact: 50,
  amountExact: 30,
  amountTolerance: 15,
  partyMatch: 15,
  dateWithin3Days: 5,
  dateWithin30Days: 2,
} as const;

/**
 * Clears this and leads the runner-up by MARGIN, or a human decides.
 *
 * 45 is chosen against the weights, not picked round. The best a line can
 * score without a reference number is 50 — exact amount (30) + party (15) +
 * same-week date (5) — so a higher bar would make a UTR mandatory for every
 * auto-match, and most Indian statement lines simply do not carry one.
 * Meanwhile a merely-plausible line (amount within tolerance, party, date) tops
 * out at 35 and stays below the bar, which is the behaviour we want.
 */
export const AUTO_MATCH_THRESHOLD = 45;
export const AUTO_MATCH_MARGIN = 15;

/**
 * Below this, there is no candidate worth showing.
 *
 * Found by using the screen rather than by testing it: a ₹15,000 cash deposit
 * and a ₹9,000 interest credit were both offered a "proposed match" against
 * unrelated invoices, scoring 5 and 2 — the score came only from the two
 * invoices happening to be dated the same month.
 *
 * A near-zero score is not a weak match, it is *no* match, and presenting it as
 * a proposal invites a wrong click. Reporting nothing is the honest answer and
 * pushes the line towards classification, where it belongs.
 *
 * The line is drawn at 15 — "at least one signal stronger than date
 * proximity", date being worth 5 at most. First set to 20, which then hid a
 * ₹10,000 part payment from a known customer against their ₹25,000 invoice: it
 * scored 17 on party plus date, since the amount legitimately does not match.
 * That is a real match a CA must see, and partial payments are routine, so a
 * resolved party alone has to be enough to earn a proposal.
 */
export const MIN_PROPOSAL_SCORE = 15;

const dayGap = (a: string, b: string): number =>
  Math.abs(Math.round((+new Date(a) - +new Date(b)) / 86_400_000));

export function scoreCandidate(
  txn: { amount: string; txnDate: string; reference: string | null; partyId: string | null },
  cand: Candidate,
): ScoredCandidate {
  const signals: string[] = [];
  let score = 0;

  if (txn.reference && cand.reference
      && txn.reference.toUpperCase() === cand.reference.toUpperCase()) {
    score += WEIGHTS.referenceExact;
    signals.push(`reference ${txn.reference} matches exactly (+${WEIGHTS.referenceExact})`);
  }

  const amount = paise(txn.amount);
  const outstanding = paise(cand.outstanding);

  if (amount === outstanding) {
    score += WEIGHTS.amountExact;
    signals.push(`amount ${money(amount)} matches the outstanding exactly (+${WEIGHTS.amountExact})`);
  } else {
    // Tolerance covers the everyday shortfalls: remittance charges, a rounding
    // difference, or a TDS deduction (BR-16 handles that case explicitly).
    const gap = outstanding > amount ? outstanding - amount : amount - outstanding;
    const withinTolerance = gap <= 100n * 100n
      || (outstanding > 0n && gap * 100n <= outstanding * 12n);
    if (withinTolerance) {
      score += WEIGHTS.amountTolerance;
      signals.push(
        `amount ${money(amount)} is within tolerance of ${money(outstanding)} ` +
        `(gap ${money(gap)}, +${WEIGHTS.amountTolerance})`);
    }
  }

  if (txn.partyId && cand.partyId && txn.partyId === cand.partyId) {
    score += WEIGHTS.partyMatch;
    signals.push(`party resolved to ${cand.partyName} (+${WEIGHTS.partyMatch})`);
  }

  const gap = dayGap(txn.txnDate, cand.documentDate);
  if (gap <= 3) {
    score += WEIGHTS.dateWithin3Days;
    signals.push(`${gap} day(s) from the document date (+${WEIGHTS.dateWithin3Days})`);
  } else if (gap <= 30) {
    score += WEIGHTS.dateWithin30Days;
    signals.push(`${gap} days from the document date (+${WEIGHTS.dateWithin30Days})`);
  }

  return { ...cand, score, signals };
}

/**
 * Rank candidates and decide whether the top one may auto-match.
 *
 * BR-15 — ambiguity is never resolved silently. Two open invoices for ₹11,800
 * from the same customer is a case for the CA, not a coin flip. Guessing here
 * is worse than not matching: an unmatched line is visibly unfinished work,
 * while a wrongly matched one looks finished and quietly corrupts the ageing
 * of two invoices at once.
 */
export function rank(
  txn: { amount: string; txnDate: string; reference: string | null; partyId: string | null },
  candidates: Candidate[],
): MatchProposal {
  if (candidates.length === 0) {
    return {
      layer: 'scored', best: null, runnersUp: [], ambiguous: false, autoMatchable: false,
      reason: 'no open voucher is a plausible counterpart for this line',
    };
  }

  const scored = candidates.map((c) => scoreCandidate(txn, c))
    .sort((a, b) => b.score - a.score)
    .filter((c) => c.score >= MIN_PROPOSAL_SCORE);

  if (scored.length === 0) {
    return {
      layer: 'scored', best: null, runnersUp: [], ambiguous: false, autoMatchable: false,
      reason: 'no open voucher shares an amount, reference or party with this line',
    };
  }

  const best = scored[0]!;
  const runnersUp = scored.slice(1, 4);
  const second = scored[1];

  // An exact reference is conclusive on its own — layer 1, not layer 2.
  const byReference = best.signals.some((s) => s.startsWith('reference'));
  const layer: MatchLayer = byReference ? 'exact_reference' : 'scored';

  const ambiguous = second !== undefined
    && best.score - second.score < AUTO_MATCH_MARGIN
    && second.score >= AUTO_MATCH_THRESHOLD - AUTO_MATCH_MARGIN;

  const autoMatchable = best.score >= AUTO_MATCH_THRESHOLD && !ambiguous;

  return {
    layer, best, runnersUp, ambiguous, autoMatchable,
    reason: ambiguous
      ? `BR-15: ${best.documentNumber} scored ${best.score} and ${second!.documentNumber} ` +
        `scored ${second!.score} — too close to decide automatically`
      : autoMatchable
        ? `${best.documentNumber} scored ${best.score}: ${best.signals.join('; ')}`
        : `best candidate ${best.documentNumber} scored ${best.score}, below the ` +
          `${AUTO_MATCH_THRESHOLD} auto-match threshold — needs review`,
  };
}

// ---------------------------------------------------------------------------
// BR-16 — customer-deducted TDS
// ---------------------------------------------------------------------------

export interface TdsShortfall {
  isLikelyTds: boolean;
  shortfall: string;
  /** The rate the shortfall implies, e.g. '2' for 2%. */
  impliedRate: string | null;
  section: string | null;
  explanation: string;
}

/**
 * Rates a customer plausibly deducts, with the section each implies.
 * PLACEHOLDER — verify with the CA advisor. The Income Tax Act 2025 renumbered
 * the 194-series, so the codes here are the categories, not the citations.
 */
const PLAUSIBLE_RATES: Array<{ rate: string; section: string }> = [
  { rate: '0.1', section: 'purchase of goods' },
  { rate: '1',   section: 'contractor — individual/HUF' },
  { rate: '2',   section: 'contractor — company' },
  { rate: '5',   section: 'commission or brokerage' },
  { rate: '10',  section: 'professional or technical fees / rent' },
];

/**
 * Decide whether a payment shortfall is a customer's TDS deduction.
 *
 * A customer paying ₹49,000 against a ₹50,000 invoice has almost certainly
 * deducted ₹1,000 of TDS. The invoice is **fully settled**; the ₹1,000 becomes
 * TDS Receivable, claimable against the client's own income tax.
 *
 * Treating it as an unpaid balance does two kinds of damage at once: it leaves
 * a receivable that can never be collected and will be chased forever, and it
 * forfeits a real tax credit the client has already paid for. This is a
 * frequent, silent, expensive error in manual bookkeeping — and it is easy to
 * detect, because the gap is a recognisable percentage.
 *
 * The percentage is taken on the TAXABLE value, not the gross. Where GST is
 * shown separately on the invoice, TDS is deducted on the value excluding GST
 * — so checking the shortfall against the gross would miss every case where
 * the invoice carries tax.
 *
 * §16.5 is settled conservatively: propose with the computed rate shown,
 * require confirmation. Never auto-apply.
 */
export function inferTdsShortfall(args: {
  invoiceGrandTotal: string;
  invoiceTaxableValue: string;
  amountReceived: string;
  /** Paise of slack for rounding in the customer's own system. */
  tolerancePaise?: bigint;
}): TdsShortfall {
  const gross = paise(args.invoiceGrandTotal);
  const taxable = paise(args.invoiceTaxableValue);
  const received = paise(args.amountReceived);
  const shortfall = gross - received;
  const slack = args.tolerancePaise ?? 100n;   // ₹1

  if (shortfall <= 0n) {
    return {
      isLikelyTds: false, shortfall: money(shortfall), impliedRate: null, section: null,
      explanation: 'no shortfall — the invoice was paid in full or over-paid',
    };
  }

  for (const { rate, section } of PLAUSIBLE_RATES) {
    const expected = (taxable * paise(rate) + 5000n) / 10000n;
    const diff = expected > shortfall ? expected - shortfall : shortfall - expected;
    if (diff <= slack) {
      return {
        isLikelyTds: true,
        shortfall: money(shortfall),
        impliedRate: rate,
        section,
        explanation:
          `the ${money(shortfall)} shortfall is ${rate}% of the taxable value ` +
          `${money(taxable)}, consistent with TDS on ${section}. The invoice is ` +
          `fully settled; ${money(shortfall)} belongs in TDS Receivable, not in ` +
          'the outstanding balance. Confirm before posting.',
      };
    }
  }

  return {
    isLikelyTds: false,
    shortfall: money(shortfall),
    impliedRate: null,
    section: null,
    explanation:
      `the ${money(shortfall)} shortfall is not a plausible TDS percentage of ` +
      `${money(taxable)} — treat as a genuine partial payment`,
  };
}

// ---------------------------------------------------------------------------
// Candidate lookup
// ---------------------------------------------------------------------------

/**
 * Open sales invoices for a client, with what is still owed on each.
 *
 * Outstanding is computed from the ledger rather than stored, so it cannot
 * drift from the books it is supposed to describe.
 */
export async function openInvoiceCandidates(
  c: PoolClient, clientId: string, opts: { partyId?: string; onOrBefore?: string } = {},
): Promise<Candidate[]> {
  const r = await c.query<Candidate>(
    `SELECT si.voucher_id                              AS "voucherId",
            v.voucher_number                           AS "voucherNumber",
            v.voucher_number                           AS "documentNumber",
            si.party_id                                AS "partyId",
            p.name                                     AS "partyName",
            v.posting_date::text                       AS "documentDate",
            si.taxable_value::text                     AS "taxableValue",
            si.grand_total::text                       AS "grandTotal",
            (si.grand_total - COALESCE((
               SELECT SUM(le.credit - le.debit) FROM ledger_entries le
               WHERE le.settles_voucher_id = si.voucher_id), 0))::text AS outstanding,
            si.expected_reference                      AS reference
     FROM sales_invoices si
     JOIN vouchers v ON v.id = si.voucher_id
     LEFT JOIN parties p ON p.id = si.party_id
     WHERE si.client_id = $1
       AND NOT EXISTS (SELECT 1 FROM vouchers r WHERE r.reverses_id = si.voucher_id)
       AND ($2::uuid IS NULL OR si.party_id = $2)
       AND ($3::date IS NULL OR v.posting_date <= $3)
       AND (si.grand_total - COALESCE((
              SELECT SUM(le.credit - le.debit) FROM ledger_entries le
              WHERE le.settles_voucher_id = si.voucher_id), 0)) > 0
     ORDER BY v.posting_date`,
    [clientId, opts.partyId ?? null, opts.onOrBefore ?? null]);
  return r.rows;
}

/** Unpaid purchase bills — the debit-side counterpart. */
export async function openBillCandidates(
  c: PoolClient, clientId: string, opts: { partyId?: string } = {},
): Promise<Candidate[]> {
  const r = await c.query<Candidate>(
    `SELECT pb.voucher_id                              AS "voucherId",
            v.voucher_number                           AS "voucherNumber",
            pb.bill_number                             AS "documentNumber",
            pb.party_id                                AS "partyId",
            pb.supplier_legal_name                     AS "partyName",
            pb.bill_date::text                         AS "documentDate",
            pb.taxable_value::text                     AS "taxableValue",
            pb.grand_total::text                       AS "grandTotal",
            (pb.grand_total - COALESCE((
               SELECT SUM(le.debit - le.credit) FROM ledger_entries le
               WHERE le.settles_voucher_id = pb.voucher_id), 0))::text AS outstanding,
            NULL::text                                 AS reference
     FROM purchase_bills pb
     JOIN vouchers v ON v.id = pb.voucher_id
     WHERE pb.client_id = $1
       AND NOT EXISTS (SELECT 1 FROM vouchers r WHERE r.reverses_id = pb.voucher_id)
       AND ($2::uuid IS NULL OR pb.party_id = $2)
       AND (pb.grand_total - COALESCE((
              SELECT SUM(le.debit - le.credit) FROM ledger_entries le
              WHERE le.settles_voucher_id = pb.voucher_id), 0)) > 0
     ORDER BY pb.bill_date`,
    [clientId, opts.partyId ?? null]);
  return r.rows;
}

export interface QueueItem {
  bankTransactionId: string;
  txnDate: string;
  narration: string;
  debit: string;
  credit: string;
  amount: string;
  direction: 'inbound' | 'outbound';
  paymentMode: string | null;
  reference: string | null;
  counterpartyName: string | null;
  status: string;
  unmatchedAmount: string;
  proposal: MatchProposal;
  /**
   * What this line probably IS, when no voucher can settle it (§9).
   *
   * The narration parser already knows a line is a charge or an interest
   * credit; not using that was leaving the operator to work it out from a
   * failed match. Classification is the right action for these lines, not
   * matching, so the queue says so.
   */
  suggestedClassification: 'bank_charge' | 'interest' | 'cheque' | null;
}

/** §9 — statement-only lines, where no invoice or bill exists to match. */
function classifyFromMode(
  mode: string | null, direction: 'inbound' | 'outbound',
): QueueItem['suggestedClassification'] {
  if (mode === 'charge') return 'bank_charge';
  if (mode === 'interest') return direction === 'inbound' ? 'interest' : 'bank_charge';
  if (mode === 'cheque') return 'cheque';
  return null;
}

/**
 * The CA's work queue for one bank account.
 *
 * Sorted by confidence descending (§14.1) so the easy lines are cleared in
 * bulk at the top and attention is spent at the bottom, where it belongs.
 * Sorting by date instead — the obvious choice — mixes trivial and hard work
 * together and makes bulk-accept useless.
 *
 * Candidates are loaded ONCE and scored in memory rather than re-queried per
 * line. A month of statement lines against a month of open invoices is a
 * few hundred by a few hundred; doing that as N round trips would make the
 * screen feel slow for no reason.
 */
export async function reconciliationQueue(
  firmId: string,
  bankAccountId: string,
  opts: { limit?: number; includeMatched?: boolean } = {},
): Promise<{ items: QueueItem[]; totals: { unmatched: number; matched: number;
             autoMatchable: number; ambiguous: number } }> {
  return withFirm(firmId, async (c) => {
    const acct = await c.query<{ client_id: string }>(
      'SELECT client_id FROM bank_accounts WHERE id = $1', [bankAccountId]);
    if (acct.rowCount === 0) throw new ValidationError('bank account not found', 'BR-2');
    const clientId = acct.rows[0]!.client_id;

    // Sequential, not Promise.all. A single pg client cannot run concurrent
    // queries — doing so warns today and throws in pg 9. The parallelism that
    // matters here is scoring in memory rather than one query per line.
    const invoices = await openInvoiceCandidates(c, clientId);
    const bills = await openBillCandidates(c, clientId);
    const parties = await c.query<{ id: string; name: string; legal_name: string | null }>(
      'SELECT id, name, legal_name FROM parties WHERE client_id = $1', [clientId]);

    /** Resolve a parsed counterparty name to a party, loosely. */
    const resolveParty = (name: string | null): string | null => {
      if (!name) return null;
      const needle = name.toLowerCase();
      const hit = parties.rows.find((p) =>
        needle.includes(p.name.toLowerCase())
        || p.name.toLowerCase().includes(needle)
        || (p.legal_name && needle.includes(p.legal_name.toLowerCase())));
      return hit?.id ?? null;
    };

    const txns = await c.query(
      `SELECT id, txn_date::text AS txn_date, narration, debit::text, credit::text,
              amount::text, unmatched_amount::text, status, payment_mode::text,
              reference_number, counterparty_name, source::text
       FROM bank_transactions_reconciled
       WHERE bank_account_id = $1 AND NOT is_ignored
         AND ($2 OR status <> 'matched')
       ORDER BY txn_date DESC
       LIMIT $3`,
      [bankAccountId, opts.includeMatched ?? false, opts.limit ?? 500]);

    const items: QueueItem[] = txns.rows.map((t) => {
      const direction: 'inbound' | 'outbound' = paise(t.credit) > 0n ? 'inbound' : 'outbound';
      const candidates = direction === 'inbound' ? invoices : bills;

      // Score against the amount still unallocated, not the whole line — a
      // partially matched line should be judged on what remains.
      const proposal = rank({
        amount: t.unmatched_amount,
        txnDate: t.txn_date,
        reference: t.reference_number,
        partyId: resolveParty(t.counterparty_name),
      }, candidates);

      return {
        bankTransactionId: t.id,
        txnDate: t.txn_date,
        narration: t.narration,
        debit: t.debit, credit: t.credit, amount: t.amount,
        direction,
        paymentMode: t.payment_mode,
        reference: t.reference_number,
        counterpartyName: t.counterparty_name,
        status: t.status,
        unmatchedAmount: t.unmatched_amount,
        proposal,
        suggestedClassification: proposal.best
          ? null                                    // a real match outranks a guess
          : classifyFromMode(t.payment_mode, direction),
      };
    });

    items.sort((a, b) => (b.proposal.best?.score ?? -1) - (a.proposal.best?.score ?? -1));

    return {
      items,
      totals: {
        unmatched: items.filter((i) => i.status === 'unmatched').length,
        matched: items.filter((i) => i.status === 'matched').length,
        autoMatchable: items.filter((i) => i.proposal.autoMatchable).length,
        ambiguous: items.filter((i) => i.proposal.ambiguous).length,
      },
    };
  });
}

/**
 * Propose a match for one bank line, running the layers in order.
 *
 * Layer 0 is checked first and short-circuits everything: a Decentro webhook
 * knew the answer at creation time (BR-12), so scoring it would be inventing
 * uncertainty that does not exist.
 */
export async function proposeMatch(
  firmId: string, bankTransactionId: string,
): Promise<MatchProposal & { bankTransactionId: string; amount: string }> {
  return withFirm(firmId, async (c) => {
    const t = await c.query(
      `SELECT bt.*, (bt.debit + bt.credit)::text AS amount
       FROM bank_transactions bt WHERE bt.id = $1`, [bankTransactionId]);
    if (t.rowCount === 0) throw new ValidationError('bank transaction not found', 'BV-6');
    const txn = t.rows[0]!;

    // Layer 0 — known link. Confidence is definitional, not scored.
    if (txn.source === 'decentro_webhook') {
      const linked = await openInvoiceCandidates(c, txn.client_id, { partyId: txn.party_id });
      const exact = linked.find((cand) => cand.reference === txn.reference_number);
      if (exact) {
        return {
          bankTransactionId, amount: txn.amount, layer: 'known_link' as const,
          best: { ...exact, score: 100, signals: ['virtual-account collection, link known at creation'] },
          runnersUp: [], ambiguous: false, autoMatchable: true,
          reason: 'BR-12: the virtual account identifies the payer and the invoice',
        };
      }
    }

    // Layers 1–2 share the candidate set; scoring separates them.
    const direction = paise(txn.credit) > 0n ? 'inbound' : 'outbound';
    const candidates = direction === 'inbound'
      ? await openInvoiceCandidates(c, txn.client_id)
      : await openBillCandidates(c, txn.client_id);

    const party = txn.counterparty_name
      ? (await c.query<{ id: string }>(
          `SELECT id FROM parties WHERE client_id = $1
             AND (name ILIKE $2 OR legal_name ILIKE $2) LIMIT 1`,
          [txn.client_id, `%${txn.counterparty_name}%`])).rows[0]?.id ?? null
      : null;

    return {
      bankTransactionId, amount: txn.amount,
      ...rank(
        { amount: txn.amount, txnDate: txn.txn_date.toISOString().slice(0, 10),
          reference: txn.reference_number, partyId: party },
        candidates),
    };
  });
}
