-- 011_registrations.sql
-- A client is one PAN with several GST registrations beneath it.
-- Spec: invoicing.md §14.2, gst-engine.md §15.3 — settled by CA review answer C1.
-- Gap: DEFECT-LOG G-22
--
-- 002_tenancy.sql modelled a client as one GSTIN and said so in a comment:
-- "the most expensive open question remaining". The CA review closed it. A
-- client is a PAN. The income tax return and the balance sheet are filed at PAN
-- level, so a company registered in Delhi and Haryana has ONE set of books, one
-- P&L and one balance sheet — while still filing GSTR-1 and GSTR-3B separately
-- per state.
--
-- Both levels are therefore real, and neither can be dropped:
--
--     clients                  PAN. Books, trial balance, balance sheet.
--       └── client_registrations   GSTIN + state. GST returns, place of supply.
--             └── invoices/bills   reference the registration they belong to.
--
-- Three things break under the old shape, and the third is not a reporting
-- nuisance but a default under the Act:
--
--   1. No company-level financials — only per-state fragments, none of which is
--      a legal entity.
--   2. A Delhi→Haryana branch transfer reads as a sale to an outsider in one
--      set of books and a purchase from an outsider in the other, so it never
--      eliminates and consolidated revenue is overstated.
--   3. TDS thresholds are counted PER PAN. Split across two "clients", a
--      ₹60 lakh purchase counts as ₹30 lakh twice, neither crosses the ₹50 lakh
--      threshold, and no tax is deducted where the Act requires it. The rates
--      seeded in tdsSections.ts compute correctly and would be handed the wrong
--      aggregate.

CREATE TABLE client_registrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid NOT NULL REFERENCES firms(id),
  client_id       uuid NOT NULL REFERENCES clients(id),

  gstin           char(15) NOT NULL,
  -- Redundant with the GSTIN by construction, and kept anyway because almost
  -- every query wants the state without parsing. The CHECK below is what makes
  -- the redundancy safe: the first two characters of a GSTIN ARE the state
  -- code, so the two can never drift apart.
  state_code      char(2)  NOT NULL,

  -- The registration used when a document does not name one, and the state
  -- whose place-of-supply rules apply by default.
  is_primary      boolean  NOT NULL DEFAULT false,

  effective_from  date     NOT NULL DEFAULT '1900-01-01',
  -- Registrations get surrendered. A cancelled one must stay visible, because
  -- last year's returns were filed under it.
  cancelled_on    date,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT state_code_matches_gstin CHECK (state_code = substring(gstin from 1 for 2)),
  CONSTRAINT cancelled_after_effective CHECK (cancelled_on IS NULL OR cancelled_on >= effective_from)
);

CREATE UNIQUE INDEX ON client_registrations (client_id, gstin);
CREATE INDEX ON client_registrations (firm_id);
CREATE INDEX ON client_registrations (client_id);

-- At most one primary per client. A partial unique index rather than a trigger:
-- the database refuses the second one outright.
CREATE UNIQUE INDEX one_primary_per_client
  ON client_registrations (client_id) WHERE is_primary;

-- --------------------------------------------------------------------------
-- Backfill from the old single-GSTIN column, before it is dropped.
-- --------------------------------------------------------------------------
INSERT INTO client_registrations (firm_id, client_id, gstin, state_code, is_primary)
SELECT firm_id, id, gstin, substring(gstin from 1 for 2), true
FROM clients
WHERE gstin IS NOT NULL;

-- --------------------------------------------------------------------------
-- Point the documents at a registration.
-- --------------------------------------------------------------------------

-- NOT NULL: a sales invoice already requires `supplier_gstin`, so it has always
-- been issued under exactly one registration. This records WHICH, rather than
-- leaving it to be re-derived from a string.
ALTER TABLE sales_invoices
  ADD COLUMN registration_id uuid REFERENCES client_registrations(id);

UPDATE sales_invoices si
SET registration_id = cr.id
FROM client_registrations cr
WHERE cr.client_id = si.client_id
  AND cr.gstin = si.supplier_gstin;

-- Anything the GSTIN match missed falls back to the client's primary.
UPDATE sales_invoices si
SET registration_id = cr.id
FROM client_registrations cr
WHERE si.registration_id IS NULL
  AND cr.client_id = si.client_id
  AND cr.is_primary;

ALTER TABLE sales_invoices ALTER COLUMN registration_id SET NOT NULL;

-- NULLABLE, unlike sales. A client below the GST registration threshold has no
-- GSTIN at all and still keeps books and records purchase bills — they simply
-- cannot claim input credit. Forcing a registration here would make the schema
-- refuse a legitimate small business.
ALTER TABLE purchase_bills
  ADD COLUMN registration_id uuid REFERENCES client_registrations(id);

UPDATE purchase_bills pb
SET registration_id = cr.id
FROM client_registrations cr
WHERE cr.client_id = pb.client_id
  AND cr.is_primary;

CREATE INDEX ON sales_invoices (registration_id);
CREATE INDEX ON purchase_bills (registration_id);

-- --------------------------------------------------------------------------
-- Remove the columns that are now wrong.
-- --------------------------------------------------------------------------
-- Dropped rather than deprecated. "The client's GSTIN" is not a thing that
-- exists once a client can have several, and leaving the column would let a
-- query keep reading a stale one and silently produce a document for the wrong
-- state. Every caller is forced to say which registration it means.
--
-- `pan` stays, and becomes the client's real identity.
ALTER TABLE clients DROP COLUMN gstin;
ALTER TABLE clients DROP COLUMN state_code;

COMMENT ON COLUMN clients.pan IS
  'The client IS this PAN. GST registrations hang off client_registrations.';

-- --------------------------------------------------------------------------
-- Tenancy
-- --------------------------------------------------------------------------
ALTER TABLE client_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_registrations FORCE ROW LEVEL SECURITY;

CREATE POLICY firm_isolation ON client_registrations
  USING (firm_id = current_firm_id())
  WITH CHECK (firm_id = current_firm_id());

GRANT SELECT, INSERT, UPDATE ON client_registrations TO bharaterp_app;
