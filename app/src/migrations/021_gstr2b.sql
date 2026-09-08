-- A GSTR-2B statement as filed, and the reconciliation it produced.
-- Spec: bills-and-expenses.md §5 · CGST s.16(2)(aa)
--
-- Two tables. The first is the department's record, stored as received so a
-- reconciliation can be re-run or audited later against exactly what 2B said
-- for a period. The second is one row per invoice on either side of a
-- reconciliation, with the verdict — the working document a reviewer clears.
--
-- Per firm, with RLS: unlike gstin_registry (a public identifier, shared),
-- a client's 2B is that client's confidential filing data.
CREATE TABLE gstr2b_statements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES firms(id),
  client_id     uuid NOT NULL REFERENCES clients(id),
  -- The return period this statement is for: 'YYYY-MM'.
  period        text NOT NULL,
  -- Where it came from: 'portal-json' (downloaded by hand) or a provider name.
  source        text NOT NULL,
  raw           jsonb NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, period, fetched_at)
);

CREATE TABLE gstr2b_recon_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id        uuid NOT NULL REFERENCES firms(id),
  client_id      uuid NOT NULL REFERENCES clients(id),
  statement_id   uuid NOT NULL REFERENCES gstr2b_statements(id),
  period         text NOT NULL,

  -- 'matched' | 'mismatch' | 'in_books_only' | 'in_2b_only'
  status         text NOT NULL,
  supplier_gstin char(15),

  -- The books side, when there is one.
  voucher_id     uuid REFERENCES vouchers(id),
  -- The 2B side, when there is one.
  filed_number   text,
  filed_date     date,
  filed_taxable  numeric(18,2),
  filed_tax      numeric(18,2),
  filed_itc_available boolean,

  note           text NOT NULL,
  -- A reviewer's disposition. Null until someone acts on the line.
  resolved_by    uuid REFERENCES users(id),
  resolved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON gstr2b_recon_lines (client_id, period, status);

ALTER TABLE gstr2b_statements   ENABLE ROW LEVEL SECURITY;
ALTER TABLE gstr2b_recon_lines  ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON gstr2b_statements
  USING (firm_id = current_setting('app.firm_id')::uuid);
CREATE POLICY firm_isolation ON gstr2b_recon_lines
  USING (firm_id = current_setting('app.firm_id')::uuid);

GRANT SELECT, INSERT, UPDATE ON gstr2b_statements  TO bharaterp_app;
GRANT SELECT, INSERT, UPDATE ON gstr2b_recon_lines TO bharaterp_app;
