-- Bind saved Nexus bank activity outputs to the exact read-only request inputs.
ALTER TABLE nexus_case_messages ADD COLUMN request_fingerprint text;
ALTER TABLE nexus_case_messages ADD CONSTRAINT nexus_case_messages_request_fingerprint_format
  CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[a-f0-9]{64}$');
