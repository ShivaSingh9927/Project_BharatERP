/**
 * Indian bank narration parsing.
 * Spec: bank-and-reconciliation.md §6
 *
 * Bank narrations look cryptic but are largely semi-structured. A regex
 * library keyed by payment mode extracts the reference, the counterparty and
 * the mode deterministically — fast, free, auditable, and correct.
 *
 * BR-9: rules first, model for the residue. Every line a rule resolves is a
 * model call not made. If lines are reaching the LLM in bulk, the answer is a
 * better rule, not a bigger prompt.
 */

export type PaymentMode =
  | 'upi' | 'neft' | 'rtgs' | 'imps' | 'cheque' | 'cash' | 'nach'
  | 'card' | 'atm' | 'charge' | 'interest' | 'transfer';

export interface ParsedNarration {
  mode: PaymentMode | null;
  /** UTR, cheque number, or UPI reference — whichever the mode carries. */
  reference: string | null;
  counterparty: string | null;
  /** True when a rule matched. False means this line is a candidate for the LLM. */
  matchedByRule: boolean;
  /** Which pattern fired, for provenance. */
  rule: string | null;
}

/**
 * A UTR is 12–22 alphanumerics beginning with the remitting bank's IFSC-ish
 * prefix. Banks are inconsistent about labelling it, so both the labelled and
 * the bare forms are recognised.
 */
const UTR_RE = /\b(?:UTR[:\s-]*)?([A-Z]{4}[A-Za-z]?\d{6,18})\b/;

/**
 * An IFSC is NOT a UTR, and telling them apart matters more than it looks.
 *
 * Real HDFC narration: `UPI-XXXXXXX7140-SBIN0000641-624861888406`. The UPI
 * reference is `624861888406`; `SBIN0000641` is the counterparty bank's IFSC.
 * The UTR pattern matches the IFSC too (four letters plus digits), and because
 * a UTR is preferred over any positional match, the IFSC *overwrote* the
 * correct reference.
 *
 * That corrupts the single strongest matching signal in the product (BR-10),
 * and does so in a specifically nasty way: an IFSC is identical for every
 * transaction from that bank, so instead of one wrong reference you get dozens
 * of transactions all claiming the same one.
 *
 * An IFSC is exactly eleven characters with `0` in the fifth position — that
 * fifth-character rule is what distinguishes it reliably.
 */
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

const isIfsc = (token: string): boolean => IFSC_RE.test(token.toUpperCase());

interface Rule {
  name: string;
  mode: PaymentMode;
  re: RegExp;
  /** Which capture groups hold the reference and the counterparty. */
  reference?: number;
  counterparty?: number;
}

/**
 * Ordered — first match wins. More specific patterns come first, because
 * `NEFT-...` would otherwise be swallowed by a looser transfer rule.
 */
