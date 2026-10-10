-- The four-run budget is for the assigned specialist (initial run plus three
-- retries). Verifier calls are recorded separately within a bounded budget.
ALTER TABLE nexus_specialist_task_attempts
  DROP CONSTRAINT nexus_specialist_task_attempts_ordinal_check,
  ADD CONSTRAINT nexus_specialist_task_attempts_ordinal_check CHECK (ordinal BETWEEN 1 AND 8);

UPDATE nexus_specialist_tasks t
   SET current_attempt = COALESCE((
     SELECT count(*)::integer FROM nexus_specialist_task_attempts a
      WHERE a.task_id = t.id AND a.agent_role <> 'verifier'
   ), 0);

CREATE FUNCTION enforce_nexus_task_attempt_budget() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE task_max integer; prior_count integer; next_ordinal integer;
BEGIN
  SELECT max_attempts INTO task_max FROM nexus_specialist_tasks
   WHERE id = NEW.task_id AND firm_id = NEW.firm_id AND client_id = NEW.client_id
   FOR UPDATE;
  IF task_max IS NULL THEN
    RAISE EXCEPTION 'Nexus task is unavailable' USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT count(*)::integer, COALESCE(max(ordinal),0)+1
    INTO prior_count,next_ordinal
    FROM nexus_specialist_task_attempts WHERE task_id = NEW.task_id;
  IF NEW.ordinal <> next_ordinal THEN
    RAISE EXCEPTION 'Nexus task attempt ordinal is out of sequence' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.agent_role = 'verifier' THEN
    SELECT count(*)::integer INTO prior_count FROM nexus_specialist_task_attempts
     WHERE task_id = NEW.task_id AND agent_role = 'verifier';
  ELSE
    SELECT count(*)::integer INTO prior_count FROM nexus_specialist_task_attempts
     WHERE task_id = NEW.task_id AND agent_role <> 'verifier';
  END IF;
  IF prior_count >= task_max THEN
    RAISE EXCEPTION 'Nexus task attempt budget is exhausted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER nexus_specialist_task_attempt_budget
  BEFORE INSERT ON nexus_specialist_task_attempts
  FOR EACH ROW EXECUTE FUNCTION enforce_nexus_task_attempt_budget();

CREATE FUNCTION sync_nexus_specialist_attempt_count() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NEW.agent_role <> 'verifier' THEN
    UPDATE nexus_specialist_tasks SET current_attempt = (
      SELECT count(*)::integer FROM nexus_specialist_task_attempts
       WHERE task_id = NEW.task_id AND agent_role <> 'verifier'
    ), updated_at = now()
     WHERE id = NEW.task_id AND firm_id = NEW.firm_id AND client_id = NEW.client_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER nexus_specialist_attempt_count_sync
  AFTER INSERT ON nexus_specialist_task_attempts
  FOR EACH ROW EXECUTE FUNCTION sync_nexus_specialist_attempt_count();
