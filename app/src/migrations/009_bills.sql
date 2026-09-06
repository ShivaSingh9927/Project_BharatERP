-- 009_bills.sql
-- Document ingestion, extraction provenance, purchase bills, ITC, TDS.
-- Spec: bills-and-expenses.md

-- ---------------------------------------------------------------------------
-- ITC eligibility. Section 17(5) blocks input credit on certain categories
-- outright — team lunches, club membership, most motor vehicles — regardless
-- of how valid the invoice is. 'conditional' means the answer depends on what
-- business the client is *in* (a transport company CAN claim vehicle ITC), so
-- the system must ask rather than guess. Spec: bills-and-expenses.md §6.2
-- ---------------------------------------------------------------------------
CREATE TYPE itc_eligibility AS ENUM ('eligible', 'blocked', 'conditional');

-- Spec: bills-and-expenses.md §6.3. The verdict from GSTR-2B matching, which
-- gates whether ITC may be claimed at all.
CREATE TYPE gstr2b_match_status AS ENUM (
  'pending', 'exact_match', 'suggested_match', 'mismatch',
  'manual_match', 'missing_in_2b', 'missing_in_books', 'amended', 'ignored'
);

CREATE TYPE bill_approval_status AS ENUM
  ('extracted', 'pending_review', 'approved', 'rejected', 'on_hold');

CREATE TYPE ingest_channel AS ENUM ('email', 'whatsapp', 'upload', 'camera', 'portal');

CREATE TYPE extraction_method AS ENUM ('llamaparse', 'ocr_vlm', 'irp_fetch', 'manual', 'derived');

-- Every expense account declares whether input credit may be claimed on it.
ALTER TABLE accounts ADD COLUMN itc_eligibility itc_eligibility;

-- ---------------------------------------------------------------------------
-- Ingestion. The original document is the auditor's evidence (Lesson 11 —
-- vouching), so it is stored before anything is processed and never altered.
-- Spec: bills-and-expenses.md §4
-- ---------------------------------------------------------------------------
CREATE TABLE source_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           uuid NOT NULL REFERENCES firms(id),
  client_id         uuid NOT NULL REFERENCES clients(id),
  channel           ingest_channel NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  sender            text,                       -- email address or phone number
  original_blob_uri text NOT NULL,
  mime_type         text,
  file_size         bigint,
  page_count        integer,
  -- BE-2: deduplicate on content, not filename. The same bill routinely
  -- arrives twice — emailed by the vendor and photographed by the employee.
  sha256            text NOT NULL,
  status            text NOT NULL DEFAULT 'received',
  linked_voucher_id uuid REFERENCES vouchers(id),
  UNIQUE (client_id, sha256)
);

CREATE INDEX ON source_documents (client_id, received_at);

-- ---------------------------------------------------------------------------
-- Field-level extraction provenance.
--
-- Storing WHERE a value was read from — not merely the value — is what makes
-- highlight-on-the-bill review possible, and that is the primary mechanism by
-- which a CA comes to trust the AI. Bounding boxes exist only at extraction
-- time; they cannot be reconstructed later.
-- Spec: provenance.md PR-3, PR-4, PR-5, PR-6
-- ---------------------------------------------------------------------------
CREATE TABLE extracted_fields (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id uuid NOT NULL REFERENCES source_documents(id),
  field_path         text NOT NULL,          -- 'vendor_gstin', 'line_items[2].hsn'
  -- PR-4: keep both. The raw string proves what the document said; the parsed
  -- value is what the system used. Parsing bugs are invisible without both.
  raw_text           text,
  parsed_value       jsonb,
  page_number        integer,
  -- PR-6: normalised 0-1, not pixels. Images get resized and re-rendered;
  -- pixel coordinates rot.
  bbox               numeric[4],
  confidence         numeric(4,3),
  -- PR-5: not decoration. A value fetched from the IRP against an IRN is
  -- authoritative government data; one read from a photo is probabilistic.
  extraction_method  extraction_method NOT NULL,
  model_version      text,
  extracted_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON extracted_fields (source_document_id);

-- ---------------------------------------------------------------------------
-- TDS section master. Date-ranged, exactly like gst_rates.
--
-- The Income Tax Act 2025 renumbered every section (the old 194C/194J/194I
-- series). A voucher from before the change must still explain itself under
-- the numbering in force at the time, so sections are data, never constants.
-- Spec: bills-and-expenses.md §7.2
-- ---------------------------------------------------------------------------
CREATE TABLE tds_sections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL,          -- as printed on the return
  category_name        text NOT NULL,          -- 'Professional Fees'
  entity_type          text NOT NULL,          -- individual | company | no_pan
  effective_from       date NOT NULL,
  effective_to         date,
  rate                 numeric(6,3) NOT NULL,
  single_threshold     numeric(18,2) NOT NULL DEFAULT 0,
  cumulative_threshold numeric(18,2) NOT NULL DEFAULT 0,
  -- BE-10: once the cumulative threshold is crossed, TDS is generally due on
  -- the ENTIRE cumulative amount, not merely the excess. Configurable because
  -- it is not universal across sections.
  deduct_on_full_cumulative boolean NOT NULL DEFAULT true,
  source_citation      text,
  UNIQUE (category_name, entity_type, effective_from)
);

