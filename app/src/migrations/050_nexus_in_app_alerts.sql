-- Durable, client-scoped in-app notices for explicitly recorded work events.
-- No delivery provider or outbound channel is configured by this migration.
CREATE TABLE nexus_alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  source_kind text NOT NULL CHECK (source_kind IN ('follow_up', 'obligation_event')),
  source_id uuid NOT NULL,
  alert_type text NOT NULL CHECK (alert_type IN
    ('follow_up_created', 'follow_up_completed', 'obligation_blocked', 'obligation_needs_human_review')),
  priority text NOT NULL CHECK (priority IN ('routine', 'high')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 240),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, client_id, dedupe_key),
  UNIQUE (id, firm_id, client_id),
  FOREIGN KEY (client_id, firm_id) REFERENCES clients(id, firm_id)
);

CREATE INDEX nexus_alert_events_client_recent
  ON nexus_alert_events (client_id, created_at DESC);
ALTER TABLE nexus_alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus_alert_events FORCE ROW LEVEL SECURITY;
CREATE POLICY nexus_alert_events_firm_isolation ON nexus_alert_events
  USING (firm_id = current_firm_id()) WITH CHECK (firm_id = current_firm_id());
GRANT SELECT, INSERT ON nexus_alert_events TO bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON nexus_alert_events FROM bharaterp_app;
