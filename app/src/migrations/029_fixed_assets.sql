-- The asset register, and depreciation.
-- Spec: bills-and-expenses.md BE-41 (and BE-11, which has been waiting for it)
--
-- BE-11 says a bill above the capitalisation threshold must ask "expense or
-- capitalise?" and never default silently. Nothing asked, because there was
-- nowhere to capitalise TO — so a ₹3,00,000 batch of laptops went to expense,
-- and that is Lesson 2's error of principle: this year's profit is understated
-- by the whole cost and the next four years' by nothing.
--
-- ── The fact this schema is shaped around ────────────────────────────────
--
-- BOOK depreciation and TAX depreciation are two different numbers for the
-- same asset, and neither is a rounding of the other.
--
--   Books follow Companies Act 2013 Schedule II: a useful life per class,
--   straight line or written down, residual value capped at 5%, and pro-rata
--   from the date the asset was available for use. This is what posts to the
--   ledger and what the P&L reports.
--
--   Tax follows Income Tax Act s.32 with Appendix I rates: a BLOCK of assets
--   rather than individual ones, always written-down value, and half the rate
--   for anything put to use for under 180 days in its first year. This never
--   posts — it is a computation, and the gap between it and the book figure is
--   the main add-back in the income computation and the source of the deferred
--   tax item.
--
-- A system that computes one of these and calls it "depreciation" is telling a
-- CA something false. So the class master carries both, the ledger takes the
-- book figure, and the tax figure is produced as a schedule.

-- ---------------------------------------------------------------------------
-- What each class of asset does, under both regimes. Statutory, so global and
-- date-ranged like `gst_rates` and `tds_sections`.
-- ---------------------------------------------------------------------------
CREATE TABLE asset_classes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                text NOT NULL,
  name               text NOT NULL,

  -- Which head in the client's chart this capitalises to, by NAME — the chart
  -- is seeded from one template, and an id would differ per client.
  asset_account_name text NOT NULL,

  -- BOOK: Companies Act 2013, Schedule II.
  useful_life_years  numeric(5,2) NOT NULL,
  book_method        text NOT NULL,
  -- Schedule II caps residual value at 5% of original cost.
  residual_percent   numeric(5,2) NOT NULL DEFAULT 5,

  -- TAX: Income Tax Act s.32, Appendix I. The block, and its WDV rate.
  tax_block          text NOT NULL,
  tax_wdv_rate       numeric(5,2) NOT NULL,

  effective_from     date NOT NULL,
  effective_to       date,
  source_citation    text,

  CONSTRAINT asset_class_method_ck CHECK (book_method IN ('slm', 'wdv')),
  CONSTRAINT asset_class_residual_ck CHECK (residual_percent >= 0 AND residual_percent <= 5),
  CONSTRAINT asset_class_life_ck CHECK (useful_life_years > 0),
  CONSTRAINT asset_class_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (key, effective_from)
);

CREATE INDEX ON asset_classes (key, effective_from);

-- ---------------------------------------------------------------------------
-- The register.
-- ---------------------------------------------------------------------------
CREATE TABLE fixed_assets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id            uuid NOT NULL REFERENCES firms(id),
  client_id          uuid NOT NULL REFERENCES clients(id),
  asset_class_key    text NOT NULL,
  description        text NOT NULL,
  -- A serial number, a plate, an asset tag. What makes one of five identical
  -- laptops identifiable when one of them is sold or stolen.
  identifier         text,

  -- What was capitalised. Not the invoice total: GST that is claimable as
  -- input credit is not part of the cost, and GST that is BLOCKED is.
  cost               numeric(18,2) NOT NULL,

  -- The bill that bought it, when there was one. Null for an asset the client
  -- already owned when they came on to this system.
  source_voucher_id  uuid REFERENCES vouchers(id),
  party_id           uuid REFERENCES parties(id),

  -- Schedule II depreciates from the date the asset was AVAILABLE FOR USE,
  -- which is not always the invoice date — a machine delivered in March and
  -- commissioned in May depreciates from May.
  put_to_use_on      date NOT NULL,

  -- Per-asset overrides. Null means the class decides, which is the usual
  -- case; a CA who knows a particular machine will last five years rather than
  -- fifteen may say so, and Schedule II permits a different life with
  -- disclosure.
  useful_life_years  numeric(5,2),
  book_method        text,
  residual_percent   numeric(5,2),

  disposed_on        date,
  disposal_proceeds  numeric(18,2),
  disposal_voucher_id uuid REFERENCES vouchers(id),

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),

  CONSTRAINT fixed_asset_cost_ck CHECK (cost > 0),
  CONSTRAINT fixed_asset_method_ck CHECK (book_method IS NULL OR book_method IN ('slm','wdv')),
  CONSTRAINT fixed_asset_disposal_ck CHECK (
    (disposed_on IS NULL AND disposal_proceeds IS NULL)
    OR (disposed_on IS NOT NULL AND disposal_proceeds IS NOT NULL)),
  CONSTRAINT fixed_asset_disposal_after_ck CHECK (
    disposed_on IS NULL OR disposed_on >= put_to_use_on)
);

CREATE INDEX ON fixed_assets (client_id, asset_class_key);
CREATE INDEX ON fixed_assets (client_id, put_to_use_on);

