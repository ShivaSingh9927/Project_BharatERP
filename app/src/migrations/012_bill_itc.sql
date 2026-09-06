-- 012_bill_itc.sql
-- Input tax credit is decided per LINE, and a bill may be mixed.
-- Spec: bills-and-expenses.md §6.2 — CA review answer A5.3.
-- Gap: DEFECT-LOG G-9
--
-- The ledger already posted correctly per line: an eligible line debits the
-- expense net and claims the tax, a blocked line debits the expense INCLUSIVE
-- of tax. What was wrong was everything the bill then *said* about itself.
--
-- The header collapsed the lines with "blocked if any line is blocked", so a
-- hotel bill with allowable lodging and blocked food reported as wholly
-- blocked, and `itcClaimable` came back false while real money was in fact
-- claimable. The review called that a harsh UX; it is also simply untrue, and
-- there was no figure anywhere for how much credit the bill actually carried —
-- which GSTR-3B needs.
--
-- Mixed bills are routine, not an edge case: a hotel invoice, a vehicle service
-- with parts and insurance, a works contract with materials.

-- A separate type from `itc_eligibility` rather than an added value.
--
-- `itc_eligibility` is also used by accounts and by bill LINES, where "mixed"
-- is meaningless — a single line is one thing or the other. Adding the value to
-- the shared enum would make an impossible state expressible in two places to
-- avoid declaring a type in one. (It would also not work: migrations run inside
-- a transaction, and PostgreSQL will not let a value added by ALTER TYPE be
-- used in the same transaction.)
CREATE TYPE bill_itc_status AS ENUM ('eligible', 'blocked', 'conditional', 'mixed');

ALTER TABLE purchase_bills ALTER COLUMN itc_eligibility DROP DEFAULT;
ALTER TABLE purchase_bills
  ALTER COLUMN itc_eligibility TYPE bill_itc_status
  USING itc_eligibility::text::bill_itc_status;
ALTER TABLE purchase_bills ALTER COLUMN itc_eligibility SET DEFAULT 'eligible';

-- How much credit this bill actually carries, split.
--
-- Stored rather than derived on demand: these are the figures a GSTR-3B is
-- built from and a return is a statement about what was decided at the time.
-- Recomputing later against a changed account master would silently restate a
-- filed return.
ALTER TABLE purchase_bills
  ADD COLUMN itc_claimable_value numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN itc_blocked_value   numeric(18,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN purchase_bills.itc_claimable_value IS
  'GST on lines whose ITC is eligible. The amount claimable in GSTR-3B.';
COMMENT ON COLUMN purchase_bills.itc_blocked_value IS
  'GST on blocked or undecided lines. Capitalised into the expense, not claimed.';

-- --------------------------------------------------------------------------
-- Backfill from the lines, which were already correct.
-- --------------------------------------------------------------------------
UPDATE purchase_bills pb SET
  itc_claimable_value = COALESCE(agg.claimable, 0),
  itc_blocked_value   = COALESCE(agg.blocked, 0)
FROM (
  SELECT voucher_id,
         sum(CASE WHEN itc_eligibility = 'eligible'
                  THEN cgst_amount + sgst_amount + igst_amount ELSE 0 END) AS claimable,
         sum(CASE WHEN itc_eligibility <> 'eligible'
                  THEN cgst_amount + sgst_amount + igst_amount ELSE 0 END) AS blocked
  FROM purchase_bill_items GROUP BY voucher_id
) agg
WHERE agg.voucher_id = pb.voucher_id;

-- Re-derive the header now that "mixed" can be said.
UPDATE purchase_bills pb SET itc_eligibility = agg.status
FROM (
  SELECT voucher_id,
         CASE
           WHEN count(*) FILTER (WHERE itc_eligibility = 'eligible') = count(*)
             THEN 'eligible'
           WHEN count(*) FILTER (WHERE itc_eligibility = 'blocked') = count(*)
             THEN 'blocked'
           WHEN count(*) FILTER (WHERE itc_eligibility = 'conditional') = count(*)
             THEN 'conditional'
           ELSE 'mixed'
         END::bill_itc_status AS status
  FROM purchase_bill_items GROUP BY voucher_id
) agg
WHERE agg.voucher_id = pb.voucher_id;

-- A bill claiming credit it has no eligible line for, or claiming a negative
-- amount, is not a state any code path should be able to reach.
ALTER TABLE purchase_bills
  ADD CONSTRAINT itc_values_non_negative
  CHECK (itc_claimable_value >= 0 AND itc_blocked_value >= 0);

ALTER TABLE purchase_bills
  ADD CONSTRAINT itc_blocked_header_claims_nothing
  CHECK (itc_eligibility <> 'blocked' OR itc_claimable_value = 0);
