-- Human-confirmed document class history is distinct from AI suggestions.
CREATE TABLE document_class_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  source_document_id uuid NOT NULL REFERENCES source_documents(id),
  document_class text NOT NULL CHECK (document_class IN
    ('bank_statement','purchase_bill','sales_invoice','expense_receipt',
     'tds_document','gst_document','payroll','contract_legal','other','uncertain')),
  confirmed_by uuid NOT NULL REFERENCES users(id),
  confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_class_reviews_latest
  ON document_class_reviews (source_document_id, confirmed_at DESC);
ALTER TABLE document_class_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_class_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY document_class_reviews_firm_isolation
  ON document_class_reviews
  USING (firm_id = current_firm_id())
  WITH CHECK (firm_id = current_firm_id());
GRANT SELECT, INSERT ON document_class_reviews TO bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON document_class_reviews FROM bharaterp_app;
