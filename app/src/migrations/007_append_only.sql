-- 007_append_only.sql
--
-- THE control. Everything in audit-trail.md rests on this file.
--
-- Immutability is enforced as a DATABASE PERMISSION, not an application
-- convention. A bug, a careless migration, a compromised API key, or a
-- developer at a psql prompt using the app role cannot rewrite posted history.
--
-- Spec: audit-trail.md AT-2 (no update, no delete), gl-engine.md GL-5
-- Also serves as SOC 1 change-management evidence — provenance.md §9.2

-- ---------------------------------------------------------------------------
-- 1. Revoke mutation on the books of account.
--
-- These grants were never issued in earlier migrations; the explicit REVOKE is
-- belt-and-braces against a future migration granting them by accident (e.g.
-- via GRANT ALL). Keep this file last in the sequence.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON vouchers       FROM bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log      FROM bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON account_versions FROM bharaterp_app;

-- Master data may change, but never disappear.
REVOKE DELETE, TRUNCATE ON accounts FROM bharaterp_app;
REVOKE DELETE, TRUNCATE ON firms, clients, users FROM bharaterp_app;

-- Default-deny for anything added later without explicit thought.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM bharaterp_app;

-- ---------------------------------------------------------------------------
-- 2. Row-level security — defence in depth for multi-tenancy.
--
-- A missing WHERE clause in application code must not be able to leak another
-- firm's data. The app sets `app.firm_id` per connection/transaction; policies
-- filter on it. Spec: gl-engine.md §9
-- ---------------------------------------------------------------------------
CREATE FUNCTION current_firm_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.firm_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clients','users','accounts','vouchers','ledger_entries','audit_log',
    'account_versions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY firm_isolation ON %I
        USING (firm_id = current_firm_id())
        WITH CHECK (firm_id = current_firm_id())
    $f$, t);
  END LOOP;
END $$;

-- fiscal_years and accounting_periods reach the firm through client_id.
ALTER TABLE fiscal_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_years FORCE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON fiscal_years
  USING (client_id IN (SELECT id FROM clients WHERE firm_id = current_firm_id()))
  WITH CHECK (client_id IN (SELECT id FROM clients WHERE firm_id = current_firm_id()));

ALTER TABLE accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON accounting_periods
  USING (client_id IN (SELECT id FROM clients WHERE firm_id = current_firm_id()))
  WITH CHECK (client_id IN (SELECT id FROM clients WHERE firm_id = current_firm_id()));

GRANT EXECUTE ON FUNCTION current_firm_id() TO bharaterp_app;
GRANT EXECUTE ON FUNCTION next_voucher_number(uuid, voucher_type, uuid) TO bharaterp_app;
GRANT EXECUTE ON FUNCTION resolve_open_fiscal_year(uuid, date) TO bharaterp_app;
