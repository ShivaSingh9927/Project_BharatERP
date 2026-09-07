/**
 * Turn a PDF into proposed purchase bills — and never post one on a guess.
 *
 * Spec: bills-and-expenses.md §4.4 · provenance.md PR-7
 *
 * This is the join between the reading side and the posting side. It reads a
 * file, splits it into the documents it contains, reads each one's tax profile
 * and line-item table, matches the supplier, and produces a `CreateBillInput`
 * for each document where every one of those succeeded.
 *
 * ── It proposes; it does not decide ────────────────────────────────────────
 *
 * A proposal is either READY, with a complete input a caller can post, or it
 * carries `blockers` naming exactly what a human has to supply. Nothing is
 * defaulted into existence:
 *
 *   - **The expense account is never inferred.** It decides ITC eligibility
 *     (G-3), and inferring it would mean inferring whether input credit is
 *     claimable. A wrong account produces a bill that posts, reconciles, and
 *     claims credit it is not entitled to.
 *   - **An unknown supplier is not created.** A party carries a GSTIN, a state
 *     and a ledger account, and inventing one on the strength of a GSTIN read
 *     off a PDF would put an unreviewed master record behind every future bill
 *     from that vendor.
 *   - **A GSTIN that fails its check digit stops the proposal**, even when a
 *     party happens to match. That check exists because a transposed GSTIN
 *     passes every arithmetic test there is.
 *
 * ── Why the posted figures can be trusted ──────────────────────────────────
 *
 * Three independent checks have to agree before a bill exists:
 *
 *   1. The table's own arithmetic tied (`invoiceTable` gate 2), or there is no
 *      proposal at all.
 *   2. `claimedTotals` carries the document's printed figures into
 *      `createBill`, whose PB-4 check recomputes tax from taxable × rate and
 *      compares. So the rate this module derives is verified by code that did
 *      not derive it.
 *   3. The GSTIN check digit and the tax names read from running text
 *      (`invoiceTax`) must agree with the intra/inter-state split `createBill`
 *      derives from the GSTINs themselves.
 *
 * Any one of those alone would be a number nobody checked.
 */

import { withFirm } from '../db/pool.ts';
import { validateGstin } from './gstin.ts';
import { paise, money } from './tax.ts';
import { parseAmount } from '../parse/values.ts';
import { createBill, contentHash, type CreateBillInput, type BillLineInput,
         type CreatedBill } from './bills.ts';
import { ValidationError } from './types.ts';
import { extractPdfWords, type WordPage } from '../parse/pdfWords.ts';
import { extractPdfText } from '../parse/pdf.ts';
import { splitDocuments, type DocumentSegment } from '../parse/documentSplit.ts';
import { extractTaxProfile, taxProfileWarnings, type TaxProfile } from '../parse/invoiceTax.ts';
import { extractInvoiceDate } from '../parse/invoiceDate.ts';
import { recordProvenance } from './provenance.ts';
import { readInvoiceTableFromWords, type InvoiceTable, type TableRow } from '../parse/invoiceTable.ts';
import { readInvoiceTableFromLlm, type LlmClient } from '../parse/llmTable.ts';

export interface BillProposal {
  /** Position of this document within the file, in page order. */
  index: number;
  pages: number[];
  documentNumber: string | null;
  supplierGstin: string | null;
  /** sha256 of the whole file — BE-2 deduplicates on content, not filename. */
  fileHash: string;
  taxProfile: TaxProfile;
  table: InvoiceTable;
  /** Matched supplier, when the GSTIN identified exactly one. */
  partyId: string | null;
  partyName: string | null;
  /** Empty when the proposal is ready to post. */
  blockers: string[];
  /** Worth a reviewer's attention, but not blocking. */
  warnings: string[];
  /** Present only when `blockers` is empty. */
  input: CreateBillInput | null;
  /**
   * How the figures were read. `llm` means the document left the building, so
   * it belongs on the record beside the figures rather than in a log file.
   */
  readBy: 'coordinates' | 'llm';
  llmProvenance?: { provider: string; model: string };
  /**
   * Whether a second, independent reader confirmed these figures.
   * `unavailable` means it was asked and could not read the document — which
   * is not the same as agreeing, and is recorded rather than glossed.
   */
  crossChecked: 'off' | 'agreed' | 'disagreed' | 'unavailable';
  /** The date read off the document, and how it was settled (PR-7). */
  billDate?: string;
  billDateBasis?: string;
}

