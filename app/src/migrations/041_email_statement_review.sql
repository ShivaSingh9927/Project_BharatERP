-- A remembered password is not permission to open future emails in the
-- background. Keep the latter as a separate, revocable, account-scoped grant.
ALTER TABLE bank_statement_credentials
  ADD COLUMN auto_open_email boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_open_consented_at timestamptz,
  ADD COLUMN auto_open_consented_by uuid REFERENCES users(id),
  ADD CONSTRAINT bank_statement_auto_open_consent CHECK (
    (auto_open_email AND auto_open_consented_at IS NOT NULL
      AND auto_open_consented_by IS NOT NULL)
    OR (NOT auto_open_email AND auto_open_consented_at IS NULL
      AND auto_open_consented_by IS NULL)
  );

-- An email attachment is evidence of receipt, not evidence that it is a bank
-- statement. Record a review state without changing the original document.
ALTER TABLE inbound_email_attachments
  ADD COLUMN intake_status text NOT NULL DEFAULT 'unreviewed'
    CHECK (intake_status IN ('unreviewed', 'other_file', 'needs_password',
      'needs_review', 'statement_ready')),
  ADD COLUMN intake_note text CHECK (intake_note IS NULL OR length(intake_note) <= 500),
  ADD COLUMN inspected_at timestamptz,
  ADD COLUMN bank_account_id uuid REFERENCES bank_accounts(id),
  ADD COLUMN statement_row_count integer CHECK (statement_row_count IS NULL OR statement_row_count >= 0),
  ADD COLUMN statement_period_from date,
  ADD COLUMN statement_period_to date;

GRANT UPDATE (auto_open_email, auto_open_consented_at, auto_open_consented_by)
  ON bank_statement_credentials TO bharaterp_app;
GRANT DELETE ON bank_statement_credentials TO bharaterp_app;
GRANT UPDATE (intake_status, intake_note, inspected_at, bank_account_id,
  statement_row_count, statement_period_from, statement_period_to)
  ON inbound_email_attachments TO bharaterp_app;
