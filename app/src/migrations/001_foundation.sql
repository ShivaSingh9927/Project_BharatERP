-- 001_foundation.sql
-- Extensions, enums, and the application role.
-- Spec: gl-engine.md §3, §5.4 · audit-trail.md §4

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- digest() for the audit hash chain

-- ---------------------------------------------------------------------------
-- Application role.
--
-- The app connects as this role, NOT as the schema owner. It is granted
-- INSERT + SELECT on ledger tables and is explicitly denied UPDATE and DELETE
-- (008_append_only.sql). This makes immutability a database permission rather
-- than an application convention — a bug, a bad migration, or a leaked
-- connection string cannot rewrite posted history.
--
-- Spec: gl-engine.md GL-5, audit-trail.md AT-2
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bharaterp_app') THEN
    CREATE ROLE bharaterp_app LOGIN PASSWORD 'bharaterp_app_dev';
  END IF;
END $$;

GRANT CONNECT ON DATABASE bharaterp TO bharaterp_app;
GRANT USAGE ON SCHEMA public TO bharaterp_app;

-- ---------------------------------------------------------------------------
-- Enums. Spec: gl-engine.md §3.2, §3.4, §5.4
-- ---------------------------------------------------------------------------

-- The five account types (Lesson 1).
CREATE TYPE root_type AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');

-- Which side increases the account. Derived from root_type, but overridden for
-- contra accounts: accumulated_depreciation sits under Assets yet its normal
-- balance is credit (Lesson 8).
CREATE TYPE normal_balance AS ENUM ('debit', 'credit');

-- The P&L waterfall (Lesson 7). Drives Gross → Operating → Net Profit.
CREATE TYPE expense_class AS ENUM ('cogs', 'opex', 'non_operating');

-- Balance Sheet grouping and Working Capital (Lesson 9). Stored explicitly
-- rather than inferred from tree position — see gl-engine.md §3.3 for why.
CREATE TYPE liquidity_class AS ENUM ('current', 'non_current');

-- Behavioural classification. The engine uses this to decide what is legal,
-- e.g. receivable/payable accounts require a party. Spec: gl-engine.md §3.4
CREATE TYPE account_type AS ENUM (
  'bank', 'cash',
  'receivable', 'payable',
  'tax_output', 'tax_input',
  'tds_payable', 'tds_receivable',
  'fixed_asset', 'accumulated_depreciation',
  'stock', 'cogs',
  'equity', 'capital', 'drawings',
  'round_off', 'temporary',
  'general'
);

-- Voucher taxonomy mirrors Tally's, including F-key mapping. Spec: gl-engine.md §5.4
CREATE TYPE voucher_type AS ENUM (
  'contra',        -- F4
  'payment',       -- F5
  'receipt',       -- F6
  'journal',       -- F7
  'sales',         -- F8
  'purchase',      -- F9
  'credit_note',   -- Ctrl+F8
  'debit_note',    -- Ctrl+F9
  'opening',
  'depreciation',
  'period_close'
);

CREATE TYPE voucher_status AS ENUM ('draft', 'posted', 'reversed');

-- How a voucher entered the system. Required for audit-trail.md AT-9 (imports
-- must be distinguishable from natively-originated transactions).
CREATE TYPE created_via AS ENUM ('ui', 'api', 'ai_proposal', 'tally_import', 'whatsapp');

CREATE TYPE party_type AS ENUM ('customer', 'supplier', 'employee');

-- Spec: audit-trail.md §4.4
CREATE TYPE audit_action AS ENUM
  ('create', 'update', 'cancel', 'reverse', 'submit', 'approve', 'reject');

CREATE TYPE actor_type AS ENUM
  ('human', 'ai_agent', 'system_job', 'support_engineer');
