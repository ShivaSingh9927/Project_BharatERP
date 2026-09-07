-- 018_llm_cross_check.sql
-- Ask two readers and compare, because a tied sum is not proof of a full read.
-- Spec: bills-and-expenses.md §4.6
--
-- ── What made this necessary ───────────────────────────────────────────────
--
-- On 2026-09-07 a model was measured against the 11 documents the coordinate
-- reader had already read and gate 2 had already passed. It disagreed on two,
-- and on both the coordinate reader was WRONG.
--
-- A three-fee Flipkart invoice reads 50.00, 109.32 and 168.64, each followed
-- by an "[IMEI/Serial No: ...]" line whose text runs into the numeric columns.
-- The row loop treated that as the end of the table and reported a taxable
-- value of 50.00 against a true 327.96.
--
-- Both gates passed it, and there was nothing wrong with the gates: one row's
-- 50.00 + 9.00 = 59.00 ties perfectly on its own. An arithmetic check proves
-- the rows it was GIVEN are consistent. It cannot see rows never presented to
-- it. Completeness and consistency are different properties.
--
-- Nothing internal to one reader can catch that. Two readers can, because they
-- fail differently — which is the only reason this column exists.
--
-- ── Why it is a SEPARATE switch from llm_extraction ───────────────────────
--
-- `llm_extraction` sends documents we could not read. Cross-check sends
-- documents we read perfectly well. That is strictly more client data leaving
-- the building, for a benefit the firm may or may not want to pay for in
-- privacy terms. Folding it into the first switch would enrol a firm in the
-- larger exposure on the strength of consenting to the smaller one.

ALTER TABLE firm_ai_settings
  ADD COLUMN llm_cross_check boolean NOT NULL DEFAULT false;

-- Cross-check has no meaning without a model to check against, and the
-- attribution CHECK on the existing columns already covers who decided.
ALTER TABLE firm_ai_settings ADD CONSTRAINT cross_check_needs_extraction CHECK (
  NOT llm_cross_check OR llm_extraction
);

COMMENT ON COLUMN firm_ai_settings.llm_cross_check IS
  'Send documents that already read cleanly to a second reader and compare. '
  'Catches silent truncation, which no single reader can detect. Costs one '
  'API call per document and sends more client data than llm_extraction alone.';
