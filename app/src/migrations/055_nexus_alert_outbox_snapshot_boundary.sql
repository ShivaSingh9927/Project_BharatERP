-- An alert is offered only to preferences that exist when it is created.
-- Adding a recipient later must never retroactively email old alert events.
CREATE OR REPLACE FUNCTION enqueue_nexus_alert_email_after_alert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO nexus_alert_email_outbox
    (firm_id, client_id, alert_id, preference_id, recipient_email, subject,
     body_text, dedupe_key, delivery_state)
  SELECT NEW.firm_id, NEW.client_id, NEW.id, p.id, p.recipient_email, NEW.title,
         NEW.message, NEW.dedupe_key || ':' || p.id::text,
         CASE WHEN NOT p.email_enabled THEN 'held_disabled'
              WHEN p.verification_status <> 'verified' THEN 'held_unverified'
              ELSE 'queued' END
    FROM nexus_alert_email_preferences p
   WHERE p.firm_id = NEW.firm_id AND p.client_id = NEW.client_id
  ON CONFLICT (firm_id, client_id, dedupe_key) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Preference changes affect rows already created for this preference only.
-- This function intentionally does not enqueue historic alert events.
CREATE OR REPLACE FUNCTION enqueue_nexus_alert_email_after_preference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
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

DROP FUNCTION enqueue_nexus_alert_email_for_client(uuid, uuid);

-- A verified destination is a review record, not proof of mailbox ownership.
-- Require a new preference row for any address change so the new address must
-- pass the same verification gate.
CREATE FUNCTION prevent_nexus_alert_recipient_retarget() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recipient_email IS DISTINCT FROM OLD.recipient_email THEN
    RAISE EXCEPTION 'alert email recipient is immutable; create a new preference';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nexus_alert_recipient_immutable
  BEFORE UPDATE OF recipient_email ON nexus_alert_email_preferences
  FOR EACH ROW EXECUTE FUNCTION prevent_nexus_alert_recipient_retarget();
