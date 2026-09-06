-- 013_business_type.sql
-- What business is the client IN, and which Section 17(5) category blocks
-- this account?
-- Spec: bills-and-expenses.md §6.2 — CA review answers A5.3, A5.4.
-- Gap: DEFECT-LOG G-3
--
-- `decideItc` has always known how to unblock a conditional category for a
-- client whose trade qualifies: a transport company genuinely may claim credit
-- on motor vehicles, a restaurant on food. It needs two facts to do it, and
-- NEITHER was ever supplied.
--
--   1. The client's business type. `createBill` ran
--          SELECT NULL::text AS business_type
--      a literal placeholder, so the answer was always "unknown".
--   2. WHICH blocked category the account falls under. `createBill` never
--      passed `blockedCategory` at all, so the lookup that finds the exception
--      returned undefined every time.
--
-- The second is the more instructive failure. `blockedCategory` was exercised
-- only by unit tests calling `decideItc` directly, so the exception logic was
-- covered, passing, and unreachable from the one code path that matters — the
-- same shape as BV-6 and the malformed .gitignore line. A test that calls the
-- function is not a test that the function is called.
--
-- Consequence: every conditional line parked for a human forever. Safe, and
-- exactly the "harsh UX" the review warned about, since answer A5.4 says asking
-- once at the client level is normally enough.

ALTER TABLE clients ADD COLUMN business_type text;

COMMENT ON COLUMN clients.business_type IS
  'What the client does, for Section 17(5) exceptions. NULL means not asked — '
  'which keeps conditional lines with a human rather than guessing.';

-- Constrained rather than free text. A typo would fail SAFE (no exception
-- applies, so the line parks for a human) but it would fail silently, and the
-- CA would never learn that the answer they gave is not being used.
--
-- This list must stay in step with `unblockedFor` in domain/itc.ts. Two places,
-- deliberately: the database refuses a value the code cannot act on, which is
-- worth more than the cost of editing both when a trade is added.
ALTER TABLE clients ADD CONSTRAINT business_type_known CHECK (
  business_type IS NULL OR business_type IN (
    'transport', 'driving_school', 'vehicle_dealer',
    'catering', 'restaurant',
    'healthcare', 'salon',
    'insurance',
    'construction', 'works_contract',
    'general'
  ));

-- Which Section 17(5) category blocks this account.
--
-- `accounts.itc_eligibility` already said THAT credit is blocked; this says
-- WHY. Without it the reason on every warning read "Section 17(5) blocks input
-- credit on blocked category", which tells a CA nothing they can check, and the
-- exception lookup had no key to search on.
ALTER TABLE accounts ADD COLUMN itc_blocked_category text;

COMMENT ON COLUMN accounts.itc_blocked_category IS
  'Key into BLOCKED_CATEGORIES in domain/itc.ts. Names the clause, and is what '
  'the business-type exception is looked up by.';

CREATE INDEX ON accounts (client_id) WHERE itc_blocked_category IS NOT NULL;
