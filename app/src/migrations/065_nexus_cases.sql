-- Durable Nexus case identity and append-only attributed state history.
-- Cases coordinate review work only; this schema grants no accounting actions.
CREATE TABLE nexus_cases (
  id uuid PRIMARY KEY,
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, client_id, idempotency_key),
  UNIQUE (id, firm_id, client_id),
  FOREIGN KEY (client_id, firm_id) REFERENCES clients(id, firm_id),
  FOREIGN KEY (requested_by) REFERENCES users(id)
);

CREATE TABLE nexus_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL,
  case_id uuid NOT NULL,
  event_ordinal integer NOT NULL CHECK (event_ordinal > 0),
  event_type text NOT NULL CHECK (event_type IN ('created', 'state_changed')),
  from_state text CHECK (from_state IS NULL OR from_state IN
    ('open','working','needs_user','with_ca','blocked','completed','cancelled')),
  to_state text NOT NULL CHECK (to_state IN
    ('open','working','needs_user','with_ca','blocked','completed','cancelled')),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, event_ordinal),
  UNIQUE (firm_id, client_id, idempotency_key),
  FOREIGN KEY (case_id, firm_id, client_id) REFERENCES nexus_cases(id, firm_id, client_id),
  CHECK ((event_type = 'created' AND from_state IS NULL AND to_state = 'open') OR
         (event_type = 'state_changed' AND from_state IS NOT NULL AND from_state <> to_state))
);

CREATE INDEX nexus_cases_client_recent ON nexus_cases (firm_id, client_id, created_at DESC);
CREATE INDEX nexus_case_events_history ON nexus_case_events (case_id, event_ordinal);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['nexus_cases','nexus_case_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (firm_id = current_firm_id()) WITH CHECK (firm_id = current_firm_id())', t || '_firm_isolation', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON nexus_cases, nexus_case_events TO bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON nexus_cases, nexus_case_events FROM bharaterp_app;

CREATE FUNCTION prevent_nexus_case_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Nexus case history is append-only'; END;
$$;
CREATE TRIGGER nexus_case_events_append_only BEFORE UPDATE OR DELETE ON nexus_case_events
  FOR EACH ROW EXECUTE FUNCTION prevent_nexus_case_event_mutation();

CREATE FUNCTION validate_nexus_case_actor_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_id uuid;
BEGIN
  actor_id := CASE WHEN TG_TABLE_NAME = 'nexus_cases' THEN NEW.requested_by ELSE NEW.actor_user_id END;
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = actor_id AND u.firm_id = NEW.firm_id
      AND (u.client_id IS NULL OR u.client_id = NEW.client_id)) THEN
    RAISE EXCEPTION 'Nexus case actor is outside client scope';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nexus_cases_actor_scope BEFORE INSERT ON nexus_cases
  FOR EACH ROW EXECUTE FUNCTION validate_nexus_case_actor_scope();
CREATE TRIGGER nexus_case_events_actor_scope BEFORE INSERT ON nexus_case_events
  FOR EACH ROW EXECUTE FUNCTION validate_nexus_case_actor_scope();

CREATE FUNCTION validate_nexus_case_event_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state text; expected_ordinal integer;
BEGIN
  SELECT to_state INTO current_state FROM nexus_case_events
    WHERE case_id=NEW.case_id ORDER BY event_ordinal DESC LIMIT 1 FOR UPDATE;
  SELECT COALESCE(MAX(event_ordinal),0)+1 INTO expected_ordinal FROM nexus_case_events WHERE case_id=NEW.case_id;
  IF NEW.event_ordinal <> expected_ordinal THEN RAISE EXCEPTION 'invalid Nexus case event ordinal'; END IF;
  IF NEW.event_type='created' THEN
    IF current_state IS NOT NULL OR NEW.event_ordinal<>1 THEN RAISE EXCEPTION 'invalid Nexus case creation event'; END IF;
  ELSE
    IF current_state IS NULL OR NEW.from_state IS DISTINCT FROM current_state THEN RAISE EXCEPTION 'stale Nexus case state'; END IF;
    IF NOT (
      (current_state='open' AND NEW.to_state IN ('working','cancelled')) OR
      (current_state='working' AND NEW.to_state IN ('needs_user','with_ca','blocked','completed','open','cancelled')) OR
      (current_state='needs_user' AND NEW.to_state IN ('working','blocked','cancelled')) OR
      (current_state='with_ca' AND NEW.to_state IN ('working','needs_user','blocked','completed','cancelled')) OR
      (current_state='blocked' AND NEW.to_state IN ('working','needs_user','with_ca','cancelled'))
    ) THEN RAISE EXCEPTION 'invalid Nexus case transition from % to %', current_state, NEW.to_state; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nexus_case_events_transition BEFORE INSERT ON nexus_case_events
  FOR EACH ROW EXECUTE FUNCTION validate_nexus_case_event_transition();
