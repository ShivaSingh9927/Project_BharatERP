-- Existing upload and email dedup paths repair a placeholder original URI
-- after receiving the real file. Permit only those metadata columns.
GRANT UPDATE (original_blob_uri, original_name, file_size)
  ON source_documents TO bharaterp_app;
