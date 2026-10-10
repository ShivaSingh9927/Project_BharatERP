-- Keep task status projections auditable even when updated outside the domain API.
ALTER TABLE nexus_specialist_task_events
  DROP CONSTRAINT nexus_specialist_task_events_event_type_check,
  ADD CONSTRAINT nexus_specialist_task_events_event_type_check
    CHECK (event_type IN ('created','attempt_recorded','status_changed'));

ALTER TABLE nexus_specialist_task_events
  DROP CONSTRAINT nexus_specialist_task_events_check,
  ADD CONSTRAINT nexus_specialist_task_events_check CHECK (
    (event_type = 'created' AND attempt_id IS NULL) OR
    (event_type = 'attempt_recorded' AND attempt_id IS NOT NULL) OR
    (event_type = 'status_changed' AND attempt_id IS NULL)
  );

CREATE FUNCTION record_nexus_task_status_change() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO nexus_specialist_task_events
      (firm_id, client_id, task_id, event_ordinal, event_type, detail, idempotency_key)
    SELECT NEW.firm_id, NEW.client_id, NEW.id,
           COALESCE(max(event_ordinal), 0) + 1,
           'status_changed',
           jsonb_build_object('from_status', OLD.status, 'to_status', NEW.status),
           'status:' || NEW.id::text || ':' || gen_random_uuid()::text
      FROM nexus_specialist_task_events
     WHERE task_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER nexus_specialist_task_status_audit
  AFTER UPDATE OF status ON nexus_specialist_tasks
  FOR EACH ROW EXECUTE FUNCTION record_nexus_task_status_change();
