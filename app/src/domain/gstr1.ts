/**
 * GSTR-1 — the outward-supplies return, built from the sales the client made.
 * Spec: invoicing.md §9 · CGST Rule 59
 *
 * The mirror of the purchase side. GSTR-2B told us what suppliers filed against
 * us; GSTR-1 is what WE file — every sale, sorted into the boxes the return
 * demands: registered customers one way, consumers another, exports and credit
 * notes their own. The classification is where a return goes right or wrong, so
 * it is a pure function tested on its own, and the grouping around it reads
 * only from the ledger's own invoices.
 *
 * This does not FILE — filing needs the taxpayer's authenticated session, the
 * same GSP path as the 2B fetch. It produces the return and the figure the
 * client owes; lodging it is a later, deliberate step.
 */

import { withFirm } from '../db/pool.ts';
import { paise, money } from './tax.ts';

/** Where a sale belongs in the return. */
export type Gstr1Section = 'b2b' | 'b2cl' | 'b2cs' | 'cdnr' | 'exp';

export interface Gstr1Item {
  hsn: string; description: string; uqc: string; quantity: string;
  rate: string; taxable: string; igst: string; cgst: string; sgst: string;
  cess: string;
}

export interface Gstr1Invoice {
  voucherId: string;
  invoiceNumber: string;
  invoiceDate: string;
  documentType: string;
  customerGstin: string | null;
  customerName: string;
  placeOfSupply: string;
  supplierState: string;
  isExport: boolean;
  exportType: string | null;
  reverseCharge: boolean;
  grandTotal: string;
  taxable: string;
  igst: string; cgst: string; sgst: string; cess: string;
  items: Gstr1Item[];
}

/** The B2C threshold above which an inter-state consumer sale is itemised
 *  (B2CL) rather than summarised (B2CS): ₹2,50,000. */
const B2CL_THRESHOLD = 25_000_000n;   // paise

/**
 * Which box a sale belongs in — the decision the whole return turns on.
 *
 * Order matters: an export is an export even to a registered buyer, a credit
 * note is filed as a credit note whatever it adjusts, and only then does the
 * registered/consumer split apply. A large inter-state consumer sale is
 * itemised on its own (B2CL); everything else consumer is summarised (B2CS).
 */
export function sectionOf(inv: Pick<Gstr1Invoice,
  'documentType' | 'isExport' | 'customerGstin' | 'placeOfSupply'
  | 'supplierState' | 'grandTotal'>): Gstr1Section {
  if (inv.isExport || inv.documentType === 'export_invoice') return 'exp';
  if (inv.documentType === 'credit_note' || inv.documentType === 'debit_note') {
    return 'cdnr';
  }
  if (inv.customerGstin) return 'b2b';
  const interState = inv.supplierState !== inv.placeOfSupply;
  if (interState && paise(inv.grandTotal) > B2CL_THRESHOLD) return 'b2cl';
  return 'b2cs';
}

export interface Gstr1 {
  period: string;
  b2b: Array<{ ctin: string; name: string; invoices: Gstr1Invoice[] }>;
  b2cl: Gstr1Invoice[];
  /** Consumer sales collapsed to place-of-supply × rate — the return's shape. */
  b2cs: Array<{ pos: string; rate: string; taxable: string; igst: string;
    cgst: string; sgst: string; cess: string }>;
  exp: Gstr1Invoice[];
  cdnr: Gstr1Invoice[];
  /** HSN summary, mandatory in GSTR-1: quantity and value by code and rate. */
  hsn: Array<{ hsn: string; description: string; uqc: string; quantity: string;
    rate: string; taxable: string; igst: string; cgst: string; sgst: string;
    cess: string }>;
  summary: {
    documents: number;
    taxable: string; igst: string; cgst: string; sgst: string; cess: string;
    totalTax: string;
  };
}

const add = (a: string, b: string) => money(paise(a) + paise(b));

