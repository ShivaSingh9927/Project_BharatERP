-- A separate, attributed opt-in for sending minimal bill-line data to an AI
-- classifier. Invoice extraction consent does not imply classification consent.
ALTER TABLE firm_ai_settings
  ADD COLUMN llm_bill_classification boolean NOT NULL DEFAULT false,
  ADD COLUMN llm_bill_classification_by uuid REFERENCES users(id),
  ADD COLUMN llm_bill_classification_at timestamptz;

ALTER TABLE firm_ai_settings ADD CONSTRAINT bill_classifier_consent_attributed CHECK (
  NOT llm_bill_classification OR
  (llm_bill_classification_by IS NOT NULL AND llm_bill_classification_at IS NOT NULL
   AND llm_provider IS NOT NULL AND llm_model IS NOT NULL)
);

CREATE TABLE bill_line_ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  source_document_id uuid NOT NULL REFERENCES source_documents(id),
  bill_index integer NOT NULL CHECK (bill_index >= 0),
  line_index integer NOT NULL CHECK (line_index >= 0),
  input_hash text NOT NULL CHECK (length(input_hash) = 64),
  prompt_version text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  account_id uuid REFERENCES accounts(id),
  confidence integer NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  rationale text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bill_line_ai_suggestions_lookup
  ON bill_line_ai_suggestions
    (source_document_id, bill_index, line_index, prompt_version, created_at DESC);
ALTER TABLE bill_line_ai_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_line_ai_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY bill_line_ai_suggestions_firm_isolation
  ON bill_line_ai_suggestions
  USING (firm_id = current_firm_id())
  WITH CHECK (firm_id = current_firm_id());
GRANT SELECT, INSERT ON bill_line_ai_suggestions TO bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON bill_line_ai_suggestions FROM bharaterp_app;

COMMENT ON TABLE bill_line_ai_suggestions IS
  'Append-only, review-only suggestions for purchase bill expense accounts. '
  'Never used to post without human approval.';
