-- Phase 4 foundation: durable bounded task envelopes and immutable run history.
-- No worker, model invocation, or accounting write capability is introduced.

CREATE TABLE nexus_specialist_tasks (
  id uuid PRIMARY KEY,
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL,
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 1000),
  specialist text NOT NULL CHECK (specialist IN ('document','banking','gst','tds','verifier')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','running','verifying','retry_ready','completed','blocked','failed','needs_human_review','cancelled')),
  envelope_schema_version integer NOT NULL DEFAULT 1 CHECK (envelope_schema_version = 1),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object' AND envelope->>'schema_version' IS NOT NULL AND (envelope->>'schema_version')::integer = 1),
  checkpoint jsonb CHECK (checkpoint IS NULL OR jsonb_typeof(checkpoint) = 'object'),
  result_schema_version integer CHECK (result_schema_version IS NULL OR result_schema_version > 0),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  current_attempt integer NOT NULL DEFAULT 0 CHECK (current_attempt BETWEEN 0 AND 4),
  max_attempts integer NOT NULL DEFAULT 4 CHECK (max_attempts = 4),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, client_id, idempotency_key),
  UNIQUE (id, firm_id, client_id),
  FOREIGN KEY (client_id, firm_id) REFERENCES clients(id, firm_id),
  CHECK ((result IS NULL) = (result_schema_version IS NULL))
);

CREATE TABLE nexus_specialist_task_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL,
  task_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 4),
  agent_role text NOT NULL CHECK (agent_role IN ('document','banking','gst','tds','verifier')),
  model_version text CHECK (model_version IS NULL OR length(model_version) <= 160),
  input_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(input_refs) = 'array'),
  outcome text NOT NULL CHECK (outcome IN ('completed','partial','blocked','failed')),
  result_schema_version integer NOT NULL CHECK (result_schema_version > 0),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  verifier_findings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(verifier_findings) = 'array'),
  error_category text CHECK (error_category IS NULL OR length(error_category) <= 80),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, ordinal),
  UNIQUE (firm_id, client_id, idempotency_key),
  UNIQUE (id, firm_id, client_id),
  FOREIGN KEY (task_id, firm_id, client_id)
    REFERENCES nexus_specialist_tasks(id, firm_id, client_id),
  CHECK (ended_at >= started_at)
);

CREATE TABLE nexus_specialist_task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL,
  task_id uuid NOT NULL,
  event_ordinal integer NOT NULL CHECK (event_ordinal > 0),
  event_type text NOT NULL CHECK (event_type IN ('created','attempt_recorded')),
  attempt_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, event_ordinal),
  UNIQUE (firm_id, client_id, idempotency_key),
  FOREIGN KEY (task_id, firm_id, client_id)
    REFERENCES nexus_specialist_tasks(id, firm_id, client_id),
  FOREIGN KEY (attempt_id, firm_id, client_id)
    REFERENCES nexus_specialist_task_attempts(id, firm_id, client_id),
  CHECK ((event_type = 'created' AND attempt_id IS NULL) OR
         (event_type = 'attempt_recorded' AND attempt_id IS NOT NULL))
);

CREATE INDEX nexus_specialist_tasks_client_recent ON nexus_specialist_tasks (firm_id, client_id, created_at DESC);
CREATE INDEX nexus_specialist_attempts_history ON nexus_specialist_task_attempts (task_id, ordinal);
CREATE INDEX nexus_specialist_events_history ON nexus_specialist_task_events (task_id, event_ordinal);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['nexus_specialist_tasks','nexus_specialist_task_attempts','nexus_specialist_task_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (firm_id = current_firm_id()) WITH CHECK (firm_id = current_firm_id())', t || '_firm_isolation', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE, TRUNCATE ON nexus_specialist_tasks, nexus_specialist_task_attempts, nexus_specialist_task_events FROM bharaterp_app;
GRANT SELECT, INSERT ON nexus_specialist_tasks TO bharaterp_app;
GRANT UPDATE (status, checkpoint, result_schema_version, result, current_attempt, updated_at) ON nexus_specialist_tasks TO bharaterp_app;
GRANT SELECT, INSERT ON nexus_specialist_task_attempts, nexus_specialist_task_events TO bharaterp_app;

CREATE FUNCTION prevent_nexus_task_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Nexus task history is append-only'; END;
$$;
CREATE TRIGGER nexus_specialist_attempts_append_only BEFORE UPDATE OR DELETE ON nexus_specialist_task_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_nexus_task_history_mutation();
CREATE TRIGGER nexus_specialist_events_append_only BEFORE UPDATE OR DELETE ON nexus_specialist_task_events
  FOR EACH ROW EXECUTE FUNCTION prevent_nexus_task_history_mutation();
