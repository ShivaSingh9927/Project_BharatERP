-- The shared actor-scope trigger must access only fields present on each row
-- type. PostgreSQL can evaluate record fields in CASE expressions too early.
CREATE OR REPLACE FUNCTION validate_nexus_case_actor_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'nexus_cases' THEN
    actor_id := NEW.requested_by;
  ELSIF TG_TABLE_NAME = 'nexus_case_events' THEN
    actor_id := NEW.actor_user_id;
  ELSE
    RAISE EXCEPTION 'unexpected table for Nexus case actor scope trigger';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = actor_id AND u.firm_id = NEW.firm_id
      AND (u.client_id IS NULL OR u.client_id = NEW.client_id)) THEN
    RAISE EXCEPTION 'Nexus case actor is outside client scope';
  END IF;
  RETURN NEW;
END;
$$;
