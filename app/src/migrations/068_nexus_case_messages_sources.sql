-- Durable user-facing conversation and scoped evidence references for cases.
-- Message bodies are plain text; this migration adds no action or file storage.
CREATE TABLE nexus_case_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL,
  client_id uuid NOT NULL,
  case_id uuid NOT NULL,
  message_ordinal integer NOT NULL CHECK (message_ordinal > 0),
  actor_type text NOT NULL CHECK (actor_type IN ('user','nexus','system')),
  actor_user_id uuid REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, message_ordinal),
  UNIQUE (firm_id, client_id, idempotency_key),
  FOREIGN KEY (case_id, firm_id, client_id) REFERENCES nexus_cases(id, firm_id, client_id),
  CHECK ((actor_type='user' AND actor_user_id IS NOT NULL) OR (actor_type<>'user' AND actor_user_id IS NULL))
);

CREATE TABLE nexus_case_source_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL,
  client_id uuid NOT NULL,
  case_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('bank_transaction','specialist_task','obligation')),
  source_id uuid NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 240),
  attached_by uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, client_id, idempotency_key),
  UNIQUE (case_id, source_kind, source_id),
  FOREIGN KEY (case_id, firm_id, client_id) REFERENCES nexus_cases(id, firm_id, client_id)
);

CREATE INDEX nexus_case_messages_timeline ON nexus_case_messages(firm_id,client_id,case_id,message_ordinal);
CREATE INDEX nexus_case_sources_timeline ON nexus_case_source_refs(firm_id,client_id,case_id,recorded_at);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['nexus_case_messages','nexus_case_source_refs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (firm_id=current_firm_id()) WITH CHECK (firm_id=current_firm_id())',t||'_firm_isolation',t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON nexus_case_messages,nexus_case_source_refs TO bharaterp_app;
REVOKE UPDATE,DELETE,TRUNCATE ON nexus_case_messages,nexus_case_source_refs FROM bharaterp_app;

CREATE FUNCTION prevent_nexus_case_message_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Nexus case conversation is append-only'; END; $$;
CREATE TRIGGER nexus_case_messages_append_only BEFORE UPDATE OR DELETE ON nexus_case_messages
  FOR EACH ROW EXECUTE FUNCTION prevent_nexus_case_message_mutation();
CREATE TRIGGER nexus_case_sources_append_only BEFORE UPDATE OR DELETE ON nexus_case_source_refs
  FOR EACH ROW EXECUTE FUNCTION prevent_nexus_case_message_mutation();

CREATE FUNCTION validate_nexus_case_message_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='nexus_case_messages' THEN
    IF NEW.actor_type='user' AND NOT EXISTS (
      SELECT 1 FROM users u WHERE u.id=NEW.actor_user_id AND u.firm_id=NEW.firm_id
        AND (u.client_id IS NULL OR u.client_id=NEW.client_id)
    ) THEN RAISE EXCEPTION 'Nexus message actor is outside client scope'; END IF;
  ELSIF TG_TABLE_NAME='nexus_case_source_refs' THEN
    IF NOT EXISTS (
      SELECT 1 FROM users u WHERE u.id=NEW.attached_by AND u.firm_id=NEW.firm_id
        AND (u.client_id IS NULL OR u.client_id=NEW.client_id)
    ) THEN RAISE EXCEPTION 'Nexus source actor is outside client scope'; END IF;
  ELSE
    RAISE EXCEPTION 'unexpected table for Nexus case message scope trigger';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER nexus_case_messages_actor_scope BEFORE INSERT ON nexus_case_messages
  FOR EACH ROW EXECUTE FUNCTION validate_nexus_case_message_scope();
CREATE TRIGGER nexus_case_sources_actor_scope BEFORE INSERT ON nexus_case_source_refs
  FOR EACH ROW EXECUTE FUNCTION validate_nexus_case_message_scope();

CREATE FUNCTION validate_nexus_case_source_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE valid_source boolean := false;
BEGIN
  IF NEW.source_kind='bank_transaction' THEN
    SELECT EXISTS(SELECT 1 FROM bank_transactions WHERE id=NEW.source_id AND firm_id=NEW.firm_id AND client_id=NEW.client_id) INTO valid_source;
  ELSIF NEW.source_kind='specialist_task' THEN
    SELECT EXISTS(SELECT 1 FROM nexus_specialist_tasks WHERE id=NEW.source_id AND firm_id=NEW.firm_id AND client_id=NEW.client_id) INTO valid_source;
  ELSIF NEW.source_kind='obligation' THEN
    SELECT EXISTS(SELECT 1 FROM obligation_timeline_items WHERE id=NEW.source_id AND firm_id=NEW.firm_id AND client_id=NEW.client_id) INTO valid_source;
  END IF;
  IF NOT valid_source THEN RAISE EXCEPTION 'Nexus source is unavailable for this client'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER nexus_case_source_valid BEFORE INSERT ON nexus_case_source_refs
  FOR EACH ROW EXECUTE FUNCTION validate_nexus_case_source_scope();