export interface ProposeInput {
  clientId: string;
  file: Buffer;
  password?: string;
  createdBy: string;
  /**
   * Which expense account these lines post to. Required, and deliberately so:
   * see the note above. One account for the whole file is the common case —
   * a reviewer splitting a bill across accounts edits the proposal.
   */
  expenseAccountId: string;
  /**
   * Optional extractor of last resort, tried ONLY when the deterministic paths
   * refuse and ONLY when the firm has switched it on. Passing a client is not
   * consent — `firm_ai_settings` is.
   */
  llm?: LlmClient;
  /**
   * Where the original file lives — the auditor's evidence (Lesson 11). Used
   * to register the document so every posted figure can point back at it.
   */
  sourceUri?: string;
}

/**
 * Has this firm agreed that documents may be sent to a third-party model?
 *
 * No row means no. The default has to be off: uploading a client's invoice is
 * a DPDP decision belonging to the firm as data fiduciary, and a default that
 * exports documents would be making it for them.
 */
export interface LlmSettings { extraction: boolean; crossCheck: boolean }

export async function llmSettings(firmId: string): Promise<LlmSettings> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ extraction: boolean; cross_check: boolean }>(
      `SELECT llm_extraction AS extraction, llm_cross_check AS cross_check
         FROM firm_ai_settings WHERE firm_id = $1`, [firmId]);
    const row = r.rows[0];
    return {
      extraction: row?.extraction === true,
      crossCheck: row?.cross_check === true,
    };
  });
}

/** Kept for callers that only care whether documents may leave at all. */
export async function llmExtractionEnabled(firmId: string): Promise<boolean> {
  return (await llmSettings(firmId)).extraction;
}

/**
 * Switches it on, naming who decided.
 *
 * The CHECK on `firm_ai_settings` makes the attribution mandatory rather than
 * customary — an unattributed decision to export client documents is exactly
 * what that table exists to prevent.
 */
export async function enableLlmExtraction(
  firmId: string,
  opts: { provider: string; model: string; enabledBy: string;
          crossCheck?: boolean },
): Promise<void> {
  await withFirm(firmId, async (c) => {
    await c.query(
      `INSERT INTO firm_ai_settings
         (firm_id, llm_extraction, llm_cross_check,
          llm_provider, llm_model, enabled_by, enabled_at)
       VALUES ($1, true, $2, $3, $4, $5, now())
       ON CONFLICT (firm_id) DO UPDATE SET
         llm_extraction = true, llm_cross_check = $2,
         llm_provider = $3, llm_model = $4,
         enabled_by = $5, enabled_at = now()`,
      [firmId, opts.crossCheck ?? false, opts.provider, opts.model, opts.enabledBy]);
  });
}

/** The money roles two readers must agree on before a bill may post. */
const CROSS_CHECKED: Array<'taxable' | 'cgst' | 'sgst' | 'igst' | 'cess' | 'total'> =
  ['taxable', 'cgst', 'sgst', 'igst', 'cess', 'total'];

/**
 * Compares two readings of the same document and names every figure that
 * differs.
 *
 * A missing value on one side counts as a difference. That is the whole point:
 * the truncation defect showed up as one reader finding 327.96 where the other
 * found 50.00, and it would have shown up equally as one finding a CGST column
 * the other missed entirely.
 */
export function compareReadings(
  a: InvoiceTable, b: InvoiceTable,
): string[] {
  const out: string[] = [];
  for (const role of CROSS_CHECKED) {
    const x = a.sums[role], y = b.sums[role];
    if (x === y) continue;
    if (x === undefined && y === undefined) continue;
    out.push(`${role}: ${x ?? 'not found'} vs ${y ?? 'not found'}`);
  }
  return out;
}

