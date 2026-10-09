-- Passwords used to open bank-issued PDF and Excel statements.
--
-- The password is encrypted by the application with AES-256-GCM before it
-- reaches PostgreSQL. The encryption key lives outside the database, so a
-- database backup alone cannot reveal the password.

CREATE TABLE bank_statement_credentials (
  bank_account_id uuid PRIMARY KEY REFERENCES bank_accounts(id) ON DELETE CASCADE,
  firm_id         uuid NOT NULL REFERENCES firms(id),
  client_id       uuid NOT NULL REFERENCES clients(id),
  ciphertext      bytea NOT NULL,
  nonce           bytea NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag        bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  updated_by      uuid NOT NULL REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bank_statement_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_credentials FORCE ROW LEVEL SECURITY;

CREATE POLICY bank_statement_credentials_firm_isolation
  ON bank_statement_credentials
  USING (firm_id = current_firm_id())
  WITH CHECK (firm_id = current_firm_id());

GRANT SELECT, INSERT, UPDATE ON bank_statement_credentials TO bharaterp_app;
REVOKE DELETE, TRUNCATE ON bank_statement_credentials FROM bharaterp_app;
