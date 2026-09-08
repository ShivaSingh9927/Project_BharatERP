/**
 * Reads a GSTR-2B statement from the JSON the GST portal hands out.
 * Spec: bills-and-expenses.md §5
 *
 * A CA can download this file today, by hand, from the portal — so supporting
 * it means reconciliation works before any API access is arranged, and keeps
 * working as a fallback if a fetch ever fails. The live authenticated fetch is
 * a separate concern and produces the same `Gstr2bInvoice[]`, so nothing
 * downstream depends on where the statement came from.
 *
 * The portal's own shape is the input, untrusted like any file: it is data,
 * not instructions, and every figure is re-derived here rather than believed.
 * The parser is deliberately tolerant — the department has published the B2B
 * block with tax at invoice level in some months and only at item level in
 * others — so tax is summed from items when present and taken from the invoice
 * otherwise, and a record that yields no usable figures is skipped rather than
 * guessed at.
 */

import { ValidationError } from '../domain/types.ts';
import { paise, money } from '../domain/tax.ts';
import type { Gstr2bInvoice } from '../domain/gstr2b.ts';

/** DD-MM-YYYY, as the portal writes 2B dates. */
function isoDate(v: unknown): string {
  if (typeof v !== 'string') return '';
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(v.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function num(v: unknown): bigint {
  if (typeof v === 'number') return paise(v.toFixed(2));
  if (typeof v === 'string' && v.trim() !== '') {
    try { return paise(v.trim()); } catch { return 0n; }
  }
  return 0n;
}

/**
 * Pulls the B2B invoices out of a parsed 2B document.
 *
 * Reaches for `data.docdata.b2b` and `docdata.b2b` and a bare `b2b`, because
 * the file is sometimes the envelope the API returns and sometimes just the
 * document inside it. A shape with none of these is an error worth naming, not
 * an empty result to move quietly past.
 */
export function parseGstr2b(raw: unknown): Gstr2bInvoice[] {
  const root = raw as Record<string, any>;
  const b2b =
    root?.data?.docdata?.b2b ?? root?.docdata?.b2b ?? root?.b2b;

  if (!Array.isArray(b2b)) {
    throw new ValidationError(
      'this does not look like a GSTR-2B file — no B2B section was found at ' +
      'data.docdata.b2b. Check it is the 2B JSON downloaded from the portal.',
      'BE-13');
  }

  const out: Gstr2bInvoice[] = [];
  for (const supplier of b2b) {
    const gstin = typeof supplier?.ctin === 'string' ? supplier.ctin.trim() : '';
    const invoices = supplier?.inv;
    if (gstin === '' || !Array.isArray(invoices)) continue;

    for (const inv of invoices) {
      const items = Array.isArray(inv?.items) ? inv.items
        : Array.isArray(inv?.itms) ? inv.itms : [];

      // Tax from the items when the block carries them, from the invoice line
      // otherwise. The item shape nests the figures under `itm_det` in some
      // months and inline in others.
      let igst = 0n, cgst = 0n, sgst = 0n, cess = 0n, txval = 0n;
      if (items.length > 0) {
        for (const it of items) {
          const d = it?.itm_det ?? it;
          igst += num(d?.iamt); cgst += num(d?.camt);
          sgst += num(d?.samt); cess += num(d?.csamt);
          txval += num(d?.txval);
        }
      } else {
        igst = num(inv?.iamt); cgst = num(inv?.camt);
        sgst = num(inv?.samt); cess = num(inv?.csamt);
        txval = num(inv?.txval);
      }

      const number = typeof inv?.inum === 'string' ? inv.inum.trim() : '';
      const date = isoDate(inv?.dt ?? inv?.idt);
      if (number === '' || date === '') continue;

      // 'N' blocks the claim; anything else is treated as available, since the
      // absence of a flag on an ordinary invoice means nothing is wrong.
      const avail = typeof inv?.itcavl === 'string'
        ? inv.itcavl.trim().toUpperCase() !== 'N' : true;

      out.push({
        supplierGstin: gstin,
        invoiceNumber: number,
        invoiceDate: date,
        taxableValue: money(txval),
        igst: money(igst), cgst: money(cgst), sgst: money(sgst), cess: money(cess),
        total: money(num(inv?.val) || (txval + igst + cgst + sgst + cess)),
        itcAvailable: avail,
        itcReason: typeof inv?.rsn === 'string' && inv.rsn.trim() !== ''
          ? inv.rsn.trim() : null,
      });
    }
  }
  return out;
}
