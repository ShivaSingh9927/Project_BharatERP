-- The app role intentionally cannot UPDATE case events, so the transition
-- trigger must not take a row lock. Domain appends are serialized with an
-- advisory transaction lock; unique (case_id,event_ordinal) rejects races.
CREATE OR REPLACE FUNCTION validate_nexus_case_event_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state text; expected_ordinal integer;
BEGIN
  SELECT to_state INTO current_state FROM nexus_case_events
    WHERE case_id=NEW.case_id ORDER BY event_ordinal DESC LIMIT 1;
  SELECT COALESCE(MAX(event_ordinal),0)+1 INTO expected_ordinal
    FROM nexus_case_events WHERE case_id=NEW.case_id;
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
