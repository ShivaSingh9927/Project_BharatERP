-- 008_invoicing.sql
-- Parties, date-ranged rate masters, and sales invoices.
-- Spec: invoicing.md §3, §4, §5

-- ---------------------------------------------------------------------------
-- Party GST category. Drives the GSTR-1 bucket a supply lands in, so the
-- taxonomy is dictated by the return format, not by us. Spec: invoicing.md §3.1
-- ---------------------------------------------------------------------------
CREATE TYPE gst_category AS ENUM (
  'registered_regular',
  'registered_composition',
  'unregistered',
  'sez',
  'overseas',
  'deemed_export',
  'uin_holder',
  'tax_deductor',
  'tax_collector',
  'input_service_distributor'
);

-- Spec: invoicing.md §3.3. Zero-rated and exempt both charge 0% but differ on
-- whether input credit survives — a distinction that matters in the returns.
CREATE TYPE gst_treatment AS ENUM ('taxable', 'zero_rated', 'nil_rated', 'exempt', 'non_gst');

CREATE TYPE sales_document_type AS ENUM (
  'tax_invoice', 'bill_of_supply', 'credit_note', 'debit_note',
  'export_invoice', 'advance_receipt'
);

CREATE TYPE export_type AS ENUM ('with_payment', 'without_payment');

-- ---------------------------------------------------------------------------
-- Parties. Customers and suppliers share a table; ledger_entries.party_id
-- points here.
-- ---------------------------------------------------------------------------
CREATE TABLE parties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           uuid NOT NULL REFERENCES firms(id),
  client_id         uuid NOT NULL REFERENCES clients(id),
  party_type        party_type NOT NULL,
  name              text NOT NULL,
  legal_name        text,
  gstin             char(15),
  pan               char(10),
  gst_category      gst_category NOT NULL DEFAULT 'unregistered',
  state_code        char(2),
  billing_address   jsonb,
  email             text,
  phone             text,
  -- Which control account this party posts to (Debtors / Creditors).
  ledger_account_id uuid NOT NULL REFERENCES accounts(id),
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),

  -- A registered party must carry a GSTIN; an unregistered one must not.
  CONSTRAINT parties_gstin_ck CHECK (
    (gst_category IN ('unregistered','overseas') AND gstin IS NULL)
    OR (gst_category NOT IN ('unregistered','overseas') AND gstin IS NOT NULL)
  )
);

CREATE INDEX ON parties (client_id, party_type);
CREATE UNIQUE INDEX ON parties (client_id, gstin) WHERE gstin IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Date-ranged masters.
--
-- We learned the hard way that compliance identifiers move: the Income Tax Act
-- 2025 renumbered every TDS section. Nothing here may be hardcoded in code.
-- Lookups are always AS OF the document's posting date, never "current", so a
-- credit note issued today against a March invoice uses March's rate.
-- Spec: invoicing.md §2.3, §4.4
-- ---------------------------------------------------------------------------
CREATE TABLE gst_rates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hsn_sac_prefix      text NOT NULL,
  description         text NOT NULL,
  effective_from      date NOT NULL,
  effective_to        date,
  gst_rate            numeric(5,2) NOT NULL,
  cess_rate           numeric(5,2) NOT NULL DEFAULT 0,
  -- Provenance PR-7: cite the rule, not just the number. A figure must be
  -- defensible years later, after rates have changed twice.
  source_notification text,
  CONSTRAINT gst_rates_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX ON gst_rates (hsn_sac_prefix, effective_from);

CREATE TABLE compliance_thresholds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                 text NOT NULL,        -- 'e_invoice_aato', 'b2cl_value', 'hsn_digits_aato'
  effective_from      date NOT NULL,
  effective_to        date,
  value               numeric(18,2) NOT NULL,
  unit                text,
  source_notification text
);

CREATE INDEX ON compliance_thresholds (key, effective_from);

/**
 * Resolve the GST rate for an HSN/SAC as of a date.
 * Longest matching prefix wins, so an 8-digit rule beats a 4-digit one.
 */
CREATE FUNCTION resolve_gst_rate(p_hsn text, p_on date)
RETURNS TABLE (rate_id uuid, gst_rate numeric, cess_rate numeric) AS $$
  SELECT id, gst_rate, cess_rate
  FROM gst_rates
  WHERE p_hsn LIKE hsn_sac_prefix || '%'
    AND p_on >= effective_from
    AND (effective_to IS NULL OR p_on <= effective_to)
  ORDER BY length(hsn_sac_prefix) DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- Sales invoices. Extends `vouchers` rather than duplicating it — the voucher
