-- Specialist tasks can send selected client records to the configured model.
-- This is a separate purpose and remains off until an authorized user opts in.
ALTER TABLE firm_ai_settings
  ADD COLUMN llm_nexus_tasks boolean NOT NULL DEFAULT false,
  ADD COLUMN llm_nexus_tasks_by uuid REFERENCES users(id),
  ADD COLUMN llm_nexus_tasks_at timestamptz;

ALTER TABLE firm_ai_settings ADD CONSTRAINT nexus_task_ai_consent_attributed CHECK (
  NOT llm_nexus_tasks OR
  (llm_nexus_tasks_by IS NOT NULL AND llm_nexus_tasks_at IS NOT NULL
   AND llm_provider IS NOT NULL AND llm_model IS NOT NULL)
);
