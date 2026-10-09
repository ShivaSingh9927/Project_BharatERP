-- One shared inbox can identify a client without a mailbox per client.
CREATE TABLE email_intake_routes (
  client_id uuid PRIMARY KEY REFERENCES clients(id),
  firm_id uuid NOT NULL REFERENCES firms(id),
  token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(10), 'hex')
    CHECK (token ~ '^[a-f0-9]{20}$')
);
INSERT INTO email_intake_routes (client_id, firm_id)
SELECT id, firm_id FROM clients;

CREATE FUNCTION create_email_intake_route() RETURNS trigger AS $$
BEGIN
  INSERT INTO email_intake_routes (client_id, firm_id) VALUES (NEW.id, NEW.firm_id);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER clients_email_intake_route
  AFTER INSERT ON clients FOR EACH ROW EXECUTE FUNCTION create_email_intake_route();

CREATE TABLE email_verified_senders (
  firm_id uuid NOT NULL REFERENCES firms(id),
  email text NOT NULL,
  client_id uuid NOT NULL REFERENCES clients(id),
  verified_by uuid NOT NULL REFERENCES users(id),
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (firm_id, email),
  CHECK (email = lower(email))
);

CREATE TABLE inbound_email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  source text NOT NULL CHECK (source IN ('sample', 'provider')),
  external_id text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  sender text NOT NULL,
  recipients text[] NOT NULL,
  subject text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  raw_mime bytea,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'unassigned'
    CHECK (status IN ('unassigned', 'processing', 'assigned', 'failed')),
  suggested_client_id uuid REFERENCES clients(id),
  routing_reason text NOT NULL DEFAULT '',
  client_id uuid REFERENCES clients(id),
  routing_method text,
  assigned_by uuid REFERENCES users(id),
  assigned_at timestamptz,
  processing_error text,
  UNIQUE (firm_id, source, external_id)
);
CREATE INDEX inbound_email_firm_status_time
  ON inbound_email_messages (firm_id, status, received_at DESC);

CREATE TABLE inbound_email_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  email_id uuid NOT NULL REFERENCES inbound_email_messages(id),
  original_name text NOT NULL,
  mime_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bytea,
  source_document_id uuid REFERENCES source_documents(id),
  UNIQUE (email_id, sha256),
  CHECK (bytes IS NOT NULL OR source_document_id IS NOT NULL)
);
CREATE INDEX inbound_email_attachments_email ON inbound_email_attachments (email_id);

ALTER TABLE email_intake_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_intake_routes_firm ON email_intake_routes
  USING (firm_id = current_firm_id()) WITH CHECK (firm_id = current_firm_id());
ALTER TABLE email_verified_senders ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_verified_senders_firm ON email_verified_senders
  USING (firm_id = current_firm_id()) WITH CHECK (firm_id = current_firm_id());
ALTER TABLE inbound_email_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY inbound_email_messages_firm ON inbound_email_messages
  USING (firm_id = current_firm_id()) WITH CHECK (firm_id = current_firm_id());
ALTER TABLE inbound_email_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY inbound_email_attachments_firm ON inbound_email_attachments
  USING (firm_id = current_firm_id()) WITH CHECK (firm_id = current_firm_id());

GRANT SELECT, INSERT ON email_intake_routes TO bharaterp_app;
GRANT SELECT, INSERT ON email_verified_senders TO bharaterp_app;
GRANT SELECT, INSERT, UPDATE ON inbound_email_messages, inbound_email_attachments TO bharaterp_app;
REVOKE DELETE, TRUNCATE ON email_intake_routes, email_verified_senders,
  inbound_email_messages, inbound_email_attachments FROM bharaterp_app;