CREATE INDEX ON tds_sections (category_name, entity_type, effective_from);

CREATE FUNCTION resolve_tds_section(p_category text, p_entity text, p_on date)
RETURNS TABLE (
  section_id uuid, code text, rate numeric,
  single_threshold numeric, cumulative_threshold numeric,
  deduct_on_full_cumulative boolean
) AS $$
  SELECT id, code, rate, single_threshold, cumulative_threshold, deduct_on_full_cumulative
  FROM tds_sections
  WHERE category_name = p_category AND entity_type = p_entity
    AND p_on >= effective_from AND (effective_to IS NULL OR p_on <= effective_to)
  ORDER BY effective_from DESC LIMIT 1;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- Purchase bills.
-- ---------------------------------------------------------------------------
CREATE TABLE purchase_bills (
  voucher_id           uuid PRIMARY KEY REFERENCES vouchers(id),
  firm_id              uuid NOT NULL REFERENCES firms(id),
  client_id            uuid NOT NULL REFERENCES clients(id),
  party_id             uuid NOT NULL REFERENCES parties(id),

  -- Snapshots: what the vendor's document said when we received it.
  supplier_gstin       char(15),
  supplier_legal_name  text NOT NULL,
  bill_number          text NOT NULL,          -- the vendor's number, not ours
  bill_date            date NOT NULL,

  place_of_supply      char(2) NOT NULL,
  is_reverse_charge    boolean NOT NULL DEFAULT false,

  taxable_value        numeric(18,2) NOT NULL,
  total_cgst           numeric(18,2) NOT NULL DEFAULT 0,
  total_sgst           numeric(18,2) NOT NULL DEFAULT 0,
  total_igst           numeric(18,2) NOT NULL DEFAULT 0,
  total_cess           numeric(18,2) NOT NULL DEFAULT 0,
  round_off            numeric(18,2) NOT NULL DEFAULT 0,
  grand_total          numeric(18,2) NOT NULL,

  itc_eligibility      itc_eligibility NOT NULL DEFAULT 'eligible',
  itc_claim_period     text,                   -- 'YYYY-MM' or NULL when deferred
  gstr2b_status        gstr2b_match_status NOT NULL DEFAULT 'pending',

  -- BE-7: ITC claimed on a bill unpaid beyond 180 days must be reversed with
  -- interest. Tracking the due date is what makes the warning possible.
  payment_due_date     date,

  approval_status      bill_approval_status NOT NULL DEFAULT 'pending_review',
  approved_by          uuid REFERENCES users(id),
  approved_at          timestamptz,
  hold_reason          text,
  release_date         date,

  source_document_id   uuid REFERENCES source_documents(id),

  -- PB-2: the same vendor cannot issue the same bill number twice in a year.
  UNIQUE (client_id, party_id, bill_number),
  CONSTRAINT bill_tax_split_ck CHECK (
    NOT (total_igst > 0 AND (total_cgst > 0 OR total_sgst > 0))
  )
);

CREATE INDEX ON purchase_bills (client_id, bill_date);
CREATE INDEX ON purchase_bills (client_id, gstr2b_status);
CREATE INDEX ON purchase_bills (client_id, payment_due_date)
  WHERE approval_status = 'approved';

