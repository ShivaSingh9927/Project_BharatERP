-- The original's display name is metadata. Storage paths are generated from
-- tenant IDs and content hashes, never from this untrusted name.
ALTER TABLE source_documents ADD COLUMN original_name text;
CREATE INDEX source_documents_client_recent
  ON source_documents (client_id, received_at DESC);
