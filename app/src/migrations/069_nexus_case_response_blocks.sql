-- Persist validated structured read-only Nexus outputs beside their message.
ALTER TABLE nexus_case_messages ADD COLUMN response_blocks jsonb;
ALTER TABLE nexus_case_messages ADD CONSTRAINT nexus_case_messages_response_blocks_object
  CHECK (response_blocks IS NULL OR jsonb_typeof(response_blocks) = 'object');