/**
 * Assembles the return from a period's invoices. Pure — the database read is
 * the caller's job, so this can be tested on hand-built sales.
 */
export function buildGstr1(period: string, invoices: Gstr1Invoice[]): Gstr1 {
  const b2bByCustomer = new Map<string, { ctin: string; name: string; invoices: Gstr1Invoice[] }>();
  const b2cl: Gstr1Invoice[] = [];
  const b2csMap = new Map<string, { pos: string; rate: string; taxable: string;
    igst: string; cgst: string; sgst: string; cess: string }>();
  const exp: Gstr1Invoice[] = [];
  const cdnr: Gstr1Invoice[] = [];
  const hsnMap = new Map<string, Gstr1['hsn'][number]>();

  let docs = 0;
  let tTaxable = 0n, tIgst = 0n, tCgst = 0n, tSgst = 0n, tCess = 0n;

  for (const inv of invoices) {
    docs += 1;
    tTaxable += paise(inv.taxable); tIgst += paise(inv.igst);
    tCgst += paise(inv.cgst); tSgst += paise(inv.sgst); tCess += paise(inv.cess);

    // HSN summary spans every section — it is the whole return's goods, by code.
    for (const it of inv.items) {
      const key = `${it.hsn}::${it.rate}`;
      const row = hsnMap.get(key) ?? {
        hsn: it.hsn, description: it.description, uqc: it.uqc,
        quantity: '0', rate: it.rate,
        taxable: '0.00', igst: '0.00', cgst: '0.00', sgst: '0.00', cess: '0.00',
      };
      row.quantity = (Number(row.quantity) + Number(it.quantity)).toString();
      row.taxable = add(row.taxable, it.taxable);
      row.igst = add(row.igst, it.igst); row.cgst = add(row.cgst, it.cgst);
      row.sgst = add(row.sgst, it.sgst); row.cess = add(row.cess, it.cess);
      hsnMap.set(key, row);
    }

    switch (sectionOf(inv)) {
      case 'exp': exp.push(inv); break;
      case 'cdnr': cdnr.push(inv); break;
      case 'b2b': {
        const g = b2bByCustomer.get(inv.customerGstin!) ?? {
          ctin: inv.customerGstin!, name: inv.customerName, invoices: [] };
        g.invoices.push(inv);
        b2bByCustomer.set(inv.customerGstin!, g);
        break;
      }
      case 'b2cl': b2cl.push(inv); break;
      case 'b2cs': {
        // Summarised by place of supply and rate, per item.
        for (const it of inv.items) {
          const key = `${inv.placeOfSupply}::${it.rate}`;
          const row = b2csMap.get(key) ?? {
            pos: inv.placeOfSupply, rate: it.rate,
            taxable: '0.00', igst: '0.00', cgst: '0.00', sgst: '0.00', cess: '0.00' };
          row.taxable = add(row.taxable, it.taxable);
          row.igst = add(row.igst, it.igst); row.cgst = add(row.cgst, it.cgst);
          row.sgst = add(row.sgst, it.sgst); row.cess = add(row.cess, it.cess);
          b2csMap.set(key, row);
        }
        break;
      }
    }
  }

  return {
    period,
    b2b: [...b2bByCustomer.values()],
    b2cl,
    b2cs: [...b2csMap.values()],
    exp, cdnr,
    hsn: [...hsnMap.values()],
    summary: {
      documents: docs,
      taxable: money(tTaxable), igst: money(tIgst), cgst: money(tCgst),
      sgst: money(tSgst), cess: money(tCess),
      totalTax: money(tIgst + tCgst + tSgst + tCess),
    },
  };
}

