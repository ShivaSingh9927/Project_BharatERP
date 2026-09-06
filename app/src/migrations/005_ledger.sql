-- 005_ledger.sql
-- The two-layer core: vouchers (business documents) → ledger_entries (uniform
-- double-entry facts). Spec: gl-engine.md §5

-- ---------------------------------------------------------------------------
-- Voucher numbering. Must be atomic and gapless under concurrency — MAX()+1
-- races. A cancelled voucher keeps its number forever (invoicing.md INV-2),
-- because an unexplained gap in a GST invoice series invites questions about
-- suppressed sales.
-- ---------------------------------------------------------------------------
CREATE TABLE voucher_number_counters (
  client_id      uuid NOT NULL REFERENCES clients(id),
  voucher_type   voucher_type NOT NULL,
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_years(id),
  prefix         text NOT NULL DEFAULT '',
  next_value     integer NOT NULL DEFAULT 1,
  PRIMARY KEY (client_id, voucher_type, fiscal_year_id)
);

CREATE FUNCTION next_voucher_number(
  p_client_id uuid, p_type voucher_type, p_fy_id uuid
) RETURNS text AS $$
DECLARE
  v_prefix text;
  v_num    integer;
BEGIN
  -- FOR UPDATE serialises concurrent allocation for this counter only.
  SELECT prefix, next_value INTO v_prefix, v_num
  FROM voucher_number_counters
  WHERE client_id = p_client_id AND voucher_type = p_type AND fiscal_year_id = p_fy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO voucher_number_counters (client_id, voucher_type, fiscal_year_id, prefix, next_value)
    VALUES (p_client_id, p_type, p_fy_id, upper(left(p_type::text, 3)) || '/', 2)
    RETURNING prefix, 1 INTO v_prefix, v_num;
  ELSE
    UPDATE voucher_number_counters SET next_value = next_value + 1
    WHERE client_id = p_client_id AND voucher_type = p_type AND fiscal_year_id = p_fy_id;
  END IF;

  RETURN v_prefix || lpad(v_num::text, 5, '0');
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Vouchers — the business-document layer.
-- ---------------------------------------------------------------------------
CREATE TABLE vouchers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id            uuid NOT NULL REFERENCES firms(id),
  client_id          uuid NOT NULL REFERENCES clients(id),
  voucher_type       voucher_type NOT NULL,
  voucher_number     text NOT NULL,
  posting_date       date NOT NULL,             -- accounting date, user-supplied
  fiscal_year_id     uuid NOT NULL REFERENCES fiscal_years(id),
  narration          text,
  status             voucher_status NOT NULL DEFAULT 'posted',

  -- Corrections are reversals, never edits (GL-6, AT-3/AT-4).
  --
  -- Only the forward link is stored. The reverse direction ("was this voucher
  -- reversed?") is DERIVED — see the vouchers_with_reversal view below. Storing
  -- reversed_by_id would require UPDATE on a posted voucher, which would break
  -- the append-only guarantee (GL-5) for the sake of a value we can compute.
  reverses_id        uuid REFERENCES vouchers(id),

  source_document_id uuid,                      -- FK added when documents land
  created_via        created_via NOT NULL DEFAULT 'ui',
  ai_proposal_id     uuid,
  created_by         uuid NOT NULL REFERENCES users(id),
  approved_by        uuid REFERENCES users(id),
  -- Server clock only. posting_date is a different field and may be backdated
  -- within an open period (AT-5, AT-6).
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vouchers_number_unique UNIQUE (client_id, voucher_type, voucher_number, fiscal_year_id),

  -- AT-13: an AI-originated voucher must name the human who authorised it.
  -- "Auto-post" means a CA pre-approved the pattern, not that nobody is
  -- responsible. Enforced here so no code path can bypass it.
  CONSTRAINT vouchers_ai_needs_approver_ck CHECK (
    created_via <> 'ai_proposal' OR approved_by IS NOT NULL
  )
);

CREATE INDEX ON vouchers (client_id, posting_date);
CREATE INDEX ON vouchers (client_id, voucher_type, posting_date);
CREATE INDEX ON vouchers (reverses_id) WHERE reverses_id IS NOT NULL;

-- Effective status, derived rather than stored. A voucher is 'reversed' iff
-- some other voucher points at it. Keeps `vouchers` strictly append-only.
CREATE VIEW vouchers_with_reversal AS
SELECT v.*,
       r.id   AS reversed_by_id,
       (r.id IS NOT NULL) AS is_reversed,
       CASE WHEN r.id IS NOT NULL THEN 'reversed'::voucher_status ELSE v.status END
         AS effective_status
FROM vouchers v
LEFT JOIN vouchers r ON r.reverses_id = v.id;

