-- Every Ask Bharat response is evidence: which user asked, what was asked,
-- whether DeepSeek routed it or BharatERP fell back, and which book records
-- supported the reply. Runs are append-only so a later review sees what the
-- CA actually saw at that time.

CREATE TABLE assistant_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid NOT NULL REFERENCES firms(id),
  client_id       uuid NOT NULL REFERENCES clients(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  question        text NOT NULL CHECK (length(question) BETWEEN 1 AND 500),
  page            text NOT NULL CHECK (length(page) <= 40),
  routing_mode    text NOT NULL CHECK (routing_mode IN
                    ('deepseek', 'deterministic', 'deepseek_fallback')),
  intent          text,
  provider        text,
  model           text,
  answer          text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '[]'::jsonb,
  supported       boolean NOT NULL,
  duration_ms     integer NOT NULL CHECK (duration_ms >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assistant_runs_client_time ON assistant_runs (client_id, created_at DESC);
CREATE INDEX assistant_runs_firm_time ON assistant_runs (firm_id, created_at DESC);

ALTER TABLE assistant_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY assistant_runs_firm_isolation ON assistant_runs
  USING (firm_id = current_setting('app.firm_id', true)::uuid)
  WITH CHECK (firm_id = current_setting('app.firm_id', true)::uuid);

GRANT SELECT, INSERT ON assistant_runs TO bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON assistant_runs FROM bharaterp_app;