/** Reads a period's sales invoices and builds the return. */
export async function generateGstr1(
  firmId: string, clientId: string, period: string,
): Promise<Gstr1> {
  return withFirm(firmId, async (c) => {
    const inv = await c.query<{
      voucher_id: string; invoice_number: string; invoice_date: string;
      document_type: string; customer_gstin: string | null; customer_name: string;
      place_of_supply: string; supplier_gstin: string; is_export: boolean;
      export_type: string | null; reverse_charge: boolean;
      grand_total: string; taxable: string;
      igst: string; cgst: string; sgst: string; cess: string;
    }>(
      `SELECT si.voucher_id, v.voucher_number AS invoice_number,
              to_char(v.posting_date, 'YYYY-MM-DD') AS invoice_date,
              si.document_type::text, si.customer_gstin, si.customer_legal_name AS customer_name,
              si.place_of_supply, si.supplier_gstin, si.is_export,
              si.export_type::text, si.is_reverse_charge AS reverse_charge,
              si.grand_total::text, si.taxable_value::text AS taxable,
              si.total_igst::text AS igst, si.total_cgst::text AS cgst,
              si.total_sgst::text AS sgst, si.total_cess::text AS cess
         FROM sales_invoices si JOIN vouchers v ON v.id = si.voucher_id
        WHERE si.client_id = $1 AND to_char(v.posting_date, 'YYYY-MM') = $2
        ORDER BY v.posting_date, v.voucher_number`,
      [clientId, period]);

    const items = await c.query<{
      voucher_id: string; hsn_sac: string; description: string; uom: string;
      quantity: string; gst_rate: string; taxable_value: string;
      igst_amount: string; cgst_amount: string; sgst_amount: string; cess_amount: string;
    }>(
      `SELECT sii.voucher_id, sii.hsn_sac, sii.description, sii.uom,
              sii.quantity::text, sii.gst_rate::text, sii.taxable_value::text,
              sii.igst_amount::text, sii.cgst_amount::text, sii.sgst_amount::text,
              sii.cess_amount::text
         FROM sales_invoice_items sii
         JOIN sales_invoices si ON si.voucher_id = sii.voucher_id
         JOIN vouchers v ON v.id = si.voucher_id
        WHERE si.client_id = $1 AND to_char(v.posting_date, 'YYYY-MM') = $2`,
      [clientId, period]);

    const itemsByVoucher = new Map<string, Gstr1Item[]>();
    for (const it of items.rows) {
      const list = itemsByVoucher.get(it.voucher_id) ?? [];
      list.push({
        hsn: it.hsn_sac, description: it.description, uqc: it.uom,
        quantity: it.quantity, rate: it.gst_rate, taxable: it.taxable_value,
        igst: it.igst_amount, cgst: it.cgst_amount, sgst: it.sgst_amount,
        cess: it.cess_amount,
      });
      itemsByVoucher.set(it.voucher_id, list);
    }

    const invoices: Gstr1Invoice[] = inv.rows.map((r) => ({
      voucherId: r.voucher_id, invoiceNumber: r.invoice_number,
      invoiceDate: r.invoice_date, documentType: r.document_type,
      customerGstin: r.customer_gstin, customerName: r.customer_name,
      placeOfSupply: r.place_of_supply, supplierState: r.supplier_gstin.slice(0, 2),
      isExport: r.is_export, exportType: r.export_type,
      reverseCharge: r.reverse_charge, grandTotal: r.grand_total,
      taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess,
      items: itemsByVoucher.get(r.voucher_id) ?? [],
    }));

    return buildGstr1(period, invoices);
  });
}

/** Months that have sales invoices, newest first — the period picker. */
export async function salesPeriods(
  firmId: string, clientId: string,
): Promise<string[]> {
  return withFirm(firmId, async (c) => {
    const r = await c.query<{ period: string }>(
      `SELECT DISTINCT to_char(v.posting_date, 'YYYY-MM') AS period
         FROM sales_invoices si JOIN vouchers v ON v.id = si.voucher_id
        WHERE si.client_id = $1 ORDER BY period DESC`, [clientId]);
    return r.rows.map((x) => x.period);
  });
}
