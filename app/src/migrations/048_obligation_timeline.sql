-- Phase 1a: durable client-scoped obligation timeline storage.
-- This migration stores observations and history only; it does not generate
-- statutory obligations or establish filing/payment outcomes.

CREATE UNIQUE INDEX clients_id_firm_id_unique ON clients (id, firm_id);
CREATE UNIQUE INDEX client_registrations_identity_scope_unique
  ON client_registrations (id, firm_id, client_id);

CREATE TABLE obligation_timeline_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  registration_id uuid,
  obligation_kind text NOT NULL CHECK (length(obligation_kind) BETWEEN 1 AND 80),
  period_key text NOT NULL CHECK (length(period_key) BETWEEN 1 AND 40),
  identity_key text NOT NULL CHECK (length(identity_key) BETWEEN 1 AND 200),
  owner_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, client_id, identity_key),
  UNIQUE (id, firm_id, client_id),
  FOREIGN KEY (client_id, firm_id) REFERENCES clients(id, firm_id),
  FOREIGN KEY (registration_id, firm_id, client_id)
    REFERENCES client_registrations(id, firm_id, client_id)
);

CREATE TABLE obligation_workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  obligation_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN
    ('observed', 'opened', 'blocked', 'needs_human_review', 'prepared',
     'submitted_unverified', 'paid_unverified', 'closed', 'superseded', 'note')),
  workflow_state text NOT NULL CHECK (workflow_state IN
    ('observed', 'open', 'blocked', 'needs_human_review', 'prepared',
     'submitted_unverified', 'paid_unverified', 'closed', 'superseded')),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system', 'agent')),
  actor_id uuid,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 2000),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  correlation_id text,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  UNIQUE (firm_id, client_id, idempotency_key),
  FOREIGN KEY (obligation_id, firm_id, client_id)
    REFERENCES obligation_timeline_items(id, firm_id, client_id)
);

-- Outcome claims are their own records. Their lifecycle is append-only and
-- cannot be confused with the obligation's workflow state.
CREATE TABLE obligation_outcome_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  obligation_id uuid NOT NULL,
  fact_kind text NOT NULL CHECK (fact_kind IN ('filed', 'paid', 'acknowledged')),
  source_ref text,
  source_claim text NOT NULL CHECK (length(source_claim) BETWEEN 1 AND 1000),
  source_hash text,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  UNIQUE (id, firm_id, client_id),
  FOREIGN KEY (obligation_id, firm_id, client_id)
    REFERENCES obligation_timeline_items(id, firm_id, client_id)
);

CREATE TABLE obligation_outcome_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  fact_id uuid NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('proposed', 'human_confirmed', 'rejected', 'superseded')),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system', 'agent')),
  actor_id uuid,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 2000),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  UNIQUE (firm_id, client_id, idempotency_key),
  FOREIGN KEY (fact_id, firm_id, client_id)
    REFERENCES obligation_outcome_facts(id, firm_id, client_id)
);

CREATE INDEX obligation_timeline_client_created
  ON obligation_timeline_items (client_id, created_at DESC);
CREATE INDEX obligation_workflow_history
  ON obligation_workflow_events (obligation_id, recorded_at, id);
CREATE INDEX obligation_outcome_history
  ON obligation_outcome_events (fact_id, recorded_at, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'obligation_timeline_items', 'obligation_workflow_events',
    'obligation_outcome_facts', 'obligation_outcome_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (firm_id = current_firm_id()) WITH CHECK (firm_id = current_firm_id())',
      t || '_firm_isolation', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO bharaterp_app', t);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM bharaterp_app', t);
  END LOOP;
END $$;
