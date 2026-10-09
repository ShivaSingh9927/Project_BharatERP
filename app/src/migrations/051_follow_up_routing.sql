-- Human-owned routing metadata for the client-scoped follow-up queue.
-- Assignees are validated by the domain against this client's firm/scope.
ALTER TABLE follow_up_items
  ADD COLUMN assignee_user_id uuid REFERENCES users(id),
  ADD COLUMN due_date date,
  ADD COLUMN priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high'));

CREATE INDEX follow_up_items_client_open_routing
  ON follow_up_items (client_id, status, due_date, priority)
  WHERE status = 'open';