-- ---------------------------------------------------------------------------
-- Ledger entries — the uniform double-entry layer. Every report is a query
-- over this table. No stored balances anywhere (§8).
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_entries (
  id                 bigserial PRIMARY KEY,
  firm_id            uuid NOT NULL REFERENCES firms(id),
  client_id          uuid NOT NULL REFERENCES clients(id),
  voucher_id         uuid NOT NULL REFERENCES vouchers(id),
  line_no            integer NOT NULL,

  posting_date       date NOT NULL,             -- denormalised for index locality
  fiscal_year_id     uuid NOT NULL REFERENCES fiscal_years(id),
  account_id         uuid NOT NULL REFERENCES accounts(id),

  debit              numeric(18,2) NOT NULL DEFAULT 0,
  credit             numeric(18,2) NOT NULL DEFAULT 0,

  party_type         party_type,
  party_id           uuid,
  cost_center_id     uuid,                      -- nullable now, UI hidden until Phase 2

  settles_voucher_id uuid REFERENCES vouchers(id),   -- which invoice this clears
  against_accounts   text[],                    -- Tally-style display only, never computed on
  is_opening         boolean NOT NULL DEFAULT false,
  finance_book_id    uuid,                      -- NULL = statutory books (§7.3)

  txn_currency       char(3),
  txn_amount         numeric(18,2),
  exchange_rate      numeric(18,6),

  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ledger_amounts_nonneg_ck CHECK (debit >= 0 AND credit >= 0),
  CONSTRAINT ledger_one_sided_ck      CHECK (NOT (debit > 0 AND credit > 0)),
  CONSTRAINT ledger_nonzero_ck        CHECK (debit > 0 OR credit > 0),
  CONSTRAINT ledger_line_unique       UNIQUE (voucher_id, line_no)
);

CREATE INDEX ON ledger_entries (client_id, posting_date);
CREATE INDEX ON ledger_entries (client_id, account_id, posting_date);
CREATE INDEX ON ledger_entries (client_id, party_id, posting_date) WHERE party_id IS NOT NULL;
CREATE INDEX ON ledger_entries (voucher_id);
CREATE INDEX ON ledger_entries (settles_voucher_id) WHERE settles_voucher_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- V-1 as a deferred database constraint.
--
-- Checked at COMMIT, not per row, so a multi-line voucher can be inserted line
-- by line and still be verified as a whole. This means an unbalanced voucher
-- cannot exist even if application validation is skipped entirely.
-- Spec: gl-engine.md GL-1, V-1
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_voucher_balanced() RETURNS trigger AS $$
DECLARE
  v_debit  numeric(18,2);
  v_credit numeric(18,2);
  v_lines  integer;
BEGIN
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0), COUNT(*)
    INTO v_debit, v_credit, v_lines
  FROM ledger_entries WHERE voucher_id = NEW.voucher_id;

  IF v_lines < 2 THEN
    RAISE EXCEPTION 'V-2: voucher % has % line(s); at least 2 required',
      NEW.voucher_id, v_lines USING ERRCODE = 'check_violation';
  END IF;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'V-1: voucher % unbalanced — debits %, credits %',
      NEW.voucher_id, v_debit, v_credit USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_voucher_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_voucher_balanced();

-- ---------------------------------------------------------------------------
-- V-3/V-4/V-5 at row level: leaf accounts only, not frozen, party present
-- where the account type demands it. Also resolves the fiscal year (V-6).
-- ---------------------------------------------------------------------------
CREATE FUNCTION validate_ledger_entry() RETURNS trigger AS $$
DECLARE
  a RECORD;
BEGIN
  SELECT is_group, is_frozen, is_disabled, account_type, client_id
    INTO a FROM accounts WHERE id = NEW.account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'V-4: account % does not exist', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF a.client_id <> NEW.client_id THEN
    RAISE EXCEPTION 'V-4: account % belongs to a different client', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF a.is_group THEN
    RAISE EXCEPTION 'V-4: account % is a group; postings must target a leaf', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF a.is_frozen OR a.is_disabled THEN
    RAISE EXCEPTION 'V-4: account % is frozen or disabled', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF a.account_type IN ('receivable','payable') AND NEW.party_id IS NULL THEN
    RAISE EXCEPTION 'V-5: account_type % requires a party_id', a.account_type
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_ledger_entry
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION validate_ledger_entry();

-- INSERT + SELECT only. No UPDATE, no DELETE — see 008_append_only.sql.
GRANT SELECT, INSERT ON vouchers, ledger_entries TO bharaterp_app;
GRANT SELECT ON vouchers_with_reversal TO bharaterp_app;
-- Counters are operational state, not books of account, so they may be updated.
GRANT SELECT, INSERT, UPDATE ON voucher_number_counters TO bharaterp_app;
GRANT USAGE, SELECT ON SEQUENCE ledger_entries_id_seq TO bharaterp_app;