/**
 * Which GST rate explains a taxable value and a tax amount.
 *
 * ── Why this is not a division ─────────────────────────────────────────────
 *
 * It was, and a real invoice broke it inside a minute. A Flipkart platform fee
 * of ₹4.24 carries ₹0.76 of IGST, and the document says 18%. Dividing gives
 * 17.92% — which reproduces 0.76 exactly, because 4.24 × 17.92% = 0.7598 and
 * 4.24 × 18% = 0.7632 and both round to the same paise.
 *
 * So an exactness check is not enough on small amounts: several rates land on
 * the same figure, and the division picks the one that is almost certainly
 * wrong. The tax would still have posted correctly — but the RATE is a filed
 * field, it appears on the bill and in GSTR-2B reconciliation, and 17.92% is
 * not a rate that exists.
 *
 * A GST rate is not a continuum. It comes from a fixed schedule. So the
 * question is not "what quotient is this" but "which SCHEDULED rate produces
 * this tax" — and the rate printed on the document, when it could be read, is
 * the first candidate tried.
 *
 * ── And the tax is rounded PER LINE, then summed ──────────────────────────
 *
 * A second real invoice made that unavoidable. Three fees at 18% —
 * 50.00 -> 9.00, 109.32 -> 19.68, 168.64 -> 30.36 — sum to a taxable value of
 * 327.96 and a tax of 59.04. But 327.96 x 18% is 59.0328, which rounds to
 * 59.03. No rate on the schedule explains the aggregate, and the document is
 * not wrong: each line was rounded in its own right before being added.
 *
 * So candidates are tested the way the invoice was computed — line by line,
 * summed afterwards. Passing a single aggregate still works and is treated as
 * a one-line document.
 *
 * Returns null when no candidate reproduces the tax to the exact paise, or
 * when more than one does and the document did not say which. `createBill`
 * recomputes tax from whatever comes back here, so a rate that is merely close
 * would produce a bill disagreeing with the paper by a rounding error nobody
 * could explain a year later.
 */
const STATUTORY_RATES = [
  '0', '0.25', '1.5', '3', '5', '12', '18', '28',
] as const;
/*
 * 12 and 28 were collapsed by the 2025-09-22 rationalisation (G-19b) and are
 * kept deliberately: a bill for an earlier period was charged at the rate in
 * force then, and this function has to be able to recognise it.
 */

/**
 * Total tax at `rate`, computed the way the law computes it.
 *
 * An intra-state supply is not taxed once at 18%. It is taxed at 9% for the
 * centre and 9% for the state, each rounded to the paisa in its own right, and
 * the two halves are then added. That is not the same number: on a taxable
 * value of ₹105.94, two 9% halves give 9.53 + 9.53 = 19.06, while a single 18%
 * gives 19.07.
 *
 * A real Flipkart invoice sits exactly on that paisa. Computing it as one 18%
 * charge made 18% look wrong, no scheduled rate fitted, and a perfectly good
 * bill was refused.
 */
function taxAt(taxableP: bigint, rate: string, intraState: boolean): bigint {
  const hundredths = paise(rate);              // "18" -> 1800
  if (!intraState) return (taxableP * hundredths + 5000n) / 10000n;
  const half = (taxableP * (hundredths / 2n) + 5000n) / 10000n;
  return half * 2n;
}

