-- Store the verifier's decision separately from its model-authored result.
ALTER TABLE nexus_specialist_task_attempts
  ADD COLUMN verification_decision text
    CHECK (verification_decision IS NULL OR verification_decision IN
      ('accepted','retry','needs_human_review'));

-- Prototype attempts predate this field. NOT VALID preserves that history
-- while enforcing the constraint on every new attempt.
ALTER TABLE nexus_specialist_task_attempts
  ADD CONSTRAINT nexus_attempt_verification_role_ck CHECK (
    (agent_role = 'verifier') = (verification_decision IS NOT NULL)
  ) NOT VALID;

-- A task cannot be marked completed based only on a specialist's proposal.
CREATE OR REPLACE FUNCTION enforce_nexus_task_transition() RETURNS trigger
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
  IF NEW.status = 'completed' AND NOT EXISTS (
    SELECT 1 FROM nexus_specialist_task_attempts a
     WHERE a.task_id = NEW.id AND a.firm_id = NEW.firm_id AND a.client_id = NEW.client_id
       AND a.agent_role = 'verifier' AND a.verification_decision = 'accepted'
     ORDER BY a.ordinal DESC LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Nexus task completion requires verifier acceptance'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
