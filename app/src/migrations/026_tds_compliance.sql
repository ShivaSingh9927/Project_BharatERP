-- Depositing what was deducted, and filing the statement.
-- Spec: bills-and-expenses.md BE-37
--
-- BE-36 made the liability appear in TDS Payable and stopped there. That is
-- half a job: a deduction the client never deposits carries interest at 1.5%
-- per month under s.201(1A), and a statement never filed carries ₹200 a day
-- under s.234E — both running from dates nothing in the software knew about.
--
-- A CA does not need to be told what TDS is. They need to be told what is due,
-- by when, and how much it has already cost to be late.

-- ---------------------------------------------------------------------------
-- WHEN it is due.
--
-- Expressed as data and date-ranged, for the reason migration 008 gives: these
-- dates move. The Q1 FY2025-26 statement deadline was extended by CBDT
-- circular, and a hardcoded 31 July would have quietly reported a client as
-- late for three months.
--
-- The shape is (period this row governs) -> (offset to the due month, day).
-- That expresses the March exception — deductions in March are payable by
-- 30 April rather than 7 April — as a row rather than as an `if` in code.
-- ---------------------------------------------------------------------------
CREATE TABLE tds_deadlines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'deposit': paying the tax over (Rule 30).
  -- 'statement': the quarterly return, Form 26Q (Rule 31A).
  kind           text NOT NULL,
  -- The calendar month whose deductions this governs. For a statement, the
  -- LAST month of the quarter — 6, 9, 12, 3.
  period_month   int  NOT NULL,
  -- 1 = the month after the period ends. Q4's statement is 2, being due in May.
  due_month_offset int NOT NULL,
  due_day        int  NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  source_citation text,

  CONSTRAINT tds_deadline_kind_ck CHECK (kind IN ('deposit', 'statement')),
  CONSTRAINT tds_deadline_month_ck CHECK (period_month BETWEEN 1 AND 12),
  CONSTRAINT tds_deadline_day_ck CHECK (due_day BETWEEN 1 AND 31),
  CONSTRAINT tds_deadline_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (kind, period_month, effective_from)
);

CREATE INDEX ON tds_deadlines (kind, period_month, effective_from);

-- ---------------------------------------------------------------------------
-- The challan: proof the money reached the government.
--
-- Without this, "outstanding" is always the whole liability and the report
-- cries wolf on every client. The voucher does the accounting — TDS Payable Dr
-- / Bank Cr — and this records WHICH month's deductions it covers and the
-- CIN a return has to quote.
--
-- Not a status column on `tds_deductions`, because one challan usually covers
-- a whole month of deductions across several suppliers, and one month can be
-- paid in two challans when somebody notices a shortfall.
-- ---------------------------------------------------------------------------
CREATE TABLE tds_challans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id        uuid NOT NULL REFERENCES firms(id),
  client_id      uuid NOT NULL REFERENCES clients(id),
  -- The payment voucher that moved the money.
  voucher_id     uuid NOT NULL REFERENCES vouchers(id),
  -- Which month's deductions this pays over, as YYYY-MM. The deadline hangs
  -- off the deduction month, not off the date the challan was paid.
  period         char(7) NOT NULL,
  deposited_on   date NOT NULL,

  -- The Challan Identification Number: BSR code + tender date + serial. It is
  -- what the quarterly statement quotes against each deduction, and a return
  -- filed without it is rejected. Nullable because a client may record the
  -- payment the day they make it and get the CIN the next morning.
  bsr_code       char(7),
  challan_serial text,
  -- Split out, because a return reports them separately and interest paid late
  -- is not tax deducted.
  tax_amount     numeric(18,2) NOT NULL,
  interest_amount numeric(18,2) NOT NULL DEFAULT 0,
  late_fee_amount numeric(18,2) NOT NULL DEFAULT 0,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),

  CONSTRAINT tds_challan_period_ck CHECK (period ~ '^\d{4}-\d{2}$'),
  CONSTRAINT tds_challan_amounts_ck CHECK (
    tax_amount >= 0 AND interest_amount >= 0 AND late_fee_amount >= 0
    AND tax_amount + interest_amount + late_fee_amount > 0)
);

