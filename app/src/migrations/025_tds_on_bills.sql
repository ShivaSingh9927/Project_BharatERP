-- TDS at the point of CREDIT, not only at payment.
-- Spec: bills-and-expenses.md BE-36
--
-- Every section in `tds_sections` charges the deduction "at the time of credit
-- of such sum to the account of the payee or at the time of payment, whichever
-- is earlier". Booking a purchase bill IS that credit. Deducting only when the
-- bill is paid is therefore late whenever the bill is booked in one month and
-- paid in another — it moves the deposit deadline and the return quarter, and
-- interest under s.201(1A) runs from the date the deduction was due.
--
-- Two things were missing to do it at bill time.
--
-- 1. WHICH SECTION. That follows from the nature of the expense, which the
--    chart of accounts already knows: "Professional Fees" is s.194J work,
--    "Rent" is 194-I, a contractor's bill is 194C. So the category lives on
--    the account, next to `itc_eligibility`, which is already resolved the
--    same way — by what the spend IS rather than by who was paid.
ALTER TABLE accounts ADD COLUMN tds_category text;

COMMENT ON COLUMN accounts.tds_category IS
  'Matches tds_sections.category_name. NULL means this head attracts no TDS. '
  'Deliberately not a foreign key: tds_sections is date-ranged on '
  '(category, entity_type, effective_from), so the category is a name that '
  'outlives any one row of it.';

-- Existing clients are BACKFILLED, and that matters more than it looks.
--
-- A new column defaulting to NULL would leave every chart already in the
-- database saying no head attracts TDS — so the feature would be silently off
-- for every existing client, which is indistinguishable from it not working.
-- The chart is seeded from one fixed template, so the heads can be named.
--
-- Kept in step with TDS_HEADS in src/seed/tdsSections.ts. Two heads are
-- deliberately absent from both: Interest on Loan, because s.194A excludes
-- interest paid to a bank and that is what the account holds; and Salary,
-- which is deducted at the employee's own average rate and needs payroll.
UPDATE accounts SET tds_category = v.category
  FROM (VALUES
    ('Professional Fees',       'Professional Fees'),
    ('Contract Payments',       'Contractor Payments'),
    ('Commission and Brokerage','Commission or Brokerage'),
    ('Office Rent',             'Rent on Land / Building')
  ) AS v(account, category)
 WHERE accounts.name = v.account
   AND accounts.root_type = 'expense' AND NOT accounts.is_group;

-- 2. WHERE THE DEDUCTION IS RECORDED. `tds_deductions` already points at a
--    voucher, so a bill-time deduction needs no new table — but nothing
--    stopped the same bill being deducted twice, once on credit and again on
--    payment, which is the exact error this feature could introduce.
--
--    `bill_voucher_id` names the bill the deduction belongs to: the bill
--    itself on the credit limb, the bill being settled on the payment limb,
--    and NULL for an advance that has no bill yet. Unique, so a second
--    deduction against one bill cannot be written at all.
ALTER TABLE tds_deductions ADD COLUMN bill_voucher_id uuid REFERENCES vouchers(id);
ALTER TABLE tds_deductions ADD COLUMN deducted_on text NOT NULL DEFAULT 'payment';
ALTER TABLE tds_deductions ADD CONSTRAINT tds_deducted_on_ck
  CHECK (deducted_on IN ('credit', 'payment'));

COMMENT ON COLUMN tds_deductions.deducted_on IS
  'Which limb of "credit or payment, whichever is earlier" this deduction was '
  'made under. Not cosmetic: it is what tells a reviewer why a March bill '
  'paid in May was deducted in March.';

-- 3. WHAT WAS DUE, alongside what was taken.
--
--    A reviewer may decline a deduction — they know something the chart does
--    not. Posting gross and writing no row would hide it: the bill would look
--    like one that attracted no TDS at all, and the ₹20,000 nobody withheld
--    would surface as a notice a year later.
--
--    So the row is always written, and it carries both figures. Equal means
--    deducted; computed > 0 with amount 0 is a SHORTFALL somebody chose, and
--    it can be listed. It also keeps the threshold arithmetic honest: the base
--    counts toward the annual total either way, while only what was really
--    withheld is netted off the crossing deduction.
ALTER TABLE tds_deductions ADD COLUMN tds_computed numeric(18,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN tds_deductions.tds_computed IS
  'What the section required. tds_amount is what was actually withheld. A gap '
  'between them is a deduction a human declined, kept visible on purpose.';

CREATE UNIQUE INDEX tds_deductions_one_per_bill
  ON tds_deductions (bill_voucher_id) WHERE bill_voucher_id IS NOT NULL;