CREATE TABLE purchase_bill_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id        uuid NOT NULL REFERENCES purchase_bills(voucher_id),
  line_no           integer NOT NULL,
  description       text NOT NULL,
  hsn_sac           text,
  quantity          numeric(18,3) NOT NULL DEFAULT 1,
  uom               text NOT NULL DEFAULT 'NOS',
  unit_price        numeric(18,4) NOT NULL,
  taxable_value     numeric(18,2) NOT NULL,
  gst_rate          numeric(5,2) NOT NULL DEFAULT 0,
  cgst_amount       numeric(18,2) NOT NULL DEFAULT 0,
  sgst_amount       numeric(18,2) NOT NULL DEFAULT 0,
  igst_amount       numeric(18,2) NOT NULL DEFAULT 0,
  cess_amount       numeric(18,2) NOT NULL DEFAULT 0,
  expense_account_id uuid NOT NULL REFERENCES accounts(id),
  itc_eligibility   itc_eligibility NOT NULL DEFAULT 'eligible',
  UNIQUE (voucher_id, line_no)
);

CREATE INDEX ON purchase_bill_items (voucher_id);

-- ---------------------------------------------------------------------------
-- TDS deductions. One row per deduction event, carrying the cumulative state
-- that produced it — so the arithmetic is explainable years later
-- (provenance PR-8).
-- ---------------------------------------------------------------------------
CREATE TABLE tds_deductions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id            uuid NOT NULL REFERENCES firms(id),
  client_id          uuid NOT NULL REFERENCES clients(id),
  voucher_id         uuid NOT NULL REFERENCES vouchers(id),
  party_id           uuid NOT NULL REFERENCES parties(id),
  section_id         uuid NOT NULL REFERENCES tds_sections(id),
  fiscal_year_id     uuid NOT NULL REFERENCES fiscal_years(id),

  payment_amount     numeric(18,2) NOT NULL,
  cumulative_before  numeric(18,2) NOT NULL,
  cumulative_after   numeric(18,2) NOT NULL,
  taxable_base       numeric(18,2) NOT NULL,   -- what the rate was applied to
  rate               numeric(6,3) NOT NULL,
  tds_already_deducted numeric(18,2) NOT NULL DEFAULT 0,
  tds_amount         numeric(18,2) NOT NULL,
  threshold_crossed  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON tds_deductions (client_id, party_id, fiscal_year_id);

-- Row-level security, matching 007.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'source_documents','purchase_bills','tds_deductions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY firm_isolation ON %I
        USING (firm_id = current_firm_id())
        WITH CHECK (firm_id = current_firm_id())
    $f$, t);
  END LOOP;
END $$;

ALTER TABLE purchase_bill_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_bill_items FORCE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON purchase_bill_items
  USING (voucher_id IN (SELECT voucher_id FROM purchase_bills WHERE firm_id = current_firm_id()))
  WITH CHECK (voucher_id IN (SELECT voucher_id FROM purchase_bills WHERE firm_id = current_firm_id()));

ALTER TABLE extracted_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE extracted_fields FORCE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON extracted_fields
  USING (source_document_id IN (SELECT id FROM source_documents WHERE firm_id = current_firm_id()))
  WITH CHECK (source_document_id IN (SELECT id FROM source_documents WHERE firm_id = current_firm_id()));

GRANT SELECT, INSERT ON source_documents, extracted_fields TO bharaterp_app;
GRANT UPDATE (status, linked_voucher_id) ON source_documents TO bharaterp_app;
GRANT SELECT ON tds_sections TO bharaterp_app;
GRANT SELECT, INSERT ON purchase_bills, purchase_bill_items, tds_deductions TO bharaterp_app;
-- Approval state and 2B verdict change after posting; the financial figures do not.
GRANT UPDATE (approval_status, approved_by, approved_at, hold_reason, release_date,
              gstr2b_status, itc_claim_period)
  ON purchase_bills TO bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON purchase_bill_items, tds_deductions FROM bharaterp_app;
REVOKE DELETE, TRUNCATE ON purchase_bills, source_documents, extracted_fields FROM bharaterp_app;
GRANT EXECUTE ON FUNCTION resolve_tds_section(text, text, date) TO bharaterp_app;