-- carries date, number, status and the audit linkage. Spec: invoicing.md §4.1
-- ---------------------------------------------------------------------------
CREATE TABLE sales_invoices (
  voucher_id           uuid PRIMARY KEY REFERENCES vouchers(id),
  firm_id              uuid NOT NULL REFERENCES firms(id),
  client_id            uuid NOT NULL REFERENCES clients(id),
  document_type        sales_document_type NOT NULL,
  party_id             uuid NOT NULL REFERENCES parties(id),

  -- Snapshots, deliberately not foreign keys. An invoice is a legal record of
  -- what was true when it was issued; if the customer moves next year, last
  -- year's invoice must still show last year's details. Spec: §4.3
  customer_gstin       char(15),
  customer_legal_name  text NOT NULL,
  billing_address      jsonb,
  supplier_gstin       char(15) NOT NULL,

  gst_category         gst_category NOT NULL,
  place_of_supply      char(2) NOT NULL,
  is_reverse_charge    boolean NOT NULL DEFAULT false,
  is_export            boolean NOT NULL DEFAULT false,
  export_type          export_type,
  shipping_bill_no     text,
  shipping_bill_date   date,
  port_code            text,

  due_date             date,
  payment_terms        text,

  taxable_value        numeric(18,2) NOT NULL,
  total_cgst           numeric(18,2) NOT NULL DEFAULT 0,
  total_sgst           numeric(18,2) NOT NULL DEFAULT 0,
  total_igst           numeric(18,2) NOT NULL DEFAULT 0,
  total_cess           numeric(18,2) NOT NULL DEFAULT 0,
  round_off            numeric(18,2) NOT NULL DEFAULT 0,
  grand_total          numeric(18,2) NOT NULL,

  -- Credit/debit notes reference the invoice they adjust.
  reference_invoice_id uuid REFERENCES vouchers(id),
  reason_code          text,

  -- A line never carries both the CGST/SGST pair and IGST (SI-6). Enforced at
  -- header level too as a cheap structural guard.
  CONSTRAINT invoice_tax_split_ck CHECK (
    NOT (total_igst > 0 AND (total_cgst > 0 OR total_sgst > 0))
  ),
  CONSTRAINT invoice_export_ck CHECK (NOT is_export OR export_type IS NOT NULL)
);

CREATE INDEX ON sales_invoices (client_id, party_id);
CREATE INDEX ON sales_invoices (reference_invoice_id) WHERE reference_invoice_id IS NOT NULL;

CREATE TABLE sales_invoice_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id        uuid NOT NULL REFERENCES sales_invoices(voucher_id),
  line_no           integer NOT NULL,
  description       text NOT NULL,
  hsn_sac           text NOT NULL,          -- mandatory: GSTR-1 needs HSN summary
  quantity          numeric(18,3) NOT NULL,
  uom               text NOT NULL DEFAULT 'NOS',
  unit_price        numeric(18,4) NOT NULL,
  discount_amount   numeric(18,2) NOT NULL DEFAULT 0,
  taxable_value     numeric(18,2) NOT NULL,
  gst_treatment     gst_treatment NOT NULL DEFAULT 'taxable',
  gst_rate          numeric(5,2) NOT NULL,
  cgst_amount       numeric(18,2) NOT NULL DEFAULT 0,
  sgst_amount       numeric(18,2) NOT NULL DEFAULT 0,
  igst_amount       numeric(18,2) NOT NULL DEFAULT 0,
  cess_rate         numeric(5,2) NOT NULL DEFAULT 0,
  cess_amount       numeric(18,2) NOT NULL DEFAULT 0,
  income_account_id uuid NOT NULL REFERENCES accounts(id),

  -- Provenance PR-7: which rate row produced these figures.
  applied_rate_id   uuid REFERENCES gst_rates(id),

  UNIQUE (voucher_id, line_no),
  CONSTRAINT item_tax_split_ck CHECK (
    NOT (igst_amount > 0 AND (cgst_amount > 0 OR sgst_amount > 0))
  )
);

CREATE INDEX ON sales_invoice_items (voucher_id);
CREATE INDEX ON sales_invoice_items (hsn_sac);

-- ---------------------------------------------------------------------------
-- e-Invoice log. Append-only: when the IRP disputes something months later,
-- the payload we sent is the only evidence. Spec: invoicing.md §8.4
-- ---------------------------------------------------------------------------
CREATE TABLE e_invoice_logs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id            uuid NOT NULL REFERENCES firms(id),
  voucher_id         uuid NOT NULL REFERENCES vouchers(id),
  irn                text,
  ack_no             text,
  ack_date           timestamptz,
  signed_invoice     text,      -- government-signed — strongest audit evidence
  signed_qr          text,
  request_payload    jsonb,
  response_payload   jsonb,
  status             text NOT NULL,     -- pending | generated | cancelled | failed
  is_sandbox         boolean NOT NULL DEFAULT true,
  cancelled_at       timestamptz,
  cancel_reason_code text,
  cancel_remark      text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON e_invoice_logs (voucher_id);
CREATE UNIQUE INDEX ON e_invoice_logs (irn) WHERE irn IS NOT NULL;

-- Row-level security, matching 007.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['parties','sales_invoices','e_invoice_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY firm_isolation ON %I
        USING (firm_id = current_firm_id())
        WITH CHECK (firm_id = current_firm_id())
    $f$, t);
  END LOOP;
END $$;

ALTER TABLE sales_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_invoice_items FORCE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON sales_invoice_items
  USING (voucher_id IN (SELECT voucher_id FROM sales_invoices WHERE firm_id = current_firm_id()))
  WITH CHECK (voucher_id IN (SELECT voucher_id FROM sales_invoices WHERE firm_id = current_firm_id()));

GRANT SELECT, INSERT, UPDATE ON parties TO bharaterp_app;
GRANT SELECT ON gst_rates, compliance_thresholds TO bharaterp_app;
GRANT SELECT, INSERT ON sales_invoices, sales_invoice_items, e_invoice_logs TO bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON sales_invoices, sales_invoice_items FROM bharaterp_app;
REVOKE DELETE, TRUNCATE ON e_invoice_logs FROM bharaterp_app;
-- e_invoice_logs needs UPDATE only to record an IRP response against a pending row.
GRANT UPDATE (irn, ack_no, ack_date, signed_invoice, signed_qr, response_payload,
              status, cancelled_at, cancel_reason_code, cancel_remark)
  ON e_invoice_logs TO bharaterp_app;
GRANT EXECUTE ON FUNCTION resolve_gst_rate(text, date) TO bharaterp_app;