export function deriveGstRate(
  taxable: string | readonly string[], tax: string,
  readRates: readonly string[] = [], intraState = false,
): string | null {
  const lines = (Array.isArray(taxable) ? taxable : [taxable as string])
    .map((v) => paise(v));
  if (lines.length === 0 || lines.reduce((a, b) => a + b, 0n) === 0n) return null;
  const tx = paise(tax);

  // Rounded per line, then summed — the way the vendor's system did it.
  const totalAt = (rate: string): bigint =>
    lines.reduce((sum, lineP) => sum + taxAt(lineP, rate, intraState), 0n);

  /*
   * The document's own word first: if it states a rate and that rate produces
   * the tax printed beside it, there is nothing to infer.
   *
   * "Produces" allows a paisa per component per line, and only here — for a
   * rate the document actually printed. Vendors price backwards from a
   * round-rupee total, so the printed tax can sit a paisa off the rate printed
   * next to it: a Flipkart appliance states 9% and 727.54 where 9% of 8083.90
   * is 727.55, and refusing it made the software right and the invoice wrong,
   * which is the wrong way round for a purchase bill.
   *
   * The inferred search below takes the same slack, and is protected by
   * something better than exactness: it must fit EXACTLY ONE scheduled rate.
   *
   * Exactness looked like the safeguard and was not. It rejected an appliance
   * invoice whose 18% works out to 727.55 a half where the document prints
   * 727.54 — the same vendor rounding the printed-rate branch above forgives,
   * refused only because that document states its rate as the 9% half rather
   * than the 18% pair, so there was nothing to match against.
   *
   * The danger exactness was guarding against is real but is uniqueness's job:
   * on a small enough line two neighbouring rates can both land within a
   * paisa, and the wrong rate misfiles the credit in GSTR-2, where the figure
   * is right and the classification is not. When that happens more than one
   * candidate fits, `fits.length === 1` fails, and the document is refused —
   * which is the correct answer and a tighter one than exactness gave.
   */
  const slack = BigInt(lines.length) * (intraState ? 2n : 1n);
  for (const r of readRates) {
    const at = totalAt(r);
    const diff = at > tx ? at - tx : tx - at;
    if (diff <= slack) return r;
  }

  const fits = STATUTORY_RATES.filter((r) => {
    const at = totalAt(r);
    return (at > tx ? at - tx : tx - at) <= slack;
  });
  return fits.length === 1 ? fits[0]! : null;
}

/**
 * The tax components printed on one row, normalised.
 *
 * Returns undefined when the row breaks out no tax at all, which is the
 * difference between "this line is untaxed" and "this document does not split
 * its tax by line" — only the second is safe to fall back to computation on.
 */
function chargedOn(row: TableRow): BillLineInput['chargedTax'] {
  const out: Record<string, string> = {};
  for (const k of ['cgst', 'sgst', 'igst', 'cess'] as const) {
    const raw = row.by[k]?.trim();
    if (raw === undefined || raw === '') continue;
    try { out[k] = parseAmount(raw).value; } catch { /* gate 1's problem */ }
  }
  /*
   * Some documents name the component in a column of its own instead of
   * heading a column with it. Amazon prints "Tax Type: IGST" beside "Tax
   * Amount: 24.82" rather than an IGST column, so looking only for named
   * columns found nothing and the supplier's figure was silently replaced by
   * our own — the exact substitution this function exists to make.
   *
   * Only when the row names ONE component. "CGST/SGST" against a single
   * combined figure would have to be halved to be used, and half of a rounded
   * number is not a figure the supplier printed; that case falls back to
   * computation, where the halving is at least done by the rate.
   */
  if (Object.keys(out).length === 0) {
    const named = (row.by.tax_type ?? '').toUpperCase()
      .match(/\b(?:C|S|UT|I)GST\b/g) ?? [];
    const raw = row.by.tax_amount?.trim();
    if (named.length === 1 && raw !== undefined && raw !== '') {
      const k = named[0] === 'UTGST' ? 'sgst' : named[0]!.toLowerCase();
      try { out[k] = parseAmount(raw).value; } catch { /* gate 1's problem */ }
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

async function statesFor(
  firmId: string, clientId: string, partyId: string,
): Promise<{ ours: string | null; theirs: string | null }> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ ours: string | null; theirs: string | null }>(
      `SELECT (SELECT state_code FROM client_registrations
                WHERE client_id = $1 AND is_primary LIMIT 1) AS ours,
              (SELECT state_code FROM parties WHERE id = $2) AS theirs`,
      [clientId, partyId]);
    return r.rows[0] ?? { ours: null, theirs: null };
  });
}

