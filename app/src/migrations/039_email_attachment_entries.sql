-- Keep every attachment entry in the email record. Client originals remain
-- content-deduplicated by source_documents(client_id, sha256).
ALTER TABLE inbound_email_attachments
  DROP CONSTRAINT inbound_email_attachments_email_id_sha256_key;