-- ---------------------------------------------------------------------------
-- Depreciation runs.
--
-- A run is a period, and a period may be depreciated ONCE — the unique
-- constraint is the guard, because charging a month twice halves the asset's
-- life and is invisible in a trial balance that still balances.
-- ---------------------------------------------------------------------------
CREATE TABLE depreciation_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id            uuid NOT NULL REFERENCES firms(id),
  client_id          uuid NOT NULL REFERENCES clients(id),
  voucher_id         uuid NOT NULL REFERENCES vouchers(id),
  from_date          date NOT NULL,
  to_date            date NOT NULL,
  total              numeric(18,2) NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),

  CONSTRAINT depreciation_run_range_ck CHECK (to_date >= from_date),
  UNIQUE (client_id, from_date, to_date)
);

CREATE TABLE depreciation_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid NOT NULL REFERENCES depreciation_runs(id) ON DELETE CASCADE,
  asset_id           uuid NOT NULL REFERENCES fixed_assets(id),
  -- Carrying amount before this charge, the charge, and after. Kept so the
  -- schedule can be reproduced years later without re-deriving it from a rate
  -- master that has since changed.
  opening_wdv        numeric(18,2) NOT NULL,
  charge             numeric(18,2) NOT NULL,
  closing_wdv        numeric(18,2) NOT NULL,
  -- Days the asset was held in the period, for the pro-rata.
  days               int NOT NULL,
  method             text NOT NULL,
  note               text,

  UNIQUE (run_id, asset_id)
);

CREATE INDEX ON depreciation_lines (asset_id);

ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON fixed_assets
  USING (firm_id = current_firm_id()) WITH CHECK (firm_id = current_firm_id());

ALTER TABLE depreciation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE depreciation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON depreciation_runs
  USING (firm_id = current_firm_id()) WITH CHECK (firm_id = current_firm_id());

-- Isolated through its parent, like every other line table here.
ALTER TABLE depreciation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE depreciation_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON depreciation_lines
  USING (run_id IN (SELECT id FROM depreciation_runs WHERE firm_id = current_firm_id()))
  WITH CHECK (run_id IN (SELECT id FROM depreciation_runs WHERE firm_id = current_firm_id()));

GRANT SELECT, INSERT ON fixed_assets, depreciation_runs, depreciation_lines
  TO bharaterp_app;
-- Disposal is the only thing about a capitalised asset that changes later.
GRANT UPDATE (disposed_on, disposal_proceeds, disposal_voucher_id)
  ON fixed_assets TO bharaterp_app;
GRANT SELECT ON asset_classes TO bharaterp_app;

-- ---------------------------------------------------------------------------
-- Heads the register needs, added to charts that predate it.
--
-- The same backfill migration 025 does, for the same reason: a column or an
-- account that exists only for new clients is a feature silently off for
-- everyone else. Computers and Vehicles because they are what an SMB buys and
-- they depreciate quite differently from "Office Equipment"; Loss on Sale of
-- Assets because a disposal below carrying amount has to land somewhere that
-- is not an income account.
-- ---------------------------------------------------------------------------
INSERT INTO accounts (firm_id, client_id, code, name, parent_id, is_group,
                      root_type, account_type, normal_balance, liquidity_class,
                      created_by)
SELECT g.firm_id, g.client_id, v.code, v.name, g.id, false,
       'asset', 'fixed_asset', 'debit', 'non_current', g.created_by
  FROM accounts g
  CROSS JOIN (VALUES ('1140','Computers'), ('1150','Vehicles')) AS v(code, name)
 WHERE g.name = 'Fixed Assets' AND g.is_group AND g.root_type = 'asset'
   AND NOT EXISTS (SELECT 1 FROM accounts a
                    WHERE a.client_id = g.client_id AND a.name = v.name);

INSERT INTO accounts (firm_id, client_id, code, name, parent_id, is_group,
                      root_type, account_type, normal_balance, expense_class,
                      created_by)
SELECT g.firm_id, g.client_id, '5197', 'Loss on Sale of Assets', g.id, false,
       'expense', 'general', 'debit', 'non_operating', g.created_by
  FROM accounts g
 WHERE g.name = 'Non-Operating' AND g.is_group AND g.root_type = 'expense'
   AND NOT EXISTS (SELECT 1 FROM accounts a
                    WHERE a.client_id = g.client_id
                      AND a.name = 'Loss on Sale of Assets');

-- ---------------------------------------------------------------------------
-- The capitalisation threshold BE-11 has been asking for.
--
-- A POLICY, not a statute, and the distinction matters: Schedule II sets no
-- de minimis, so where a client draws the line between an expense and an asset
-- is their own accounting policy, consistently applied and disclosed. ₹5,000
-- is the figure most Indian SMBs use, inherited from the old Schedule XIV
-- rule, and it is a default to be changed rather than a rule to be obeyed.
--
-- It lives in the threshold master so it is date-ranged like everything else
-- here: a client who raises their threshold does not retrospectively turn last
-- year's expenses into assets.
-- ---------------------------------------------------------------------------
INSERT INTO compliance_thresholds (key, effective_from, value, unit, source_notification)
VALUES ('capitalisation_threshold', '2014-04-01', 5000, 'rupees',
        'ACCOUNTING POLICY, not a statutory limit — Schedule II sets no de '
        'minimis. 5,000 is the common default, inherited from Schedule XIV.');
