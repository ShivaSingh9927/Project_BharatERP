-- Link a specialist retry to the verifier findings it addresses.
ALTER TABLE nexus_specialist_task_attempts
  ADD COLUMN addressed_findings jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(addressed_findings) = 'array');
