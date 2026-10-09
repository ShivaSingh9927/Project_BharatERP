-- Append-only, client-scoped human activity for follow-up work.
ALTER TABLE follow_up_items
  ADD COLUMN blocker_reason text CHECK (blocker_reason IS NULL OR length(blocker_reason) BETWEEN 1 AND 2000),
  ADD COLUMN snoozed_until date;

ALTER TABLE follow_up_items ADD CONSTRAINT follow_up_item_scope_unique
  UNIQUE (id, firm_id, client_id);

CREATE TABLE follow_up_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  follow_up_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  event_type text NOT NULL CHECK (event_type IN ('created', 'blocker_recorded', 'snoozed', 'completed')),
  reason text CHECK (reason IS NULL OR length(reason) <= 2000),
  snoozed_until date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (follow_up_id, firm_id, client_id)
    REFERENCES follow_up_items(id, firm_id, client_id),
  CHECK ((event_type = 'snoozed' AND snoozed_until IS NOT NULL)
      OR (event_type <> 'snoozed' AND snoozed_until IS NULL)),
  CHECK ((event_type = 'blocker_recorded' AND reason IS NOT NULL AND length(reason) > 0)
      OR event_type <> 'blocker_recorded')
);

CREATE INDEX follow_up_events_history ON follow_up_events (follow_up_id, recorded_at, id);
ALTER TABLE follow_up_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_events FORCE ROW LEVEL SECURITY;
CREATE POLICY follow_up_events_firm_isolation ON follow_up_events
  USING (firm_id = current_firm_id())
  WITH CHECK (firm_id = current_firm_id());
GRANT SELECT, INSERT ON follow_up_events TO bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON follow_up_events FROM bharaterp_app;

CREATE FUNCTION prevent_follow_up_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'follow-up events are append-only';
END;
$$;
CREATE TRIGGER follow_up_events_append_only
  BEFORE UPDATE OR DELETE ON follow_up_events
  FOR EACH ROW EXECUTE FUNCTION prevent_follow_up_event_mutation();
