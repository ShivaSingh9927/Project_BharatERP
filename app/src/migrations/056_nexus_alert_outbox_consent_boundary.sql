-- Opt-in and recipient review apply only to alerts created afterward. Held
-- rows are never made deliverable by a later preference change.
CREATE OR REPLACE FUNCTION enqueue_nexus_alert_email_after_preference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Revocation/review withdrawal must stop work that has not been sent.
  -- Re-enabling a preference never promotes held rows back into the queue.
  UPDATE nexus_alert_email_outbox o
     SET delivery_state = CASE
           WHEN NOT NEW.email_enabled THEN 'held_disabled'
           ELSE 'held_unverified' END,
         next_attempt_at = NULL, updated_at = now()
   WHERE o.preference_id = NEW.id
     AND o.delivery_state IN ('queued', 'retry')
     AND (NOT NEW.email_enabled OR NEW.verification_status <> 'verified');
  RETURN NEW;
END;
$$;
