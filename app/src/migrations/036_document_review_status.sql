-- Let a CA communicate the next document action without changing the books.
ALTER TABLE source_documents
  ADD COLUMN review_note text CHECK (review_note IS NULL OR length(review_note) <= 1000),
  ADD COLUMN review_updated_at timestamptz,
  ADD COLUMN review_updated_by uuid REFERENCES users(id);

GRANT UPDATE (review_note, review_updated_at, review_updated_by)
  ON source_documents TO bharaterp_app;
