-- Durable client-scoped work created from assistant conversations.
-- Follow-ups are operational metadata only: they cannot post to ledgers.
CREATE TABLE follow_up_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES firms(id),
  client_id     uuid NOT NULL REFERENCES clients(id),
  created_by    uuid NOT NULL REFERENCES users(id),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  details       text NOT NULL DEFAULT '' CHECK (length(details) <= 2000),
  source_question text CHECK (length(source_question) <= 500),
  source_answer text CHECK (length(source_answer) <= 2000),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
  completed_by  uuid REFERENCES users(id),
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'open' AND completed_by IS NULL AND completed_at IS NULL)
      OR (status = 'completed' AND completed_by IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE INDEX follow_up_items_client_status_time
  ON follow_up_items (client_id, status, created_at DESC);
CREATE INDEX follow_up_items_firm_status_time
  ON follow_up_items (firm_id, status, created_at DESC);

ALTER TABLE follow_up_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY follow_up_items_firm_isolation ON follow_up_items
  USING (firm_id = current_setting('app.firm_id', true)::uuid)
  WITH CHECK (firm_id = current_setting('app.firm_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON follow_up_items TO bharaterp_app;
REVOKE DELETE, TRUNCATE ON follow_up_items FROM bharaterp_app;
