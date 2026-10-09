-- Keep each CA question and founder answer with the document it concerns.
CREATE TABLE document_information_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  document_id uuid NOT NULL REFERENCES source_documents(id),
  requested_by uuid REFERENCES users(id),
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 1000),
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'superseded')),
  answer text CHECK (answer IS NULL OR length(answer) <= 2000),
  attachment_ids uuid[] NOT NULL DEFAULT '{}',
  answered_by uuid REFERENCES users(id),
  answered_at timestamptz
);
CREATE UNIQUE INDEX document_information_one_open
  ON document_information_requests (document_id) WHERE status = 'open';
CREATE INDEX document_information_client_time
  ON document_information_requests (client_id, requested_at DESC);
ALTER TABLE document_information_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_information_firm_isolation ON document_information_requests
  USING (firm_id = current_setting('app.firm_id', true)::uuid)
  WITH CHECK (firm_id = current_setting('app.firm_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON document_information_requests TO bharaterp_app;
REVOKE DELETE, TRUNCATE ON document_information_requests FROM bharaterp_app;

-- Preserve requests already visible in the document inbox before this migration.
INSERT INTO document_information_requests
  (firm_id, client_id, document_id, requested_by, question, requested_at)
SELECT firm_id, client_id, id, review_updated_by, review_note,
       COALESCE(review_updated_at, received_at)
FROM source_documents
WHERE status = 'needs_information' AND review_note IS NOT NULL;
