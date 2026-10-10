-- Prevent the task status projection from skipping runner/review gates.
CREATE FUNCTION enforce_nexus_task_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
  IF NOT (CASE OLD.status
    WHEN 'queued' THEN NEW.status IN ('running','cancelled')
    WHEN 'running' THEN NEW.status IN ('verifying','retry_ready','blocked','failed','needs_human_review','cancelled')
    WHEN 'verifying' THEN NEW.status IN ('completed','retry_ready','blocked','failed','needs_human_review','cancelled')
    WHEN 'retry_ready' THEN NEW.status IN ('running','needs_human_review','cancelled')
    WHEN 'blocked' THEN NEW.status IN ('retry_ready','needs_human_review','cancelled')
    WHEN 'failed' THEN NEW.status IN ('retry_ready','needs_human_review','cancelled')
    WHEN 'needs_human_review' THEN NEW.status = 'cancelled'
    ELSE false
  END) THEN
    RAISE EXCEPTION 'invalid Nexus task transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER nexus_specialist_task_transition_guard
  BEFORE UPDATE OF status ON nexus_specialist_tasks
  FOR EACH ROW EXECUTE FUNCTION enforce_nexus_task_transition();
