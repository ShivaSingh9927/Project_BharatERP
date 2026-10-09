-- Client-scoped Nexus email preferences and a durable, non-sending outbox.
-- Recipient verification is a human review gate: the existing user/email
-- schema does not prove mailbox ownership or alert-delivery authorization.

CREATE TABLE nexus_alert_email_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL,
  recipient_email text NOT NULL CHECK (recipient_email = lower(btrim(recipient_email))
    AND recipient_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  email_enabled boolean NOT NULL DEFAULT false,
  verification_status text NOT NULL DEFAULT 'pending_review'
    CHECK (verification_status IN ('pending_review', 'verified', 'rejected')),
  verification_note text CHECK (verification_note IS NULL OR length(verification_note) <= 500),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, client_id, recipient_email),
  UNIQUE (id, firm_id, client_id),
  FOREIGN KEY (client_id, firm_id) REFERENCES clients(id, firm_id),
  CHECK ((verification_status = 'pending_review' AND reviewed_by IS NULL AND reviewed_at IS NULL)
      OR (verification_status <> 'pending_review' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE nexus_alert_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL,
  alert_id uuid NOT NULL,
  preference_id uuid NOT NULL,
  recipient_email text NOT NULL,
  -- Deliberately limited to the deterministic alert copy; no source document,
  -- attachment, inbox body, or accounting record is copied into email payload.
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 160),
  body_text text NOT NULL CHECK (length(body_text) BETWEEN 1 AND 500),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 300),
  delivery_state text NOT NULL CHECK (delivery_state IN
    ('held_disabled', 'held_unverified', 'queued', 'sending', 'retry', 'sent', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, client_id, dedupe_key),
  FOREIGN KEY (alert_id, firm_id, client_id)
    REFERENCES nexus_alert_events(id, firm_id, client_id),
  FOREIGN KEY (preference_id, firm_id, client_id)
    REFERENCES nexus_alert_email_preferences(id, firm_id, client_id)
);

CREATE INDEX nexus_alert_email_outbox_ready
  ON nexus_alert_email_outbox (next_attempt_at, created_at)
  WHERE delivery_state IN ('queued', 'retry');
CREATE INDEX nexus_alert_email_outbox_client_recent
  ON nexus_alert_email_outbox (client_id, created_at DESC);

ALTER TABLE nexus_alert_email_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus_alert_email_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY nexus_alert_email_preferences_firm_isolation
  ON nexus_alert_email_preferences
  USING (firm_id = current_firm_id()) WITH CHECK (firm_id = current_firm_id());

ALTER TABLE nexus_alert_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexus_alert_email_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY nexus_alert_email_outbox_firm_isolation
  ON nexus_alert_email_outbox
  USING (firm_id = current_firm_id()) WITH CHECK (firm_id = current_firm_id());

GRANT SELECT, INSERT, UPDATE ON nexus_alert_email_preferences TO bharaterp_app;
GRANT SELECT, INSERT ON nexus_alert_email_outbox TO bharaterp_app;
REVOKE DELETE, TRUNCATE ON nexus_alert_email_preferences, nexus_alert_email_outbox FROM bharaterp_app;

-- Materialize alert × recipient rows idempotently. This records even held
-- deliveries so each eligible future transition has an auditable disposition.
CREATE FUNCTION enqueue_nexus_alert_email_for_client(p_firm_id uuid, p_client_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO nexus_alert_email_outbox
    (firm_id, client_id, alert_id, preference_id, recipient_email, subject,
     body_text, dedupe_key, delivery_state)
  SELECT a.firm_id, a.client_id, a.id, p.id, p.recipient_email, a.title,
         a.message, a.dedupe_key || ':' || p.id::text,
         CASE WHEN NOT p.email_enabled THEN 'held_disabled'
              WHEN p.verification_status <> 'verified' THEN 'held_unverified'
              ELSE 'queued' END
    FROM nexus_alert_events a
    JOIN nexus_alert_email_preferences p
      ON p.firm_id = a.firm_id AND p.client_id = a.client_id
   WHERE a.firm_id = p_firm_id AND a.client_id = p_client_id
  ON CONFLICT (firm_id, client_id, dedupe_key) DO NOTHING;
$$;

CREATE FUNCTION enqueue_nexus_alert_email_after_alert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM enqueue_nexus_alert_email_for_client(NEW.firm_id, NEW.client_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER nexus_alert_email_enqueue_on_alert
  AFTER INSERT ON nexus_alert_events
  FOR EACH ROW EXECUTE FUNCTION enqueue_nexus_alert_email_after_alert();

CREATE FUNCTION enqueue_nexus_alert_email_after_preference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM enqueue_nexus_alert_email_for_client(NEW.firm_id, NEW.client_id);
  UPDATE nexus_alert_email_outbox o
     SET delivery_state = CASE
           WHEN NOT NEW.email_enabled THEN 'held_disabled'
           WHEN NEW.verification_status <> 'verified' THEN 'held_unverified'
           ELSE 'queued' END,
         next_attempt_at = NULL, updated_at = now()
   WHERE o.preference_id = NEW.id
     AND o.delivery_state IN ('held_disabled', 'held_unverified', 'queued', 'retry');
  RETURN NEW;
END;
$$;
CREATE TRIGGER nexus_alert_email_enqueue_on_preference
  AFTER INSERT OR UPDATE OF email_enabled, verification_status
  ON nexus_alert_email_preferences
  FOR EACH ROW EXECUTE FUNCTION enqueue_nexus_alert_email_after_preference();

