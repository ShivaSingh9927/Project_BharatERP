-- 002_tenancy.sql
-- CA firm → client (the SMB) → users.
-- Spec: gl-engine.md §9

CREATE TABLE firms (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id      uuid NOT NULL REFERENCES firms(id),
  name         text NOT NULL,
  -- One client currently maps to one GSTIN. Whether a client should instead be
  -- one PAN with several GSTINs beneath it is the most expensive open question
  -- remaining — invoicing.md §14.2, gst-engine.md §15.3. Deliberately narrow
  -- until the CA advisor settles it.
  gstin        char(15),
  pan          char(10),
  state_code   char(2),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON clients (firm_id);

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id      uuid NOT NULL REFERENCES firms(id),
  -- NULL means firm-scoped (a CA who can act across the firm's clients).
  -- Non-NULL scopes the user to a single client (typically an SMB owner).
  client_id    uuid REFERENCES clients(id),
  email        text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role         text NOT NULL,   -- ca_partner | ca_staff | owner | auditor | support
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON users (firm_id);

GRANT SELECT, INSERT, UPDATE ON firms, clients, users TO bharaterp_app;