const RULES: Rule[] = [
  // UPI/123456789012/Payment from/ramesh@okhdfcbank/UPI
  { name: 'upi_slash', mode: 'upi',
    re: /^UPI[/-](\d{9,18})[/](?:[^/]*[/])?([^/]*)/i, reference: 1, counterparty: 2 },
  { name: 'upi_generic', mode: 'upi', re: /\bUPI\b.*?\b(\d{9,18})\b/i, reference: 1 },

  // NEFT-CITIN52024061012345-ACME TRADING PVT LTD-UTR123456789
  { name: 'neft', mode: 'neft',
    re: /^NEFT[\s/-]+([A-Z0-9]+)[\s/-]+([^-/]+?)(?:[\s/-]+UTR\s*([A-Z0-9]+))?$/i,
    reference: 1, counterparty: 2 },
  { name: 'rtgs', mode: 'rtgs',
    re: /^RTGS[\s/-]+([A-Z0-9]+)[\s/-]+(.+?)$/i, reference: 1, counterparty: 2 },

  // IMPS/P2A/412345678901/RAMESH KUMAR/HDFC
  { name: 'imps', mode: 'imps',
    re: /^IMPS[/-](?:[A-Z0-9]{3}[/-])?(\d{6,18})[/-]([^/]+)/i, reference: 1, counterparty: 2 },

  { name: 'cheque_paid', mode: 'cheque',
    re: /\bCHQ(?:UE)?\s*(?:PAID|NO|CLG)?\s*[-:.#]?\s*(\d{5,6})\b/i, reference: 1 },
  { name: 'cheque_clearing', mode: 'cheque',
    re: /\bCLG\b.*?\b(\d{6})\b/i, reference: 1 },

  // `ACH C- EXAMPLE COMPANY-32256648` — the trailing digits are the mandate or
  // reference, and gluing them onto the party name (as this first did) makes
  // party resolution fail on every direct debit.
  { name: 'nach', mode: 'nach',
    re: /^(?:NACH|ACH)\s*(?:DR|CR|C|D)?[\s-]+(.+?)(?:[\s-]+MANDATE\s*(\S+)|-(\d{6,}))?$/i,
    counterparty: 1, reference: 3 },

  // `IB BILLPAY DR-HDFC93-361135XXXX4700` — a CREDIT CARD bill paid from the
  // bank account, seen in a real statement. Recognising it matters because of
  // the double-counting hazard in §18.5: this line must settle the Credit Card
  // Payable liability, never an expense account. The card number is already
  // masked by the bank.
  { name: 'card_bill_payment', mode: 'card',
    re: /\b(?:IB\s+)?BILLPAY\s*(?:DR|CR)?\b[\s-]*([A-Z0-9]+)?[\s-]*([0-9X]{8,20})?/i,
    reference: 2 },

  { name: 'atm', mode: 'atm', re: /\bATM\s*(?:WDL|WITHDRAWAL|CASH)\b.*?(\d{4,8})?/i, reference: 1 },
  { name: 'cash', mode: 'cash', re: /^(?:BY|TO)\s+CASH\b/i },

  // INT.PD:01-04-2026 TO 30-06-2026
  { name: 'interest', mode: 'interest',
    re: /\b(?:INT\.?\s*(?:PD|CR|PAID|CREDIT)|INTEREST\s+(?:CREDIT|PAID))\b/i },

  { name: 'charge', mode: 'charge',
    re: /\b(?:SMS\s*CHARGES?|SERVICE\s*CHARGES?|AMC|ACCOUNT\s*MAINT|CHQ\s*RETURN\s*CHARGES?|BANK\s*CHARGES?|DEBIT\s*CARD\s*(?:AMC|FEE))\b/i },

  { name: 'card', mode: 'card', re: /\b(?:POS|DEBIT\s*CARD|CREDIT\s*CARD)\b/i },
  { name: 'transfer', mode: 'transfer', re: /^(?:TRF|TRANSFER|FT)\b[\s/-]*(.*)$/i, counterparty: 1 },
];

/** The first UTR-shaped token that is not actually an IFSC. */
function findUtr(text: string): string | null {
  const re = new RegExp(UTR_RE.source, 'g');
  for (const m of text.matchAll(re)) {
    if (!isIfsc(m[1]!)) return m[1]!;
  }
  return null;
}

/** Strip the bank's padding without touching the stored raw text (BR-11). */
function tidy(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.replace(/\s+/g, ' ').replace(/^[\s\-/:.]+|[\s\-/:.]+$/g, '').trim();
  return s.length > 1 ? s : null;
}

export function parseNarration(raw: string): ParsedNarration {
  const text = raw.trim();

  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;

    // BR-10: the UTR is the strongest matching signal available, so it is
    // preferred over whatever positional reference the rule found. An exact
    // UTR turns a probabilistic match into a certain one.
    const utr = findUtr(text);
    const positional = rule.reference ? tidy(m[rule.reference]) : null;

    // On a UPI line the 12-digit numeric id IS the transaction reference, so a
    // positional match beats a UTR-shaped token there. Everywhere else the UTR
    // is the stronger signal.
    const reference = rule.mode === 'upi'
      ? (positional ?? utr)
      : (utr ?? positional);

    return {
      mode: rule.mode,
      reference,
      counterparty: rule.counterparty ? tidy(m[rule.counterparty]) : null,
      matchedByRule: true,
      rule: rule.name,
    };
  }

  // Nothing fired. A bare UTR is still worth extracting before giving up —
  // it may be all the matcher needs.
  const utr = findUtr(text);
  return {
    mode: null, reference: utr, counterparty: null,
    matchedByRule: false, rule: null,
  };
}

/**
 * Which of these lines actually need a model call.
 *
 * Exposed as its own function because it is the metric that matters for BR-9:
 * if this list is long, the rule library is underdeveloped and the fix is a
 * regex, not a prompt.
 */
export function residueForModel(narrations: string[]): string[] {
  return narrations.filter((n) => !parseNarration(n).matchedByRule);
}