async function findSupplier(
  firmId: string, clientId: string, gstin: string,
): Promise<{ id: string; name: string } | null> {
  return withFirm(firmId, async (c) => {
    /*
     * Suppliers only, and exactly one.
     *
     * `party_type` has no 'both' value — a party is a customer, a supplier or
     * an employee — so a vendor who is also a customer needs two rows today.
     * Matching a 'customer' row here would attach a purchase bill to the
     * wrong ledger account, so it is left unmatched and reported as unknown.
     */
    const r = await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM parties
       WHERE client_id = $1 AND gstin = $2 AND party_type = 'supplier'`,
      [clientId, gstin]);
    return r.rowCount === 1 ? r.rows[0]! : null;
  });
}

/** Reads a file and proposes one bill per document it contains. */
export async function proposeBills(
  firmId: string, input: ProposeInput,
): Promise<BillProposal[]> {
  const fileHash = contentHash(input.file);
  const pages = extractPdfWords(input.file, input.password);
  const text = extractPdfText(input.file, input.password);
  const segments = splitDocuments(text);

  const out: BillProposal[] = [];
  for (const seg of segments) {
    out.push(await proposeFromDocument(firmId, input, seg, pages, fileHash, text));
  }
  return out;
}

/**
 * Proposes one bill from one already-split document.
 *
 * Exported so it can be exercised against constructed segments and word boxes
 * rather than against a PDF. Every failure mode here — an unknown supplier, a
 * corrupted GSTIN, a table that will not tie — is a decision about what NOT to
 * post, and those are the paths worth testing directly.
 */
export async function proposeFromDocument(
  firmId: string, input: Omit<ProposeInput, 'file' | 'password'>,
  seg: DocumentSegment, pages: WordPage[], fileHash: string,
  fileText?: string,
): Promise<BillProposal> {
  const profile = extractTaxProfile(seg);
  let table = readInvoiceTableFromWords(
    pages.filter((p) => seg.pages.includes(p.number)));

  const blockers: string[] = [];
  const warnings = taxProfileWarnings(seg, profile);
  let readBy: BillProposal['readBy'] = 'coordinates';
  let llmProvenance: { provider: string; model: string } | undefined;
  let crossChecked: BillProposal['crossChecked'] = 'off';

  /*
   * The fallback, in that order: coordinates first, a model only if they
   * failed AND the firm has agreed.
   *
   * Tried second rather than first on purpose. The coordinate path is
   * deterministic, free, leaves the document in the building, and can point at
   * the exact region a figure came from (PR-7). A model can do none of those,
   * so it earns its turn only where the cheaper answer is unavailable.
   */
  const ai = input.llm ? await llmSettings(firmId) : { extraction: false, crossCheck: false };

  if (!table.readable && input.llm && ai.extraction) {
    const attempt = await readInvoiceTableFromLlm(seg.text, input.llm!);
    if (attempt.table.readable) {
      table = attempt.table;
      readBy = 'llm';
      llmProvenance = attempt.provenance;
      warnings.push(
        `the figures on document ${seg.documentNumber ?? seg.index} were read ` +
        `by ${attempt.provenance.provider}/${attempt.provenance.model}, not by ` +
        'this software. They passed the same arithmetic checks, but the ' +
        'document was sent to a third party to obtain them.');
    }
  } else if (table.readable && input.llm && ai.crossCheck) {
    /*
     * Cross-check: read it again, independently, and refuse to post if the two
     * readings differ.
     *
     * A DISAGREEMENT BLOCKS, and that is not caution for its own sake. When
     * this was measured, both readings of the two disputed documents tied
     * arithmetically — 50.00 + 9.00 = 59.00 and 327.96 + 59.04 = 387.00 are
     * each internally consistent — so there is no check available that can
     * pick the right one. We know one of them is wrong and we cannot know
     * which. Posting either would be a coin toss with a provenance trail.
     *
     * A model failing to read the document is NOT a disagreement. It refuses 6
     * of 24 documents in the corpus including a mainstream Indian format, so
     * treating silence as dissent would block bills we read correctly.
     */
    const second = await readInvoiceTableFromLlm(seg.text, input.llm!);
    if (second.table.readable) {
      const diffs = compareReadings(table, second.table);
      if (diffs.length > 0) {
        blockers.push(
          `two independent readings of document ${seg.documentNumber ?? seg.index} ` +
          `disagree — ${diffs.join('; ')}. Both may add up on their own, so no ` +
          'arithmetic check can settle it. Read the document.');
        crossChecked = 'disagreed';
      } else {
        crossChecked = 'agreed';
      }
      llmProvenance = second.provenance;
    } else {
      // Recorded, not treated as assent: nobody confirmed this reading.
      crossChecked = 'unavailable';
    }
  }

  /*
   * The date. Previously TODAY, with a comment telling a reviewer to fix it —
   * the worst-filled field in the pipeline, because a wrong date lands the
   * bill in the wrong return period and nothing downstream can tell.
   *
   * `fileText` is passed so the day-first/month-first question is settled from
   * the whole file: how dates are arranged is a property of whatever generated
   * the PDF, and one PDF has one generator.
   */
  const dateRead = extractInvoiceDate(seg.text, fileText);
  if (dateRead.date === undefined) {
    blockers.push(`the invoice date could not be read — ${dateRead.reason}`);
  }

  // --- supplier ------------------------------------------------------------
  let partyId: string | null = null;
  let partyName: string | null = null;

  if (seg.supplierGstin === null) {
    /*
     * A foreign supplier: no GSTIN, no GST. These are imports of service and
     * belong on the reverse-charge path — a valid bill, but one whose supplier
     * cannot be found by GSTIN and whose tax the recipient owes. Blocked here
     * rather than treated as an error.
     */
    blockers.push(
      'no supplier GSTIN appears on this document. If the supplier is outside ' +
      'India this is an import of service and the tax falls on the recipient ' +
      'under reverse charge — choose the supplier by hand.');
  } else {
    const check = validateGstin(seg.supplierGstin);
    if (!check.valid) {
      // Nothing downstream catches a corrupted identifier: every arithmetic
      // test passes on a transposed GSTIN.
      blockers.push(
        `the supplier GSTIN read from this document, "${seg.supplierGstin}", ` +
        `is not valid — ${check.reason}`);
    } else {
      const found = await findSupplier(firmId, input.clientId, seg.supplierGstin);
      if (found) { partyId = found.id; partyName = found.name; }
      else {
        blockers.push(
          `no supplier is on file with GSTIN ${seg.supplierGstin}. Add the ` +
          'vendor first — a party carries a state and a ledger account, and ' +
          'creating one from a PDF would leave an unreviewed master record ' +
          'behind every future bill from them.');
      }
    }
  }

  /*
   * Does the tax the document CHARGED look consistent with the parties' states?
   *
   * This started as a blocker and was wrong, in a way a real document caught
   * within minutes. A Flipkart invoice from a Jharkhand supplier charges CGST
   * and SGST to a client registered in Uttar Pradesh, and it is CORRECT: the
   * intra/inter decision compares the supplier's state with the PLACE OF
   * SUPPLY, not with the recipient's registration. Another document in the
   * same file states "Nature of transaction : INTRA" with a place of supply of
   * Delhi while the recipient sits in UP.
   *
   * So a mismatch here is not evidence of an error, and blocking on it would
   * refuse perfectly good bills. It IS worth a reviewer's eye, because the
   * other explanations — a supplier master with the wrong state, or a vendor
   * charging the wrong tax — survive every arithmetic check there is, and
   * claiming CGST+SGST credit on an inter-state supply is a claim against the
   * wrong government.
   *
   * Place of supply is printed on most of these documents. Reading it would
   * turn this back into a real check; until then it stays a warning that names
   * what would settle it.
   */
  if (partyId !== null && profile.charged === 'yes' && profile.taxKind !== 'mixed') {
    const { ours, theirs } = await statesFor(firmId, input.clientId, partyId);
    if (ours !== null && theirs !== null && (ours === theirs) !== (profile.taxKind === 'intra')) {
      warnings.push(
        `this document charges ${profile.taxKind === 'intra' ? 'CGST and SGST' : 'IGST'}, ` +
        `while the supplier is registered in state ${theirs} and the client in ` +
        `${ours}. That can be right — the split follows the place of supply, ` +
        'not the recipient\'s registration — but check the place of supply on ' +
        'the document before claiming credit.');
    }
  }

  // --- figures -------------------------------------------------------------
  if (!table.readable) {
    blockers.push(`the line-item table could not be read: ${table.reason}`);
  }

  /*
   * Whatever the reader accepted but wants a human to see — today only a
   * rounding difference between the parts and the stated total.
   *
   * This is the whole point of the round-off rule being a warning rather than
   * a tolerance. `computeTotals` has always rounded the payable total to the
   * nearest rupee and posted the difference to Round Off, capped at ₹1 by
   * V-10; the parser was refusing documents the ledger would have handled
   * correctly. Accepting them silently would have been the other error, so the
   * difference travels with the proposal and reaches the approver AT-13
   * already requires.
   */
  if (table.warnings) warnings.push(...table.warnings);

  const lines: BillLineInput[] = [];
  if (table.readable) {
    const taxable = table.sums.taxable!;
    const tax = money(
      paise(table.sums.cgst ?? '0') + paise(table.sums.sgst ?? '0')
      + paise(table.sums.igst ?? '0'));
    // The document's own tax names say how it was computed: CGST+SGST means
    // two halves rounded separately, IGST means one charge.
    /*
     * Per-line taxable values, excluding the document's own totals row — that
     * row restates the sum and counting it would double everything.
     */
    const itemRows = table.rows.filter((r) => r !== table.totals);

    /*
     * Normalised through `parseAmount`, which is what the aggregate path got
     * for free by going via `table.sums`.
     *
     * Without it the cells arrive exactly as printed — "₹66.00" — and every
     * document with a rupee symbol in its taxable column threw
     * `SI-7: not a valid decimal amount` out of the middle of the proposal.
     * Four whole files failed to read at all, which is a louder failure than
     * the aggregate rounding this change was fixing.
     */
    /*
     * The value stays WITH its row.
     *
     * This was two parallel arrays, and the taxable one was filtered while the
     * row one was not — so every wrapped description line dropped a value and
     * shifted the indices, and a line's description and HSN could be read off
     * a different row than its figure. Nothing caught it because both arrays
     * were plausible and the arithmetic only ever looked at the figures.
     */
    const items = itemRows.flatMap((r) => {
      const raw = r.by.taxable?.trim();
      if (raw === undefined || raw === '') return [];
      try { return [{ row: r, taxable: parseAmount(raw).value }]; }
      catch { return []; }
    });
    const lineTaxables = items.map((it) => it.taxable);

    const rate = deriveGstRate(
      lineTaxables.length > 0 ? lineTaxables : taxable,
      tax, profile.rates, profile.taxKind === 'intra');

    if (rate === null) {
      blockers.push(
        `no single GST rate explains this document: tax of ${tax} on a taxable ` +
        `value of ${taxable} matches no scheduled rate exactly` +
        (profile.rates.length > 0
          ? `, including the ${profile.rates.join('% and ')}% printed on it`
          : ' and the document does not state one') +
        '. The supply is probably taxed at more than one rate — enter the ' +
        'lines by hand.');
    } else {
      /*
       * One posted line per item row, each carrying that row's TAXABLE value
       * as its unit price at quantity 1.
       *
       * Not the quantity and unit price printed on the document: those rarely
       * multiply out to the taxable value once a discount is involved, and the
       * taxable value is the figure input credit rests on.
       *
       * But not one aggregate line either, which is what this did first. The
       * vendor rounds each line's tax before adding them, so a single line of
       * 327.96 at 18% computes 59.03 where the document says 59.04 — and PB-4
       * would then reject a bill that is perfectly correct. Posting the same
       * number of lines the document has makes `createBill` round the same way
       * the vendor did.
       *
       * A side benefit worth having: the description and HSN survive per line,
       * which is what GSTR-2B reconciliation needs.
       */
      /*
       * A line worth nothing is not posted.
       *
       * Amazon prints a zero-value shipping line — quantity 1, value 0.00, tax
       * 0.00 — and posting it produced a zero ledger entry, which
       * `ledger_nonzero_ck` refuses outright. One free line took a whole
       * correct bill down with it.
       *
       * Only when the tax is zero too. A line at nil value still carrying tax
       * is a contradiction worth seeing, not something to quietly drop, and it
       * will fail the arithmetic where a human can read about it.
       */
      const postable = items.filter(({ row, taxable: tv }) => {
        if (paise(tv) !== 0n) return true;
        const t = chargedOn(row);
        return t !== undefined
          && Object.values(t).some((v) => paise(v) !== 0n);
      });
      if (postable.length < items.length) {
        warnings.push(
          `${items.length - postable.length} line(s) on this document are worth ` +
          'nothing and carry no tax — free delivery or a waived fee — and are ' +
          'not posted. The figures are unaffected.');
      }

      for (const { row, taxable: tv } of postable) {
        lines.push({
          description: row.by.description?.trim()
            || (seg.documentNumber ? `Purchase per ${seg.documentNumber}` : 'Purchase'),
          hsnSac: row.by.hsn?.replace(/^\D+/, '').trim() || undefined,
          unitPrice: tv,
          quantity: '1',
          gstRate: rate,
          expenseAccountId: input.expenseAccountId,
          /*
           * The tax as printed on this very row, so the ledger records the
           * supplier's figure rather than our re-derivation of it.
           *
           * Only from a row that actually shows the component. An absent cell
           * means the document did not break the tax down that far, and
           * passing '' or 0 would assert the supplier charged nothing.
           */
          chargedTax: chargedOn(row),
        });
      }
    }
  }

  if (profile.resolvedKind === 'unspecified') {
    blockers.push(
      'the document does not say whether it is a tax invoice or a bill of ' +
      'supply, and its rates could not be read — input credit must not be ' +
      'claimed on it unread.');
  }

  const ready = blockers.length === 0;
  return {
    index: seg.index, pages: seg.pages,
    documentNumber: seg.documentNumber, supplierGstin: seg.supplierGstin,
    fileHash, taxProfile: profile, table, partyId, partyName,
    blockers, warnings, readBy, llmProvenance, crossChecked,
    billDate: dateRead.date, billDateBasis: dateRead.basis,
    input: ready ? {
      clientId: input.clientId,
      partyId: partyId!,
      billNumber: seg.documentNumber!,
      billDate: dateRead.date!,          // a blocker above if it could not be read
      isReverseCharge: profile.reverseCharge === true,
      lines,
      createdBy: input.createdBy,
      createdVia: 'ai_proposal',
      // `approvedBy` is deliberately absent here and supplied at posting time.
      // AT-13 is a database CHECK: an `ai_proposal` voucher with no approver
      // cannot be written at all. A proposal is not an approval, and the
      // schema is what makes that true rather than this comment.
      // The document's own printed figures, so PB-4 recomputes and compares
      // rather than trusting what this module derived.
      claimedTotals: {
        cgst: table.sums.cgst, sgst: table.sums.sgst, igst: table.sums.igst,
        grandTotal: table.sums.total,
      },
    } : null,
  };
}

/**
 * Posts a ready proposal, on a named human's authority.
 *
 * `approvedBy` is not optional, and it is not this module that insists: AT-13
 * is a database CHECK that refuses any `ai_proposal` voucher without an
 * approver. Attempting to post without one during development produced
 * `vouchers_ai_needs_approver_ck` from Postgres — the control working exactly
 * as designed, on the first code path that tried to skirt it.
 *
 * "Auto-post" would mean a CA pre-approved the pattern, never that nobody is
 * responsible.
 *
 * `billDate` is now READ from the document, so it is only an override here —
 * for the reviewer who can see something the parser could not. It used to be
 * mandatory and was filled with today's date by every caller.
 */
export async function postProposal(
  firmId: string, proposal: BillProposal,
  opts: { approvedBy: string; billDate?: string; sourceUri?: string },
): Promise<CreatedBill> {
  if (proposal.input === null) {
    throw new ValidationError(
      `this document is not ready to post: ${proposal.blockers.join(' ')}`, 'PB-6');
  }
  const bill = await createBill(firmId, {
    ...proposal.input,
    billDate: opts.billDate ?? proposal.input.billDate,
    approvedBy: opts.approvedBy,
  });

  /*
   * Provenance is written AFTER the bill, and its failure does not unwind it.
   *
   * The ledger is append-only, so by this point the voucher exists and is
   * correct. Losing the audit trail is a real loss and a lesser one than
   * throwing past a completed write — a caller cannot un-post the bill, so an
   * exception here would leave them with a posted voucher and an error to
   * explain. The gap is reported instead.
   */
  try {
    await recordProvenance(firmId, proposal, {
      clientId: proposal.input.clientId,
      voucherId: bill.voucherId,
      sourceUri: opts.sourceUri ?? 'unrecorded',
    });
  } catch (e) {
    bill.warnings.push(
      'the bill posted, but where its figures were read from could not be ' +
      `recorded: ${e instanceof Error ? e.message : String(e)}. The figures ` +
      'are correct; the trail back to the document is missing.');
  }
  return bill;
}