CREATE INDEX ON tds_challans (client_id, period);

ALTER TABLE tds_challans ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON tds_challans
  USING (firm_id = current_setting('app.firm_id')::uuid);

GRANT SELECT, INSERT, UPDATE ON tds_challans TO bharaterp_app;
GRANT SELECT ON tds_deadlines TO bharaterp_app;

-- ---------------------------------------------------------------------------
-- The deadlines themselves.
--
-- Rule 30: tax deducted is payable by the 7th of the following month, except
-- for March, which is payable by 30 April.
-- ---------------------------------------------------------------------------
INSERT INTO tds_deadlines (kind, period_month, due_month_offset, due_day,
                           effective_from, source_citation)
SELECT 'deposit', m, 1, CASE WHEN m = 3 THEN 30 ELSE 7 END, '2020-04-01',
       CASE WHEN m = 3
         THEN 'Rule 30(2) — March deductions are payable by 30 April'
         ELSE 'Rule 30(2) — by the 7th of the following month' END
  FROM generate_series(1, 12) AS m;

-- Rule 31A: the quarterly statement. Q4 is the odd one, due in May.
INSERT INTO tds_deadlines (kind, period_month, due_month_offset, due_day,
                           effective_from, source_citation)
VALUES
  ('statement',  6, 1, 31, '2020-04-01', 'Rule 31A — Q1 (Apr-Jun), Form 26Q'),
  ('statement',  9, 1, 31, '2020-04-01', 'Rule 31A — Q2 (Jul-Sep), Form 26Q'),
  ('statement', 12, 1, 31, '2020-04-01', 'Rule 31A — Q3 (Oct-Dec), Form 26Q'),
  ('statement',  3, 2, 31, '2020-04-01', 'Rule 31A — Q4 (Jan-Mar), Form 26Q');

-- ---------------------------------------------------------------------------
-- What being late costs. Rates, so they belong in the threshold master.
-- ---------------------------------------------------------------------------
INSERT INTO compliance_thresholds (key, effective_from, value, unit, source_notification)
VALUES
  ('tds_interest_late_deduction', '2020-04-01', 1.0, 'percent_per_month',
   's.201(1A)(i) — 1% per month from the date the tax was deductible to the date it was deducted'),
  ('tds_interest_late_deposit', '2020-04-01', 1.5, 'percent_per_month',
   's.201(1A)(ii) — 1.5% per month from the date of deduction to the date of payment'),
  ('tds_late_filing_fee_per_day', '2020-04-01', 200, 'rupees_per_day',
   's.234E — Rs 200 per day, capped at the tax deducted');

-- ---------------------------------------------------------------------------
-- The expense head interest and late fees are posted to.
--
-- Added to charts that predate it, for the reason migration 025 backfills the
-- TDS categories: without it, recording a challan that includes interest has
-- nowhere to put the figure. `recordTdsDeposit` refuses rather than choosing a
-- neighbouring account — which is right, and would refuse every existing
-- client until somebody added this by hand.
--
-- Under Non-Operating, beside Interest on Loan, and deliberately not merged
-- with it: a tax penalty is not a cost of borrowing, and it has to be findable
-- at year end because it is added back in the income computation.
-- ---------------------------------------------------------------------------
INSERT INTO accounts (firm_id, client_id, code, name, parent_id, is_group,
                      root_type, account_type, normal_balance, expense_class,
                      created_by)
SELECT g.firm_id, g.client_id, '5215', 'Interest and Penalties on Taxes',
       g.id, false, 'expense', 'general', 'debit', 'non_operating', g.created_by
  FROM accounts g
 WHERE g.name = 'Non-Operating' AND g.is_group AND g.root_type = 'expense'
   AND NOT EXISTS (
     SELECT 1 FROM accounts a
      WHERE a.client_id = g.client_id
        AND a.name = 'Interest and Penalties on Taxes');
