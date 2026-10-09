-- Document class suggestions have their own attributed opt-in. Other AI
-- settings (bank narration, bill lines, extraction) do not authorize this use.
ALTER TABLE firm_ai_settings
  ADD COLUMN llm_document_classification boolean NOT NULL DEFAULT false,
  ADD COLUMN llm_document_classification_by uuid REFERENCES users(id),
  ADD COLUMN llm_document_classification_at timestamptz;

ALTER TABLE firm_ai_settings ADD CONSTRAINT document_classifier_consent_attributed CHECK (
  NOT llm_document_classification OR
  (llm_document_classification_by IS NOT NULL
   AND llm_document_classification_at IS NOT NULL
   AND llm_provider IS NOT NULL AND llm_model IS NOT NULL)
);

CREATE TABLE document_ai_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  source_document_id uuid NOT NULL REFERENCES source_documents(id),
  input_hash text NOT NULL CHECK (length(input_hash) = 64),
  prompt_version text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  document_class text NOT NULL CHECK (document_class IN
    ('bank_statement','purchase_bill','sales_invoice','expense_receipt',
     'tds_document','gst_document','payroll','contract_legal','other','uncertain')),
  subtype text,
  confidence integer NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  rationale text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_ai_classifications_latest
  ON document_ai_classifications (source_document_id, created_at DESC);
ALTER TABLE document_ai_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_ai_classifications FORCE ROW LEVEL SECURITY;
CREATE POLICY document_ai_classifications_firm_isolation
  ON document_ai_classifications
  USING (firm_id = current_firm_id())
  WITH CHECK (firm_id = current_firm_id());
GRANT SELECT, INSERT ON document_ai_classifications TO bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON document_ai_classifications FROM bharaterp_app;
