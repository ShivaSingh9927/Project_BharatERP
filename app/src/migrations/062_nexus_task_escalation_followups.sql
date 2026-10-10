-- Preserve the human who initiated Nexus work and link a single escalation
-- follow-up to that task. Existing prototype tasks remain without a requester.
ALTER TABLE nexus_specialist_tasks
  ADD COLUMN requested_by uuid REFERENCES users(id);

ALTER TABLE follow_up_items
  ADD COLUMN source_nexus_task_id uuid,
  ADD CONSTRAINT follow_up_source_nexus_task_unique UNIQUE (source_nexus_task_id),
  ADD CONSTRAINT follow_up_source_nexus_task_scope_fk
    FOREIGN KEY (source_nexus_task_id, firm_id, client_id)
    REFERENCES nexus_specialist_tasks (id, firm_id, client_id);

ALTER TABLE follow_up_events
  ALTER COLUMN actor_user_id DROP NOT NULL,
  ADD COLUMN actor_type text NOT NULL DEFAULT 'user'
    CHECK (actor_type IN ('user','system'));

ALTER TABLE follow_up_events
  DROP CONSTRAINT follow_up_events_event_type_check,
  ADD CONSTRAINT follow_up_events_event_type_check
    CHECK (event_type IN ('created','blocker_recorded','snoozed','completed','system_created')),
  ADD CONSTRAINT follow_up_event_actor_ck CHECK (
    (actor_type = 'user' AND actor_user_id IS NOT NULL) OR
    (actor_type = 'system' AND actor_user_id IS NULL)
  );
