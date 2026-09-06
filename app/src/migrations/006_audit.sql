-- 006_audit.sql
-- Audit log with a tamper-evident hash chain.
-- Spec: audit-trail.md §4.4, §4.5

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  firm_id       uuid NOT NULL REFERENCES firms(id),
  client_id     uuid REFERENCES clients(id),     -- NULL for firm-level actions

  entity_type   text NOT NULL,                   -- 'voucher', 'account', ...
  entity_id     uuid NOT NULL,
  action        audit_action NOT NULL,

  before        jsonb,                           -- NULL on create
  after         jsonb,

  actor_user_id uuid REFERENCES users(id),       -- NULL only for system jobs
  actor_type    actor_type NOT NULL,
  ai_model      text,                            -- set when actor_type = ai_agent
  approved_by   uuid REFERENCES users(id),       -- the human, when AI-originated
  batch_id      uuid,                            -- groups bulk operations (AT-8)

  session_id    uuid,
  ip_address    inet,
  user_agent    text,

  occurred_at   timestamptz NOT NULL DEFAULT now(),   -- server clock only (AT-5)

  -- Tamper evidence (§4.5). Populated by trigger; never supplied by callers.
  prev_hash     text NOT NULL DEFAULT '',
  row_hash      text NOT NULL DEFAULT '',

  -- AT-13, mirrored from vouchers: an AI actor always names its human approver.
  CONSTRAINT audit_ai_needs_approver_ck CHECK (
    actor_type <> 'ai_agent' OR approved_by IS NOT NULL
  )
);

CREATE INDEX ON audit_log (firm_id, occurred_at);
CREATE INDEX ON audit_log (client_id, occurred_at);
CREATE INDEX ON audit_log (entity_type, entity_id);
CREATE INDEX ON audit_log (batch_id) WHERE batch_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Hash chain.
--
-- Each row's hash incorporates the previous row's hash for the same firm, so
-- altering or removing any row breaks every hash after it. Permissions stop
-- the application from tampering; this makes tampering by anyone with direct
-- database access *detectable*.
--
-- The advisory lock serialises appends per firm. Without it two concurrent
-- inserts could read the same prev_hash and fork the chain. The lock is
-- transaction-scoped and keyed per firm, so firms never block each other.
-- ---------------------------------------------------------------------------
CREATE FUNCTION audit_log_chain() RETURNS trigger AS $$
DECLARE
  v_prev text;
  v_payload text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_chain:' || NEW.firm_id::text));

  SELECT row_hash INTO v_prev
  FROM audit_log
  WHERE firm_id = NEW.firm_id
  ORDER BY id DESC
  LIMIT 1;

  NEW.prev_hash := COALESCE(v_prev, repeat('0', 64));

  -- Canonical, order-stable serialisation of the fields being attested.
  v_payload := concat_ws('|',
    NEW.prev_hash,
    NEW.firm_id::text,
    COALESCE(NEW.client_id::text, ''),
    NEW.entity_type,
    NEW.entity_id::text,
    NEW.action::text,
    COALESCE(NEW.before::text, ''),
    COALESCE(NEW.after::text, ''),
    COALESCE(NEW.actor_user_id::text, ''),
    NEW.actor_type::text,
    COALESCE(NEW.ai_model, ''),
    COALESCE(NEW.approved_by::text, ''),
    to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USOF')
  );

  NEW.row_hash := encode(digest(v_payload, 'sha256'), 'hex');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- ---------------------------------------------------------------------------
-- Chain verification. Recomputes every hash for a firm in order and reports
-- the first break. Intended to run nightly; also called directly by tests.
-- Spec: audit-trail.md §4.5, provenance.md PR-20
-- ---------------------------------------------------------------------------
CREATE FUNCTION verify_audit_chain(p_firm_id uuid)
RETURNS TABLE (ok boolean, broken_at bigint, checked bigint) AS $$
DECLARE
  r RECORD;
  v_prev text := repeat('0', 64);
  v_expected text;
  v_count bigint := 0;
BEGIN
  FOR r IN
    SELECT * FROM audit_log WHERE firm_id = p_firm_id ORDER BY id ASC
  LOOP
    v_expected := encode(digest(concat_ws('|',
      v_prev, r.firm_id::text, COALESCE(r.client_id::text, ''),
      r.entity_type, r.entity_id::text, r.action::text,
      COALESCE(r.before::text, ''), COALESCE(r.after::text, ''),
      COALESCE(r.actor_user_id::text, ''), r.actor_type::text,
      COALESCE(r.ai_model, ''), COALESCE(r.approved_by::text, ''),
      to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USOF')
    ), 'sha256'), 'hex');

    v_count := v_count + 1;

    IF r.prev_hash <> v_prev OR r.row_hash <> v_expected THEN
      RETURN QUERY SELECT false, r.id, v_count;
      RETURN;
    END IF;

    v_prev := r.row_hash;
  END LOOP;

  RETURN QUERY SELECT true, NULL::bigint, v_count;
END $$ LANGUAGE plpgsql;

GRANT SELECT, INSERT ON audit_log TO bharaterp_app;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO bharaterp_app;
GRANT EXECUTE ON FUNCTION verify_audit_chain(uuid) TO bharaterp_app;
