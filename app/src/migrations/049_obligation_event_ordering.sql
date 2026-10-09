-- Phase 1a hardening: durable identity-request idempotency and serialized
-- workflow event ordering. Events stay append-only.

ALTER TABLE obligation_workflow_events ADD COLUMN event_ordinal bigint;
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY obligation_id ORDER BY recorded_at, id
  ) AS ordinal
  FROM obligation_workflow_events
)
UPDATE obligation_workflow_events e
   SET event_ordinal = ranked.ordinal
  FROM ranked
 WHERE ranked.id = e.id;
ALTER TABLE obligation_workflow_events ALTER COLUMN event_ordinal SET NOT NULL;
ALTER TABLE obligation_workflow_events
  ADD CONSTRAINT obligation_workflow_event_ordinal_positive CHECK (event_ordinal > 0),
  ADD CONSTRAINT obligation_workflow_event_ordinal_unique UNIQUE (obligation_id, event_ordinal);
DROP INDEX obligation_workflow_history;
CREATE INDEX obligation_workflow_history
  ON obligation_workflow_events (obligation_id, event_ordinal);

CREATE TABLE obligation_identity_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  obligation_id uuid NOT NULL,
  identity_key text NOT NULL CHECK (length(identity_key) BETWEEN 1 AND 200),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, client_id, idempotency_key),
  FOREIGN KEY (obligation_id, firm_id, client_id)
    REFERENCES obligation_timeline_items(id, firm_id, client_id)
);

ALTER TABLE obligation_identity_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE obligation_identity_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY obligation_identity_requests_firm_isolation
  ON obligation_identity_requests
  USING (firm_id = current_firm_id())
  WITH CHECK (firm_id = current_firm_id());
GRANT SELECT, INSERT ON obligation_identity_requests TO bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON obligation_identity_requests FROM bharaterp_app;
