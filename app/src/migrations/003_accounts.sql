-- 003_accounts.sql
-- Chart of accounts, plus its version history.
-- Spec: gl-engine.md §3.5, §3.6 · audit-trail.md §4.3

CREATE TABLE accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id          uuid NOT NULL REFERENCES firms(id),
  client_id        uuid NOT NULL REFERENCES clients(id),
  code             text,
  name             text NOT NULL,
  parent_id        uuid REFERENCES accounts(id),
  is_group         boolean NOT NULL DEFAULT false,

  root_type        root_type    NOT NULL,
  account_type     account_type NOT NULL,
  normal_balance   normal_balance NOT NULL,

  -- Classification tags. A wrong value here produces a wrong report forever,
  -- and the Trial Balance still balances perfectly (Lesson 2 error of
  -- principle). Spec: gl-engine.md §3.3
  expense_class    expense_class,     -- expense accounts only
  liquidity_class  liquidity_class,   -- asset / liability accounts only

  currency         char(3) NOT NULL DEFAULT 'INR',
  is_frozen        boolean NOT NULL DEFAULT false,
  is_disabled      boolean NOT NULL DEFAULT false,

  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES users(id),

  CONSTRAINT accounts_unique_sibling UNIQUE (client_id, name, parent_id),

  -- Only expense accounts carry expense_class, and every non-group expense
  -- account must carry one, or the P&L waterfall cannot be built.
  CONSTRAINT accounts_expense_class_ck CHECK (
    (root_type = 'expense' AND (is_group OR expense_class IS NOT NULL))
    OR (root_type <> 'expense' AND expense_class IS NULL)
  ),

  -- Same reasoning for Balance Sheet grouping and Working Capital.
  CONSTRAINT accounts_liquidity_class_ck CHECK (
    (root_type IN ('asset','liability') AND (is_group OR liquidity_class IS NOT NULL))
    OR (root_type NOT IN ('asset','liability') AND liquidity_class IS NULL)
  )
);

CREATE INDEX ON accounts (client_id);
CREATE INDEX ON accounts (parent_id);
CREATE INDEX ON accounts (client_id, account_type);

-- ---------------------------------------------------------------------------
-- Version history. Master data may change; every prior version is retained so
-- "what was this account on 31 March?" is answerable. Written by trigger, not
-- by application code, so it cannot be bypassed.
-- Spec: audit-trail.md §4.3
-- ---------------------------------------------------------------------------
CREATE TABLE account_versions (
  id           bigserial PRIMARY KEY,
  -- Denormalised from the parent account so row-level security can filter on
  -- it directly. The version row is written by a BEFORE INSERT trigger, at
  -- which point the account row does not yet exist — so a policy that resolved
  -- the firm via a subquery on `accounts` would reject every insert.
  firm_id      uuid NOT NULL REFERENCES firms(id),
  account_id   uuid NOT NULL,
  version      integer NOT NULL,
  snapshot     jsonb NOT NULL,
  changed_by   uuid REFERENCES users(id),
  changed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, version)
);

CREATE INDEX ON account_versions (firm_id);

CREATE FUNCTION account_snapshot_on_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.version    := OLD.version + 1;
    NEW.updated_at := now();
  END IF;

  INSERT INTO account_versions (firm_id, account_id, version, snapshot, changed_by)
  VALUES (NEW.firm_id, NEW.id, NEW.version, to_jsonb(NEW), NEW.updated_by);

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_accounts_version
  BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION account_snapshot_on_change();

GRANT SELECT, INSERT, UPDATE ON accounts TO bharaterp_app;
GRANT SELECT, INSERT ON account_versions TO bharaterp_app;
GRANT USAGE, SELECT ON SEQUENCE account_versions_id_seq TO bharaterp_app;
